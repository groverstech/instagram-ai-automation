import "server-only";
import { and, eq, gte, inArray, isNotNull, lt, ne, sql } from "drizzle-orm";
import { format, startOfMonth } from "date-fns";
import { getDb, schema } from "./db/client";
import type { PlanLimits } from "./db/schema";
import { audit } from "./audit";
import { log } from "./log";

/**
 * Plans and AI credits as configuration (PR 4.5; docs/plan/05-credits-billing.md). Worker-safe: no
 * auth/guard import, so the worker and the CLI can use it.
 *
 * **Shadow mode.** Credits are computed from the usage ledger (usage_events: one row per provider
 * attempt, with its estimated USD cost) and shown to owners and admins, caps raise alerts, but
 * nothing is refused on credits: the plan's monthly AI-run quota (quota.ts) stays the enforced
 * limit. PR 4.6 switches enforcement to credits after a shadow period of matching numbers.
 *
 *   credits = estimated provider cost (USD) ÷ credit value (credit_settings, default $0.01)
 *
 * Charged attempts: successful ones; failed and retried ones only when chargeFailedAttempts is on
 * (default off: the platform absorbs them, and they still appear in the admin cost views).
 * Demo (mock) calls and unpriced attempts are never charged.
 *
 * CREDITS_MODE: "shadow" (default), "off" (no alerts; the numbers are still shown) or "enforce" (PR 4.6:
 * requests that would exceed a cap are refused before they're sent; ai/credit-gate.ts). Enforce
 * stays off until the owner approves it after a shadow period (decision D-17).
 */

export type PlanKey = "starter" | "growth" | "agency";
export const PLAN_KEYS: PlanKey[] = ["starter", "growth", "agency"];
export type Plan = { key: PlanKey; name: string; priceMonthlyUsd: number; limits: PlanLimits; includedCredits: number | null };
export type CreditSettings = { creditValueUsd: number; chargeFailedAttempts: boolean; alertThresholds: number[] };

/** Used only if the configuration rows are missing (a database that skipped migration 0014's seed). */
const FALLBACK_PLAN: Plan = { key: "starter", name: "Starter", priceMonthlyUsd: 0, limits: { brands: 1, seats: 2, socialAccounts: 3, aiRunsPerMonth: 200 }, includedCredits: null };
const DEFAULT_SETTINGS: CreditSettings = { creditValueUsd: 0.01, chargeFailedAttempts: false, alertThresholds: [70, 90, 100] };

export function creditsMode(env: Record<string, string | undefined> = process.env): "shadow" | "off" | "enforce" {
  const v = (env.CREDITS_MODE ?? "").trim().toLowerCase();
  return v === "off" ? "off" : v === "enforce" ? "enforce" : "shadow";
}

export async function listPlans(): Promise<Plan[]> {
  const db = await getDb();
  const rows = await db.select().from(schema.plans);
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return PLAN_KEYS.filter((k) => byKey.has(k)).map((k) => {
    const r = byKey.get(k)!;
    return { key: r.key, name: r.name, priceMonthlyUsd: r.priceMonthlyUsd, limits: r.limits, includedCredits: r.includedCredits };
  });
}

/** The plan's configuration. An unknown key reads as Starter, the most restrictive plan. */
export async function getPlan(key: string | null | undefined): Promise<Plan> {
  const all = await listPlans();
  const p = all.find((x) => x.key === key) ?? all.find((x) => x.key === "starter");
  if (!p) {
    log.error("plans.not_configured", { key: key ?? null });
    return FALLBACK_PLAN;
  }
  return p;
}

export async function getCreditSettings(): Promise<CreditSettings> {
  const db = await getDb();
  const [r] = await db.select().from(schema.creditSettings).where(eq(schema.creditSettings.id, "default"));
  if (!r) return DEFAULT_SETTINGS;
  return { creditValueUsd: r.creditValueUsd, chargeFailedAttempts: r.chargeFailedAttempts, alertThresholds: [...r.alertThresholds].sort((a, b) => a - b) };
}

