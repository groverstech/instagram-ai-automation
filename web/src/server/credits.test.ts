/**
 * PR 4.5: plans as configuration, and AI credits in shadow mode (credits.ts, credit-caps.ts).
 * Credits are computed from the usage ledger and raise alerts; nothing is refused on credits.
 */
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

process.env.PGLITE_DIR = "memory://";
delete process.env.CREDITS_MODE;
delete process.env.AI_MONTHLY_COST_LIMIT_USD;

const { getDb, schema } = await import("./db/client");
const credits = await import("./credits");
const { setCreditCapFor, creditStatusFor, CreditCapError } = await import("./credit-caps");
const { assertAiQuota, assertCanAdd, QuotaError } = await import("./quota");
const { purgeBrand } = await import("./purge");
const { checkConfig } = await import("./config");
const { AccessError } = await import("./auth/guard");
type SessionUser = import("./auth/session").SessionUser;

let n = 0;
async function org(plan: "starter" | "growth" | "agency" = "growth") {
  const db = await getDb();
  const [w] = await db.insert(schema.workspaces).values({ name: `Org ${n}`, plan }).returning();
  const mk = async (role: "owner" | "admin" | "editor") => {
    const [u] = await db.insert(schema.users).values({ email: `c${n++}@x.test`, name: role, passwordHash: "x" }).returning();
    await db.insert(schema.workspaceMembers).values({ workspaceId: w.id, userId: u.id, role, status: "active" });
    const s: SessionUser = { sessionId: `s-${u.id}`, activeBrandId: null, user: { id: u.id, email: u.email, name: u.name } };
    await db.insert(schema.sessions).values({ id: s.sessionId, userId: u.id, expiresAt: new Date(Date.now() + 86400_000) });
    return s;
  };
  const owner = await mk("owner");
  const editor = await mk("editor");
  const [a] = await db.insert(schema.brands).values({ workspaceId: w.id, name: "Alpha" }).returning();
  const [b] = await db.insert(schema.brands).values({ workspaceId: w.id, name: "Beta" }).returning();
  return { ws: w.id, owner, editor, a: a.id, b: b.id };
}

async function use(ws: string, brandId: string | null, usd: number | null, o: { outcome?: "success" | "failed" | "retried" | "unknown"; kind?: "text" | "image" | "research"; provider?: string; route?: string } = {}) {
  const db = await getDb();
  await db.insert(schema.usageEvents).values({
    workspaceId: ws,
    brandId,
    route: o.route ?? "content.copy",
    provider: o.provider ?? "anthropic",
    model: "m",
    kind: o.kind ?? "text",
    outcome: o.outcome ?? "success",
    costUsd: usd,
    settledAt: new Date(),
  });
}

beforeEach(async () => {
  const db = await getDb();
  await db.update(schema.plans).set({ includedCredits: null });
  await db.update(schema.creditSettings).set({ creditValueUsd: 0.01, chargeFailedAttempts: false, alertThresholds: [70, 90, 100] });
  delete process.env.CREDITS_MODE;
});

