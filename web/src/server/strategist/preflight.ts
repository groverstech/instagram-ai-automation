import "server-only";
import { eq } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import { latestProfile, profileOf } from "../agents/context";
import type { Brand } from "../db/schema";
import type { BrandProfileV2 } from "@/lib/brand-profile";
import { PLATFORM_IDS, objectiveLabel } from "@/lib/domain";
import type { AccountType } from "@/lib/strategy";

export type Question = { id: string; question: string; why: string; critical: boolean; assumption: string; prefill?: string };

export type Preflight = {
  /** The approved Brand Intelligence Profile the strategist will use. Required to generate. */
  profile: { id: string; version: number } | null;
  /** A newer draft exists that isn't approved yet. */
  newerDraft: { id: string; version: number } | null;
  blocked: string | null;
  questions: Question[];
  defaults: { accountType: AccountType; businessObjectives: string[]; marketingGoals: string; platforms: string[] };
  workspaceType: "creator" | "business" | "agency";
};

const has = (s: string | null | undefined) => Boolean(s && s.trim().length > 2);

export function accountTypeFor(wsType: string): AccountType {
  return wsType === "creator" ? "influencer" : wsType === "agency" ? "agency" : "business";
}

/**
 * Before generating, check that the strategist has what it needs. Critical gaps become questions
 * the user answers, or explicitly lets the AI assume (recorded and shown as assumptions).
 */
export function missingInfo(brand: Brand, p: BrandProfileV2 | null): Question[] {
  const q: Question[] = [];
  if (!has(brand.products) && !has(brand.description)) {
    q.push({ id: "offer", question: "What do you sell or offer, and what's the hero product or service?", why: "Campaigns and pillars are built around the offer.", critical: true, assumption: "The strategist will infer the offer from the brand profile and website." });
  }
  if (!has(brand.targetAudience) && !(p && p.audience.personas.length)) {
    q.push({ id: "audience", question: "Who is your ideal customer? (who they are, what they need, where they spend time online)", why: "Personas and channel choices depend on it.", critical: true, assumption: "Personas will be hypotheses based on the category; validate them before approving." });
  }
  if (!has(brand.geography)) {
    q.push({ id: "market", question: "Which countries, regions or cities do you sell to?", why: "Seasonal moments, timing and language depend on the market.", critical: true, assumption: "The strategy will avoid market-specific dates and assume an English-speaking online audience." });
  }
  if (!has(brand.marketingGoals)) {
    q.push({ id: "targets", question: "Do you have measurable targets for the next 30–90 days? (e.g. followers, enquiries, sales, sign-ups)", why: "KPIs use your targets; without them, targets are labelled as suggestions.", critical: false, assumption: "KPI targets will be suggested starting points, clearly labelled." });
  }
  q.push({ id: "conversion", question: "What should a follower do next? (buy online, book, enquire, visit the store, DM, sign up)", why: "Shapes CTAs and the lead-generation strategy.", critical: false, assumption: "CTAs will point to the website.", prefill: brand.website ? `Visit ${brand.website}` : undefined });
  if (!brand.competitors.length && !(p && p.competitors.length)) {
    q.push({ id: "competitors", question: "Who do customers compare you with? Name 2–3 competitors or alternatives.", why: "Used for competitor research and differentiation.", critical: false, assumption: "Competitors will be identified through research where possible." });
  }
  if (p && !p.identity.differentiation.length && !p.identity.usps.length) {
    q.push({ id: "difference", question: "Why do customers choose you over the alternatives?", why: "Positioning and differentiation need a real reason to believe.", critical: true, assumption: "Differentiation will be proposed as hypotheses for you to confirm." });
  }
  return q;
}

export async function preflight(brand: Brand): Promise<Preflight> {
  const db = await getDb();
  const [ws] = await db.select({ type: schema.workspaces.type }).from(schema.workspaces).where(eq(schema.workspaces.id, brand.workspaceId));
  const { latest, approved } = await latestProfile(brand.id);
  const profile = profileOf(approved);
  const blocked = !approved
    ? latest
      ? "Your Brand Intelligence Profile hasn't been approved yet. The strategist only builds on an approved profile, so review and approve it first."
      : "There's no Brand Intelligence Profile yet. Analyse your brand first so the strategy is specific to you, not generic."
    : !profile
      ? "The approved Brand Intelligence Profile couldn't be read. Re-generate and approve it, then try again."
      : null;
  const wsType = (ws?.type ?? "business") as Preflight["workspaceType"];
  const platforms = brand.platforms.filter((x) => (PLATFORM_IDS as readonly string[]).includes(x));
  return {
    profile: approved && profile ? { id: approved.id, version: approved.version } : null,
    newerDraft: latest && approved && latest.version > approved.version && latest.status !== "approved" ? { id: latest.id, version: latest.version } : null,
    blocked,
    questions: missingInfo(brand, profile),
    defaults: {
      accountType: accountTypeFor(wsType),
      businessObjectives: brand.objectives.length ? brand.objectives.map(objectiveLabel) : profile ? profile.marketing.objectives.map((o) => o.text).filter(Boolean).slice(0, 5) : [],
      marketingGoals: brand.marketingGoals ?? "",
      platforms: platforms.length ? platforms : ["instagram"],
    },
    workspaceType: wsType,
  };
}