export const toCredits = (usd: number, s: Pick<CreditSettings, "creditValueUsd">) => (s.creditValueUsd > 0 ? usd / s.creditValueUsd : 0);
export const periodKey = (now: Date) => format(startOfMonth(now), "yyyy-MM");

export type CapStatus = { cap: number; used: number; percent: number; source: "plan" | "organisation" | "brand" };
export type CreditStatus = {
  mode: "shadow" | "off" | "enforce";
  /** Credits added this period (top-ups and adjustments), included in the organisation cap. */
  granted: number;
  /** Open reservations: requests in flight, counted at their worst case until settled. */
  reserved: number;
  period: string;
  since: Date;
  settings: CreditSettings;
  plan: Plan;
  /** Charged credits this period, organisation-wide. */
  used: number;
  byKind: { kind: string; credits: number }[];
  byBrand: { brandId: string | null; credits: number }[];
  byRoute: { route: string; credits: number }[];
  /** Cost the platform absorbs under the failed-attempt policy, in credits (for transparency). */
  notCharged: number;
  /** The organisation's monthly cap: its own setting, else the plan's included credits; null = none. */
  org: CapStatus | null;
  brands: (CapStatus & { brandId: string })[];
  /** Thresholds already alerted this period. */
  alerts: { brandId: string; threshold: number; at: Date }[];
};

const pct = (used: number, cap: number) => (cap > 0 ? Math.round((used / cap) * 1000) / 10 : used > 0 ? 100 : 0);

