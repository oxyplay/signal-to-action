/**
 * Benchmark data model and metric computation.
 *
 * Three concepts are kept deliberately separate everywhere:
 *
 *   1. classification   application_degradation  (what Jev picked)
 *   2. confidence       0.41                      (how sure it was, or the gap to the runner-up)
 *   3. policy decision  OBSERVE                   (what the deterministic gate did about it)
 *
 * "Jev decided OBSERVE" is never reported, because it is not what happened.
 *
 * No statistics library. The arithmetic here is the whole method.
 */

import { applyPolicy, resolveConfidence, type ConfidenceSource } from "./decision.js";
import { OPERATIONAL_STATES, type OperationalState } from "./jev.js";
import type { Decision, Observation } from "./types.js";

export const BENCHMARK_VERSION = "1";
export const CRITERIA_VERSION = "1";

export type CaseSpec = {
  name: string;
  category: string;
  family?: string;
  familyOrder?: number;
  expectedOperationalState: OperationalState;
  expectedDecision: Decision;
  note: string;
  observation: Omit<Observation, "collectedAt">;
};

/** One Jev invocation. A failure is still a run, and is never discarded. */
export type RawRun = {
  run: number;
  choice: OperationalState | null;
  probabilities: Record<string, number> | null;
  topProbability: number | null;
  secondProbability: number | null;
  probabilityMargin: number | null;
  confidence: number | null;
  confidenceSource: ConfidenceSource | null;
  effectiveConfidence: number | null;
  policyDecision: Decision | null;
  correctClassification: boolean | null;
  correctPolicy: boolean | null;
  lowConfidence: boolean | null;
  latencyMs: number | null;
  cost: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  model: string | null;
  requestId: string | null;
  error: { kind: string; message: string } | null;
};

export type RawCaseResult = {
  name: string;
  category: string;
  family: string | null;
  familyOrder: number | null;
  expectedOperationalState: OperationalState;
  expectedDecision: Decision;
  note: string;
  observation: Observation;
  rules: { decision: Decision; summary: string };
  runs: RawRun[];
};

export type BenchmarkResult = {
  benchmarkVersion: string;
  criteriaVersion: string;
  generatedAt: string;
  modelRequested: string;
  modelsReturned: string[];
  /** Frozen copy of the criteria the run used, so results stay interpretable. */
  criteria: Record<string, string>;
  minConfidence: number;
  timeoutMs: number;
  runsPerCase: number;
  caseCount: number;
  plannedCalls: number;
  totalCalls: number;
  rulesOnly: boolean;
  cases: RawCaseResult[];
};

/** Severity order for spotting boundary reversals. insufficient_evidence is off-scale. */
const SEVERITY: Record<string, number> = {
  healthy: 0,
  workload_pressure: 1,
  application_degradation: 2,
};

export function recordRun(input: {
  case: CaseSpec;
  run: number;
  minConfidence: number;
  result: {
    choice: OperationalState;
    probabilities: Record<string, number>;
    confidence: number | null;
    latencyMs: number;
    model: string | null;
    requestId: string | null;
    cost: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
  } | null;
  error: { kind: string; message: string } | null;
}): RawRun {
  const { case: spec, run, minConfidence, result, error } = input;

  if (result === null) {
    return {
      run,
      choice: null,
      probabilities: null,
      topProbability: null,
      secondProbability: null,
      probabilityMargin: null,
      confidence: null,
      confidenceSource: null,
      effectiveConfidence: null,
      policyDecision: null,
      correctClassification: null,
      correctPolicy: null,
      lowConfidence: null,
      latencyMs: null,
      cost: null,
      inputTokens: null,
      outputTokens: null,
      model: null,
      requestId: null,
      error,
    };
  }

  const ordered = Object.entries(result.probabilities)
    .map(([name, value]) => [name, value] as [string, number])
    .sort((a, b) => b[1] - a[1]);
  const top = ordered[0]?.[1] ?? null;
  const second = ordered.length > 1 ? (ordered[1][1] as number) : null;

  const { value: effectiveConfidence, source } = resolveConfidence({
    confidence: result.confidence,
    probabilities: result.probabilities as never,
    choice: result.choice,
  });

  const policyDecision = applyPolicy(result.choice, effectiveConfidence, minConfidence);
  const lowConfidence = effectiveConfidence === null || effectiveConfidence < minConfidence;

  return {
    run,
    choice: result.choice,
    probabilities: result.probabilities,
    topProbability: top,
    secondProbability: second,
    probabilityMargin: top !== null && second !== null ? top - second : null,
    confidence: result.confidence,
    confidenceSource: source,
    effectiveConfidence,
    policyDecision,
    correctClassification: result.choice === spec.expectedOperationalState,
    correctPolicy: policyDecision === spec.expectedDecision,
    lowConfidence,
    latencyMs: result.latencyMs,
    cost: result.cost,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    model: result.model,
    requestId: result.requestId,
    error: null,
  };
}

