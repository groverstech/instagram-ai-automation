import { z } from "zod";
import { FORMAT_IDS, OBJECTIVES, PLATFORM_IDS } from "./domain";

/**
 * AI Marketing Strategist — the strategy document (schemaVersion 2).
 *
 * A strategy is a set of independently generated, editable sections. Each section is stored in an
 * envelope that records where it came from (AI run, user edit) so sections can be regenerated on
 * their own and history can show who changed what.
 *
 * Schemas named `*AI` are sent to Claude as structured-output JSON Schemas, so they stay in the
 * supported subset (plain objects, arrays, enums, strings, numbers, booleans; no length/number
 * constraints). Ids, approval flags and verification are added by the server, never by the model.
 * This file is shared by server and client: no secrets, no server imports.
 */

export const STRATEGY_SCHEMA_VERSION = 2;

const platform = z.enum(PLATFORM_IDS);
const format = z.enum(FORMAT_IDS);
const objective = z.enum(OBJECTIVES);

export const ACCOUNT_TYPES = ["business", "influencer", "agency"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];
export const accountTypeLabel = (t: string) => ({ business: "Business", influencer: "Creator / influencer", agency: "Agency (client brand)" })[t] ?? t;

export const CAMPAIGN_KINDS = ["seasonal", "launch", "promotional", "awareness", "engagement", "evergreen"] as const;
export type CampaignKind = (typeof CAMPAIGN_KINDS)[number];

// ---------------------------------------------------------------------------
// Inputs collected by the wizard (steps 1–4)
// ---------------------------------------------------------------------------

export const StrategyInputs = z.object({
  accountType: z.enum(ACCOUNT_TYPES),
  businessObjectives: z.array(z.string().trim().min(1).max(300)).max(10),
  marketingGoals: z.string().trim().max(2000).default(""),
  platforms: z.array(platform).min(1).max(6),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  postsPerWeek: z.number().int().min(1).max(28),
  campaignKinds: z.array(z.enum(CAMPAIGN_KINDS)).max(6).default([]),
  keyDates: z.string().trim().max(2000).default(""),
  focus: z.string().trim().max(2000).default(""),
  budget: z.string().trim().max(300).default(""),
  /** Answers to the missing-information questions, keyed by question id. */
  answers: z.record(z.string(), z.string().trim().max(2000)).default({}),
  /** Question ids the user chose to let the AI assume. Shown as explicit assumptions. */
  assumeFor: z.array(z.string()).default([]),
});
export type StrategyInputs = z.infer<typeof StrategyInputs>;

// ---------------------------------------------------------------------------
// A. Market research
// ---------------------------------------------------------------------------

export const RESEARCH_CATEGORIES = ["industry", "opportunity", "competitor", "trend", "customer_behaviour", "content_opportunity"] as const;
export const researchCategoryLabel = (c: string) =>
  ({ industry: "Industry", opportunity: "Opportunity", competitor: "Competitor", trend: "Trend", customer_behaviour: "Customer behaviour", content_opportunity: "Content opportunity" })[c] ?? c;

export const ResearchAI = z.object({
  summary: z.string(),
  industryOverview: z.string(),
  findings: z.array(
    z.object({
      category: z.enum(RESEARCH_CATEGORIES),
      title: z.string(),
      detail: z.string(),
      basis: z.enum(["sourced", "hypothesis"]).describe("sourced ONLY if the finding is directly supported by a search result you cite in sourceUrls"),
      sourceUrls: z.array(z.string()).describe("URLs from the research notes' sources that support this finding; empty for hypotheses"),
      evidence: z.string().describe("Short paraphrase of what the source says; for hypotheses, the reasoning"),
      confidence: z.enum(["low", "medium", "high"]),
    }),
  ),
  competitors: z.array(
    z.object({
      name: z.string(),
      positioning: z.string(),
      strengths: z.array(z.string()),
      weaknesses: z.array(z.string()),
      contentApproach: z.string(),
      opportunity: z.string().describe("Where this brand can win against them"),
      basis: z.enum(["sourced", "brand_data", "hypothesis"]),
      sourceUrls: z.array(z.string()),
    }),
  ),
  openQuestions: z.array(z.string()).describe("What we couldn't verify and the brand should confirm"),
});
export type ResearchAI = z.infer<typeof ResearchAI>;