/** This period's credit position for an organisation. The caller authorises. */
export async function creditStatus(workspaceId: string, now = new Date()): Promise<CreditStatus> {
  const db = await getDb();
  const [ws] = await db.select({ plan: schema.workspaces.plan }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
  const [plan, settings] = await Promise.all([getPlan(ws?.plan), getCreditSettings()]);
  const since = startOfMonth(now);
  const e = schema.usageEvents;
  const charged = settings.chargeFailedAttempts ? (["success", "failed", "retried"] as const) : (["success"] as const);
  const usd = sql<number>`coalesce(sum(${e.costUsd}), 0)`;
  const base = and(eq(e.workspaceId, workspaceId), gte(e.createdAt, since), ne(e.provider, "mock"), isNotNull(e.costUsd));
  const where = and(base, inArray(e.outcome, [...charged]));
  const [byKind, byBrand, byRoute, absorbed, limits, alerts, grants, pending] = await Promise.all([
    db.select({ kind: e.kind, usd }).from(e).where(where).groupBy(e.kind),
    db.select({ brandId: e.brandId, usd }).from(e).where(where).groupBy(e.brandId),
    db.select({ route: e.route, usd }).from(e).where(where).groupBy(e.route),
    settings.chargeFailedAttempts
      ? Promise.resolve([{ usd: 0 }])
      : db.select({ usd }).from(e).where(and(base, inArray(e.outcome, ["failed", "retried"]))),
    db.select().from(schema.creditLimits).where(eq(schema.creditLimits.workspaceId, workspaceId)),
    db.select().from(schema.usageAlerts).where(and(eq(schema.usageAlerts.workspaceId, workspaceId), eq(schema.usageAlerts.period, periodKey(now)))),
    db.select({ n: sql<number>`coalesce(sum(${schema.creditGrants.credits}), 0)` }).from(schema.creditGrants).where(and(eq(schema.creditGrants.workspaceId, workspaceId), eq(schema.creditGrants.period, periodKey(now)))),
    db.select({ usd: sql<number>`coalesce(sum(${e.reserveUsd}), 0)` }).from(e).where(and(eq(e.workspaceId, workspaceId), gte(e.createdAt, since), ne(e.provider, "mock"), eq(e.outcome, "pending"))),
  ]);
  const c = (x: number) => toCredits(Number(x), settings);
  const used = byKind.reduce((a, r) => a + c(r.usd), 0);
  const orgLimit = limits.find((l) => l.brandId === "");
  const granted = Number(grants[0]?.n ?? 0);
  const baseCap = orgLimit?.monthlyCapCredits ?? plan.includedCredits;
  const orgCap = baseCap == null ? null : baseCap + granted;
  const brandCredits = new Map(byBrand.map((r) => [r.brandId ?? "", c(r.usd)]));
  return {
    mode: creditsMode(),
    granted,
    reserved: c(pending[0]?.usd ?? 0),
    period: periodKey(now),
    since,
    settings,
    plan,
    used,
    byKind: byKind.map((r) => ({ kind: r.kind, credits: c(r.usd) })).sort((a, b) => b.credits - a.credits),
    byBrand: byBrand.map((r) => ({ brandId: r.brandId, credits: c(r.usd) })).sort((a, b) => b.credits - a.credits),
    byRoute: byRoute.map((r) => ({ route: r.route, credits: c(r.usd) })).sort((a, b) => b.credits - a.credits).slice(0, 8),
    notCharged: c(absorbed[0]?.usd ?? 0),
    org: orgCap == null ? null : { cap: orgCap, used, percent: pct(used, orgCap), source: orgLimit ? "organisation" : "plan" },
    brands: limits
      .filter((l) => l.brandId !== "")
      .map((l) => {
        const u = brandCredits.get(l.brandId) ?? 0;
        return { brandId: l.brandId, cap: l.monthlyCapCredits, used: u, percent: pct(u, l.monthlyCapCredits), source: "brand" as const };
      }),
    alerts: alerts.map((a) => ({ brandId: a.brandId, threshold: a.threshold, at: a.createdAt })).sort((a, b) => a.threshold - b.threshold),
  };
}

/**
 * Record each threshold an organisation or brand cap has crossed this period, once (unique key),
 * and notify: Security log, structured log, and an email to owners and admins (through the email
 * hook; with no provider configured it's logged as not sent). In shadow mode reaching 100% doesn't
 * stop anything: it's logged as `credits.shadow_would_block` so the shadow period can be compared.
 * Never throws: credit bookkeeping must not break an AI action.
 */
export async function evaluateCreditAlerts(workspaceId: string, now = new Date()): Promise<{ threshold: number; brandId: string }[]> {
  if (creditsMode() === "off") return [];
  try {
    const st = await creditStatus(workspaceId, now);
    const scopes = [...(st.org ? [{ brandId: "", ...st.org }] : []), ...st.brands];
    const fresh: { threshold: number; brandId: string }[] = [];
    const db = await getDb();
    for (const s of scopes) {
      for (const t of st.settings.alertThresholds) {
        if (s.percent < t) continue;
        const ins = await db
          .insert(schema.usageAlerts)
          .values({ workspaceId, brandId: s.brandId, period: st.period, threshold: t, creditsUsed: Math.round(s.used * 100) / 100, capCredits: s.cap })
          .onConflictDoNothing()
          .returning({ id: schema.usageAlerts.id });
        if (ins.length) fresh.push({ threshold: t, brandId: s.brandId });
      }
      if (s.percent >= 100 && st.mode !== "enforce") log.warn("credits.shadow_would_block", { workspaceId, brandId: s.brandId || null, period: st.period, used: Math.round(s.used), cap: s.cap });
    }
    for (const f of fresh) await notify(workspaceId, f, st);
    return fresh;
  } catch (e) {
    log.error("credits.alert_failed", { workspaceId, error: e instanceof Error ? e.message : String(e) });
    return [];
  }
}

async function notify(workspaceId: string, f: { threshold: number; brandId: string }, st: CreditStatus) {
  const db = await getDb();
  const scope = f.brandId ? st.brands.find((b) => b.brandId === f.brandId)! : st.org!;
  let brandName: string | null = null;
  if (f.brandId) [{ name: brandName } = { name: null }] = await db.select({ name: schema.brands.name }).from(schema.brands).where(eq(schema.brands.id, f.brandId));
  await audit({
    action: "credits.alert",
    workspaceId,
    brandId: f.brandId || null,
    actorType: "system",
    targetType: f.brandId ? "brand" : "workspace",
    targetId: f.brandId || workspaceId,
    details: { threshold: f.threshold, period: st.period, used: Math.round(scope.used), cap: scope.cap, mode: st.mode },
  });
  const recipients = await db
    .select({ email: schema.users.email })
    .from(schema.workspaceMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.workspaceMembers.userId))
    .where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), eq(schema.workspaceMembers.status, "active"), inArray(schema.workspaceMembers.role, ["owner", "admin"])));
  const what = brandName ? `${brandName}'s monthly AI credit cap` : "your organisation's monthly AI credits";
  const subject = `BrandPilot: ${f.threshold}% of ${what} used`;
  const text = [
    `${Math.round(scope.used)} of ${scope.cap} credits used this month (${st.period}).`,
    st.mode === "shadow"
      ? "Credits are shown for information while they're introduced: nothing is stopped on credits yet, and your plan's monthly AI-run limit still applies."
      : st.mode === "enforce" && f.threshold >= 100
        ? "AI requests that would go over the cap are now refused until next month or until more credits are added."
        : "",
    "Details: Settings → AI credits.",
  ]
    .filter(Boolean)
    .join("\n\n");
  const { sendEmail } = await import("./email");
  for (const r of recipients) {
    try {
      await sendEmail({ to: r.email, subject, text, tag: "credits.alert" });
    } catch (e) {
      log.warn("credits.alert_email_failed", { workspaceId, threshold: f.threshold, error: e instanceof Error ? e.message : String(e) });
    }
  }
}

