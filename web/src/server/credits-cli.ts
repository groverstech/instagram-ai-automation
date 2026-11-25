// `npm run credits -- <command>`: operator tool for plan and credit configuration (PR 4.5).
// Platform-level: never exposed in the web app. Every change is recorded in the Security log
// (config.plan_update, config.credits_update) with the --by name.
//
//   show                                   plans, credit value, failed-attempt policy, alert thresholds
//   plan <starter|growth|agency> --by <name> [--name <text>] [--price <USD>] [--included-credits <n|none>]
//        [--brands <n>] [--seats <n>] [--social-accounts <n>] [--ai-runs <n>]
//   settings --by <name> [--credit-value <USD>] [--charge-failed <true|false>] [--thresholds <70,90,100>]
//   shadow [<YYYY-MM>]                     per organisation: AI runs (enforced) vs credits (shadow) for the
//                                          month, and whether credits would have stopped it
//
// Runs with the server's database configuration. Output contains no personal data beyond
// organisation names.
import { and, count, eq, gte, lt } from "drizzle-orm";
import { addMonths } from "date-fns";
import { getDb, schema } from "./db/client";
import { creditStatus, getCreditSettings, listPlans, PLAN_KEYS, updateCreditSettings, updatePlan, type PlanKey } from "./credits";

function flags(args: string[]) {
  const out: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) out[args[i].slice(2)] = args[++i] ?? "";
    else rest.push(args[i]);
  }
  return { f: out, rest };
}
const int = (v: string | undefined, name: string) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} needs a whole number ≥ 0.`);
  return n;
};
const needBy = (f: Record<string, string>) => {
  if (!f.by?.trim()) throw new Error("--by <your name> is required: it's recorded with the change.");
  return f.by.trim();
};

async function show() {
  const [plans, s] = await Promise.all([listPlans(), getCreditSettings()]);
  console.log(`Credit value: $${s.creditValueUsd} of estimated provider cost per credit`);
  console.log(`Failed and retried attempts charged: ${s.chargeFailedAttempts ? "yes" : "no"}`);
  console.log(`Alert thresholds: ${s.alertThresholds.join("%, ")}%`);
  console.log("");
  console.log("plan       name       price/mo  included credits  brands  seats  social  AI runs/mo");
  for (const p of plans)
    console.log(
      [p.key.padEnd(10), p.name.padEnd(10), `$${p.priceMonthlyUsd}`.padStart(8), String(p.includedCredits ?? "not set").padStart(17), String(p.limits.brands).padStart(7), String(p.limits.seats).padStart(6), String(p.limits.socialAccounts).padStart(7), String(p.limits.aiRunsPerMonth).padStart(11)].join(" "),
    );
}

async function shadow(month?: string) {
  const at = month ? new Date(`${month}-15T12:00:00Z`) : new Date();
  if (Number.isNaN(at.getTime())) throw new Error("Month must look like 2026-11.");
  const db = await getDb();
  const wss = await db.select({ id: schema.workspaces.id, name: schema.workspaces.name, plan: schema.workspaces.plan }).from(schema.workspaces);
  console.log("organisation                    plan     AI runs / limit     credits / cap        credits would stop it");
  for (const w of wss) {
    const st = await creditStatus(w.id, at);
    const [runs] = await db
      .select({ n: count() })
      .from(schema.agentRuns)
      .innerJoin(schema.brands, eq(schema.brands.id, schema.agentRuns.brandId))
      .where(and(eq(schema.brands.workspaceId, w.id), gte(schema.agentRuns.startedAt, st.since), lt(schema.agentRuns.startedAt, addMonths(st.since, 1))));
    const stop = [st.org && st.org.percent >= 100 ? "organisation" : null, ...st.brands.filter((b) => b.percent >= 100).map((b) => `brand ${b.brandId.slice(0, 8)}`)].filter(Boolean);
    console.log(
      [w.name.slice(0, 30).padEnd(31), w.plan.padEnd(8), `${runs.n} / ${st.plan.limits.aiRunsPerMonth}`.padEnd(19), `${Math.round(st.used)} / ${st.org?.cap ?? "—"}`.padEnd(20), stop.length ? stop.join(", ") : "no"].join(" "),
    );
  }
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const { f, rest } = flags(args);
  if (cmd === "show") return show();
  if (cmd === "shadow") return shadow(rest[0]);
  if (cmd === "plan") {
    const key = rest[0] as PlanKey;
    if (!PLAN_KEYS.includes(key)) throw new Error(`Plan must be one of ${PLAN_KEYS.join(", ")}.`);
    const by = needBy(f);
    const limits = { brands: int(f.brands, "brands"), seats: int(f.seats, "seats"), socialAccounts: int(f["social-accounts"], "social-accounts"), aiRunsPerMonth: int(f["ai-runs"], "ai-runs") };
    const price = f.price === undefined ? undefined : Number(f.price);
    if (price !== undefined && !(price >= 0)) throw new Error("--price needs a number ≥ 0.");
    await updatePlan(
      key,
      {
        name: f.name,
        priceMonthlyUsd: price,
        includedCredits: f["included-credits"] === undefined ? undefined : f["included-credits"] === "none" ? null : int(f["included-credits"], "included-credits"),
        limits: Object.fromEntries(Object.entries(limits).filter(([, v]) => v !== undefined)),
      },
      by,
    );
    return show();
  }
  if (cmd === "settings") {
    const by = needBy(f);
    const v = f["credit-value"] === undefined ? undefined : Number(f["credit-value"]);
    const cf = f["charge-failed"];
    if (cf !== undefined && cf !== "true" && cf !== "false") throw new Error("--charge-failed is true or false.");
    await updateCreditSettings(
      {
        ...(v !== undefined ? { creditValueUsd: v } : {}),
        ...(cf !== undefined ? { chargeFailedAttempts: cf === "true" } : {}),
        ...(f.thresholds !== undefined ? { alertThresholds: f.thresholds.split(",").map((t) => Number(t.trim())) } : {}),
      },
      by,
    );
    return show();
  }
  console.log("Usage: npm run credits -- show | plan <key> --by <name> [...] | settings --by <name> [...] | shadow [YYYY-MM]");
  process.exitCode = 2;
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
