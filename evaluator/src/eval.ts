/**
 * Benchmark CLI.
 *
 *   npm run eval                       all cases, 10 Jev runs each
 *   npm run eval -- --runs 20          more repetitions
 *   npm run eval -- --rules-only       baseline only, no API key needed
 *   npm run eval -- --case NAME        one case
 *   npm run eval -- --category CAT     one category
 *   npm run eval -- --concurrency 3    conservative by default (2)
 *   npm run eval -- --output DIR       where to write json/csv/md
 *   npm run eval -- --no-write         do not persist anything
 *   npm run eval -- --json             print the raw result to stdout
 *
 * Rules run once per case because they are deterministic. Jev runs N times on
 * the identical Observation. Failed calls are stored, counted, and never
 * silently excluded.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { RuleBasedDecisionEngine, buildJevState } from "./decision.js";
import { JevClient, JevError } from "./jev.js";
import {
  BENCHMARK_VERSION,
  CRITERIA_VERSION,
  DEFAULT_THRESHOLDS,
  computeMetrics,
  frozenCriteria,
  recordRun,
  type BenchmarkResult,
  type CaseSpec,
  type RawCaseResult,
  type RawRun,
} from "./benchmark.js";
import { toConsole, toCsv, toMarkdown } from "./report.js";
import type { Observation } from "./types.js";

const CASES_URL = new URL("../../eval/cases.json", import.meta.url);
const DEFAULT_OUTPUT_DIR = new URL("../../eval/results/", import.meta.url);

// The batch timeout is deliberately looser than the interactive evaluator's.
// Eight-plus calls in quick succession can trip a slow provider, and a lost
// case is a worse outcome here than a slow benchmark. See README.
const DEFAULT_RUNS = 10;
const DEFAULT_CONCURRENCY = 2;
const BATCH_TIMEOUT_MS = 15_000;

const rules = new RuleBasedDecisionEngine();

type Options = {
  runs: number;
  rulesOnly: boolean;
  write: boolean;
  json: boolean;
  concurrency: number;
  outputDir: string;
  caseFilter: string | null;
  categoryFilter: string | null;
  /** Rebuild csv/markdown from a stored raw result. Makes no Jev calls. */
  reportFrom: string | null;
  minConfidence: number;
  timeoutMs: number;
  model: string;
};

function parseArgs(argv: string[]): Options {
  const options: Options = {
    runs: DEFAULT_RUNS,
    rulesOnly: false,
    write: true,
    json: false,
    concurrency: DEFAULT_CONCURRENCY,
    outputDir: resolve(new URL(".", DEFAULT_OUTPUT_DIR).pathname),
    caseFilter: null,
    categoryFilter: null,
    reportFrom: null,
    minConfidence: Number(process.env.JEV_MIN_CONFIDENCE ?? 0.65),
    timeoutMs: Number(process.env.JEV_TIMEOUT_MS ?? BATCH_TIMEOUT_MS),
    model: process.env.OPENROUTER_JEV_MODEL ?? "typesafe/jev-1.13",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      index += 1;
      return value;
    };
    switch (arg) {
      case "--runs": options.runs = Number(next()); break;
      case "--rules-only": options.rulesOnly = true; break;
      case "--no-write": options.write = false; break;
      case "--json": options.json = true; break;
      case "--report": options.reportFrom = resolve(next()); break;
      case "--concurrency": options.concurrency = Math.max(1, Number(next())); break;
      case "--output": options.outputDir = resolve(next()); break;
      case "--case": options.caseFilter = next(); break;
      case "--category": options.categoryFilter = next().toLowerCase(); break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!Number.isFinite(options.runs) || options.runs < 1) {
    throw new Error("--runs must be a positive number");
  }
  return options;
}

function timestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function toObservation(spec: CaseSpec): Observation {
  return { ...spec.observation, collectedAt: new Date().toISOString() };
}

