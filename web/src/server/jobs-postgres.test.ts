/**
 * Background jobs on real Postgres (F13): the jobs queue (scheduled publishing, metric syncs) through
 * every entry point that runs it: runDueJobs, the scheduler tick, the in-process scheduler started by
 * instrumentation.ts, the cron route and the standalone worker process.
 *
 * PGlite accepts parameters the production driver (postgres.js) rejects, so these must run on the
 * real driver. Runs when TEST_DATABASE_URL points at a Postgres 15+ server with pgvector where the
 * role may create databases (CI provides one); each run uses its own throwaway database.
 * No request leaves the test: social platforms are stubbed, AI runs in mock mode.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq, inArray, sql } from "drizzle-orm";

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DB_NAME = `bp_jobs_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const CRON_SECRET = "f13-test-cron-secret-".padEnd(40, "x");

function dbUrl(name: string) {
  const u = new URL(ADMIN_URL!);
  u.pathname = `/${name}`;
  return u.toString();
}

async function admin<T>(fn: (sql: import("postgres").Sql) => Promise<T>): Promise<T> {
  const { default: postgres } = await import("postgres");
  const sql = postgres(ADMIN_URL!, { max: 1, onnotice: () => {} });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

if (ADMIN_URL) {
  await admin((sql) => sql.unsafe(`create database ${DB_NAME}`));
  Object.assign(process.env, {
    DATABASE_URL: dbUrl(DB_NAME),
    AI_PROVIDER: "mock",
    IMAGE_PROVIDER: "none",
    RUN_JOBS_IN_PROCESS: "true",
    CRON_SECRET,
    STORAGE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "bp-jobs-pg-")),
  });
}

afterAll(async () => {
  if (!ADMIN_URL) return;
  await admin((sql) => sql.unsafe(`drop database if exists ${DB_NAME} with (force)`)).catch(() => {});
});

describe.skipIf(!ADMIN_URL)("background jobs on real Postgres (F13)", async () => {
  const { getDb, schema } = await import("./db/client");
  const { saveAccounts } = await import("./social/service");
  const { PROVIDERS } = await import("./social/registry");
  const { enqueue, runDueJobs } = await import("./jobs/queue");
  const { handlers, interruptedHooks, tick } = await import("./jobs/handlers");
  type Db = Awaited<ReturnType<typeof getDb>>;

  let db: Db;
  let brandId = "";
  let userId = "";
  let creativeId = "";
  let accountId = "";
  let emptyBrandId = "";

  beforeAll(async () => {
    db = await getDb(); // migrates the fresh database (MIGRATE_ON_START defaults on outside staging/production)
    const [u] = await db.insert(schema.users).values({ email: "jobs-pg@x.test", name: "J", passwordHash: "x" }).returning();
    const [w] = await db.insert(schema.workspaces).values({ name: "Jobs PG" }).returning();
    await db.insert(schema.workspaceMembers).values({ workspaceId: w.id, userId: u.id, role: "owner" });
    const [b] = await db.insert(schema.brands).values({ workspaceId: w.id, name: "Kora", platforms: ["linkedin"], colors: ["#2B2620", "#F3EDE4"] }).returning();
    const [empty] = await db.insert(schema.brands).values({ workspaceId: w.id, name: "No accounts" }).returning();
    const [c] = await db
      .insert(schema.creatives)
      .values({ brandId: b.id, format: "linkedin_post", style: "minimalist_luxury", visualSource: "typographic", concept: { title: "T", headline: "Made to last", subline: "Stoneware", cta: "Shop", layout: "typographic", palette: { background: "#F3EDE4", foreground: "#2B2620", accent: "#B5643C" }, imagePrompt: "", imageTreatment: "", rationale: "" } })
      .returning();
    await saveAccounts(b.id, u.id, [{ platform: "linkedin", externalId: "urn:li:person:pg", name: "Kora", token: { accessToken: "test-token" } }]);
    const [a] = await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.brandId, b.id));
    brandId = b.id;
    userId = u.id;
    creativeId = c.id;
    accountId = a.id;
    emptyBrandId = empty.id;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    delete PROVIDERS.linkedin.accountMetrics;
    delete PROVIDERS.linkedin.postMetrics;
    // Each test starts with an empty queue, so one test's jobs never run in another.
    await db.delete(schema.jobs);
  });

  /** Stub LinkedIn publishing: counts calls; nothing leaves the test. */
  function stubPublish() {
    let n = 0;
    vi.spyOn(PROVIDERS.linkedin, "publish").mockImplementation(async () => {
      n++;
      return { externalId: `urn:li:share:pg-${n}`, url: "https://www.linkedin.com/feed/update/x" };
    });
    return () => n;
  }

  /** Stub LinkedIn metrics (LinkedIn has none in production code; the test adds them for the sync). */
  function stubMetrics() {
    const calls = { account: 0, post: 0 };
    PROVIDERS.linkedin.accountMetrics = async () => {
      calls.account++;
      return { followers: 1200, reach: 3400 };
    };
    PROVIDERS.linkedin.postMetrics = async () => {
      calls.post++;
      return { reach: 500, impressions: 900, likes: 40, comments: 5, shares: 3, saves: 2 };
    };
    return calls;
  }

  async function scheduledPost(minutesAgo = 1) {
    const [p] = await db
      .insert(schema.posts)
      .values({ brandId, platform: "linkedin", format: "linkedin_post", status: "scheduled", scheduledAt: new Date(Date.now() - minutesAgo * 60_000), approvedAt: new Date(), approvedBy: userId, creativeId, socialAccountId: accountId, caption: "Hello from Postgres" })
      .returning();
    // An approval is for this exact content (social/approval.ts).
    await (await import("./social/approval")).recordApprovedContent(db, p.id);
    return p;
  }

  const job = async (id: string) => (await db.select().from(schema.jobs).where(eq(schema.jobs.id, id)))[0];
  const post = async (id: string) => (await db.select().from(schema.posts).where(eq(schema.posts.id, id)))[0];
  const ago = (ms: number) => new Date(Date.now() - ms);

  describe("queue: claim to completion", () => {
    it("claims a due job, runs it and records completion; a second run doesn't execute it again", async () => {
      const calls: string[] = [];
      const id = await enqueue("sync_metrics", { brandId: emptyBrandId }, ago(1000));
      const run = () => runDueJobs({ sync_metrics: async (p) => void calls.push(String(p.brandId)) });
      expect(await run()).toEqual([{ id, ok: true }]);
      expect(await job(id)).toMatchObject({ status: "done", attempts: 1, lockedAt: null, lastError: null });
      expect(await run()).toEqual([]);
      expect(calls).toEqual([emptyBrandId]);
    });

    it("leaves jobs that aren't due yet, and jobs another worker holds with a fresh lock", async () => {
      const ran: string[] = [];
      const future = await enqueue("sync_metrics", { brandId: emptyBrandId }, new Date(Date.now() + 60_000));
      const [held] = await db.insert(schema.jobs).values({ type: "sync_metrics", payload: { brandId: emptyBrandId }, status: "running", lockedAt: ago(60_000), attempts: 1, runAt: ago(120_000) }).returning();
      expect(await runDueJobs({ sync_metrics: async () => void ran.push("x") })).toEqual([]);
      expect(ran).toEqual([]);
      expect(await job(future)).toMatchObject({ status: "queued", attempts: 0 });
      expect(await job(held.id)).toMatchObject({ status: "running", attempts: 1 });
    });

    it("runs due jobs oldest first", async () => {
      const order: string[] = [];
      const late = await enqueue("sync_metrics", { n: "late" }, ago(1_000));
      const early = await enqueue("sync_metrics", { n: "early" }, ago(60_000));
      const res = await runDueJobs({ sync_metrics: async (p) => void order.push(String(p.n)) });
      expect(res.map((r) => r.id)).toEqual([early, late]);
      expect(order).toEqual(["early", "late"]);
    });

    it("a failing job is re-queued with backoff and its error, then marked failed after the last attempt", async () => {
      const boom = async () => {
        throw new Error("platform timeout");
      };
      const id = await enqueue("sync_metrics", { brandId: emptyBrandId }, ago(1000));
      const before = Date.now();
      expect(await runDueJobs({ sync_metrics: boom })).toEqual([{ id, ok: false, error: "platform timeout" }]);
      const retry = await job(id);
      expect(retry).toMatchObject({ status: "queued", attempts: 1, lastError: "platform timeout", lockedAt: null });
      expect(retry.runAt.getTime()).toBeGreaterThanOrEqual(before + 60_000); // backoff: not claimable now
      expect(await runDueJobs({ sync_metrics: boom })).toEqual([]);
      // Last attempt: make it due again and fail it.
      await db.update(schema.jobs).set({ runAt: ago(1000), attempts: 2 }).where(eq(schema.jobs.id, id));
      expect((await runDueJobs({ sync_metrics: boom }))[0]).toMatchObject({ id, ok: false });
      expect(await job(id)).toMatchObject({ status: "failed", attempts: 3, lastError: "platform timeout", lockedAt: null });
    });

    it("a job type without a handler fails visibly instead of being dropped", async () => {
      const [j] = await db.insert(schema.jobs).values({ type: "no_such_type", payload: {}, runAt: ago(1000) }).returning();
      expect(await runDueJobs({})).toEqual([{ id: j.id, ok: false, error: "No handler for job type no_such_type" }]);
      expect(await job(j.id)).toMatchObject({ status: "queued", attempts: 1, lastError: "No handler for job type no_such_type" });
    });

    it("concurrent runners execute each due job exactly once", async () => {
      const ids = await Promise.all(Array.from({ length: 30 }, (_, i) => enqueue("sync_metrics", { n: i }, ago(1000 + i))));
      const runs = new Map<number, number>();
      const handler = async (p: Record<string, unknown>) => {
        await new Promise((r) => setImmediate(r));
        runs.set(Number(p.n), (runs.get(Number(p.n)) ?? 0) + 1);
      };
      // Six runners at once on separate pool connections, each allowed to take every job.
      const results = (await Promise.all(Array.from({ length: 6 }, () => runDueJobs({ sync_metrics: handler }, 30)))).flat();
      expect(results.filter((r) => r.ok)).toHaveLength(30);
      expect(new Set(results.map((r) => r.id)).size).toBe(30);
      expect([...runs.values()].every((n) => n === 1)).toBe(true);
      expect(runs.size).toBe(30);
      const rows = await db.select().from(schema.jobs).where(inArray(schema.jobs.id, ids));
      expect(rows.every((r) => r.status === "done" && r.attempts === 1)).toBe(true);
    });

    it("a runner whose claim was taken over doesn't overwrite the new owner's state", async () => {
      // Simulates a job that outlived the stale-lock window: while it runs, another worker
      // re-claims it (new lock). The first runner must not then mark it done or re-queue it.
      const id = await enqueue("sync_metrics", { brandId: emptyBrandId }, ago(1000));
      const takeover = new Date(Date.now() + 5_000);
      const res = await runDueJobs({
        sync_metrics: async () => {
          await db.update(schema.jobs).set({ lockedAt: takeover, attempts: 2 }).where(eq(schema.jobs.id, id));
        },
      });
      expect(res).toEqual([{ id, ok: false, error: "claim lost" }]);
      expect(await job(id)).toMatchObject({ status: "running", attempts: 2, lockedAt: takeover });
    });

    it("recovers a job abandoned by a dead worker (stale lock)", async () => {
      const ran: string[] = [];
      const [j] = await db.insert(schema.jobs).values({ type: "sync_metrics", payload: { brandId: emptyBrandId }, status: "running", lockedAt: ago(11 * 60_000), attempts: 1, runAt: ago(12 * 60_000) }).returning();
      expect(await runDueJobs({ sync_metrics: async () => void ran.push("x") }, 10, interruptedHooks)).toEqual([{ id: j.id, ok: true }]);
      expect(ran).toEqual(["x"]);
      expect(await job(j.id)).toMatchObject({ status: "done", attempts: 2 });
    });
  });

  describe("scheduled publishing", () => {
    it("publishes a due scheduled post through its job exactly once", async () => {
      const calls = stubPublish();
      const p = await scheduledPost();
      const id = await enqueue("publish_post", { postId: p.id }, p.scheduledAt!);
      expect(await runDueJobs(handlers, 10, interruptedHooks)).toEqual([{ id, ok: true }]);
      expect(calls()).toBe(1);
      expect(await post(p.id)).toMatchObject({ status: "published", externalId: "urn:li:share:pg-1", publishError: null });
      expect(await job(id)).toMatchObject({ status: "done", attempts: 1 });
      await runDueJobs(handlers, 10, interruptedHooks);
      expect(calls()).toBe(1);
    });

    it("a platform failure is recorded on the post and not retried blindly", async () => {
      vi.spyOn(PROVIDERS.linkedin, "publish").mockRejectedValue(new Error("LinkedIn said no"));
      const p = await scheduledPost();
      const id = await enqueue("publish_post", { postId: p.id }, p.scheduledAt!);
      await runDueJobs(handlers, 10, interruptedHooks);
      expect(await post(p.id)).toMatchObject({ status: "failed" });
      expect((await post(p.id)).publishError).toMatch(/LinkedIn said no/);
      expect(await job(id)).toMatchObject({ status: "done", attempts: 1 });
    });

    it("never re-sends a publish whose worker died mid-flight; the post is flagged for a check", async () => {
      const calls = stubPublish();
      const p = await scheduledPost();
      await db.update(schema.posts).set({ status: "publishing" }).where(eq(schema.posts.id, p.id));
      const [j] = await db.insert(schema.jobs).values({ type: "publish_post", payload: { postId: p.id }, status: "running", lockedAt: ago(11 * 60_000), attempts: 1, runAt: ago(12 * 60_000) }).returning();
      expect(await runDueJobs(handlers, 10, interruptedHooks)).toEqual([{ id: j.id, ok: false, error: "interrupted" }]);
      expect(calls()).toBe(0);
      expect(await post(p.id)).toMatchObject({ status: "failed" });
      expect(await job(j.id)).toMatchObject({ status: "failed", lockedAt: null });
    });

    it("a post that isn't publishable fails its job after the retries, with the reason", async () => {
      const calls = stubPublish();
      const [draft] = await db.insert(schema.posts).values({ brandId, platform: "linkedin", format: "linkedin_post", status: "draft", creativeId, socialAccountId: accountId, caption: "x" }).returning();
      const [j] = await db.insert(schema.jobs).values({ type: "publish_post", payload: { postId: draft.id }, runAt: ago(1000), attempts: 2 }).returning();
      await runDueJobs(handlers, 10, interruptedHooks);
      expect(calls()).toBe(0);
      expect(await job(j.id)).toMatchObject({ status: "failed", attempts: 3 });
      expect((await job(j.id)).lastError).toMatch(/must be approved/);
    });
  });

  describe("metric synchronisation", () => {
    it("syncs account and post metrics through the job and records completion", async () => {
      const calls = stubMetrics();
      const p = await scheduledPost();
      await db.update(schema.posts).set({ status: "published", externalId: "urn:li:share:metrics" }).where(eq(schema.posts.id, p.id));
      const id = await enqueue("sync_metrics", { brandId }, ago(1000));
      const published = await db.select().from(schema.posts).where(eq(schema.posts.socialAccountId, accountId));
      expect(await runDueJobs(handlers, 10, interruptedHooks)).toEqual([{ id, ok: true }]);
      expect(calls).toEqual({ account: 1, post: published.filter((x) => x.status === "published" && x.externalId).length });
      const [acct] = await db.select().from(schema.accountMetrics).where(eq(schema.accountMetrics.socialAccountId, accountId));
      expect(acct).toMatchObject({ followers: 1200, reach: 3400 });
      const [pm] = await db.select().from(schema.postMetrics).where(eq(schema.postMetrics.postId, p.id));
      expect(pm).toMatchObject({ reach: 500, impressions: 900 });
      expect(await job(id)).toMatchObject({ status: "done", attempts: 1 });
    });

    it("an interrupted metric sync is simply run again (it is idempotent)", async () => {
      stubMetrics();
      const [j] = await db.insert(schema.jobs).values({ type: "sync_metrics", payload: { brandId }, status: "running", lockedAt: ago(11 * 60_000), attempts: 1, runAt: ago(12 * 60_000) }).returning();
      expect(await runDueJobs(handlers, 10, interruptedHooks)).toEqual([{ id: j.id, ok: true }]);
      expect(await job(j.id)).toMatchObject({ status: "done", attempts: 2 });
    });
  });

  describe("scheduler tick (what the in-process scheduler, cron route and worker run)", () => {
    it("plans metric syncs for brands with connected accounts and runs due jobs", async () => {
      const calls = stubMetrics();
      const res = await tick();
      const jobs = await db.select().from(schema.jobs);
      expect(jobs.filter((j) => j.type === "sync_metrics" && j.payload.brandId === brandId)).toHaveLength(1);
      expect(res.some((r) => r.ok)).toBe(true);
      expect(jobs.every((j) => j.status === "done")).toBe(true);
      expect(calls.account).toBe(1);
    });

    it("returns no results when there is no work, and leaves the database untouched", async () => {
      expect(await tick({ jobs: true, ai: true })).toEqual([]);
      expect(await db.select().from(schema.jobs)).toEqual([]);
    });

    it("the in-process scheduler started by instrumentation runs due jobs", async () => {
      const calls = stubPublish();
      const p = await scheduledPost();
      const id = await enqueue("publish_post", { postId: p.id }, p.scheduledAt!);
      let scheduled: (() => void) | undefined;
      const interval = vi.spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void) => {
        scheduled = fn;
        return 0 as unknown as NodeJS.Timeout;
      }) as typeof setInterval);
      const g = globalThis as { __bpTicker?: unknown };
      const prevRuntime = process.env.NEXT_RUNTIME;
      try {
        process.env.NEXT_RUNTIME = "nodejs";
        delete g.__bpTicker;
        const { register } = await import("../instrumentation");
        await register();
        expect(interval).toHaveBeenCalledWith(expect.any(Function), 30_000);
        scheduled!(); // one scheduler interval elapses
        await vi.waitFor(async () => expect(await job(id)).toMatchObject({ status: "done" }), { timeout: 15_000, interval: 50 });
        expect(calls()).toBe(1);
        expect(await post(p.id)).toMatchObject({ status: "published" });
      } finally {
        delete g.__bpTicker;
        if (prevRuntime === undefined) delete process.env.NEXT_RUNTIME;
        else process.env.NEXT_RUNTIME = prevRuntime;
      }
    });
  });

  describe("cron route", () => {
    const call = async (auth?: string) => {
      const { GET } = await import("../app/api/cron/tick/route");
      return GET(new Request("http://localhost/api/cron/tick", { headers: { "x-forwarded-for": "203.0.113.9", ...(auth ? { authorization: auth } : {}) } }));
    };

    it("runs due jobs for an authenticated scheduler and reports them", async () => {
      const calls = stubPublish();
      const p = await scheduledPost();
      const id = await enqueue("publish_post", { postId: p.id }, p.scheduledAt!);
      const res = await call(`Bearer ${CRON_SECRET}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = await res.json();
      expect(body.results).toContainEqual({ id, ok: true });
      expect(calls()).toBe(1);
      expect(await job(id)).toMatchObject({ status: "done" });
      expect(await post(p.id)).toMatchObject({ status: "published" });
    });

    it("refuses an unauthenticated call without running anything", async () => {
      const id = await enqueue("sync_metrics", { brandId: emptyBrandId }, ago(1000));
      const res = await call("Bearer wrong-secret");
      expect(res.status).toBe(401);
      expect(await job(id)).toMatchObject({ status: "queued", attempts: 0 });
    });

    it("a database failure returns a 500 with a reference, without the error details, and leaves jobs intact", async () => {
      const id = await enqueue("sync_metrics", { brandId: emptyBrandId }, ago(1000));
      await db.execute(sql.raw("alter table jobs rename to jobs_unavailable"));
      let res: Response;
      try {
        res = await call(`Bearer ${CRON_SECRET}`);
      } finally {
        await db.execute(sql.raw("alter table jobs_unavailable rename to jobs"));
      }
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body).toEqual({ error: "Scheduler tick failed", reference: expect.stringMatching(/^[0-9a-f]{8}$/) });
      expect(JSON.stringify(body)).not.toMatch(/jobs_unavailable|relation/);
      expect(await job(id)).toMatchObject({ status: "queued", attempts: 0, lockedAt: null });
    });
  });

  describe("standalone worker process", () => {
    /** `npm run worker` against the test database, as a separate process (polls every 200 ms). */
    function startWorker() {
      const env: NodeJS.ProcessEnv = { ...process.env, WORKER_QUEUES: "jobs,ai", WORKER_INTERVAL_MS: "200", WORKER_DRAIN_MS: "5000" };
      // A normal process, not a test one (the logger is silent under VITEST / NODE_ENV=test), and
      // hermetic: no provider credential from the shell reaches it (AI runs in mock mode anyway).
      for (const k of Object.keys(env)) if (k === "NEXT_RUNTIME" || k === "NODE_ENV" || k.startsWith("VITEST") || /_API_KEY$|_AUTH_TOKEN$/.test(k)) delete env[k];
      const child = spawn(process.execPath, ["--conditions=react-server", "--import", "tsx", "src/server/jobs/worker.ts"], { cwd: path.resolve(import.meta.dirname, "../.."), env, stdio: ["ignore", "pipe", "pipe"] });
      const w = { out: "", exited: undefined as unknown as Promise<number | null>, stop: () => child.kill("SIGTERM") };
      child.stdout.on("data", (d) => (w.out += d));
      child.stderr.on("data", (d) => (w.out += d));
      // "close": the process exited and its output pipes are drained.
      w.exited = new Promise((resolve) => child.on("close", (code) => resolve(code)));
      return w;
    }
    const waitFor = (fn: () => Promise<void> | void) => vi.waitFor(fn, { timeout: 60_000, interval: 100 });

    it("claims and completes queued jobs, picks up jobs that arrive while it runs, records failures, and stops cleanly", async () => {
      const first = await enqueue("sync_metrics", { brandId: emptyBrandId }, ago(1000));
      const w = startWorker();
      try {
        await waitFor(async () => expect(await job(first)).toMatchObject({ status: "done", attempts: 1 }));
        // Jobs that become due while the worker is already polling.
        const later = await enqueue("sync_metrics", { brandId: emptyBrandId });
        const [bad] = await db.insert(schema.jobs).values({ type: "no_such_type", payload: {} }).returning();
        await waitFor(async () => {
          expect(await job(later)).toMatchObject({ status: "done", attempts: 1 });
          expect(await job(bad.id)).toMatchObject({ status: "queued", attempts: 1, lastError: "No handler for job type no_such_type" });
        });
      } finally {
        w.stop();
      }
      expect(await w.exited).toBe(0);
      expect(w.out).toContain('"worker.started"');
      expect(w.out).toContain('"worker.ran"');
      expect(w.out).toContain('"jobs.job_failed"');
      expect(w.out).toContain('"worker.stopped"');
      expect(w.out).not.toContain("tick_failed");
      expect(w.out).not.toContain("ai_recovery_failed"); // the AI-task side of the same tick runs on Postgres too
    }, 90_000);

    it("keeps running through a database failure and processes jobs once the database is back", async () => {
      const w = startWorker();
      try {
        await waitFor(() => expect(w.out).toContain('"worker.started"'));
        await db.execute(sql.raw("alter table jobs rename to jobs_unavailable"));
        try {
          await waitFor(() => expect(w.out).toContain('"worker.tick_failed"'));
        } finally {
          await db.execute(sql.raw("alter table jobs_unavailable rename to jobs"));
        }
        const id = await enqueue("sync_metrics", { brandId: emptyBrandId });
        await waitFor(async () => expect(await job(id)).toMatchObject({ status: "done", attempts: 1 }));
      } finally {
        w.stop();
      }
      expect(await w.exited).toBe(0);
      expect(w.out).toContain('"worker.stopped"');
    }, 90_000);
  });
});
