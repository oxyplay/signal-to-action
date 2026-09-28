/**
 * OpenRouter adapter for Jev, reached through the OpenRouter Decisions API.
 *
 * This is the only place that knows Jev exists. It is deliberately not a
 * provider abstraction: the project needs exactly one semantic backend, and a
 * generic layer around one implementation would be a framework in disguise.
 *
 * Jev does not generate text. It answers a typed `choice` question about a
 * `state` and returns calibrated probabilities. It does not produce reasoning,
 * explanations, or traces, so nothing in this file should be read as a source
 * of prose.
 */

const DEFAULT_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";

/** The single question asked. Jev requires the answer to be read by this name. */
const QUESTION = "operational_state";

const INSTRUCTIONS =
  "Which operational state best describes the observed service behavior? " +
  "Use all available signals together. Missing values mean the signal is unavailable, not zero.";

/**
 * The four operational states, and the definition of each.
 *
 * These describe meaning, not thresholds. Numeric thresholds stay in
 * deterministic code on purpose: encoding them here in prose would make this
 * a copy of the rule engine and the semantic comparison worthless.
 */
export const OPERATIONAL_STATES = {
  healthy:
    "Normal service behavior with no meaningful evidence of user-visible degradation or resource pressure requiring attention.",
  workload_pressure:
    "Resource pressure is present, but increased workload plausibly explains it and user-facing latency and errors remain healthy.",
  application_degradation:
    "Multiple signals indicate user-visible service degradation, such as elevated latency or errors, especially when workload does not sufficiently explain the change.",
  insufficient_evidence:
    "The available signals are missing, contradictory, or too ambiguous to confidently classify the operational state.",
} as const;

export type OperationalState = keyof typeof OPERATIONAL_STATES;

/** Only the options Jev actually returned. Missing entries are left absent. */
export type Probabilities = Partial<Record<OperationalState, number>>;

export type JevErrorKind = "config" | "timeout" | "http" | "parse" | "network";

export class JevError extends Error {
  readonly kind: JevErrorKind;
  readonly status?: number;

  constructor(kind: JevErrorKind, message: string, status?: number) {
    super(message);
    this.name = "JevError";
    this.kind = kind;
    this.status = status;
  }
}

export type JevUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  /** USD, only present when OpenRouter reports it. */
  cost: number | null;
};

/** The model output, preserved as returned. Nothing here is inferred. */
export type JevClassification = {
  choice: OperationalState;
  probabilities: Probabilities;
  confidence: number | null;
  model: string | null;
  requestId: string | null;
  provider: string | null;
  usage: JevUsage | null;
};

export type JevResult = JevClassification & {
  latencyMs: number;
};

/** The normalized operational state handed to Jev. Mirrors the Observation. */
export type JevState = {
  cpuUtilization: number | null;
  p95LatencyMs: number | null;
  errorRate: number | null;
  requestRate: number | null;
  previousRequestRate: number | null;
  /** requestRate relative to the previous window, computed locally. */
  trafficRatio: number | null;
  observationWindowSeconds: number;
  collectedAt: string;
  missingSignals: string[];
};

type ChoiceRequest = {
  model: string;
  state: JevState;
  questions: Record<string, { type: "choice"; instructions: string; criteria: Record<string, string> }>;
};

type RawChoiceAnswer = {
  type?: unknown;
  choice?: unknown;
  probabilities?: unknown;
  confidence?: unknown;
};

type RawDecisionsResponse = {
  answers?: Record<string, RawChoiceAnswer | undefined>;
  id?: unknown;
  model?: unknown;
  provider?: unknown;
  usage?: { cost?: unknown; input_tokens?: unknown; output_tokens?: unknown };
  error?: { code?: unknown; message?: unknown };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isOperationalState = (value: string): value is OperationalState =>
  Object.hasOwn(OPERATIONAL_STATES, value);

/** Reads probabilities by option name. Position and key order are ignored. */
function readProbabilities(raw: unknown): Probabilities {
  if (!isRecord(raw)) return {};
  const probabilities: Probabilities = {};
  for (const [name, value] of Object.entries(raw)) {
    if (isOperationalState(name) && typeof value === "number" && Number.isFinite(value)) {
      probabilities[name] = value;
    }
  }
  return probabilities;
}

function readNumber(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function readString(raw: unknown): string | null {
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

export class JevClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly endpoint: string;

  constructor(options: {
    apiKey: string;
    model: string;
    timeoutMs: number;
    /** Override only for testing or proxying. Defaults to OpenRouter. */
    endpoint?: string;
  }) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs;
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  }

  private requireApiKey(): void {
    if (this.apiKey.trim() === "") {
      throw new JevError(
        "config",
        "OPENROUTER_API_KEY is not set. It is only required when DECISION_ENGINE is jev or compare.",
      );
    }
  }

  /**
   * One attempt, no retries. For an interactive decision layer, retrying hides
   * the latency and failure behaviour that matters when reading the numbers.
   */
  async classify(state: JevState): Promise<JevResult> {
    this.requireApiKey();

    const payload: ChoiceRequest = {
      model: this.model,
      state,
      questions: {
        [QUESTION]: {
          type: "choice",
          instructions: INSTRUCTIONS,
          criteria: { ...OPERATIONAL_STATES },
        },
      },
    };

    const startedAt = Date.now();
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const isTimeout = error instanceof Error && error.name === "TimeoutError";
      // The key is never part of a message or a log line.
      throw new JevError(
        isTimeout ? "timeout" : "network",
        isTimeout
          ? `Jev did not respond within ${this.timeoutMs}ms`
          : `Could not reach OpenRouter: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const latencyMs = Date.now() - startedAt;

    let body: RawDecisionsResponse;
    try {
      body = (await response.json()) as RawDecisionsResponse;
    } catch {
      throw new JevError("parse", `OpenRouter returned a non-JSON body (HTTP ${response.status})`, response.status);
    }

    if (!response.ok) {
      const message = readString(body.error?.message) ?? `HTTP ${response.status}`;
      throw new JevError("http", `OpenRouter rejected the request: ${message}`, response.status);
    }

    const answer = body.answers?.[QUESTION];
    if (!isRecord(answer)) {
      throw new JevError("parse", `OpenRouter response contained no answer for "${QUESTION}"`);
    }
    if (answer.type !== "choice") {
      throw new JevError("parse", `Expected a choice answer, got ${String(answer.type)}`);
    }

    const choice = readString(answer.choice);
    if (choice === null) {
      throw new JevError("parse", "Choice answer contained no choice");
    }
    if (!isOperationalState(choice)) {
      throw new JevError("parse", `Jev returned an unknown operational state: ${choice}`);
    }

    const usage = body.usage;

    return {
      choice,
      probabilities: readProbabilities(answer.probabilities),
      // confidence and probabilities are both optional in the API schema, so
      // neither is assumed to be present.
      confidence: readNumber(answer.confidence),
      model: readString(body.model),
      requestId: readString(body.id),
      provider: readString(body.provider),
      usage: usage
        ? {
            inputTokens: readNumber(usage.input_tokens),
            outputTokens: readNumber(usage.output_tokens),
            cost: readNumber(usage.cost),
          }
        : null,
      latencyMs,
    };
  }
}