export function frozenCriteria(): Record<string, string> {
  return { ...OPERATIONAL_STATES };
}

export type ThresholdMetrics = {
  threshold: number;
  calls: number;
  successful: number;
  classificationAccuracy: number | null;
  policyAccuracy: number | null;
  coverage: number;
  abstentionRate: number;
  acceptedCount: number;
  acceptedClassificationAccuracy: number | null;
  falseEscalations: number;
  missedDegradations: number;
};

export type CaseStability = {
  name: string;
  category: string;
  successful: number;
  failed: number;
  consistency: number | null;
  flipRate: number | null;
  distribution: Record<string, number>;
  modal: string | null;
  expected: OperationalState;
};

export type LatencyStats = {
  count: number;
  min: number | null;
  p50: number | null;
  p90: number | null;
  p95: number | null;
  max: number | null;
  mean: number | null;
};

export type CostStats = {
  callsWithCost: number;
  callsMissingCost: number;
  total: number | null;
  perCall: number | null;
  perCase: number | null;
  projectedPerThousandDecisions: number | null;
};

export type BoundaryStep = {
  order: number;
  name: string;
  expected: string;
  expectedDecision: Decision;
  modal: string | null;
  consistency: number | null;
  rulesDecision: Decision;
  isReversal: boolean;
};

export type BoundaryFamily = {
  family: string;
  steps: BoundaryStep[];
  reversals: string[];
};

export type Metrics = {
  totalCalls: number;
  successful: number;
  failed: number;
  timeouts: number;
  errorKinds: Record<string, number>;

  rulesPolicyAccuracy: number | null;
  rulesCorrect: number;
  rulesFalseEscalations: number;
  rulesMissedDegradations: number;

  classificationAccuracy: number | null;
  policyAccuracy: number | null;
  coverage: number;
  abstentionRate: number;
  acceptedClassificationAccuracy: number | null;
  falseEscalations: number;
  missedDegradations: number;

  meanConsistency: number | null;
  casesWithFlips: number;
  casesFullyStable: number;
  stability: CaseStability[];

  confidenceSources: Record<string, number>;
  meanMargin: number | null;
  lowMarginCalls: number;
  lowMarginCount: number;
  lowConfidenceRateLowMargin: number | null;
  lowConfidenceRateHighMargin: number | null;

  missingDataClassificationAccuracy: number | null;
  missingDataPolicyAccuracy: number | null;
  insufficientEvidenceDetectionRate: number | null;

  ambiguousClassificationAccuracy: number | null;
  ambiguousPolicyAccuracy: number | null;

  latency: LatencyStats;
  cost: CostStats;

  policyParityMismatches: number;
  thresholds: ThresholdMetrics[];
  boundaries: BoundaryFamily[];
  categoryCounts: Record<string, number>;
};

export const DEFAULT_THRESHOLDS = [0, 0.25, 0.4, 0.5, 0.6, 0.65, 0.7, 0.8, 0.9];

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function round(value: number | null, places = 4): number | null {
  return value === null ? null : Number(value.toFixed(places));
}

export function percentile(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] as number;
}

