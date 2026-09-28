import http from "node:http";
import { collectObservation } from "./observations.js";
import { JevDecisionEngine, RuleBasedDecisionEngine } from "./decision.js";
import { PrometheusClient } from "./prometheus.js";
import { JevClient, JevError } from "./jev.js";
import type { Comparison, DecisionEngine, JevFailure, JevReport } from "./types.js";

const PORT = Number(process.env.PORT ?? 8080);
const PROMETHEUS_URL = process.env.PROMETHEUS_URL ?? "http://prometheus:9090";
const PROMETHEUS_TIMEOUT_MS = Number(process.env.PROMETHEUS_TIMEOUT_MS ?? 5_000);

const DECISION_ENGINE = process.env.DECISION_ENGINE ?? "rules";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? "";
const OPENROUTER_JEV_MODEL = process.env.OPENROUTER_JEV_MODEL ?? "typesafe/jev-1.13";
const JEV_MIN_CONFIDENCE = Number(process.env.JEV_MIN_CONFIDENCE ?? 0.65);
const JEV_TIMEOUT_MS = Number(process.env.JEV_TIMEOUT_MS ?? 10_000);

const prometheus = new PrometheusClient(PROMETHEUS_URL, PROMETHEUS_TIMEOUT_MS);

const jevClient = new JevClient({
  apiKey: OPENROUTER_API_KEY,
  model: OPENROUTER_JEV_MODEL,
  timeoutMs: JEV_TIMEOUT_MS,
  endpoint: process.env.JEV_ENDPOINT,
});

const ruleEngine = new RuleBasedDecisionEngine();
const jevEngine = new JevDecisionEngine(jevClient, JEV_MIN_CONFIDENCE);

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}

async function handle(res: http.ServerResponse, run: () => Promise<unknown>): Promise<void> {
  try {
    sendJson(res, 200, await run());
  } catch (error) {
    // The decision layer failing must be visible and harmless. Prometheus and
    // Grafana do not depend on this process, so monitoring keeps working.
    const message = error instanceof Error ? error.message : String(error);
    console.error(`request failed: ${message}`);
    sendJson(res, 503, {
      error: "The decision layer could not produce an assessment",
      detail: message,
      monitoring: "unaffected: Prometheus and Grafana do not depend on the evaluator",
    });
  }
}

/** Turns any Jev failure into a small structured value instead of a stack trace. */
function toJevFailure(error: unknown): JevFailure {
  if (error instanceof JevError) return { error: error.message, kind: error.kind };
  return { error: error instanceof Error ? error.message : String(error), kind: "network" };
}

function logJevFailure(mode: string, failure: JevFailure): void {
  console.error(`jev unavailable (${failure.kind}) in ${mode} mode: ${failure.error}`);
}

function logJev(decision: string, report: JevReport): void {
  // The API key is never logged, and neither is the state.
  console.log(
    `jev ${report.choice} confidence=${report.confidence ?? "n/a"} ` +
      `model=${report.model ?? "n/a"} requestId=${report.requestId ?? "n/a"} ` +
      `latency=${report.latencyMs}ms -> ${decision}`,
  );
}

/**
 * One Observation, both engines. Querying Prometheus once is what makes the
 * comparison fair: a second query would produce a different state.
 */
async function compare(observation: Awaited<ReturnType<typeof collectObservation>>): Promise<Comparison> {
  const rules = await ruleEngine.evaluate(observation);
  const { observation: _omitted, ...rulesRest } = rules;
  void _omitted;

  try {
    const jev = await jevEngine.evaluate(observation);
    const { observation: _jevObservation, ...jevRest } = jev;
    void _jevObservation;
    const report = jev.jev;
    logJev(jev.decision, report);
    return {
      observation,
      rules: rulesRest,
      jev: { ...jevRest, jev: report },
      agreement: rules.decision === jev.decision,
    };
  } catch (error) {
    // The baseline stays visible. Jev is advisory, so a failure here must not
    // hide the rule engine's answer or turn into a 503.
    const failure = toJevFailure(error);
    logJevFailure("compare", failure);
    return { observation, rules: rulesRest, jev: failure, agreement: null };
  }
}

const server = http.createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://evaluator").pathname;

  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }

  // Facts: the normalized observation, straight from Prometheus.
  if (path === "/observation") {
    void handle(res, () => collectObservation(prometheus));
    return;
  }

  // Interpretation. The shape depends on the configured engine.
  if (path === "/assessment") {
    void handle(res, async () => {
      const observation = await collectObservation(prometheus);

      if (DECISION_ENGINE === "compare") {
        return compare(observation);
      }

      const engine: DecisionEngine =
        DECISION_ENGINE === "jev" ? jevEngine : ruleEngine;
      const assessment = await engine.evaluate(observation);

      if (assessment.jev) {
        logJev(assessment.decision, assessment.jev);
      } else {
        console.log(
          `assessment ${assessment.decision} | cpu=${assessment.evidence.cpu} ` +
            `latency=${assessment.evidence.latency} errors=${assessment.evidence.errors} ` +
            `traffic=${assessment.evidence.traffic}`,
        );
      }
      return assessment;
    });
    return;
  }

  // Does not touch Prometheus on purpose: the evaluator being up says nothing
  // about whether it can currently reach the customer's Prometheus.
  if (path === "/health") {
    sendJson(res, 200, {
      status: "ok",
      engine: DECISION_ENGINE,
      jev: {
        model: OPENROUTER_JEV_MODEL,
        keyConfigured: OPENROUTER_API_KEY.trim() !== "",
        minConfidence: JEV_MIN_CONFIDENCE,
        timeoutMs: JEV_TIMEOUT_MS,
      },
    });
    return;
  }

  sendJson(res, 404, {
    error: "not found",
    endpoints: ["/assessment", "/observation", "/health"],
  });
});

server.listen(PORT, () => {
  console.log(
    `evaluator listening on :${PORT} | engine=${DECISION_ENGINE} ` +
      `prometheus=${PROMETHEUS_URL} jevModel=${OPENROUTER_JEV_MODEL} ` +
      `jevKeyConfigured=${OPENROUTER_API_KEY.trim() !== ""}`,
  );
});
