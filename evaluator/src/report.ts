/**
 * Rendering: console summary, CSV for analysis, Markdown for mining numbers.
 *
 * No chart library. CSV and Markdown carry the results; a plot is optional
 * decoration, not evidence.
 */

import type { BenchmarkResult, Metrics, RawRun } from "./benchmark.js";
import type { Decision } from "./types.js";

const CSV_COLUMNS = [
  "case",
  "category",
  "family",
  "run",
  "expected_state",
  "expected_decision",
  "rules_decision",
  "jev_choice",
  "confidence",
  "confidence_source",
  "effective_confidence",
  "top_probability",
  "second_probability",
  "probability_margin",
  "policy_decision",
  "correct_classification",
  "correct_policy",
  "low_confidence",
  "latency_ms",
  "cost_usd",
  "input_tokens",
  "output_tokens",
  "model",
  "request_id",
  "error_kind",
  "error_message",
] as const;

function csvCell(value: string | number | boolean | null): string {
  if (value === null) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(result: BenchmarkResult): string {
  const rows: string[] = [CSV_COLUMNS.join(",")];

  for (const testCase of result.cases) {
    for (const run of testCase.runs) {
      rows.push(
        [
          testCase.name,
          testCase.category,
          testCase.family,
          run.run,
          testCase.expectedOperationalState,
          testCase.expectedDecision,
          testCase.rules.decision,
          run.choice,
          run.confidence,
          run.confidenceSource,
          run.effectiveConfidence,
          run.topProbability,
          run.secondProbability,
          run.probabilityMargin,
          run.policyDecision,
          run.correctClassification,
          run.correctPolicy,
          run.lowConfidence,
          run.latencyMs,
          run.cost,
          run.inputTokens,
          run.outputTokens,
          run.model,
          run.requestId,
          run.error?.kind ?? null,
          run.error?.message ?? null,
        ]
          .map(csvCell)
          .join(","),
      );
    }
  }

  return `${rows.join("\n")}\n`;
}

const pct = (value: number | null): string =>
  value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
const num = (value: number | null, suffix = ""): string =>
  value === null ? "n/a" : `${value}${suffix}`;
const usd = (value: number | null): string =>
  value === null ? "n/a" : `$${value.toFixed(8)}`;

export function toConsole(result: BenchmarkResult, metrics: Metrics): string {
  const lines: string[] = [];
  const push = (line = ""): void => void lines.push(line);

  push("Signal to Action Evaluation");
  push(`Model requested:   ${result.modelRequested}`);
  push(`Models returned:   ${[...new Set(result.modelsReturned)].join(", ") || "n/a"}`);
  push(`Benchmark version: ${result.benchmarkVersion} (criteria v${result.criteriaVersion})`);
  push(`Cases:             ${result.caseCount}`);
  push(`Runs per case:     ${result.runsPerCase}`);
  push(`Planned Jev calls: ${result.plannedCalls}`);
  push(`Timeout / gate:    ${result.timeoutMs} ms / ${result.minConfidence}`);
  push("");

  push("Rules baseline (deterministic, 1 run per case)");
  push(`  policy accuracy:        ${pct(metrics.rulesPolicyAccuracy)} (${metrics.rulesCorrect}/${result.caseCount})`);
  push(`  false escalations:      ${metrics.rulesFalseEscalations}`);
  push(`  missed degradations:    ${metrics.rulesMissedDegradations}`);
  push("");

  if (result.rulesOnly) {
    push("Jev: skipped (--rules-only)");
    return lines.join("\n");
  }

  push(`Jev calls: ${metrics.successful} succeeded, ${metrics.failed} failed of ${metrics.totalCalls}`);
  push("  (accuracy denominators are successful calls only)");
  push("");
  push("Accuracy");
  push(`  raw classification:          ${pct(metrics.classificationAccuracy)}`);
  push(`  gated policy decision:       ${pct(metrics.policyAccuracy)}`);
  push(`  coverage @ ${result.minConfidence}:            ${pct(metrics.coverage)}`);
  push(`  accuracy when accepted:      ${pct(metrics.acceptedClassificationAccuracy)}`);
  push(`  abstention rate:             ${pct(metrics.abstentionRate)}`);
  push("");
  push("Operational errors (gated policy)");
  push(`  false escalations:           ${metrics.falseEscalations}`);
  push(`  missed degradations:         ${metrics.missedDegradations}`);
  push("");
  push("Stability (identical input, repeated)");
  push(`  mean consistency:            ${num(metrics.meanConsistency)}`);
  push(`  fully stable cases:          ${metrics.casesFullyStable}/${metrics.casesWithFlips + metrics.casesFullyStable}`);
  push(`  cases with a label flip:     ${metrics.casesWithFlips}`);
  const worst = [...metrics.stability]
    .filter((entry) => entry.consistency !== null)
    .sort((a, b) => (a.consistency as number) - (b.consistency as number))
    .slice(0, 5);
  push("  least stable cases:");
  for (const entry of worst) {
    push(
      `    ${entry.name.padEnd(34)} ${num(entry.consistency)}  ${describeDistribution(entry.distribution)}`,
    );
  }
  push("");
  push("Uncertainty");
  push(`  confidence sources:         ${JSON.stringify(metrics.confidenceSources)}`);
  push(`  mean probability margin:    ${num(metrics.meanMargin)}`);
  push(`  low-margin calls (<0.10):   ${metrics.lowMarginCalls}/${metrics.lowMarginCount}`);
  push(`  low-confidence @ margin<0.1:  ${pct(metrics.lowConfidenceRateLowMargin)}`);
  push(`  low-confidence @ margin>=0.1: ${pct(metrics.lowConfidenceRateHighMargin)}`);
  push("");
  push("By category");
  push(`  missing-data classification: ${pct(metrics.missingDataClassificationAccuracy)}`);
  push(`  missing-data policy:         ${pct(metrics.missingDataPolicyAccuracy)}`);
  push(`  insufficient-evidence detect: ${pct(metrics.insufficientEvidenceDetectionRate)}`);
  push(`  ambiguous classification:    ${pct(metrics.ambiguousClassificationAccuracy)}`);
  push(`  ambiguous policy:            ${pct(metrics.ambiguousPolicyAccuracy)}`);
  push("");
  push("Latency (successful calls, ms)");
  push(`  min ${num(metrics.latency.min)}  p50 ${num(metrics.latency.p50)}  p90 ${num(metrics.latency.p90)}  p95 ${num(metrics.latency.p95)}  max ${num(metrics.latency.max)}  mean ${num(metrics.latency.mean)}`);
  push(`  timeouts: ${metrics.timeouts}`);
  push("");
  push("Cost");
  push(`  total ${usd(metrics.cost.total)}  per call ${usd(metrics.cost.perCall)}  per case ${usd(metrics.cost.perCase)}`);
  push(`  projected per 1000 decisions: ${usd(metrics.cost.projectedPerThousandDecisions)}`);
  if (metrics.cost.callsMissingCost > 0) {
    push(`  calls without cost data: ${metrics.cost.callsMissingCost}`);
  }
  if (Object.keys(metrics.errorKinds).length > 0) {
    push("");
    push("Errors");
    for (const [kind, count] of Object.entries(metrics.errorKinds)) {
      push(`  ${kind}: ${count}`);
    }
  }
  push("");
  push(`Policy parity mismatches: ${metrics.policyParityMismatches}`);

  return lines.join("\n");
}

function describeDistribution(distribution: Record<string, number>): string {
  return Object.entries(distribution)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name}:${count}`)
    .join(" ");
}

export function toMarkdown(result: BenchmarkResult, metrics: Metrics): string {
  const lines: string[] = [];
  const push = (line = ""): void => void lines.push(line);

  push("# Signal to Action benchmark run");
  push("");
  push(`Generated ${result.generatedAt} · benchmark v${result.benchmarkVersion} · criteria v${result.criteriaVersion}`);
  push("");
  push("## Summary");
  push("");
  push("| field | value |");
  push("| --- | --- |");
  push(`| model requested | \`${result.modelRequested}\` |`);
  push(`| model returned | ${[...new Set(result.modelsReturned)].map((m) => `\`${m}\``).join(", ") || "n/a"} |`);
  push(`| cases | ${result.caseCount} |`);
  push(`| runs per case | ${result.runsPerCase} |`);
  push(`| planned calls | ${result.plannedCalls} |`);
  push(`| successful calls | ${metrics.successful} |`);
  push(`| failed calls | ${metrics.failed} |`);
  push(`| confidence gate | ${result.minConfidence} |`);
  push(`| timeout | ${result.timeoutMs} ms |`);
  push("");
  push("Rules baseline and Jev, side by side. Accuracy denominators are successful calls only:");
  push("");
  push("| metric | value |");
  push("| --- | --- |");
  push(`| rules policy accuracy | ${pct(metrics.rulesPolicyAccuracy)} (${metrics.rulesCorrect}/${result.caseCount}) |`);
  push(`| Jev raw classification | ${pct(metrics.classificationAccuracy)} |`);
  push(`| Jev gated policy | ${pct(metrics.policyAccuracy)} |`);
  push(`| coverage @ ${result.minConfidence} | ${pct(metrics.coverage)} |`);
  push(`| accuracy when accepted | ${pct(metrics.acceptedClassificationAccuracy)} |`);
  push(`| abstention rate | ${pct(metrics.abstentionRate)} |`);
  push(`| false escalations (Jev) | ${metrics.falseEscalations} |`);
  push(`| missed degradations (Jev) | ${metrics.missedDegradations} |`);
  push(`| false escalations (rules) | ${metrics.rulesFalseEscalations} |`);
  push(`| missed degradations (rules) | ${metrics.rulesMissedDegradations} |`);
  push("");
  push("## Rules vs Jev");
  push("");
  push(`Mean self-consistency for Jev: **${num(metrics.meanConsistency)}** over ${metrics.casesWithFlips + metrics.casesFullyStable} cases.`);
  push(`${metrics.casesFullyStable} cases returned the same label every run, ${metrics.casesWithFlips} flipped.`);
  push("");
  push("Least stable cases:");
  push("");
  push("| case | consistency | distribution |");
  push("| --- | --- | --- |");
  for (const entry of [...metrics.stability]
    .filter((e) => e.consistency !== null)
    .sort((a, b) => (a.consistency as number) - (b.consistency as number))
    .slice(0, 8)) {
    push(`| ${entry.name} | ${num(entry.consistency)} | ${describeDistribution(entry.distribution)} |`);
  }
  push("");
  push("## Confidence threshold tradeoff");
  push("");
  push("Recomputed offline from one set of stored runs. No Jev call is repeated for a threshold.");
  push("");
  push("| threshold | coverage | accepted accuracy | policy accuracy | classification accuracy | false escalation | missed degradation |");
  push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const row of metrics.thresholds) {
    push(
      `| ${row.threshold} | ${pct(row.coverage)} | ${pct(row.acceptedClassificationAccuracy)} | ${pct(row.policyAccuracy)} | ${pct(row.classificationAccuracy)} | ${row.falseEscalations} | ${row.missedDegradations} |`,
    );
  }
  push("");
  push("## Missing data");
  push("");
  push(`Classification accuracy on missing-data cases: **${pct(metrics.missingDataClassificationAccuracy)}**.`);
  push(`Policy accuracy on missing-data cases: **${pct(metrics.missingDataPolicyAccuracy)}**.`);
  push(`Insufficient-evidence detection rate: **${pct(metrics.insufficientEvidenceDetectionRate)}**.`);
  push("");
  push("A safe final policy and a correct classification are different things. This section keeps them apart.");
  push("");
  push("| case | expected | rules | modal Jev label | consistency |");
  push("| --- | --- | --- | --- | --- |");
  for (const testCase of result.cases.filter((c) => c.category === "missing-data")) {
    const entry = metrics.stability.find((e) => e.name === testCase.name);
    push(
      `| ${testCase.name} | ${testCase.expectedOperationalState} | ${testCase.rules.decision} | ${entry?.modal ?? "n/a"} | ${num(entry?.consistency ?? null)} |`,
    );
  }
  push("");
  push("## Ambiguous states");
  push("");
  push(`Classification accuracy: **${pct(metrics.ambiguousClassificationAccuracy)}**, policy accuracy: **${pct(metrics.ambiguousPolicyAccuracy)}**.`);
  push("");
  push("| case | expected | rules | modal Jev label | consistency | mean margin |");
  push("| --- | --- | --- | --- | --- | --- |");
  for (const testCase of result.cases.filter((c) => c.category === "ambiguous")) {
    const entry = metrics.stability.find((e) => e.name === testCase.name);
    push(
      `| ${testCase.name} | ${testCase.expectedOperationalState} | ${testCase.rules.decision} | ${entry?.modal ?? "n/a"} | ${num(entry?.consistency ?? null)} | ${num(meanMargin(testCase.runs))} |`,
    );
  }
  push("");
  push("## Boundary families");
  push("");
  for (const family of metrics.boundaries) {
    push(`### ${family.family}`);
    push("");
    push("| input | expected | rules | modal Jev label | consistency | reversal |");
    push("| --- | --- | --- | --- | --- | --- |");
    for (const step of family.steps) {
      push(
        `| ${step.name} | ${step.expected} | ${step.rulesDecision} | ${step.modal ?? "n/a"} | ${num(step.consistency)} | ${step.isReversal ? "yes" : ""} |`,
      );
    }
    push("");
    if (family.reversals.length > 0) {
      push(`Severity reversals in this family: ${family.reversals.join(", ")}`);
    } else {
      push("No severity reversals in this family.");
    }
    push("");
  }
  push("## Latency and cost");
  push("");
  push("| metric | value |");
  push("| --- | --- |");
  push(`| calls measured | ${metrics.latency.count} |`);
  push(`| min | ${num(metrics.latency.min)} ms |`);
  push(`| p50 | ${num(metrics.latency.p50)} ms |`);
  push(`| p90 | ${num(metrics.latency.p90)} ms |`);
  push(`| p95 | ${num(metrics.latency.p95)} ms |`);
  push(`| max | ${num(metrics.latency.max)} ms |`);
  push(`| mean | ${num(metrics.latency.mean)} ms |`);
  push(`| total cost | ${usd(metrics.cost.total)} |`);
  push(`| per call | ${usd(metrics.cost.perCall)} |`);
  push(`| per case | ${usd(metrics.cost.perCase)} |`);
  push(`| projected per 1000 decisions | ${usd(metrics.cost.projectedPerThousandDecisions)} |`);
  push(`| calls missing cost data | ${metrics.cost.callsMissingCost} |`);
  push("");
  push("## Errors and timeouts");
  push("");
  if (Object.keys(metrics.errorKinds).length === 0) {
    push("No failed calls.");
  } else {
    push("| kind | count |");
    push("| --- | --- |");
    for (const [kind, count] of Object.entries(metrics.errorKinds)) {
      push(`| ${kind} | ${count} |`);
    }
  }
  push("");
  push(`Failed calls are kept in the raw output and excluded from accuracy denominators, which use successful calls only. Total attempts were ${metrics.totalCalls}.`);
  push("");
  const disagreements = findDisagreements(result);
  const misclassified = disagreements.filter((row) => row.jevModalLabel !== row.expectedState);

  push("## Most interesting disagreements");
  push("");
  push("### Where the final policy differs");
  push("");
  push("Rules policy decision against the modal Jev policy decision. Same axis, same units.");
  push("");
  if (disagreements.length === 0) {
    push("Rules and the gated Jev policy agreed on every case.");
  } else {
    push("| case | category | expected | rules policy | Jev policy | Jev label | consistency |");
    push("| --- | --- | --- | --- | --- | --- | --- |");
    for (const row of disagreements) {
      push(
        `| ${row.name} | ${row.category} | ${row.expectedDecision} | ${row.rulesDecision} | ${row.jevPolicyDecision ?? "n/a"} | ${row.jevModalLabel ?? "n/a"} | ${num(row.consistency)} |`,
      );
    }
  }
  push("");
  push("### Where the classification is wrong");
  push("");
  push(`Jev's modal label against the expected classification, regardless of the final policy. ${misclassified.length} of ${result.caseCount} cases.`);
  push("");
  push("| case | category | expected label | Jev label | rules policy | consistency |");
  push("| --- | --- | --- | --- | --- | --- |");
  for (const row of misclassified) {
    push(
      `| ${row.name} | ${row.category} | ${row.expectedState} | ${row.jevModalLabel ?? "n/a"} | ${row.rulesDecision} | ${num(row.consistency)} |`,
    );
  }
  push("");
  push("## Uncertainty detail");
  push("");
  push(`Confidence field sources: ${JSON.stringify(metrics.confidenceSources)}`);
  push("");
  push(`Mean probability margin (top minus runner-up): **${num(metrics.meanMargin)}**.`);
  push(`Low-margin calls (margin < 0.10): ${metrics.lowMarginCalls} of ${metrics.lowMarginCount}.`);
  push(`Low-confidence rate at margin < 0.10: **${pct(metrics.lowConfidenceRateLowMargin)}**; at margin >= 0.10: **${pct(metrics.lowConfidenceRateHighMargin)}**.`);
  push("");
  push("Margin is measured here, not used as policy. Whether it is more useful than the reported confidence is left open.");
  push("");
  push("## Frozen Jev criteria used for this run");
  push("");
  push("```json");
  push(JSON.stringify(result.criteria, null, 2));
  push("```");
  push("");

  return lines.join("\n");
}