export type ResearchSourceRef = { url: string; title: string; publishedAt: string | null; retrievedAt: string };
export type ResearchFinding = ResearchAI["findings"][number] & {
  id: string;
  /** Server-verified: at least one cited URL is a search result we actually received. */
  verified: boolean;
  /** URLs the model cited that were NOT in the search results (stripped, kept for transparency). */
  unmatchedUrls: string[];
  /** A number/percentage appears in an unverified finding. Flagged in the UI. */
  unsourcedFigure: boolean;
};
export type CompetitorInsight = ResearchAI["competitors"][number] & { id: string; verified: boolean; unmatchedUrls: string[] };
export type ResearchSection = {
  mode: "web_search" | "no_search";
  /** Why research ran without web search, when it did. */
  modeNote?: string;
  summary: string;
  industryOverview: string;
  findings: ResearchFinding[];
  competitors: CompetitorInsight[];
  openQuestions: string[];
  sources: ResearchSourceRef[];
  webSearches: number;
};

// ---------------------------------------------------------------------------
// B. Audience intelligence
// ---------------------------------------------------------------------------

export const PersonaAI = z.object({
  name: z.string().describe("A memorable persona label, e.g. 'The Considered Gifter'"),
  summary: z.string(),
  demographics: z.string().describe("Only what the evidence supports; otherwise say 'Not established'"),
  demographicsBasis: z.enum(["brand_data", "research", "assumption"]),
  interests: z.array(z.string()),
  needs: z.array(z.string()),
  painPoints: z.array(z.string()),
  motivations: z.array(z.string()),
  objections: z.array(z.string()),
  contentPreferences: z.array(z.string()),
  platforms: z.array(platform),
  engagementOpportunities: z.array(z.string()),
});
export const AudienceAI = z.object({
  overview: z.string(),
  segments: z.array(z.object({ name: z.string(), description: z.string(), priority: z.enum(["primary", "secondary", "emerging"]) })),
  personas: z.array(PersonaAI),
  insights: z.array(z.string()),
});
export type Persona = z.infer<typeof PersonaAI> & { id: string; approved: boolean };
export type AudienceSection = Omit<z.infer<typeof AudienceAI>, "personas"> & { personas: Persona[] };

// ---------------------------------------------------------------------------
// Objectives (business → marketing)
// ---------------------------------------------------------------------------

export const ObjectivesAI = z.object({
  businessObjectives: z.array(z.object({ objective: z.string(), measure: z.string() })),
  marketingObjectives: z.array(
    z.object({
      objective: z.string(),
      category: objective,
      supports: z.string().describe("Which business objective this serves"),
      metric: z.string(),
      target: z.string().describe("A target only if the user gave one or it is clearly labelled as a suggested starting point"),
      targetBasis: z.enum(["user_target", "suggested"]),
      timeframe: z.string(),
    }),
  ),
});
export type ObjectivesSection = Omit<z.infer<typeof ObjectivesAI>, "marketingObjectives"> & {
  marketingObjectives: (z.infer<typeof ObjectivesAI>["marketingObjectives"][number] & { id: string })[];
};

// ---------------------------------------------------------------------------
// C. Marketing strategy (13 parts across sections: see STRATEGY_PARTS)
// ---------------------------------------------------------------------------