describe("plans are configuration", () => {
  it("are seeded with the values that used to be hardcoded; an unknown key reads as Starter", async () => {
    const plans = await credits.listPlans();
    expect(plans.map((p) => [p.key, p.name, p.priceMonthlyUsd, p.limits])).toEqual([
      ["starter", "Starter", 0, { brands: 1, seats: 2, socialAccounts: 3, aiRunsPerMonth: 200 }],
      ["growth", "Growth", 79, { brands: 3, seats: 5, socialAccounts: 12, aiRunsPerMonth: 2000 }],
      ["agency", "Agency", 299, { brands: 25, seats: 25, socialAccounts: 150, aiRunsPerMonth: 20000 }],
    ]);
    expect(plans.every((p) => p.includedCredits === null)).toBe(true);
    expect((await credits.getPlan("platinum")).key).toBe("starter");
  });

  it("limits come from the plans table: a change applies without a deploy, and is audited", async () => {
    const o = await org("starter");
    const db = await getDb();
    await expect(assertCanAdd(o.ws, "brands")).rejects.toBeInstanceOf(QuotaError); // 2 brands, Starter allows 1
    await credits.updatePlan("starter", { limits: { brands: 5, aiRunsPerMonth: 1 }, name: "Solo" }, "ops");
    await expect(assertCanAdd(o.ws, "brands")).resolves.toBeUndefined();
    await assertAiQuota(o.a);
    await db.insert(schema.agentRuns).values({ brandId: o.a, workspaceId: o.ws, agent: "copy", task: "t" });
    await expect(assertAiQuota(o.a)).rejects.toThrow("Your Solo plan includes 1 AI runs per month");
    const [ev] = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, "config.plan_update"));
    expect(ev.details).toMatchObject({ by: "ops", after: { name: "Solo" } });
    await credits.updatePlan("starter", { limits: { brands: 1, aiRunsPerMonth: 200 }, name: "Starter" }, "ops");
  });

  it("rejects invalid values", async () => {
    await expect(credits.updatePlan("growth", { limits: { seats: -1 } }, "ops")).rejects.toThrow("whole number");
    await expect(credits.updatePlan("growth", { includedCredits: 1.5 }, "ops")).rejects.toThrow("whole number");
    await expect(credits.updateCreditSettings({ creditValueUsd: 0 }, "ops")).rejects.toThrow("> 0");
    await expect(credits.updateCreditSettings({ alertThresholds: [150] }, "ops")).rejects.toThrow("1 to 100");
  });
});

describe("credits (shadow mode)", () => {
  it("are estimated provider cost ÷ credit value; failed, demo and unpriced attempts aren't charged by default", async () => {
    const o = await org();
    await use(o.ws, o.a, 0.5);
    await use(o.ws, o.b, 0.3, { kind: "image", route: "image.generate" });
    await use(o.ws, o.a, 0.2, { outcome: "failed" });
    await use(o.ws, o.a, 0.1, { outcome: "retried" });
    await use(o.ws, o.a, 1, { provider: "mock" });
    await use(o.ws, o.a, null, { outcome: "unknown" });
    const st = await credits.creditStatus(o.ws);
    expect(st.mode).toBe("shadow");
    expect(st.used).toBeCloseTo(80);
    expect(st.notCharged).toBeCloseTo(30);
    expect(st.byKind).toEqual([{ kind: "text", credits: expect.closeTo(50) }, { kind: "image", credits: expect.closeTo(30) }]);
    expect(st.byBrand.find((b) => b.brandId === o.b)?.credits).toBeCloseTo(30);
    expect(st.byRoute[0]).toEqual({ route: "content.copy", credits: expect.closeTo(50) });
    expect(st.org).toBeNull(); // no allowance set, no organisation cap

    await credits.updateCreditSettings({ chargeFailedAttempts: true, creditValueUsd: 0.02 }, "ops");
    const charged = await credits.creditStatus(o.ws);
    expect(charged.used).toBeCloseTo(55); // $1.10 at $0.02
    expect(charged.notCharged).toBe(0);
  });

  it("the organisation cap is its own setting, else the plan's included credits", async () => {
    const o = await org("growth");
    await use(o.ws, o.a, 1);
    await credits.updatePlan("growth", { includedCredits: 400 }, "ops");
    expect((await credits.creditStatus(o.ws)).org).toEqual({ cap: 400, used: expect.closeTo(100), percent: 25, source: "plan" });
    await setCreditCapFor(o.owner, o.ws, null, 200);
    expect((await credits.creditStatus(o.ws)).org).toMatchObject({ cap: 200, percent: 50, source: "organisation" });
    await setCreditCapFor(o.owner, o.ws, null, null);
    expect((await credits.creditStatus(o.ws)).org?.source).toBe("plan");
  });

  it("alerts at 70, 90 and 100% of organisation and brand caps, each once per period; shadow mode never refuses", async () => {
    const o = await org();
    const db = await getDb();
    await setCreditCapFor(o.owner, o.ws, null, 100);
    await setCreditCapFor(o.owner, o.ws, o.b, 10);
    await use(o.ws, o.a, 0.75);
    expect(await credits.evaluateCreditAlerts(o.ws)).toEqual([{ threshold: 70, brandId: "" }]);
    expect(await credits.evaluateCreditAlerts(o.ws)).toEqual([]);
    await use(o.ws, o.b, 0.5); // org 125%, Beta 500%
    const fresh = await credits.evaluateCreditAlerts(o.ws);
    expect(fresh).toEqual(expect.arrayContaining([{ threshold: 90, brandId: "" }, { threshold: 100, brandId: "" }, { threshold: 70, brandId: o.b }, { threshold: 90, brandId: o.b }, { threshold: 100, brandId: o.b }]));
    expect(fresh).toHaveLength(5);
    // Over every cap, AI work still runs: the plan's run quota is what's enforced.
    await expect(assertAiQuota(o.a)).resolves.toBeUndefined();
    const alerts = await db.select().from(schema.usageAlerts).where(eq(schema.usageAlerts.workspaceId, o.ws));
    expect(alerts).toHaveLength(6);
    const audited = await db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.action, "credits.alert"), eq(schema.auditEvents.workspaceId, o.ws)));
    expect(audited).toHaveLength(6);
    expect(audited.find((a) => a.brandId === o.b && (a.details as { threshold: number }).threshold === 100)?.details).toMatchObject({ cap: 10, used: 50, mode: "shadow" });
    // Next month starts fresh.
    const next = new Date();
    next.setMonth(next.getMonth() + 1);
    expect((await credits.creditStatus(o.ws, next)).alerts).toEqual([]);
  });

  it("CREDITS_MODE=off records no alerts; `enforce` is rejected until PR 4.6", async () => {
    const o = await org();
    await setCreditCapFor(o.owner, o.ws, null, 1);
    const db = await getDb();
    await db.delete(schema.usageAlerts).where(eq(schema.usageAlerts.workspaceId, o.ws));
    await use(o.ws, o.a, 1);
    process.env.CREDITS_MODE = "off";
    expect(await credits.evaluateCreditAlerts(o.ws)).toEqual([]);
    const errs = (v: string) => checkConfig({ CREDITS_MODE: v }).filter((p) => p.key === "CREDITS_MODE" && p.level === "error");
    expect(errs("enforce")[0]?.message).toMatch(/PR 4.6/);
    expect(errs("shadow")).toEqual([]);
    expect(errs("off")).toEqual([]);
  });
});