function isEscalation(expected: Decision, actual: Decision): boolean {
  return (expected === "HEALTHY" || expected === "OBSERVE") && actual === "INVESTIGATE";
}

function isMissedDegradation(expected: Decision, actual: Decision): boolean {
  return expected === "INVESTIGATE" && (actual === "HEALTHY" || actual === "OBSERVE");
}

/** Recomputes the policy at an arbitrary threshold from one stored set of runs. */
function metricsAtThreshold(
  result: BenchmarkResult,
  threshold: number,
): ThresholdMetrics {
  let successful = 0;
  let classificationCorrect = 0;
  let policyCorrect = 0;
  let accepted = 0;
  let acceptedCorrect = 0;
  let falseEscalations = 0;
  let missedDegradations = 0;
  let totalCalls = 0;

  for (const testCase of result.cases) {
    for (const run of testCase.runs) {
      totalCalls += 1;
      if (run.choice === null || run.effectiveConfidence === undefined) continue;
      successful += 1;

      if (run.choice === testCase.expectedOperationalState) classificationCorrect += 1;

      const decision = applyPolicy(run.choice, run.effectiveConfidence ?? null, threshold);
      if (decision === testCase.expectedDecision) policyCorrect += 1;
      if (isEscalation(testCase.expectedDecision, decision)) falseEscalations += 1;
      if (isMissedDegradation(testCase.expectedDecision, decision)) missedDegradations += 1;

      const acceptedHere = (run.effectiveConfidence ?? null) !== null
        && (run.effectiveConfidence as number) >= threshold;
      if (acceptedHere) {
        accepted += 1;
        if (run.choice === testCase.expectedOperationalState) acceptedCorrect += 1;
      }
    }
  }

  return {
    threshold,
    calls: totalCalls,
    successful,
    classificationAccuracy: round(ratio(classificationCorrect, successful)),
    policyAccuracy: round(ratio(policyCorrect, successful)),
    coverage: round(ratio(accepted, successful)) ?? 0,
    abstentionRate: round(ratio(successful - accepted, successful)) ?? 0,
    acceptedCount: accepted,
    acceptedClassificationAccuracy: round(ratio(acceptedCorrect, accepted)),
    falseEscalations,
    missedDegradations,
  };
}

function stabilityOf(testCase: RawCaseResult): CaseStability {
  const successfulRuns = testCase.runs.filter((run) => run.choice !== null);
  const distribution: Record<string, number> = {};
  for (const run of successfulRuns) {
    distribution[run.choice as string] = (distribution[run.choice as string] ?? 0) + 1;
  }
  const modal = Object.entries(distribution).sort((a, b) => b[1] - a[1])[0];
  return {
    name: testCase.name,
    category: testCase.category,
    successful: successfulRuns.length,
    failed: testCase.runs.length - successfulRuns.length,
    consistency: ratio(modal?.[1] ?? 0, successfulRuns.length),
    flipRate: ratio((successfulRuns.length - (modal?.[1] ?? 0)), successfulRuns.length),
    distribution,
    modal: modal?.[0] ?? null,
    expected: testCase.expectedOperationalState,
  };
}

function boundariesOf(result: BenchmarkResult, stability: CaseStability[]): BoundaryFamily[] {
  const byName = new Map(stability.map((entry) => [entry.name, entry]));
  const families = new Map<string, RawCaseResult[]>();

  for (const testCase of result.cases) {
    if (!testCase.family) continue;
    const list = families.get(testCase.family) ?? [];
    list.push(testCase);
    families.set(testCase.family, list);
  }

  return [...families.entries()].map(([family, list]) => {
    const sorted = [...list].sort(
      (a, b) => (a.familyOrder ?? 0) - (b.familyOrder ?? 0),
    );

    let previousSeverity: number | null = null;
    const steps: BoundaryStep[] = sorted.map((testCase) => {
      const entry = byName.get(testCase.name);
      const modalSeverity = entry?.modal ? (SEVERITY[entry.modal] ?? null) : null;
      // A reversal is a drop in severity as the swept input gets worse.
      const isReversal =
        modalSeverity !== null &&
        previousSeverity !== null &&
        modalSeverity < previousSeverity;
      if (modalSeverity !== null) previousSeverity = modalSeverity;
      return {
        order: testCase.familyOrder ?? 0,
        name: testCase.name,
        expected: testCase.expectedOperationalState,
        expectedDecision: testCase.expectedDecision,
        modal: entry?.modal ?? null,
        consistency: entry?.consistency ?? null,
        rulesDecision: testCase.rules.decision,
        isReversal,
      };
    });

    return { family, steps, reversals: steps.filter((s) => s.isReversal).map((s) => s.name) };
  });
}