export const StrategyAI = z.object({
  executiveSummary: z.string(),
  positioning: z.object({ statement: z.string(), pointsOfDifference: z.array(z.string()), proofPoints: z.array(z.string()) }),
  differentiation: z.array(z.object({ point: z.string(), versus: z.string(), howToShow: z.string() })),
  channels: z.array(
    z.object({ platform, role: z.string(), audience: z.string(), formats: z.array(z.string()), postsPerWeek: z.number(), bestTimes: z.array(z.string()), approach: z.string() }),
  ),
  contentStrategy: z.object({ approach: z.string(), toneGuidance: z.string(), mix: z.array(z.object({ type: z.string(), sharePercent: z.number() })), avoid: z.array(z.string()) }),
  campaignStrategy: z.object({ approach: z.string(), rhythm: z.string() }),
  engagementStrategy: z.object({ approach: z.string(), tactics: z.array(z.string()), communityGuidelines: z.array(z.string()) }),
  leadGeneration: z.object({ approach: z.string(), tactics: z.array(z.string()), offers: z.array(z.string()), notApplicableReason: z.string().describe("Empty unless lead generation genuinely doesn't apply") }),
  kpis: z.array(z.object({ name: z.string(), metric: z.string(), target: z.string(), targetBasis: z.enum(["user_target", "suggested"]), frequency: z.string(), objective: z.string() })),
  roadmap: z.array(z.object({ phase: z.string(), timing: z.string(), focus: z.string(), milestones: z.array(z.string()) })),
  accountTypeNotes: z.string().describe("How this strategy is adapted to the account type"),
  assumptions: z.array(z.string()),
  risks: z.array(z.string()),
});
export type StrategyCore = z.infer<typeof StrategyAI>;

// ---------------------------------------------------------------------------
// D. Content pillars
// ---------------------------------------------------------------------------

export const PillarAI = z.object({
  name: z.string(),
  description: z.string(),
  purpose: z.string(),
  audience: z.string().describe("Which persona(s) this serves"),
  formats: z.array(z.string()),
  topics: z.array(z.string()),
  frequency: z.string().describe("e.g. '2 posts / week'"),
  sharePercent: z.number(),
  objective,
});
export const PillarsAI = z.object({ pillars: z.array(PillarAI), rationale: z.string() });
export type Pillar = z.infer<typeof PillarAI> & { id: string; approved: boolean };
export type PillarsSection = { pillars: Pillar[]; rationale: string };
export const PILLAR_MIN = 4;
export const PILLAR_MAX = 8;

// ---------------------------------------------------------------------------
// E. Campaign ideation
// ---------------------------------------------------------------------------

export const CampaignAI = z.object({
  name: z.string(),
  kind: z.enum(CAMPAIGN_KINDS),
  objective,
  audience: z.string(),
  concept: z.string(),
  keyMessage: z.string(),
  creativeDirection: z.string(),
  formats: z.array(z.string()),
  platforms: z.array(platform),
  startDate: z.string().describe("YYYY-MM-DD"),
  durationDays: z.number(),
  cta: z.string(),
  metrics: z.array(z.string()),
});
export const CampaignsAI = z.object({ campaigns: z.array(CampaignAI) });
export type CampaignConcept = z.infer<typeof CampaignAI> & { id: string; approved: boolean };
export type CampaignsSection = { campaigns: CampaignConcept[] };

// ---------------------------------------------------------------------------
// F. 30-day content calendar
// ---------------------------------------------------------------------------

export const CalendarEntryAI = z.object({
  date: z.string().describe("YYYY-MM-DD"),
  time: z.string().describe("HH:MM 24h local"),
  platform,
  pillar: z.string(),
  objective,
  format,
  creativeConcept: z.string(),
  hook: z.string(),
  captionDirection: z.string(),
  cta: z.string(),
  hashtags: z.array(z.string()),
  campaign: z.string().describe("Exact campaign name, or empty string"),
});
export const CalendarAI = z.object({ entries: z.array(CalendarEntryAI), notes: z.string() });
export type CalendarEntry = z.infer<typeof CalendarEntryAI> & { id: string };
export type CalendarSection = { startDate: string; days: number; platforms: string[]; entries: CalendarEntry[]; notes: string; appliedAt?: string | null };
export const CALENDAR_DAYS = 30;

