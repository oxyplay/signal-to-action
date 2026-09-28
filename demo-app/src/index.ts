import http from "node:http";
import os from "node:os";
import { Worker } from "node:worker_threads";
import {
  collectDefaultMetrics,
  Counter,
  Histogram,
  register,
} from "@prometheus-io/client";

const PORT = Number(process.env.PORT ?? 3000);

collectDefaultMetrics({ register });

const httpRequestsTotal = new Counter({
  name: "http_requests_total",
  help: "Total HTTP requests handled by the demo app",
  labelNames: ["method", "route", "status"],
});

const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 1.5, 2, 3, 5, 10],
});

// Runs in a worker thread so the event loop keeps serving /metrics while the
// host CPU is saturated. node_exporter reports host-wide CPU, so a busy node
// is what makes the CPU signal rise in this demo.
const CPU_BURN_SOURCE = `
  const { workerData, parentPort } = require("node:worker_threads");
  const deadline = Date.now() + workerData.durationMs;
  let sink = 0;
  while (Date.now() < deadline) {
    for (let i = 0; i < 1e6; i += 1) sink += Math.sqrt(i);
  }
  parentPort.postMessage(sink);
`;

type Reply = {
  status: number;
  payload: string;
  contentType: string;
  delayMs: number;
};

function jsonReply(status: number, value: unknown): Reply {
  return {
    status,
    payload: JSON.stringify(value),
    contentType: "application/json",
    delayMs: 0,
  };
}

function delayed(reply: Reply, delayMs: number): Reply {
  return { ...reply, delayMs };
}

function boundedMs(raw: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number(raw);
  if (raw === null || !Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

// "/work?ms=1" and "/work" both count as the same route, otherwise the
// duration of a request would fragment the label space.
function routeOf(pathname: string): string {
  if (pathname === "/work") return "/work";
  if (pathname === "/slow") return "/slow";
  if (pathname === "/error") return "/error";
  if (pathname === "/metrics") return "/metrics";
  if (pathname === "/health") return "/health";
  if (pathname === "/") return "/";
  return "other";
}

function burnCpu(durationMs: number, threads: number): Promise<number> {
  const started: Promise<number>[] = [];
  for (let i = 0; i < threads; i += 1) {
    const worker = new Worker(CPU_BURN_SOURCE, {
      eval: true,
      workerData: { durationMs },
    });
    started.push(
      new Promise<number>((resolve, reject) => {
        worker.once("message", (result: number) => resolve(result));
        worker.once("error", reject);
      }),
    );
  }
  return Promise.all(started).then((results) => results.reduce((sum, n) => sum + n, 0));
}

async function routeReply(url: URL): Promise<Reply> {
  const { pathname } = url;

  if (pathname === "/") {
    return jsonReply(200, { service: "demo-app", status: "ok" });
  }

  if (pathname === "/health") {
    return jsonReply(200, { status: "ok" });
  }

  if (pathname === "/work") {
    const durationMs = boundedMs(url.searchParams.get("ms"), 10_000, 100, 300_000);
    const requested = Number(url.searchParams.get("threads"));
    const threads = Number.isFinite(requested) && requested > 0
      ? Math.floor(requested)
      : os.availableParallelism();
    const result = await burnCpu(durationMs, threads);
    return jsonReply(200, { worked: true, durationMs, threads, checksum: result });
  }

  if (pathname === "/slow") {
    const delayMs = boundedMs(url.searchParams.get("ms"), 1_500, 100, 30_000);
    return delayed(jsonReply(200, { slow: true, waitedMs: delayMs }), delayMs);
  }

  if (pathname === "/error") {
    // Errors can also be slow. A service that hangs and then fails produces
    // high latency and high error rate from the same requests, which is the
    // shape of real degradation.
    const delayMs = boundedMs(url.searchParams.get("ms"), 0, 0, 30_000);
    return delayed(jsonReply(500, { error: "intentional failure" }), delayMs);
  }

  if (pathname === "/metrics") {
    const payload = await register.metrics();
    return { status: 200, payload, contentType: register.contentType, delayMs: 0 };
  }

  return jsonReply(404, { error: "not found" });
}

const server = http.createServer((req, res) => {
  const startedAt = process.hrtime.bigint();
  const url = new URL(req.url ?? "/", "http://demo-app");
  const route = routeOf(url.pathname);
  const method = req.method ?? "GET";

  const respond = (reply: Reply): void => {
    const send = (): void => {
      const elapsedSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      const labels = { method, route, status: String(reply.status) };
      httpRequestsTotal.inc(labels);
      httpRequestDuration.observe(labels, elapsedSeconds);
      res.writeHead(reply.status, { "content-type": reply.contentType });
      res.end(reply.payload);
    };

    if (reply.delayMs > 0) {
      setTimeout(send, reply.delayMs);
      return;
    }
    send();
  };

  routeReply(url).then(respond, (error: unknown) => {
    respond(jsonReply(500, { error: error instanceof Error ? error.message : "unknown error" }));
  });
});

server.listen(PORT, () => {
  console.log(`demo-app listening on :${PORT} (${os.availableParallelism()} CPUs available)`);
});