describe("caps: who can set them", () => {
  it("owners and admins; not editors; whole numbers; brands of this organisation only; audited", async () => {
    const o = await org();
    const other = await org();
    await expect(setCreditCapFor(o.editor, o.ws, null, 100)).rejects.toBeInstanceOf(AccessError);
    await expect(creditStatusFor(o.editor, o.ws)).rejects.toBeInstanceOf(AccessError);
    await expect(setCreditCapFor(o.owner, o.ws, null, 1.5)).rejects.toBeInstanceOf(CreditCapError);
    await expect(setCreditCapFor(o.owner, o.ws, other.a, 10)).rejects.toThrow("isn't in this workspace");
    await setCreditCapFor(o.owner, o.ws, o.a, 300);
    await setCreditCapFor(o.owner, o.ws, o.a, 400);
    const db = await getDb();
    const ev = await db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.action, "credits.cap_change"), eq(schema.auditEvents.workspaceId, o.ws)));
    expect(ev.map((e) => e.details)).toEqual(expect.arrayContaining([{ before: null, after: 300 }, { before: 300, after: 400 }]));
    const view = await creditStatusFor(o.owner, o.ws);
    expect(view.brands).toEqual([{ brandId: o.a, cap: 400, used: 0, percent: 0, source: "brand" }]);
    expect(view.brandNames[o.a]).toBe("Alpha");
  });

  it("deleting a brand removes its cap and alerts", async () => {
    const o = await org();
    await setCreditCapFor(o.owner, o.ws, o.a, 1);
    await use(o.ws, o.a, 1);
    await credits.evaluateCreditAlerts(o.ws);
    await purgeBrand(o.a);
    const db = await getDb();
    expect(await db.$count(schema.creditLimits, eq(schema.creditLimits.brandId, o.a))).toBe(0);
    expect(await db.$count(schema.usageAlerts, eq(schema.usageAlerts.brandId, o.a))).toBe(0);
  });
});