// ---------------------------------------------------------------------------
// Document & envelopes
// ---------------------------------------------------------------------------

export const SECTION_KEYS = ["research", "audience", "objectives", "strategy", "pillars", "campaigns", "calendar"] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];
export type SectionData = {
  research: ResearchSection;
  audience: AudienceSection;
  objectives: ObjectivesSection;
  strategy: StrategyCore;
  pillars: PillarsSection;
  campaigns: CampaignsSection;
  calendar: CalendarSection;
};

export const SECTION_META: Record<SectionKey, { label: string; agent: string; step: string; dependsOn: SectionKey[] }> = {
  research: { label: "Market research", agent: "Market Research Agent", step: "Researching the market", dependsOn: [] },
  audience: { label: "Audience & personas", agent: "Audience Intelligence Agent", step: "Building audience personas", dependsOn: ["research"] },
  objectives: { label: "Objectives", agent: "Marketing Strategy Agent", step: "Setting marketing objectives", dependsOn: ["audience"] },
  strategy: { label: "Marketing strategy", agent: "Marketing Strategy Agent", step: "Writing the marketing strategy", dependsOn: ["research", "audience", "objectives"] },
  pillars: { label: "Content pillars", agent: "Content Pillar Agent", step: "Defining content pillars", dependsOn: ["strategy", "audience"] },
  campaigns: { label: "Campaigns", agent: "Campaign Ideation Agent", step: "Ideating campaigns", dependsOn: ["strategy", "pillars"] },
  calendar: { label: "30-day calendar", agent: "Content Planning Agent", step: "Planning the 30-day calendar", dependsOn: ["pillars", "campaigns", "strategy"] },
};

/** The 13 parts of the marketing strategy and the section each lives in. */
export const STRATEGY_PARTS: { n: number; label: string; section: SectionKey }[] = [
  { n: 1, label: "Executive summary", section: "strategy" },
  { n: 2, label: "Business objectives", section: "objectives" },
  { n: 3, label: "Marketing objectives", section: "objectives" },
  { n: 4, label: "Audience", section: "audience" },
  { n: 5, label: "Positioning", section: "strategy" },
  { n: 6, label: "Differentiation", section: "strategy" },
  { n: 7, label: "Channels", section: "strategy" },
  { n: 8, label: "Content strategy", section: "strategy" },
  { n: 9, label: "Campaign strategy", section: "strategy" },
  { n: 10, label: "Engagement strategy", section: "strategy" },
  { n: 11, label: "Lead generation", section: "strategy" },
  { n: 12, label: "KPIs", section: "strategy" },
  { n: 13, label: "Roadmap", section: "strategy" },
];

export type Envelope<T> = {
  data: T;
  origin: "ai" | "user" | "mixed";
  generatedAt: string;
  runId: string | null;
  provider: string | null;
  editedAt: string | null;
  editedBy: string | null;
  /** An upstream section changed after this one was generated. */
  stale: boolean;
};

export type StrategyDoc = {
  schemaVersion: 2;
  inputs: StrategyInputs;
  /** Assumptions the user accepted instead of answering a question. */
  assumptions: string[];
  /** The Brand Intelligence Profile this strategy was built from. */
  profileRef: { id: string; version: number } | null;
  sections: { [K in SectionKey]?: Envelope<SectionData[K]> };
};

export function emptyDoc(inputs: StrategyInputs, assumptions: string[], profileRef: StrategyDoc["profileRef"]): StrategyDoc {
  return { schemaVersion: 2, inputs, assumptions, profileRef, sections: {} };
}

export function isDocV2(data: unknown, schemaVersion?: number): data is StrategyDoc {
  return schemaVersion === 2 || (typeof data === "object" && data !== null && (data as { schemaVersion?: unknown }).schemaVersion === 2);
}

