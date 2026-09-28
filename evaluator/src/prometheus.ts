/**
 * The only place that knows about the Prometheus HTTP API.
 *
 * Nothing outside this module needs to know that Prometheus answers with
 * { status, data: { resultType, result } } or that missing series come back as
 * NaN. Everything upstream sees `number | null`.
 */

type PrometheusVectorResponse = {
  status: string;
  error?: string;
  data: {
    resultType: string;
    result: Array<{ value?: [number, string] }>;
  };
};

export class PrometheusQueryError extends Error {}

export class PrometheusClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, timeoutMs: number) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
  }

  /**
   * Runs an instant query and returns the first sample, or null when the query
   * legitimately has no value. NaN and Infinity are how Prometheus encodes
   * "no data" and "divide by zero", so they are reported as null rather than
   * passed on as numbers.
   */
  async queryScalar(promql: string): Promise<number | null> {
    const url = `${this.baseUrl}/api/v1/query?query=${encodeURIComponent(promql)}`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      throw new PrometheusQueryError(
        `Prometheus returned ${response.status} for query: ${promql}`,
      );
    }

    const body = (await response.json()) as PrometheusVectorResponse;
    if (body.status !== "success") {
      throw new PrometheusQueryError(
        `Prometheus rejected query "${promql}": ${body.error ?? "unknown error"}`,
      );
    }
    if (body.data.resultType !== "vector") {
      throw new PrometheusQueryError(
        `Expected a vector from query "${promql}", got ${body.data.resultType}`,
      );
    }

    const sample = body.data.result[0]?.value?.[1];
    if (sample === undefined) return null;

    const value = Number(sample);
    return Number.isFinite(value) ? value : null;
  }

  async isReachable(): Promise<boolean> {
    try {
      await this.queryScalar("vector(1)");
      return true;
    } catch {
      return false;
    }
  }
}