/** Runs one Jev call. Failures are returned, never thrown, so they become data. */
async function oneRun(
  client: JevClient,
  spec: CaseSpec,
  observation: Observation,
  run: number,
  minConfidence: number,
): Promise<RawRun> {
  try {
    const result = await client.classify(buildJevState(observation));
    return recordRun({
      case: spec,
      run,
      minConfidence,
      result: {
        choice: result.choice,
        probabilities: result.probabilities as unknown as Record<string, number>,
        confidence: result.confidence,
        latencyMs: result.latencyMs,
        model: result.model,
        requestId: result.requestId,
        cost: result.usage?.cost ?? null,
        inputTokens: result.usage?.inputTokens ?? null,
        outputTokens: result.usage?.outputTokens ?? null,
      },
      error: null,
    });
  } catch (error) {
    return recordRun({
      case: spec,
      run,
      minConfidence,
      result: null,
      error: {
        kind: error instanceof JevError ? error.kind : "unknown",
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

async function runCase(
  client: JevClient,
  spec: CaseSpec,
  options: Options,
): Promise<RawCaseResult> {
  const observation = toObservation(spec);
  const rulesAssessment = await rules.evaluate(observation);

  const runs: RawRun[] = [];
  if (!options.rulesOnly) {
    // Fixed worker count. Same Observation for every run: nothing is mutated
    // between repetitions.
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= options.runs) return;
        runs.push(
          await oneRun(client, spec, observation, index + 1, options.minConfidence),
        );
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(options.concurrency, options.runs) }, worker),
    );
    runs.sort((a, b) => a.run - b.run);
  }

  return {
    name: spec.name,
    category: spec.category,
    family: spec.family ?? null,
    familyOrder: spec.familyOrder ?? null,
    expectedOperationalState: spec.expectedOperationalState,
    expectedDecision: spec.expectedDecision,
    note: spec.note,
    observation,
    rules: { decision: rulesAssessment.decision, summary: rulesAssessment.summary },
    runs,
  };
}

function buildResult(cases: RawCaseResult[], options: Options, generatedAt: string): BenchmarkResult {
  return {
    benchmarkVersion: BENCHMARK_VERSION,
    criteriaVersion: CRITERIA_VERSION,
    generatedAt,
    modelRequested: options.model,
    modelsReturned: [
      ...new Set(
        cases
          .flatMap((c) => c.runs.map((run) => run.model))
          .filter((model): model is string => model !== null),
      ),
    ],
    criteria: frozenCriteria(),
    minConfidence: options.minConfidence,
    timeoutMs: options.timeoutMs,
    runsPerCase: options.runs,
    caseCount: cases.length,
    plannedCalls: cases.length * options.runs,
    totalCalls: cases.reduce((sum, c) => sum + c.runs.length, 0),
    rulesOnly: options.rulesOnly,
    cases,
  };
}

/** Rebuilds every artifact from a stored result, without calling Jev again. */
async function reportFromStored(path: string): Promise<void> {
  const stored = JSON.parse(await readFile(path, "utf8")) as BenchmarkResult;
  const metrics = computeMetrics(stored, DEFAULT_THRESHOLDS);
  const dir = dirname(path);
  const stem = join(dir, basename(path).replace(/\.json$/, ""));
  await writeFile(`${stem}.csv`, toCsv(stored));
  await writeFile(`${stem}.md`, toMarkdown(stored, metrics));
  console.log(toConsole(stored, metrics));
  console.log("");
  console.log(`Rewrote ${stem}.csv`);
  console.log(`Rewrote ${stem}.md`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.reportFrom) {
    await reportFromStored(options.reportFrom);
    return;
  }
  const allCases = JSON.parse(await readFile(CASES_URL, "utf8")) as CaseSpec[];

  const selected = allCases.filter((spec) => {
    if (options.caseFilter && spec.name !== options.caseFilter) return false;
    if (options.categoryFilter && spec.category !== options.categoryFilter) return false;
    return true;
  });

  if (selected.length === 0) {
    throw new Error("No cases matched the filters");
  }

  const plannedCalls = options.rulesOnly ? 0 : selected.length * options.runs;
  const startedAt = Date.now();

  if (!options.rulesOnly) {
    const apiKey = process.env.OPENROUTER_API_KEY ?? "";
    if (apiKey.trim() === "") {
      throw new Error(
        "OPENROUTER_API_KEY is not set. Use --rules-only to run the baseline without it.",
      );
    }
  }

  console.log(`Signal to Action benchmark v${BENCHMARK_VERSION} (criteria v${CRITERIA_VERSION})`);
  console.log(`  cases:            ${selected.length}`);
  console.log(`  runs per case:    ${options.runs}`);
  console.log(`  planned Jev calls: ${plannedCalls}`);
  console.log(`  timeout:          ${options.timeoutMs} ms`);
  if (plannedCalls > 1000) {
    console.log(`  NOTE: ${plannedCalls} calls exceeds 1000. Lower --runs or filter with --category.`);
  }

  const client = new JevClient({
    apiKey: process.env.OPENROUTER_API_KEY ?? "",
    model: options.model,
    timeoutMs: options.timeoutMs,
  });

  // A full benchmark can run for a long time, so the raw result is rewritten
  // after every case. If the process dies, the partial file still holds
  // everything measured so far.
  const partialPath = join(options.outputDir, `partial-${timestamp(new Date(startedAt))}.json`);
  const writePartial = async (collected: RawCaseResult[]): Promise<void> => {
    if (!options.write) return;
    await mkdir(options.outputDir, { recursive: true });
    const partial = buildResult(collected, options, new Date().toISOString());
    await writeFile(partialPath, `${JSON.stringify(partial, null, 2)}\n`);
  };

  const cases: RawCaseResult[] = [];
  for (const spec of selected) {
    const result = await runCase(client, spec, options);
    cases.push(result);
    await writePartial(cases);
    const successful = result.runs.filter((run) => run.choice !== null).length;
    process.stdout.write(
      `  ${spec.name.padEnd(36)} rules=${result.rules.decision.padEnd(11)}` +
        `jev=${successful}/${result.runs.length}` +
        (result.runs.some((run) => run.error)
          ? `  errors=${result.runs.filter((run) => run.error).length}`
          : "") +
        "\n",
    );
  }

  const result = buildResult(cases, options, new Date().toISOString());
  const metrics = computeMetrics(result, DEFAULT_THRESHOLDS);
  console.log("");
  console.log(toConsole(result, metrics));
  console.log("");
  console.log(`Elapsed: ${Math.round((Date.now() - startedAt) / 1000)}s`);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  }

  if (options.write) {
    await mkdir(options.outputDir, { recursive: true });
    const stamp = timestamp(new Date());
    const stem = join(options.outputDir, `jev-1.13-${stamp}`);
    await writeFile(`${stem}.json`, `${JSON.stringify(result, null, 2)}\n`);
    await writeFile(`${stem}.csv`, toCsv(result));
    await writeFile(`${stem}.md`, toMarkdown(result, metrics));
    console.log("");
    console.log(`Wrote ${stem}.json`);
    console.log(`Wrote ${stem}.csv`);
    console.log(`Wrote ${stem}.md`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
