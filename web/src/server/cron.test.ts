import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

process.env.AI_PROVIDER = "mock";
process.env.PGLITE_DIR = "memory://";
process.env.IMAGE_PROVIDER = "none";
process.env.RUN_JOBS_IN_PROCESS = "false";

const SECRET = "c".repeat(24) + "-0123456789abcdef"; // 41 chars
const { getDb, schema } = await import("./db/client");
const { GET } = await import("../app/api/cron/tick/route");
const { MIN_CRON_SECRET } = await import("./cron-auth");

const call = (headers: Record<string, string> = {}) => GET(new Request("http://localhost/api/cron/tick", { headers: { "x-forwarded-for": "203.0.113.7", ...headers } }));

beforeEach(async () => {
  const db = await getDb();
  await db.delete(schema.rateLimitBuckets);
  process.env.CRON_SECRET = SECRET;
});

describe("cron recovery endpoint authentication", () => {
  it("fails closed when CRON_SECRET is missing or too short", async () => {
    delete process.env.CRON_SECRET;
    expect((await call({ authorization: "Bearer anything" })).status).toBe(503);
    process.env.CRON_SECRET = "short-secret";
    expect("short-secret".length).toBeLessThan(MIN_CRON_SECRET);
    expect((await call({ authorization: "Bearer short-secret" })).status).toBe(503);
  });

  it("rejects missing, malformed and wrong credentials without running anything", async () => {
    const db = await getDb();
    const [ws] = await db.insert(schema.workspaces).values({ name: "W" }).returning();
    const [b] = await db.insert(schema.brands).values({ workspaceId: ws.id, name: "B" }).returning();
    const [t] = await db.insert(schema.aiTasks).values({ brandId: b.id, workspaceId: ws.id, userId: "u", kind: "strategy_workflow", steps: [], runAfter: new Date(0) }).returning();
    const bad: Record<string, string>[] = [
      {},
      { authorization: "" },
      { authorization: SECRET }, // no scheme
      { authorization: `Basic ${SECRET}` },
      { authorization: `bearer ${SECRET}` },
      { authorization: `Bearer ${SECRET}x` }, // longer
      { authorization: `Bearer ${SECRET.slice(0, -1)}` }, // shorter
      { authorization: `Bearer ${SECRET.slice(0, -1)}X` }, // same length, last char differs
      { "x-cron-secret": SECRET },
    ];
    for (const h of bad) {
      const r = await call(h);
      expect(r.status, JSON.stringify(h)).toBe(401);
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(await r.text()).not.toContain(SECRET);
    }
    // Nothing ran: the queued task is untouched.
    const [after] = await db.select().from(schema.aiTasks).where(eq(schema.aiTasks.id, t.id));
    expect(after).toMatchObject({ status: "queued", attempts: 0 });
    await db.delete(schema.aiTasks).where(eq(schema.aiTasks.id, t.id));
  });

  it("rate-limits repeated failures per client IP, without locking out the real scheduler from another IP", async () => {
    for (let i = 0; i < 10; i++) expect((await call({ authorization: "Bearer wrong" })).status).toBe(401);
    const blocked = await call({ authorization: "Bearer wrong" });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    const fromScheduler = await GET(new Request("http://localhost/api/cron/tick", { headers: { "x-forwarded-for": "198.51.100.20", authorization: `Bearer ${SECRET}` } }));
    expect(fromScheduler.status).toBe(200);
  });

  it("with the right secret, runs the scheduler and recovers an abandoned strategist job", async () => {
    const db = await getDb();
    const { generateBrandProfile, approveProfile } = await import("./agents/brand");
    const store = await import("./strategist/store");
    const { StrategyInputs, SECTION_KEYS } = await import("@/lib/strategy");
    const [u] = await db.insert(schema.users).values({ email: "c@x.test", name: "C", passwordHash: "x" }).returning();
    const [ws] = await db.insert(schema.workspaces).values({ name: "WS", plan: "agency" }).returning();
    await db.insert(schema.workspaceMembers).values({ workspaceId: ws.id, userId: u.id, role: "owner" });
    const [b] = await db.insert(schema.brands).values({ workspaceId: ws.id, name: "Kora", platforms: ["instagram"] }).returning();
    const { profile } = await generateBrandProfile({ brandId: b.id, userId: u.id }, b);
    await approveProfile(b.id, profile.id, u.id);
    const row = await store.createStrategy(b.id, u.id, StrategyInputs.parse({ accountType: "business", businessObjectives: ["Grow"], platforms: ["instagram"], startDate: "2027-01-04", postsPerWeek: 3 }), [], null);
    // A job whose worker died two attempts ago.
    const [t] = await db
      .insert(schema.aiTasks)
      .values({ brandId: b.id, workspaceId: ws.id, userId: u.id, kind: "strategy_workflow", strategyId: row.id, status: "running", attempts: 1, claimToken: "dead", heartbeatAt: new Date(Date.now() - 10 * 60_000), steps: SECTION_KEYS.map((k) => ({ id: k, label: k, status: "pending" as const })) })
      .returning();
    const r = await call({ authorization: `Bearer ${SECRET}` });
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    for (let i = 0; i < 100; i++) {
      const [x] = await db.select().from(schema.aiTasks).where(eq(schema.aiTasks.id, t.id));
      if (x.status === "succeeded") break;
      await new Promise((res) => setTimeout(res, 100));
    }
    const [done] = await db.select().from(schema.aiTasks).where(eq(schema.aiTasks.id, t.id));
    expect(done).toMatchObject({ status: "succeeded", attempts: 2 });
    expect(Object.keys(store.docOf((await store.getStrategy(b.id, row.id))!).sections).sort()).toEqual([...SECTION_KEYS].sort());
    // Calling it again (cron overlap) does nothing to a finished job.
    expect((await call({ authorization: `Bearer ${SECRET}` })).status).toBe(200);
    const [again] = await db.select().from(schema.aiTasks).where(eq(schema.aiTasks.id, t.id));
    expect(again.attempts).toBe(2);
  });
});
