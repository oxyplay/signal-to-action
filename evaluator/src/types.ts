/**
 * The vocabulary of the decision layer.
 *
 * Observation = normalized facts collected from an existing monitoring stack.
 * Assessment  = the operational meaning a human would give those facts.
 */

import type { JevClassification, JevErrorKind, JevUsage } from "./jev.js";

export type Observation = {
  collectedAt: string;
  /** Fraction of CPU time not spent idle, 0..1. */
  cpuUtilization: number | null;
  p95LatencyMs: number | null;
  /** Failed requests as a fraction of all requests, 0..1. */
  errorRate: number | null;
  /** Requests per second over the observation window. */
  requestRate: number | null;
  /** Requests per second over the window immediately before the observation window. */
  previousRequestRate: number | null;
  observationWindowSeconds: number;
};

export type Decision = "HEALTHY" | "OBSERVE" | "INVESTIGATE";

export type SignalLevel = "high" | "elevated" | "normal" | "unknown";

export type Evidence = {
  cpu: SignalLevel;
  latency: SignalLevel;
  errors: SignalLevel;
  traffic: SignalLevel;
};

/** What Jev returned, attached to the assessment it produced. */
export type JevReport = JevClassification & {
  latencyMs: number;
  /** The threshold below which the selected category is not used as-is. */
  minConfidence: number;
  /** True when the returned confidence fell below minConfidence. */
  belowMinConfidence: boolean;
};

export type Assessment = {
  decision: Decision;
  summary: string;
  reasoning: string[];
  evidence: Evidence;
  /** Carried with the assessment so one call is enough to audit a decision. */
  observation: Observation;
  /** Present only when a semantic engine produced this assessment. */
  jev?: JevReport;
};

export type JevFailure = {
  error: string;
  kind: JevErrorKind;
};

/** Both engines read the same Observation, so results are directly comparable. */
export type Comparison = {
  observation: Observation;
  rules: Omit<Assessment, "observation">;
  jev: (Omit<Assessment, "observation"> & { jev: JevReport }) | JevFailure;
  /** null when Jev could not be reached, because nothing was actually compared. */
  agreement: boolean | null;
};

export interface DecisionEngine {
  evaluate(observation: Observation): Promise<Assessment>;
}

export type { JevUsage };
