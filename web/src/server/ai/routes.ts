import "server-only";
import { and, eq, inArray, or } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import { log } from "../log";
import {
  DEFAULT_IMAGE_EDIT_MODEL,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_IMAGE_QUALITY,
  DEFAULT_TEXT_MODEL,
  IMAGE_COMPLEXITIES,
  IMAGE_QUALITIES,
  isImageModel,
  isTextModel,
  TEXT_MODELS,
  type ImageComplexity,
  type ImageQuality,
} from "./catalog";

/**
 * Named AI routes (docs/AI_PROVIDERS.md). Every AI call names the job it does; the route decides
 * provider, model and limits. Resolution, highest priority first:
 *   1. a database override for the brand, then for the workspace's plan, then global
 *      (`ai_routes` table; model and params validated against the catalog, invalid ones ignored);
 *   2. environment configuration (ANTHROPIC_MODEL; OPENAI_IMAGE_MODEL for generation and
 *      variations, OPENAI_IMAGE_EDIT_MODEL for precision edits; OPENAI_IMAGE_QUALITY,
 *      OPENAI_IMAGE_COMPLEXITY; AI_*_TIMEOUT_MS, AI_*_MAX_ATTEMPTS);
 *   3. the defaults below.
 * The agent's own effort is used unless an override sets one.
 */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

export type RouteKind = "text" | "research" | "image";
type RouteDef = { kind: RouteKind; label: string };

export const ROUTES = {
  "brand.profile": { kind: "text", label: "Brand DNA analysis" },
  "brand.assets": { kind: "text", label: "Brand asset analysis" },
  "brand.qa": { kind: "text", label: "Brand questions" },
  "strategy.research": { kind: "research", label: "Market research (web search)" },
  "strategy.section": { kind: "text", label: "Strategy, personas and pillars" },
  "advisor.chat": { kind: "text", label: "Marketing advisor" },
  "campaign.plan": { kind: "text", label: "Campaign concepts" },
  "content.calendar": { kind: "text", label: "Content calendars" },
  "content.copy": { kind: "text", label: "Captions and copy" },
  "content.ideas": { kind: "text", label: "Content ideas" },
  "creative.concepts": { kind: "text", label: "Creative concepts" },
  "creative.review": { kind: "text", label: "Visual brand review" },
  "competitor.research": { kind: "research", label: "Competitor research (web search)" },
  "competitor.analysis": { kind: "text", label: "Competitor analysis" },
  "analytics.insights": { kind: "text", label: "Analytics insights" },
  "image.generate": { kind: "image", label: "Image generation" },
  "image.variation": { kind: "image", label: "Image variations" },
  "image.edit": { kind: "image", label: "Precision image edits" },
} as const satisfies Record<string, RouteDef>;

export type RouteKey = keyof typeof ROUTES;
export const ROUTE_KEYS = Object.keys(ROUTES) as RouteKey[];

export type RouteOverrideParams = { effort?: Effort; quality?: ImageQuality; complexity?: ImageComplexity; timeoutMs?: number; maxAttempts?: number };

export type ResolvedRoute = {
  key: RouteKey;
  kind: RouteKind;
  provider: "anthropic" | "openai";
  model: string;
  effort?: Effort;
  quality?: ImageQuality;
  /** Image planning effort; unset = the API default (high). */
  complexity?: ImageComplexity;
  timeoutMs: number;
  /** Attempts in the call, including the first. Retries are for transient failures only. */
  maxAttempts: number;
  /**
   * Retry an attempt whose outcome is unknown (sent, no response: timeout or dropped
   * connection)? The provider may already have processed and billed it. Text: yes (the cost of a
   * repeat is small and the run needs the result). Images: no, to avoid paying twice; the user
   * retries knowingly.
   */
  retryUnknown: boolean;
  /** Where the model came from (shown in the usage view). */
  source: "default" | "env" | "override:global" | "override:plan" | "override:brand";
};

type Env = Record<string, string | undefined>;
const posInt = (v: string | undefined, fallback: number) => (v && /^[1-9]\d*$/.test(v.trim()) ? Number(v.trim()) : fallback);

