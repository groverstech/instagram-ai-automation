/**
 * O4 (code part): a job that fails permanently is reported to the error monitor, and
 * /api/health/jobs tells an uptime monitor when the scheduler has stopped (overdue or stuck work).
 */
import { beforeEach, describe, expect, it } from "vitest";

process.env.AI_PROVIDER = "mock";
process.env.PGLITE_DIR = "memory://";
process.env.RUN_JOBS_IN_PROCESS = "false";

const SECRET = "j".repeat(24) + "-0123456789abcdef";
const { getDb, schema } = await import("./db/client");
const { runDueJobs } = await import("./jobs/queue");
const { jobHealth } = await import("./jobs/health");
const { GET } = await import("../app/api/health/jobs/route");
const monitoring = await import("./monitoring");

const reported: { message: string; where?: unknown }[] = [];
monitoring.addErrorReporter((e, ctx) => {
  reported.push({ message: e instanceof Error ? e.message : String(e), where: ctx.where });
});
const call = (auth?: string) => GET(new Request("http://localhost/api/health/jobs", { headers: { "x-forwarded-for": "203.0.113.9", ...(auth ? { authorization: auth } : {}) } }));

beforeEach(async () => {
  const db = await getDb();
  await db.delete(schema.jobs);
  await db.delete(schema.rateLimitBuckets);
  reported.length = 0;
  process.env.CRON_SECRET = SECRET;
});

describe("dead jobs", () => {
  it("a job out of retries is reported to the error monitor; one that will retry isn't", async () => {
    const db = await getDb();
    await db.insert(schema.jobs).values([
      { type: "publish_post", payload: { postId: "p-final" }, maxAttempts: 1, runAt: new Date(Date.now() - 1000) },
      { type: "sync_metrics", payload: { brandId: "b-retry" }, maxAttempts: 3, runAt: new Date(Date.now() - 1000) },
    ]);
    const boom = async () => {
      throw new Error("platform said no");
    };
    await runDueJobs({ publish_post: boom, sync_metrics: boom });
    expect(reported).toEqual([{ message: "Job publish_post failed permanently after 1 attempt(s)", where: "jobs.dead" }]);
    expect((await jobHealth()).dead24h).toBe(1);
  });
});

describe("/api/health/jobs", () => {
  it("needs the cron secret", async () => {
    expect((await call()).status).toBe(401);
    expect((await call("Bearer wrong-secret-wrong-secret-wrong-secret")).status).toBe(401);
  });

  it("200 when nothing is overdue or stuck; 503 with counts when the scheduler has stopped", async () => {
    let res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, overdue: 0, stuck: 0, dead24h: 0 });

    const db = await getDb();
    const ago = (min: number) => new Date(Date.now() - min * 60_000);
    await db.insert(schema.jobs).values([
      { type: "publish_post", payload: {}, runAt: ago(20) }, // overdue
      { type: "publish_post", payload: {}, runAt: ago(5) }, // due, not yet overdue
      { type: "sync_metrics", payload: {}, status: "running", lockedAt: ago(30), runAt: ago(30) }, // stuck
    ]);
    res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, overdue: 1, stuck: 1, dead24h: 0 });
  });
});
