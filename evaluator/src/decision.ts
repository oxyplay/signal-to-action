import type {
  Assessment,
  Decision,
  DecisionEngine,
  Evidence,
  JevReport,
  Observation,
  SignalLevel,
} from "./types.js";
import { JevClient, type JevState, type OperationalState, type Probabilities } from "./jev.js";

/**
 * Operational policy. Deterministic on purpose: Jev classifies the situation,
 * the application decides what to do about it.
 */
export const POLICY: Record<OperationalState, Decision> = {
  healthy: "HEALTHY",
  workload_pressure: "OBSERVE",
  application_degradation: "INVESTIGATE",
  insufficient_evidence: "OBSERVE",
};

export type ConfidenceSource = "confidence" | "selected_probability" | "missing";

/**
 * OpenRouter may omit `confidence`. When it does, the selected option's own
 * probability is used instead, and the source is recorded rather than merged
 * with a real confidence value.
 */
export function resolveConfidence(result: {
  confidence: number | null;
  probabilities: Probabilities;
  choice: OperationalState;
}): { value: number | null; source: ConfidenceSource } {
  if (result.confidence !== null) return { value: result.confidence, source: "confidence" };
  const fromProbability = result.probabilities[result.choice];
  if (typeof fromProbability === "number") {
    return { value: fromProbability, source: "selected_probability" };
  }
  return { value: null, source: "missing" };
}

/** The single place where a classification becomes an operational decision. */
export function applyPolicy(
  choice: OperationalState,
  confidence: number | null,
  minConfidence: number,
): Decision {
  return confidence === null || confidence < minConfidence ? "OBSERVE" : POLICY[choice];
}

/**
 * Thresholds for the demo service.
 *
 * In a customer deployment these would come from a per-service policy rather
 * than from constants in the code. They are grouped here so the decision logic
 * below stays readable.
 */
export const THRESHOLDS = {
  // The demo burns every available core on purpose, so the "high" line sits
  // below 100% to survive a partially idle node.
  cpuUtilizationHigh: 0.8,
  p95LatencyHighMs: 2_000,
  errorRateHigh: 0.05,
  // How much request volume must grow before traffic counts as an explanation.
  trafficChangeRatio: 1.5,
} as const;

const asPercent = (ratio: number): string => `${Math.round(ratio * 100)}%`;

const asMs = (ms: number): string => `${Math.round(ms)} ms`;

const asRate = (perSecond: number): string => `${perSecond.toFixed(1)} req/s`;

const isHigh = (value: number | null, limit: number): SignalLevel =>
  value === null ? "unknown" : value >= limit ? "high" : "normal";

function readTraffic(observation: Observation): SignalLevel {
  const { requestRate, previousRequestRate } = observation;
  if (requestRate === null || previousRequestRate === null) return "unknown";
  if (previousRequestRate === 0) return requestRate > 0 ? "elevated" : "normal";
  return requestRate >= previousRequestRate * THRESHOLDS.trafficChangeRatio
    ? "elevated"
    : "normal";
}

export function readEvidence(observation: Observation): Evidence {
  return {
    cpu: isHigh(observation.cpuUtilization, THRESHOLDS.cpuUtilizationHigh),
    latency: isHigh(observation.p95LatencyMs, THRESHOLDS.p95LatencyHighMs),
    errors: isHigh(observation.errorRate, THRESHOLDS.errorRateHigh),
    traffic: readTraffic(observation),
  };
}

function describeCpu(observation: Observation, level: SignalLevel): string {
  if (observation.cpuUtilization === null) return "CPU utilization is unavailable";
  return `CPU utilization is ${asPercent(observation.cpuUtilization)} (${level}, threshold ${asPercent(THRESHOLDS.cpuUtilizationHigh)})`;
}

function describeLatency(observation: Observation, level: SignalLevel): string {
  if (observation.p95LatencyMs === null) return "p95 latency is unavailable";
  return `p95 latency is ${asMs(observation.p95LatencyMs)} (${level}, threshold ${asMs(THRESHOLDS.p95LatencyHighMs)})`;
}