/** Plan configuration changes (operators; `npm run credits`). Audited. */
export async function updatePlan(key: PlanKey, patch: Partial<Pick<Plan, "name" | "priceMonthlyUsd" | "includedCredits">> & { limits?: Partial<PlanLimits> }, by: string) {
  const db = await getDb();
  const [cur] = await db.select().from(schema.plans).where(eq(schema.plans.key, key));
  if (!cur) throw new Error(`No plan "${key}".`);
  const limits = { ...cur.limits, ...(patch.limits ?? {}) };
  for (const [k, v] of Object.entries(limits)) if (!Number.isInteger(v) || v < 0) throw new Error(`limits.${k} must be a whole number ≥ 0.`);
  if (patch.includedCredits != null && (!Number.isInteger(patch.includedCredits) || patch.includedCredits < 0)) throw new Error("includedCredits must be a whole number ≥ 0.");
  if (patch.priceMonthlyUsd != null && !(patch.priceMonthlyUsd >= 0)) throw new Error("priceMonthlyUsd must be ≥ 0.");
  const next = {
    name: patch.name ?? cur.name,
    priceMonthlyUsd: patch.priceMonthlyUsd ?? cur.priceMonthlyUsd,
    includedCredits: patch.includedCredits === undefined ? cur.includedCredits : patch.includedCredits,
    limits,
  };
  await db.update(schema.plans).set({ ...next, updatedBy: by, updatedAt: new Date() }).where(eq(schema.plans.key, key));
  await audit({ action: "config.plan_update", actorType: "system", targetType: "plan", targetId: key, details: { by, before: { name: cur.name, priceMonthlyUsd: cur.priceMonthlyUsd, includedCredits: cur.includedCredits, limits: cur.limits }, after: next } });
  return next;
}