function meanMargin(runs: RawRun[]): number | null {
  const margins = runs
    .map((run) => run.probabilityMargin)
    .filter((value): value is number => value !== null);
  if (margins.length === 0) return null;
  return Number((margins.reduce((a, b) => a + b, 0) / margins.length).toFixed(3));
}

type DisagreementRow = {
  name: string;
  category: string;
  expectedState: string;
  expectedDecision: Decision;
  rulesDecision: Decision;
  jevPolicyDecision: string | null;
  jevModalLabel: string | null;
  consistency: number | null;
  kind: "policy" | "classification";
};

/**
 * Rules and Jev are compared on the same axis, in two separate columns:
 * the final policy decision, and the raw classification. Comparing a policy
 * decision against a classification would be meaningless.
 */
function findDisagreements(result: BenchmarkResult): DisagreementRow[] {
  const rows: DisagreementRow[] = [];

  for (const testCase of result.cases) {
    const successful = testCase.runs.filter((run) => run.choice !== null);
    if (successful.length === 0) continue;

    const labels: Record<string, number> = {};
    const policies: Record<string, number> = {};
    for (const run of successful) {
      labels[run.choice as string] = (labels[run.choice as string] ?? 0) + 1;
      if (run.policyDecision) {
        policies[run.policyDecision] = (policies[run.policyDecision] ?? 0) + 1;
      }
    }
    const modalLabel = Object.entries(labels).sort((a, b) => b[1] - a[1])[0];
    const modalPolicy = Object.entries(policies).sort((a, b) => b[1] - a[1])[0];

    rows.push({
      name: testCase.name,
      category: testCase.category,
      expectedState: testCase.expectedOperationalState,
      expectedDecision: testCase.expectedDecision,
      rulesDecision: testCase.rules.decision,
      jevPolicyDecision: modalPolicy?.[0] ?? null,
      jevModalLabel: modalLabel?.[0] ?? null,
      consistency: modalLabel ? modalLabel[1] / successful.length : null,
      kind:
        modalPolicy && modalPolicy[0] !== testCase.rules.decision
          ? "policy"
          : "classification",
    });
  }

  return rows
    .filter((row) => row.rulesDecision !== row.jevPolicyDecision)
    .sort((a, b) => (a.consistency ?? 1) - (b.consistency ?? 1));
}

export function summaryCounts(metrics: Metrics): string {
  return Object.entries(metrics.categoryCounts)
    .map(([name, count]) => `${name} ${count}`)
    .join(", ");
}