/** Sections that depend (directly or transitively) on `key`. */
export function downstreamOf(key: SectionKey): SectionKey[] {
  const out = new Set<SectionKey>();
  const visit = (k: SectionKey) => {
    for (const s of SECTION_KEYS) {
      if (SECTION_META[s].dependsOn.includes(k) && !out.has(s)) {
        out.add(s);
        visit(s);
      }
    }
  };
  visit(key);
  return SECTION_KEYS.filter((s) => out.has(s));
}

export function missingSections(doc: StrategyDoc): SectionKey[] {
  return SECTION_KEYS.filter((k) => !doc.sections[k]);
}

// ---------------------------------------------------------------------------
// User edits: schemas for what the client may send. Strict, length-bounded.
// ---------------------------------------------------------------------------

const S = (max = 2000) => z.string().trim().max(max);
const L = (maxItems = 20, max = 400) => z.array(z.string().trim().min(1).max(max)).max(maxItems);
const Id = z.string().max(64);

export const EDIT_SCHEMAS = {
  research: z.object({
    summary: S(4000),
    industryOverview: S(6000),
    openQuestions: L(20, 600),
    findings: z.array(z.object({ id: Id, title: S(300), detail: S(2000) })).max(80),
    competitors: z.array(z.object({ id: Id, positioning: S(1000), contentApproach: S(1000), opportunity: S(1000), strengths: L(), weaknesses: L() })).max(30),
  }),
  audience: z.object({
    overview: S(4000),
    insights: L(20, 600),
    segments: z.array(z.object({ name: S(200), description: S(1000), priority: z.enum(["primary", "secondary", "emerging"]) })).max(12),
    personas: z
      .array(
        z.object({
          id: Id.optional(),
          name: S(200).min(1),
          summary: S(1500),
          demographics: S(800),
          demographicsBasis: z.enum(["brand_data", "research", "assumption"]),
          interests: L(),
          needs: L(),
          painPoints: L(),
          motivations: L(),
          objections: L(),
          contentPreferences: L(),
          platforms: z.array(platform).max(6),
          engagementOpportunities: L(),
        }),
      )
      .max(8),
  }),
  objectives: z.object({
    businessObjectives: z.array(z.object({ objective: S(400).min(1), measure: S(400) })).max(10),
    marketingObjectives: z
      .array(z.object({ id: Id.optional(), objective: S(400).min(1), category: objective, supports: S(400), metric: S(300), target: S(200), targetBasis: z.enum(["user_target", "suggested"]), timeframe: S(200) }))
      .max(12),
  }),
  strategy: z.object({
    executiveSummary: S(6000),
    positioning: z.object({ statement: S(2000), pointsOfDifference: L(), proofPoints: L() }),
    differentiation: z.array(z.object({ point: S(400), versus: S(400), howToShow: S(800) })).max(12),
    channels: z.array(z.object({ platform, role: S(400), audience: S(400), formats: L(10, 100), postsPerWeek: z.number().min(0).max(50), bestTimes: L(10, 40), approach: S(1500) })).max(6),
    contentStrategy: z.object({ approach: S(3000), toneGuidance: S(2000), mix: z.array(z.object({ type: S(100), sharePercent: z.number().min(0).max(100) })).max(12), avoid: L() }),
    campaignStrategy: z.object({ approach: S(3000), rhythm: S(1000) }),
    engagementStrategy: z.object({ approach: S(3000), tactics: L(), communityGuidelines: L() }),
    leadGeneration: z.object({ approach: S(3000), tactics: L(), offers: L(), notApplicableReason: S(1000) }),
    kpis: z.array(z.object({ name: S(200), metric: S(300), target: S(200), targetBasis: z.enum(["user_target", "suggested"]), frequency: S(100), objective: S(300) })).max(20),
    roadmap: z.array(z.object({ phase: S(200), timing: S(200), focus: S(1000), milestones: L() })).max(12),
    accountTypeNotes: S(2000),
    assumptions: L(30, 600),
    risks: L(20, 600),
  }),
  pillars: z.object({
    rationale: S(3000),
    pillars: z
      .array(
        z.object({
          id: Id.optional(),
          name: S(120).min(1),
          description: S(1000),
          purpose: S(600),
          audience: S(400),
          formats: L(10, 100),
          topics: L(20, 300),
          frequency: S(100),
          sharePercent: z.number().min(0).max(100),
          objective,
        }),
      )
      .max(PILLAR_MAX),
  }),
  campaigns: z.object({
    campaigns: z
      .array(
        z.object({
          id: Id.optional(),
          name: S(200).min(1),
          kind: z.enum(CAMPAIGN_KINDS),
          objective,
          audience: S(400),
          concept: S(2000),
          keyMessage: S(600),
          creativeDirection: S(2000),
          formats: L(10, 100),
          platforms: z.array(platform).max(6),
          startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          durationDays: z.number().int().min(1).max(120),
          cta: S(300),
          metrics: L(10, 200),
        }),
      )
      .max(12),
  }),
} as const;
export type EditableSection = keyof typeof EDIT_SCHEMAS;