export function computeMetrics(
  result: BenchmarkResult,
  thresholds: number[] = DEFAULT_THRESHOLDS,
): Metrics {
  const allRuns = result.cases.flatMap((testCase) => testCase.runs);
  const successfulRuns = allRuns.filter((run) => run.choice !== null);
  const failedRuns = allRuns.filter((run) => run.choice === null);

  const errorKinds: Record<string, number> = {};
  for (const run of failedRuns) {
    const kind = run.error?.kind ?? "unknown";
    errorKinds[kind] = (errorKinds[kind] ?? 0) + 1;
  }

  // Rules run once per case because they are deterministic.
  let rulesCorrect = 0;
  let rulesFalseEscalations = 0;
  let rulesMissed = 0;
  for (const testCase of result.cases) {
    if (testCase.rules.decision === testCase.expectedDecision) rulesCorrect += 1;
    if (isEscalation(testCase.expectedDecision, testCase.rules.decision)) rulesFalseEscalations += 1;
    if (isMissedDegradation(testCase.expectedDecision, testCase.rules.decision)) rulesMissed += 1;
  }

  const atMinConfidence = metricsAtThreshold(result, result.minConfidence);

  const stability = result.cases.map(stabilityOf);
  const usable = stability.filter((entry) => entry.consistency !== null);
  const meanConsistency =
    usable.length === 0
      ? null
      : usable.reduce((sum, entry) => sum + (entry.consistency as number), 0) / usable.length;

  const confidenceSources: Record<string, number> = {};
  for (const run of successfulRuns) {
    const source = run.confidenceSource ?? "unknown";
    confidenceSources[source] = (confidenceSources[source] ?? 0) + 1;
  }

  const marginRuns = successfulRuns.filter((run) => run.probabilityMargin !== null);
  const lowMargin = marginRuns.filter((run) => (run.probabilityMargin as number) < 0.1);
  const highMargin = marginRuns.filter((run) => (run.probabilityMargin as number) >= 0.1);
  const lowConfidenceRate = (runs: RawRun[]): number | null =>
    ratio(
      runs.filter((run) => run.lowConfidence === true).length,
      runs.length,
    );

  const missingCases = result.cases.filter((c) => c.category === "missing-data");
  const missingRuns = missingCases.flatMap((c) => c.runs).filter((run) => run.choice !== null);
  const ambiguousCases = result.cases.filter((c) => c.category === "ambiguous");
  const ambiguousRuns = ambiguousCases.flatMap((c) => c.runs).filter((run) => run.choice !== null);

  const latencies = successfulRuns
    .map((run) => run.latencyMs)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  const costs = successfulRuns
    .map((run) => run.cost)
    .filter((value): value is number => value !== null);
  const totalCost = costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : null;

  // The offline threshold sweep must reproduce what the running service did at
  // the configured gate. If it ever disagrees, the benchmark is not measuring
  // the real policy.
  const storedAtMin = successfulRuns.filter(
    (run) => run.lowConfidence !== null && run.policyDecision !== null,
  ).length;
  const policyParityMismatches = atMinConfidence.policyAccuracy === null
    ? 0
    : countPolicyMismatches(result, storedAtMin);

  const categoryCounts: Record<string, number> = {};
  for (const testCase of result.cases) {
    categoryCounts[testCase.category] = (categoryCounts[testCase.category] ?? 0) + 1;
  }

  return {
    totalCalls: allRuns.length,
    successful: successfulRuns.length,
    failed: failedRuns.length,
    timeouts: errorKinds.timeout ?? 0,
    errorKinds,

    rulesPolicyAccuracy: round(ratio(rulesCorrect, result.cases.length)),
    rulesCorrect,
    rulesFalseEscalations,
    rulesMissedDegradations: rulesMissed,

    classificationAccuracy: atMinConfidence.classificationAccuracy,
    policyAccuracy: atMinConfidence.policyAccuracy,
    coverage: atMinConfidence.coverage,
    abstentionRate: atMinConfidence.abstentionRate,
    acceptedClassificationAccuracy: atMinConfidence.acceptedClassificationAccuracy,
    falseEscalations: atMinConfidence.falseEscalations,
    missedDegradations: atMinConfidence.missedDegradations,

    meanConsistency: round(meanConsistency),
    casesWithFlips: usable.filter((entry) => (entry.consistency ?? 1) < 1).length,
    casesFullyStable: usable.filter((entry) => entry.consistency === 1).length,
    stability,

    confidenceSources,
    meanMargin: round(
      marginRuns.length === 0
        ? null
        : marginRuns.reduce((sum, run) => sum + (run.probabilityMargin as number), 0) / marginRuns.length,
    ),
    lowMarginCalls: lowMargin.length,
    lowMarginCount: marginRuns.length,
    lowConfidenceRateLowMargin: round(lowConfidenceRate(lowMargin)),
    lowConfidenceRateHighMargin: round(lowConfidenceRate(highMargin)),

    missingDataClassificationAccuracy: round(
      ratio(
        missingRuns.filter((run) => run.correctClassification === true).length,
        missingRuns.length,
      ),
    ),
    missingDataPolicyAccuracy: round(
      ratio(missingRuns.filter((run) => run.correctPolicy === true).length, missingRuns.length),
    ),
    insufficientEvidenceDetectionRate: round(
      ratio(
        missingRuns.filter((run) => run.choice === "insufficient_evidence").length,
        missingRuns.length,
      ),
    ),

    ambiguousClassificationAccuracy: round(
      ratio(
        ambiguousRuns.filter((run) => run.correctClassification === true).length,
        ambiguousRuns.length,
      ),
    ),
    ambiguousPolicyAccuracy: round(
      ratio(ambiguousRuns.filter((run) => run.correctPolicy === true).length, ambiguousRuns.length),
    ),

    latency: {
      count: latencies.length,
      min: latencies[0] ?? null,
      p50: percentile(latencies, 0.5),
      p90: percentile(latencies, 0.9),
      p95: percentile(latencies, 0.95),
      max: latencies[latencies.length - 1] ?? null,
      mean:
        latencies.length === 0
          ? null
          : round(latencies.reduce((a, b) => a + b, 0) / latencies.length, 1),
    },
    cost: {
      callsWithCost: costs.length,
      callsMissingCost: successfulRuns.length - costs.length,
      total: totalCost === null ? null : Number(totalCost.toFixed(8)),
      perCall: totalCost === null ? null : Number((totalCost / costs.length).toFixed(8)),
      perCase:
        totalCost === null || result.cases.length === 0
          ? null
          : Number((totalCost / result.cases.length).toFixed(8)),
      projectedPerThousandDecisions:
        totalCost === null || costs.length === 0
          ? null
          : Number(((totalCost / costs.length) * 1000).toFixed(4)),
    },

    policyParityMismatches,
    thresholds: thresholds.map((threshold) => metricsAtThreshold(result, threshold)),
    boundaries: boundariesOf(result, stability),
    categoryCounts,
  };
}

function countPolicyMismatches(result: BenchmarkResult, _storedAtMin: number): number {
  let mismatches = 0;
  for (const testCase of result.cases) {
    for (const run of testCase.runs) {
      if (run.choice === null) continue;
      const recomputed = applyPolicy(
        run.choice,
        run.effectiveConfidence,
        result.minConfidence,
      );
      if (recomputed !== run.policyDecision) mismatches += 1;
    }
  }
  return mismatches;
}