/** Environment-level resolution (no database). Pure, for tests and the status view. */
export function baseRoute(key: RouteKey, env: Env = process.env): ResolvedRoute {
  const def: RouteDef = ROUTES[key];
  if (def.kind === "image") {
    // Precision edits default to Sunburst; generation and variations to Flare.
    const precise = key === "image.edit";
    const envModel = (precise ? env.OPENAI_IMAGE_EDIT_MODEL : env.OPENAI_IMAGE_MODEL)?.trim();
    const envQuality = env.OPENAI_IMAGE_QUALITY?.trim().toLowerCase();
    const envComplexity = env.OPENAI_IMAGE_COMPLEXITY?.trim().toLowerCase();
    return {
      key,
      kind: "image",
      provider: "openai",
      model: envModel && isImageModel(envModel) ? envModel : precise ? DEFAULT_IMAGE_EDIT_MODEL : DEFAULT_IMAGE_MODEL,
      quality: envQuality && (IMAGE_QUALITIES as readonly string[]).includes(envQuality) ? (envQuality as ImageQuality) : DEFAULT_IMAGE_QUALITY,
      ...(envComplexity && (IMAGE_COMPLEXITIES as readonly string[]).includes(envComplexity) ? { complexity: envComplexity as ImageComplexity } : {}),
      timeoutMs: posInt(env.AI_IMAGE_TIMEOUT_MS, 180_000),
      maxAttempts: posInt(env.AI_IMAGE_MAX_ATTEMPTS, 2),
      retryUnknown: false,
      source: envModel && isImageModel(envModel) ? "env" : "default",
    };
  }
  const raw = env.ANTHROPIC_MODEL?.trim();
  const envModel = raw && isTextModel(raw) && (def.kind !== "research" || TEXT_MODELS[raw].webSearchTool !== null) ? raw : undefined;
  return {
    key,
    kind: def.kind,
    provider: "anthropic",
    model: envModel ?? DEFAULT_TEXT_MODEL,
    timeoutMs: posInt(env.AI_TEXT_TIMEOUT_MS, 600_000),
    maxAttempts: posInt(env.AI_MAX_ATTEMPTS, 3),
    retryUnknown: true,
    source: envModel ? "env" : "default",
  };
}

/** Apply one override row's model and params, ignoring anything the catalog doesn't allow. */
export function applyOverride(r: ResolvedRoute, o: { model?: string | null; params?: RouteOverrideParams | null; scopeType: "global" | "plan" | "brand" }): ResolvedRoute {
  const out = { ...r };
  const bad: string[] = [];
  if (o.model) {
    // Research routes need a model with the web search tool.
    const ok = r.kind === "image" ? isImageModel(o.model) : isTextModel(o.model) && (r.kind !== "research" || TEXT_MODELS[o.model].webSearchTool !== null);
    if (ok) {
      out.model = o.model;
      out.source = `override:${o.scopeType}`;
    } else bad.push("model");
  }
  const p = o.params ?? {};
  if (p.effort !== undefined) {
    if (r.kind !== "image" && EFFORTS.includes(p.effort)) out.effort = p.effort;
    else bad.push("effort");
  }
  if (p.quality !== undefined) {
    if (r.kind === "image" && (IMAGE_QUALITIES as readonly string[]).includes(p.quality)) out.quality = p.quality;
    else bad.push("quality");
  }
  if (p.complexity !== undefined) {
    if (r.kind === "image" && (IMAGE_COMPLEXITIES as readonly string[]).includes(p.complexity)) out.complexity = p.complexity;
    else bad.push("complexity");
  }
  if (p.timeoutMs !== undefined) {
    if (Number.isInteger(p.timeoutMs) && p.timeoutMs >= 5_000 && p.timeoutMs <= 3_600_000) out.timeoutMs = p.timeoutMs;
    else bad.push("timeoutMs");
  }
  if (p.maxAttempts !== undefined) {
    if (Number.isInteger(p.maxAttempts) && p.maxAttempts >= 1 && p.maxAttempts <= 5) out.maxAttempts = p.maxAttempts;
    else bad.push("maxAttempts");
  }
  if (bad.length) log.error("ai.route_override_invalid", { route: r.key, scope: o.scopeType, ignored: bad });
  return out;
}

/** Full resolution, including database overrides for the brand and its workspace's plan. */
export async function resolveRoute(key: RouteKey, scope: { brandId?: string | null } = {}): Promise<ResolvedRoute> {
  let route = baseRoute(key);
  try {
    const db = await getDb();
    let plan: string | null = null;
    if (scope.brandId) {
      const [b] = await db
        .select({ plan: schema.workspaces.plan })
        .from(schema.brands)
        .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.brands.workspaceId))
        .where(eq(schema.brands.id, scope.brandId));
      plan = b?.plan ?? null;
    }
    const r = schema.aiRoutes;
    const scopes = [and(eq(r.scopeType, "global"), eq(r.scopeId, ""))];
    if (plan) scopes.push(and(eq(r.scopeType, "plan"), eq(r.scopeId, plan)));
    if (scope.brandId) scopes.push(and(eq(r.scopeType, "brand"), eq(r.scopeId, scope.brandId)));
    const rows = await db
      .select()
      .from(r)
      .where(and(eq(r.key, key), eq(r.active, true), or(...scopes), inArray(r.scopeType, ["global", "plan", "brand"])));
    for (const s of ["global", "plan", "brand"] as const) {
      const row = rows.find((x) => x.scopeType === s);
      if (row) route = applyOverride(route, { model: row.model, params: row.params, scopeType: s });
    }
  } catch (e) {
    // Overrides are optional: if they can't be read, the configured defaults apply.
    log.error("ai.route_overrides_unavailable", { route: key, error: e instanceof Error ? e.message : String(e) });
  }
  return route;
}