export const CalendarEntryEdit = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{2}:\d{2}$/),
  platform,
  pillar: S(120),
  objective,
  format,
  creativeConcept: S(1500).min(1),
  hook: S(400),
  captionDirection: S(1500),
  cta: S(300),
  hashtags: z.array(z.string().trim().min(1).max(60)).max(30),
  campaign: S(200),
});
export type CalendarEntryEdit = z.infer<typeof CalendarEntryEdit>;

// ---------------------------------------------------------------------------
// Validation helpers used after generation (server) and in the UI
// ---------------------------------------------------------------------------

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Entries that repeat another entry's hook or concept on a different platform (or the same one). */
export function duplicateEntries(entries: Pick<CalendarEntry, "hook" | "creativeConcept" | "platform">[]): number[] {
  const seenHook = new Map<string, number>();
  const seenConcept = new Map<string, number>();
  const dups: number[] = [];
  entries.forEach((e, i) => {
    const h = norm(e.hook);
    const c = norm(e.creativeConcept);
    if ((h && seenHook.has(h)) || (c && seenConcept.has(c))) dups.push(i);
    if (h) seenHook.set(h, i);
    if (c) seenConcept.set(c, i);
  });
  return dups;
}

export function calendarIssues(entries: CalendarEntryAIType[], opts: { startDate: string; days: number; platforms: string[]; pillars: string[] }): string[] {
  const issues: string[] = [];
  const start = Date.parse(`${opts.startDate}T00:00:00Z`);
  const end = start + (opts.days - 1) * 864e5;
  const pillarSet = new Set(opts.pillars.map(norm));
  entries.forEach((e, i) => {
    const t = Date.parse(`${e.date}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date) || Number.isNaN(t) || t < start || t > end) issues.push(`Entry ${i + 1} (${e.date}) is outside ${opts.startDate} + ${opts.days} days.`);
    if (!opts.platforms.includes(e.platform)) issues.push(`Entry ${i + 1} uses ${e.platform}, which isn't one of the selected platforms (${opts.platforms.join(", ")}).`);
    if (pillarSet.size && !pillarSet.has(norm(e.pillar))) issues.push(`Entry ${i + 1} uses pillar "${e.pillar}", which isn't one of the defined pillars.`);
  });
  for (const i of duplicateEntries(entries)) issues.push(`Entry ${i + 1} repeats the hook or concept of an earlier entry; every post (including cross-platform versions) needs its own angle.`);
  return issues;
}
type CalendarEntryAIType = z.infer<typeof CalendarEntryAI>;

const FIGURE = /(\d+(\.\d+)?\s?%|\$\s?\d|€\s?\d|£\s?\d|₹\s?\d|\b\d{1,3}(,\d{3})+\b|\b\d+(\.\d+)?\s?(million|billion|bn|m|k)\b)/i;
export function hasFigure(s: string) {
  return FIGURE.test(s);
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

export type SectionDiff = { section: SectionKey; status: "added" | "removed" | "changed" | "same"; changes: { path: string; before: string; after: string }[] };

function flatten(v: unknown, prefix = "", out: Record<string, string> = {}): Record<string, string> {
  if (Array.isArray(v)) {
    if (v.every((x) => typeof x !== "object" || x === null)) out[prefix] = v.join(" · ");
    else v.forEach((x, i) => flatten(x, `${prefix}[${labelOf(x) ?? i + 1}]`, out));
  } else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (k === "id" || k === "verified" || k === "unmatchedUrls" || k === "unsourcedFigure") continue;
      flatten(x, prefix ? `${prefix}.${k}` : k, out);
    }
  } else if (v !== undefined && v !== null && v !== "") out[prefix] = String(v);
  return out;
}
function labelOf(x: unknown): string | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  const l = o.name ?? o.title ?? (o.date && o.platform ? `${o.date} ${o.platform}` : null) ?? o.objective ?? o.phase;
  return typeof l === "string" ? l.slice(0, 40) : null;
}