function describeErrors(observation: Observation, level: SignalLevel): string {
  if (observation.errorRate === null) return "error rate is unavailable";
  return `error rate is ${asPercent(observation.errorRate)} (${level}, threshold ${asPercent(THRESHOLDS.errorRateHigh)})`;
}

function describeTraffic(observation: Observation, level: SignalLevel): string {
  const { requestRate, previousRequestRate, observationWindowSeconds: seconds } = observation;
  if (requestRate === null) return "Request rate is unavailable";
  if (previousRequestRate === null) {
    return `Request rate is ${asRate(requestRate)} but the preceding ${seconds}s window is unavailable, so the change cannot be measured`;
  }
  if (previousRequestRate === 0) {
    return requestRate > 0
      ? `Request rate rose from 0 req/s to ${asRate(requestRate)} over the last ${seconds}s (elevated)`
      : "Request rate is 0 req/s and was 0 req/s in the preceding window (normal)";
  }
  const change = (requestRate / previousRequestRate).toFixed(1);
  return `Request rate is ${asRate(requestRate)}, ${change}x the preceding ${seconds}s window of ${asRate(previousRequestRate)} (${level})`;
}

/** One line per signal, with the number and the level that produced it. */
function describeSignals(observation: Observation, evidence: Evidence): string[] {
  return [
    describeCpu(observation, evidence.cpu),
    describeLatency(observation, evidence.latency),
    describeErrors(observation, evidence.errors),
    describeTraffic(observation, evidence.traffic),
  ];
}

function missingSignals(evidence: Evidence): string[] {
  return (Object.keys(evidence) as Array<keyof Evidence>).filter(
    (signal) => evidence[signal] === "unknown",
  );
}

/**
 * The state handed to Jev.
 *
 * Normalized measurements are passed through unchanged, including nulls, so an
 * unavailable signal stays visibly unavailable instead of becoming a zero. The
 * traffic ratio is computed here rather than asked of Jev, because arithmetic
 * is not the model's job.
 */
export function buildJevState(observation: Observation): JevState {
  const { requestRate, previousRequestRate } = observation;
  const trafficRatio =
    requestRate === null || previousRequestRate === null || previousRequestRate === 0
      ? null
      : requestRate / previousRequestRate;

  const missingSignals: string[] = [];
  if (observation.cpuUtilization === null) missingSignals.push("cpuUtilization");
  if (observation.p95LatencyMs === null) missingSignals.push("p95LatencyMs");
  if (observation.errorRate === null) missingSignals.push("errorRate");
  if (observation.requestRate === null) missingSignals.push("requestRate");
  if (observation.previousRequestRate === null) missingSignals.push("previousRequestRate");

  return {
    cpuUtilization: observation.cpuUtilization,
    p95LatencyMs: observation.p95LatencyMs,
    errorRate: observation.errorRate,
    requestRate,
    previousRequestRate,
    trafficRatio,
    observationWindowSeconds: observation.observationWindowSeconds,
    collectedAt: observation.collectedAt,
    missingSignals,
  };
}

/**
 * Deterministic baseline used by the demo.
 *
 * The purpose is not to be a general rules engine. It is to make the pipeline
 * testable without a semantic backend, and to give a later Jev engine
 * something concrete to be compared against.
 */
