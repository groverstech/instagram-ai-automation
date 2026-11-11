import "server-only";
import fs from "node:fs";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import type { SessionUser } from "../auth/session";
import { ANTHROPIC_PRICES_RETRIEVED, TEXT_MODELS } from "./catalog";
import { circuitStatus } from "./circuit";
import { mockActive } from "./mode";
import { baseRoute, ROUTE_KEYS, ROUTES } from "./routes";
import { usageSummary, type UsageSummary } from "./usage";

/**
 * Settings → "AI providers & usage" (docs/AI_PROVIDERS.md). Organisation-wide, so only for
 * owners and admins with access to every brand (the same rule as billing and integrations):
 * requireWorkspaceRoleForUser refuses brand-scoped members, and the refusal is audited.
 * Reports whether keys are configured, never their values.
 */
export type ProviderStatus = {
  id: "anthropic" | "openai";
  label: string;
  purpose: string;
  configured: boolean;
  model: string | null;
  detail: string;
  circuit: "closed" | "open" | "half_open";
};

export type LiveValidation =
  | { status: "pending"; reason: string }
  | { status: "ran"; ranAt: string; results: { name: string; status: string; reason?: string }[] };

export type AiOverview = {
  mode: "production" | "demo";
  providers: ProviderStatus[];
  routes: { key: string; label: string; model: string; source: string }[];
  usage: UsageSummary & { brandNames: Record<string, string> };
  limit: { usd: number | null; spentUsd: number };
  live: LiveValidation;
  pricesRetrieved: string;
};

/** The last `npm run test:live` report, when LIVE_REPORT_DIR points at it. */
export function liveValidation(env: Record<string, string | undefined> = process.env): LiveValidation {
  const dir = env.LIVE_REPORT_DIR;
  const file = dir ? path.join(dir, "report.json") : null;
  if (!file || !fs.existsSync(file)) {
    return { status: "pending", reason: "No live test with real provider credentials has been run on this server." };
  }
  try {
    const r = JSON.parse(fs.readFileSync(file, "utf8")) as { ranAt: string; report: Record<string, { status: string; reason?: string }> };
    return { status: "ran", ranAt: r.ranAt, results: Object.entries(r.report).map(([name, v]) => ({ name, status: v.status, reason: v.reason })) };
  } catch {
    return { status: "pending", reason: "The live test report couldn't be read." };
  }
}

export async function aiOverviewFor(session: SessionUser, workspaceId: string): Promise<AiOverview> {
  const { requireWorkspaceRoleForUser } = await import("../auth/guard");
  await requireWorkspaceRoleForUser(session, workspaceId, "admin");
  const db = await getDb();
  const [ws] = await db.select({ plan: schema.workspaces.plan }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
  const usage = await usageSummary(workspaceId);
  const ids = usage.byBrand.map((b) => b.brandId).filter((x): x is string => Boolean(x));
  const brands = ids.length ? await db.select({ id: schema.brands.id, name: schema.brands.name }).from(schema.brands).where(inArray(schema.brands.id, ids)) : [];
  const { monthlyCostLimitUsd } = await import("../quota");
  const demo = mockActive();
  const text = baseRoute("brand.profile");
  const image = baseRoute("image.generate");
  const imageEdit = baseRoute("image.edit");
  const imageOn = (process.env.IMAGE_PROVIDER ?? "openai").trim().toLowerCase() !== "none";
  const { imageRates, refreshPriceOverrides, textCost } = await import("./pricing");
  await refreshPriceOverrides();
  const { imageModelLabel } = await import("./image");
  const textSource = textCost({ model: text.model, inputTokens: 1 }).source;
  const imageSource = imageRates(image.model)?.source ?? "unpriced";
  return {
    mode: demo ? "demo" : "production",
    providers: [
      {
        id: "anthropic",
        label: "Anthropic Claude",
        purpose: "Brand intelligence, strategy, campaigns, copy, advisor, research and visual review",
        configured: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
        model: TEXT_MODELS[text.model]?.label ?? text.model,
        detail: `Prices: ${priceLabel(textSource)}`,
        circuit: circuitStatus("anthropic").state,
      },
      {
        id: "openai",
        label: "OpenAI images",
        purpose: "Creative Studio images, variations and precision edits",
        configured: imageOn && Boolean(process.env.OPENAI_API_KEY),
        model: imageOn ? `${imageModelLabel(image.model)} (generation, variations) · ${imageModelLabel(imageEdit.model)} (edits)` : null,
        detail: !imageOn ? "Turned off (IMAGE_PROVIDER=none)" : `Quality: ${image.quality} · Prices: ${priceLabel(imageSource)}, per token from reported usage`,
        circuit: circuitStatus("openai").state,
      },
    ],
    routes: ROUTE_KEYS.map((k) => {
      const r = baseRoute(k);
      return { key: k, label: ROUTES[k].label, model: r.model, source: r.source };
    }),
    usage: { ...usage, brandNames: Object.fromEntries(brands.map((b) => [b.id, b.name])) },
    limit: { usd: monthlyCostLimitUsd(ws?.plan ?? "starter"), spentUsd: usage.byModel.filter((r) => r.provider !== "mock").reduce((s, r) => s + r.costUsd, 0) },
    live: liveValidation(),
    pricesRetrieved: ANTHROPIC_PRICES_RETRIEVED,
  };
}

/** "anthropic-list-2026-11-10" → "Anthropic list prices (retrieved 2026-11-10)", etc. */
export function priceLabel(source: string): string {
  const m = /^(anthropic|openai)-list-(\d{4}-\d{2}-\d{2})$/.exec(source);
  if (m) return `${m[1] === "anthropic" ? "Anthropic" : "OpenAI"} list prices (retrieved ${m[2]})`;
  if (source.startsWith("ai_prices:")) return `rates from the price table (${source.slice(10)})`;
  if (source === "config") return "rates from server configuration";
  return "not priced";
}