/** Field-level differences between two strategy documents, per section. */
export function compareDocs(a: StrategyDoc, b: StrategyDoc): SectionDiff[] {
  return SECTION_KEYS.map((section) => {
    const x = a.sections[section]?.data;
    const y = b.sections[section]?.data;
    if (!x && !y) return { section, status: "same" as const, changes: [] };
    if (!x) return { section, status: "added" as const, changes: [] };
    if (!y) return { section, status: "removed" as const, changes: [] };
    const fx = flatten(x);
    const fy = flatten(y);
    const keys = [...new Set([...Object.keys(fx), ...Object.keys(fy)])];
    const changes = keys.filter((k) => fx[k] !== fy[k]).map((k) => ({ path: k, before: fx[k] ?? "", after: fy[k] ?? "" }));
    return { section, status: changes.length ? ("changed" as const) : ("same" as const), changes: changes.slice(0, 200) };
  });
}

// ---------------------------------------------------------------------------
// Legacy (schemaVersion 1) compatibility for dashboard / campaign / content studio
// ---------------------------------------------------------------------------

export type StrategySummary = {
  pillars: { name: string; sharePercent: number; description: string }[];
  campaignIdeas: { name: string; objective: string; concept: string }[];
  moments: { date: string; name: string; idea: string }[];
};

/** A small, version-independent view of a strategy for screens that only need the headline. */
export function summarizeStrategy(data: unknown, schemaVersion?: number): StrategySummary {
  if (isDocV2(data, schemaVersion)) {
    const pillars = data.sections.pillars?.data.pillars ?? [];
    const campaigns = data.sections.campaigns?.data.campaigns ?? [];
    return {
      pillars: pillars.map((p) => ({ name: p.name, sharePercent: p.sharePercent, description: p.description })),
      campaignIdeas: campaigns.map((c) => ({ name: c.name, objective: c.objective, concept: c.concept })),
      moments: campaigns.filter((c) => c.kind === "seasonal").map((c) => ({ date: c.startDate, name: c.name, idea: c.concept })),
    };
  }
  const d = (data ?? {}) as { pillars?: { name: string; sharePercent: number; description: string }[]; campaignIdeas?: { name: string; objective: string; concept: string }[]; moments?: { date: string; name: string; idea: string }[] };
  return { pillars: d.pillars ?? [], campaignIdeas: d.campaignIdeas ?? [], moments: d.moments ?? [] };
}

export const STATUS_META: Record<string, { label: string; tone: string }> = {
  draft: { label: "Draft", tone: "neutral" },
  under_review: { label: "Under review", tone: "warn" },
  approved: { label: "Approved", tone: "success" },
  archived: { label: "Archived", tone: "outline" },
};