export async function updateCreditSettings(patch: Partial<CreditSettings>, by: string) {
  if (patch.creditValueUsd != null && !(patch.creditValueUsd > 0)) throw new Error("creditValueUsd must be > 0.");
  if (patch.alertThresholds && (!patch.alertThresholds.length || patch.alertThresholds.some((t) => !Number.isInteger(t) || t < 1 || t > 100))) throw new Error("alertThresholds must be whole percentages from 1 to 100.");
  const db = await getDb();
  const cur = await getCreditSettings();
  const next = { ...cur, ...patch };
  await db
    .insert(schema.creditSettings)
    .values({ id: "default", ...next, updatedBy: by })
    .onConflictDoUpdate({ target: schema.creditSettings.id, set: { ...next, updatedBy: by, updatedAt: new Date() } });
  await audit({ action: "config.credits_update", actorType: "system", targetType: "credit_settings", targetId: "default", details: { by, before: cur, after: next } });
  return next;
}

/**
 * Add (or, with a negative number, remove) credits for one month: top-up packs, adjustments and
 * plan grants. `reference` makes it idempotent: the same reference grants once (for a webhook or a
 * re-run CLI). Audited as config.credits_grant. The caller authorises (operator CLI only today).
 */
export async function grantCredits(input: { workspaceId: string; credits: number; period?: string; kind: "topup" | "adjustment" | "plan"; reason: string; by: string; reference?: string | null }, now = new Date()) {
  if (!Number.isInteger(input.credits) || input.credits === 0 || Math.abs(input.credits) > 10_000_000) throw new Error("Credits must be a whole number other than 0.");
  if (!input.reason.trim()) throw new Error("A reason is required.");
  const period = input.period ?? periodKey(now);
  if (!/^\d{4}-\d{2}$/.test(period)) throw new Error("Period must look like 2026-11.");
  const db = await getDb();
  const [ws] = await db.select({ id: schema.workspaces.id }).from(schema.workspaces).where(eq(schema.workspaces.id, input.workspaceId));
  if (!ws) throw new Error("Organisation not found.");
  const [row] = await db
    .insert(schema.creditGrants)
    .values({ workspaceId: input.workspaceId, period, credits: input.credits, kind: input.kind, reason: input.reason.trim().slice(0, 500), createdBy: input.by, reference: input.reference ?? null })
    .onConflictDoNothing()
    .returning();
  if (!row) return { granted: false as const, period };
  await audit({ action: "config.credits_grant", workspaceId: input.workspaceId, actorType: "system", targetType: "workspace", targetId: input.workspaceId, details: { credits: input.credits, period, kind: input.kind, by: input.by, reason: row.reason } });
  return { granted: true as const, period, id: row.id };
}

/**
 * Accounting reconciliation for one organisation and month: what Settings shows (charged + open
 * reservations) must equal what the credit gate enforces; stale reservations (pending for over an
 * hour: a process that died mid-request) and unpriced attempts are listed for an operator.
 */
export async function reconcileCredits(workspaceId: string, now = new Date()) {
  const st = await creditStatus(workspaceId, now);
  const { creditPositions } = await import("./ai/credit-gate");
  const db = await getDb();
  const { positions } = await creditPositions(db, workspaceId, null, now);
  const e = schema.usageEvents;
  const since = startOfMonth(now);
  const [stale] = await db.select({ n: sql<number>`count(*)::int` }).from(e).where(and(eq(e.workspaceId, workspaceId), gte(e.createdAt, since), eq(e.outcome, "pending"), lt(e.createdAt, new Date(now.getTime() - 3600_000))));
  const [unpriced] = await db.select({ n: sql<number>`count(*)::int` }).from(e).where(and(eq(e.workspaceId, workspaceId), gte(e.createdAt, since), ne(e.provider, "mock"), inArray(e.outcome, ["success", "failed", "retried"]), sql`${e.costUsd} is null`));
  const gateUsed = positions[0].used;
  const shown = st.used + st.reserved;
  return {
    period: st.period,
    mode: st.mode,
    charged: st.used,
    reserved: st.reserved,
    granted: st.granted,
    cap: st.org?.cap ?? null,
    gateUsed,
    consistent: Math.abs(gateUsed - shown) < 1e-6,
    stalePending: Number(stale.n),
    unpriced: Number(unpriced.n),
  };
}