export class RuleBasedDecisionEngine implements DecisionEngine {
  async evaluate(observation: Observation): Promise<Assessment> {
    const evidence = readEvidence(observation);
    const facts = describeSignals(observation, evidence);

    // User-visible degradation is decisive on its own. A missing signal must
    // not downgrade evidence that latency or errors are already bad.
    if (evidence.latency === "high" || evidence.errors === "high") {
      const trafficContributes = evidence.traffic === "elevated";
      return {
        decision: "INVESTIGATE",
        summary: "Possible application degradation",
        reasoning: [
          ...facts,
          trafficContributes
            ? "Request volume is elevated and may be contributing, but latency and errors show user-visible degradation."
            : "Request volume does not explain the change, so this is not simply more load.",
          "Latency and error rate together mean users are already seeing it, so an engineer should investigate.",
        ],
        evidence,
        observation,
      };
    }

    const missing = missingSignals(evidence);
    if (missing.length > 0) {
      return {
        decision: "OBSERVE",
        summary: "Insufficient data for a confident assessment",
        reasoning: [
          ...facts,
          `No data for ${missing.join(", ")}. An unavailable signal is not treated as a healthy one.`,
          "Collect more data before drawing a conclusion from this state.",
        ],
        evidence,
        observation,
      };
    }

    if (evidence.cpu === "high" && evidence.traffic === "elevated") {
      return {
        decision: "OBSERVE",
        summary: "Workload pressure without user-visible degradation",
        reasoning: [
          ...facts,
          "The extra load is explained by increased request volume.",
          "Latency and error rate are healthy, so there is no evidence of user-visible degradation and no immediate intervention is required.",
        ],
        evidence,
        observation,
      };
    }

    if (evidence.cpu === "high") {
      return {
        decision: "OBSERVE",
        summary: "Resource pressure that traffic does not explain",
        reasoning: [
          ...facts,
          "Latency and error rate are healthy, so there is no user-visible impact yet.",
          "The pressure is not explained by a traffic increase, so it is worth watching.",
        ],
        evidence,
        observation,
      };
    }

    if (evidence.traffic === "elevated") {
      return {
        decision: "OBSERVE",
        summary: "Traffic is increasing",
        reasoning: [
          ...facts,
          "The service is keeping up: latency and error rate are healthy.",
          "No action is required now, but a sustained increase is worth watching.",
        ],
        evidence,
        observation,
      };
    }

    return {
      decision: "HEALTHY",
      summary: "No action required",
      reasoning: [...facts, "No signal is outside its expected range."],
      evidence,
      observation,
    };
  }
}

/**
 * Where a semantic decision backend plugs in.
 *
 * Jev receives the same normalized Observation the rule engine reads and
 * returns a typed classification. It does not query Prometheus, does not
 * trigger anything, does not replace alerts, and does not write explanations.
 * Mapping its answer onto an operational decision stays here, in application
 * code, so the policy remains inspectable.
 */
export class JevDecisionEngine implements DecisionEngine {
  private readonly client: JevClient;
  private readonly minConfidence: number;

  constructor(client: JevClient, minConfidence: number) {
    this.client = client;
    this.minConfidence = minConfidence;
  }

  // Narrower than the interface on purpose: this engine always reports what
  // Jev returned, so callers never have to check for a missing report.
  async evaluate(observation: Observation): Promise<Assessment & { jev: JevReport }> {
    const evidence = readEvidence(observation);
    const facts = describeSignals(observation, evidence);
    const result = await this.client.classify(buildJevState(observation));

    // confidence and probabilities are both optional in the API. Falling back
    // to the selected option's own probability keeps the gate usable without
    // inventing a number; with neither available the classification is treated
    // as uncertain.
    const { value: effectiveConfidence, source } = resolveConfidence(result);
    const uncertain = effectiveConfidence === null || effectiveConfidence < this.minConfidence;

    const decision = applyPolicy(result.choice, effectiveConfidence, this.minConfidence);

    const reasoning = [...facts, `Jev selected ${result.choice}`];
    if (effectiveConfidence === null) {
      reasoning.push("Jev returned no confidence and no probability for the selected option");
    } else if (source === "selected_probability") {
      reasoning.push(
        `Jev classification confidence: ${effectiveConfidence} ` +
          "(Jev omitted confidence, so the selected option's probability is used)",
      );
    } else {
      reasoning.push(`Jev classification confidence: ${effectiveConfidence}`);
    }
    if (uncertain) {
      reasoning.push(
        effectiveConfidence === null
          ? `Below JEV_MIN_CONFIDENCE (${this.minConfidence}), so the selected category is not used as-is`
          : `Below JEV_MIN_CONFIDENCE (${this.minConfidence}), so the assessment is downgraded to OBSERVE`,
      );
    }
    reasoning.push(
      `Application code maps ${result.choice} to ${POLICY[result.choice]}. Jev does not choose the action.`,
    );

    return {
      decision,
      summary: uncertain
        ? "Jev classification is uncertain"
        : `Jev classified the observation as ${result.choice.replace(/_/g, " ")}`,
      reasoning,
      evidence,
      observation,
      jev: {
        ...result,
        minConfidence: this.minConfidence,
        belowMinConfidence: uncertain,
      },
    };
  }
}
