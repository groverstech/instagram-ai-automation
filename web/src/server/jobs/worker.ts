// Standalone worker for Postgres deployments: `npm run worker`.
// Not for PGlite (single-process): there the web server runs jobs in-process.
//
//   WORKER_QUEUES      which work this process takes: "jobs" (publishing, metric syncs),
//                      "ai" (strategist / creative-studio tasks), or both (default "jobs,ai").
//                      Run separate deployments per queue to scale them independently.
//   WORKER_INTERVAL_MS how often to poll (default 15000).
//
// Shutdown (SIGTERM/SIGINT, e.g. a deploy): stop claiming new work, let in-flight work finish
// (up to WORKER_DRAIN_MS, default 120000), then exit. Anything still running then is recovered by
// another worker after its heartbeat goes stale. AI steps are idempotent, and publishes are never
// re-sent automatically (see queue.ts / handlers.ts).
import { enforceConfig } from "../config";
import { tick, type TickScope } from "./handlers";
import { log } from "../log";

enforceConfig("worker");
if (!process.env.DATABASE_URL) {
  console.error("The standalone worker needs DATABASE_URL. With embedded PGlite, jobs run inside the web server.");
  process.exit(1);
}

const queues = new Set((process.env.WORKER_QUEUES ?? "jobs,ai").split(",").map((q) => q.trim()).filter(Boolean));
const unknown = [...queues].filter((q) => q !== "jobs" && q !== "ai");
if (!queues.size || unknown.length) {
  console.error(`WORKER_QUEUES must list "jobs" and/or "ai" (got: ${process.env.WORKER_QUEUES}).`);
  process.exit(1);
}
const scope: TickScope = { jobs: queues.has("jobs"), ai: queues.has("ai") };
const interval = Number(process.env.WORKER_INTERVAL_MS ?? 15_000);
const drainMs = Number(process.env.WORKER_DRAIN_MS ?? 120_000);

let stopping = false;
let current: Promise<unknown> | null = null;

async function aiInFlight() {
  if (!scope.ai) return 0;
  const { inFlightCount } = await import("./all");
  return inFlightCount();
}

async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info("worker.stopping", { signal, queues: [...queues] });
  const deadline = Date.now() + drainMs;
  await current?.catch(() => {});
  while ((await aiInFlight()) > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
  const left = await aiInFlight();
  log.info("worker.stopped", { drained: left === 0, aiTasksLeft: left });
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

async function loop() {
  log.info("worker.started", { queues: [...queues], intervalMs: interval });
  while (!stopping) {
    try {
      current = tick(scope);
      const r = (await current) as { ok: boolean }[];
      if (r.length) log.info("worker.ran", { jobs: r.length, failed: r.filter((x) => !x.ok).length });
    } catch (e) {
      log.error("worker.tick_failed", { error: e instanceof Error ? e.message : String(e) });
    } finally {
      current = null;
    }
    if (!stopping) await new Promise((r) => setTimeout(r, interval));
  }
}
loop();
