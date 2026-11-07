import { z } from "zod";
import { PLATFORM_IDS, STYLE_IDS } from "@/lib/domain";

/**
 * Brand Intelligence Profile, schema v2.
 *
 * Every finding carries its provenance so the product never presents a guess as a fact:
 *   provided  – stated by the user (onboarding answers, edits)
 *   observed  – read from their website or uploaded assets
 *   inferred  – an AI suggestion that needs the user's confirmation
 * When a user edits or confirms an item it becomes "provided".
 *
 * This file is shared by the server (structured-output schema), the UI and tests.
 * Keep the schema inside Claude's structured-output subset: no length/number constraints.
 */

export const SOURCES = ["provided", "observed", "inferred"] as const;
export type Source = (typeof SOURCES)[number];
const source = z.enum(SOURCES);

export const Finding = z.object({
  text: z.string(),
  source,
  evidence: z.string().describe("Where this comes from: the onboarding field, URL, asset name, or why it was inferred"),
});
export type Finding = z.infer<typeof Finding>;

const COLOR_ROLES = ["primary", "secondary", "accent", "neutral", "background"] as const;

export const BrandProfileV2 = z.object({
  summary: z.string(),
  identity: z.object({
    archetype: z.string(),
    personality: z.array(Finding),
    positioning: z.object({ statement: z.string(), category: z.string(), source, evidence: z.string() }),
    values: z.array(Finding),
    usps: z.array(Finding),
    differentiation: z.array(Finding),
  }),
  audience: z.object({
    personas: z.array(
      z.object({
        name: z.string(),
        snapshot: z.string(),
        demographics: z.string().describe("Only what was provided or can be reliably inferred; say 'Not specified' otherwise"),
        interests: z.array(z.string()),
        painPoints: z.array(z.string()),
        motivations: z.array(z.string()),
        channels: z.array(z.string()),
        source,
      }),
    ),
    interests: z.array(Finding),
    painPoints: z.array(Finding),
    motivations: z.array(Finding),
  }),
  communication: z.object({
    voice: Finding,
    tone: Finding,
    style: Finding,
    vocabulary: z.array(z.string()),
    avoid: z.array(z.string()).describe("Words, phrases and topics to avoid"),
    do: z.array(z.string()),
    dont: z.array(z.string()),
    sampleLines: z.array(z.string()),
  }),
  visual: z.object({
    palette: z.array(z.object({ hex: z.string(), name: z.string(), role: z.enum(COLOR_ROLES), usage: z.string(), source })),
    typography: z.object({ heading: z.string(), body: z.string(), characteristics: z.string(), source }),
    imagery: Finding,
    designPreferences: z.array(Finding),
    logoUsage: Finding,
    creativeDirection: z.string(),
    preferredStyles: z.array(z.enum(STYLE_IDS)),
  }),
  marketing: z.object({
    objectives: z.array(Finding),
    contentPillars: z.array(z.object({ name: z.string(), description: z.string(), source })),
    campaignOpportunities: z.array(z.object({ title: z.string(), why: z.string(), source })),
    platforms: z.array(z.object({ platform: z.enum(PLATFORM_IDS), role: z.string(), why: z.string(), source })),
    contentOpportunities: z.array(z.object({ title: z.string(), why: z.string(), source })),
  }),
  competitors: z.array(z.object({ name: z.string(), positioning: z.string(), howWeDiffer: z.string(), source })),
  openQuestions: z.array(z.string()).describe("What couldn't be determined and the user should answer"),
  rationale: z.string(),
});
export type BrandProfileV2 = z.infer<typeof BrandProfileV2>;

export const SECTIONS = [
  { id: "identity", label: "Brand identity", hint: "Personality, positioning, values, USPs, differentiation" },
  { id: "audience", label: "Target audience", hint: "Personas, interests, pain points, motivations" },
  { id: "communication", label: "Communication", hint: "Voice, tone, vocabulary, words to avoid" },
  { id: "visual", label: "Visual identity", hint: "Colours, typography, imagery, logo usage" },
  { id: "marketing", label: "Marketing intelligence", hint: "Objectives, pillars, campaigns, platforms" },
] as const;
export type SectionId = (typeof SECTIONS)[number]["id"];
export type SectionStatus = Partial<Record<SectionId, "confirmed" | "needs_review">>;

// ---------------------------------------------------------------------------
// Reading stored profiles (v1 → v2)
// ---------------------------------------------------------------------------

type V1 = {
  summary?: string;
  personality?: { archetype?: string; traits?: string[]; description?: string };
  positioning?: { statement?: string; category?: string; differentiators?: string[] };
  usps?: string[];
  personas?: { name: string; snapshot: string; goals?: string[]; painPoints?: string[]; channels?: string[] }[];
  painPoints?: string[];
  voice?: { description?: string; do?: string[]; dont?: string[]; vocabulary?: string[]; sampleLines?: string[] };
  visualIdentity?: {
    palette?: { hex: string; name: string; usage: string }[];
    typography?: { heading?: string; body?: string; notes?: string };
    imagery?: string;
    layout?: string;
    logoUsage?: string;
  };
  preferredStyles?: string[];
  competitorPositioning?: { name: string; positioning: string; howWeDiffer: string }[];
  contentOpportunities?: { title: string; why: string }[];
  rationale?: string;
};

const inferred = (text: string, evidence = "Generated by an earlier profile version"): Finding => ({ text, source: "inferred", evidence });

/** Convert an original (v1) profile into v2. Everything is marked as an unconfirmed AI suggestion. */
export function upgradeV1(v1: V1): BrandProfileV2 {
  const roles = ["primary", "background", "accent", "secondary", "neutral"] as const;
  return {
    summary: v1.summary ?? "",
    identity: {
      archetype: v1.personality?.archetype ?? "",
      personality: (v1.personality?.traits ?? []).map((t) => inferred(t)),
      positioning: { statement: v1.positioning?.statement ?? "", category: v1.positioning?.category ?? "", source: "inferred", evidence: "Earlier profile version" },
      values: [],
      usps: (v1.usps ?? []).map((t) => inferred(t)),
      differentiation: (v1.positioning?.differentiators ?? []).map((t) => inferred(t)),
    },
    audience: {
      personas: (v1.personas ?? []).map((p) => ({
        name: p.name,
        snapshot: p.snapshot,
        demographics: "Not specified",
        interests: [],
        painPoints: p.painPoints ?? [],
        motivations: p.goals ?? [],
        channels: p.channels ?? [],
        source: "inferred" as const,
      })),
      interests: [],
      painPoints: (v1.painPoints ?? []).map((t) => inferred(t)),
      motivations: [],
    },
    communication: {
      voice: inferred(v1.voice?.description ?? ""),
      tone: inferred(v1.voice?.description ?? ""),
      style: inferred(""),
      vocabulary: v1.voice?.vocabulary ?? [],
      avoid: v1.voice?.dont ?? [],
      do: v1.voice?.do ?? [],
      dont: v1.voice?.dont ?? [],
      sampleLines: v1.voice?.sampleLines ?? [],
    },
    visual: {
      palette: (v1.visualIdentity?.palette ?? []).map((c, i) => ({ ...c, role: roles[i] ?? "neutral", source: "inferred" as const })),
      typography: {
        heading: v1.visualIdentity?.typography?.heading ?? "",
        body: v1.visualIdentity?.typography?.body ?? "",
        characteristics: v1.visualIdentity?.typography?.notes ?? "",
        source: "inferred",
      },
      imagery: inferred(v1.visualIdentity?.imagery ?? ""),
      designPreferences: v1.visualIdentity?.layout ? [inferred(v1.visualIdentity.layout)] : [],
      logoUsage: inferred(v1.visualIdentity?.logoUsage ?? ""),
      creativeDirection: "",
      preferredStyles: (v1.preferredStyles ?? []).filter((s): s is (typeof STYLE_IDS)[number] => (STYLE_IDS as readonly string[]).includes(s)),
    },
    marketing: {
      objectives: [],
      contentPillars: [],
      campaignOpportunities: [],
      platforms: [],
      contentOpportunities: (v1.contentOpportunities ?? []).map((o) => ({ ...o, source: "inferred" as const })),
    },
    competitors: (v1.competitorPositioning ?? []).map((c) => ({ ...c, source: "inferred" as const })),
    openQuestions: [],
    rationale: v1.rationale ?? "",
  };
}

/** Read any stored profile as v2. Throws if the data is unusable. */
export function readProfile(data: unknown, schemaVersion: number): BrandProfileV2 {
  if (schemaVersion >= 2) return BrandProfileV2.parse(data);
  return BrandProfileV2.parse(upgradeV1((data ?? {}) as V1));
}

// ---------------------------------------------------------------------------
// Provenance helpers
// ---------------------------------------------------------------------------

/** Collect every provenance-tagged item in a section (for counts, badges and review). */
export function sectionSources(p: BrandProfileV2, section: SectionId): Source[] {
  switch (section) {
    case "identity":
      return [...p.identity.personality, ...p.identity.values, ...p.identity.usps, ...p.identity.differentiation].map((f) => f.source).concat(p.identity.positioning.source);
    case "audience":
      return [...p.audience.personas.map((x) => x.source), ...[...p.audience.interests, ...p.audience.painPoints, ...p.audience.motivations].map((f) => f.source)];
    case "communication":
      return [p.communication.voice.source, p.communication.tone.source, p.communication.style.source];
    case "visual":
      return [...p.visual.palette.map((c) => c.source), p.visual.typography.source, p.visual.imagery.source, p.visual.logoUsage.source, ...p.visual.designPreferences.map((f) => f.source)];
    case "marketing":
      return [
        ...p.marketing.objectives.map((f) => f.source),
        ...p.marketing.contentPillars.map((x) => x.source),
        ...p.marketing.campaignOpportunities.map((x) => x.source),
        ...p.marketing.platforms.map((x) => x.source),
        ...p.marketing.contentOpportunities.map((x) => x.source),
      ];
  }
}

/** Mark every item in a section as user-confirmed ("provided"). Used when a section is confirmed. */
export function confirmSection(p: BrandProfileV2, section: SectionId): BrandProfileV2 {
  const c = structuredClone(p);
  const ok = <T extends { source: Source }>(x: T): T => ({ ...x, source: "provided" });
  switch (section) {
    case "identity":
      c.identity.personality = c.identity.personality.map(ok);
      c.identity.values = c.identity.values.map(ok);
      c.identity.usps = c.identity.usps.map(ok);
      c.identity.differentiation = c.identity.differentiation.map(ok);
      c.identity.positioning = ok(c.identity.positioning);
      break;
    case "audience":
      c.audience.personas = c.audience.personas.map(ok);
      c.audience.interests = c.audience.interests.map(ok);
      c.audience.painPoints = c.audience.painPoints.map(ok);
      c.audience.motivations = c.audience.motivations.map(ok);
      break;
    case "communication":
      c.communication.voice = ok(c.communication.voice);
      c.communication.tone = ok(c.communication.tone);
      c.communication.style = ok(c.communication.style);
      break;
    case "visual":
      c.visual.palette = c.visual.palette.map(ok);
      c.visual.typography = ok(c.visual.typography);
      c.visual.imagery = ok(c.visual.imagery);
      c.visual.logoUsage = ok(c.visual.logoUsage);
      c.visual.designPreferences = c.visual.designPreferences.map(ok);
      break;
    case "marketing":
      c.marketing.objectives = c.marketing.objectives.map(ok);
      c.marketing.contentPillars = c.marketing.contentPillars.map(ok);
      c.marketing.campaignOpportunities = c.marketing.campaignOpportunities.map(ok);
      c.marketing.platforms = c.marketing.platforms.map(ok);
      c.marketing.contentOpportunities = c.marketing.contentOpportunities.map(ok);
      break;
  }
  return c;
}

// ---------------------------------------------------------------------------
// Editing: unchanged items keep their provenance; new or changed items become "provided".
// ---------------------------------------------------------------------------

export const EDITED = "Edited by the brand";

export function linesToFindings(prev: Finding[], text: string): Finding[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => prev.find((p) => p.text === line) ?? { text: line, source: "provided" as const, evidence: EDITED });
}

export function editOne(prev: Finding, text: string): Finding {
  return text.trim() === prev.text ? prev : { text: text.trim(), source: "provided", evidence: EDITED };
}

// ---------------------------------------------------------------------------
// Brand Intelligence Score — an indicative completeness measure
// ---------------------------------------------------------------------------

export type ScoreInput = {
  brand: {
    name?: string | null;
    website?: string | null;
    description?: string | null;
    industry?: string | null;
    products?: string | null;
    targetAudience?: string | null;
    geography?: string | null;
    positioning?: string | null;
    personality?: string | null;
    tone?: string | null;
    objectives?: string[];
    platforms?: string[];
    competitors?: string[];
    colors?: string[];
  };
  assets: { kind: string; status: string; analyzed: boolean }[];
  profile: BrandProfileV2 | null;
  sectionStatus: SectionStatus;
  approved: boolean;
  memories: number;
};

export type ScorePart = { id: string; label: string; earned: number; max: number; tip?: string };

/**
 * Completeness of what the AI team knows about the brand, 0–100. It measures coverage and
 * confirmation, not the quality of the brand or of the AI's output.
 */
export function brandIntelligenceScore(i: ScoreInput): { score: number; parts: ScorePart[] } {
  const filled = (v: unknown) => (Array.isArray(v) ? v.length > 0 : typeof v === "string" ? v.trim().length > 0 : Boolean(v));
  const fields: [keyof ScoreInput["brand"], string][] = [
    ["name", "brand name"],
    ["website", "website"],
    ["description", "business description"],
    ["industry", "industry"],
    ["products", "products & services"],
    ["targetAudience", "target audience"],
    ["geography", "markets"],
    ["positioning", "positioning"],
    ["personality", "personality"],
    ["tone", "tone of voice"],
    ["objectives", "objectives"],
    ["platforms", "platforms"],
    ["competitors", "competitors"],
    ["colors", "brand colours"],
  ];
  const missing = fields.filter(([k]) => !filled(i.brand[k])).map(([, l]) => l);
  const inputs = Math.round((30 * (fields.length - missing.length)) / fields.length);

  const kinds = new Set(i.assets.map((a) => a.kind));
  const keyAssets = ["logo", "guideline", "product"].filter((k) => kinds.has(k)).length;
  const analyzed = i.assets.filter((a) => a.analyzed).length;
  const assets = Math.min(20, keyAssets * 5 + (i.assets.length ? Math.round((5 * analyzed) / i.assets.length) : 0));

  const profile = i.profile ? 15 : 0;
  const confirmed = SECTIONS.filter((s) => i.sectionStatus[s.id] === "confirmed").length;
  const review = Math.round((25 * confirmed) / SECTIONS.length);
  const learning = Math.min(10, (i.approved ? 5 : 0) + Math.min(5, Math.floor(i.memories / 4)));

  const parts: ScorePart[] = [
    { id: "inputs", label: "Business details", earned: inputs, max: 30, tip: missing.length ? `Add: ${missing.slice(0, 4).join(", ")}${missing.length > 4 ? "…" : ""}` : undefined },
    { id: "assets", label: "Brand assets", earned: assets, max: 20, tip: keyAssets < 3 ? `Upload ${["logo", "guideline", "product"].filter((k) => !kinds.has(k)).map((k) => (k === "guideline" ? "guidelines" : k === "product" ? "product photos" : k)).join(", ")}` : analyzed < i.assets.length ? "Some assets haven't been analysed yet" : undefined },
    { id: "profile", label: "AI profile", earned: profile, max: 15, tip: i.profile ? undefined : "Generate the Brand Intelligence Profile" },
    { id: "review", label: "Sections confirmed", earned: review, max: 25, tip: confirmed < SECTIONS.length ? `${SECTIONS.length - confirmed} section(s) still need your review` : undefined },
    { id: "learning", label: "Approval & learning", earned: learning, max: 10, tip: !i.approved ? "Approve the profile" : i.memories < 20 ? "Memory grows as you approve and edit content" : undefined },
  ];
  return { score: parts.reduce((s, p) => s + p.earned, 0), parts };
}

// ---------------------------------------------------------------------------
// Prompt rendering
// ---------------------------------------------------------------------------

/**
 * Render the profile for agent prompts. Items the user hasn't confirmed are marked so agents
 * treat them as tentative, and sections still under review are labelled as such.
 */
export function renderProfileForPrompt(p: BrandProfileV2, status: SectionStatus): string {
  const tag = (s: Source) => (s === "inferred" ? " [unconfirmed AI suggestion]" : s === "observed" ? " [observed in their materials]" : "");
  const f = (x: Finding) => (x.text ? `${x.text}${tag(x.source)}` : "");
  const list = (xs: Finding[]) => xs.map(f).filter(Boolean).join("; ");
  const head = (id: SectionId, label: string) => `## ${label}${status[id] === "confirmed" ? " (confirmed by the brand)" : " (awaiting the brand's review)"}`;
  const lines = [
    `Summary: ${p.summary}`,
    head("identity", "Brand identity"),
    `Archetype: ${p.identity.archetype}`,
    `Personality: ${list(p.identity.personality)}`,
    `Positioning: ${p.identity.positioning.statement}${tag(p.identity.positioning.source)} (category: ${p.identity.positioning.category})`,
    `Values: ${list(p.identity.values)}`,
    `USPs: ${list(p.identity.usps)}`,
    `Differentiation: ${list(p.identity.differentiation)}`,
    head("audience", "Target audience"),
    ...p.audience.personas.map(
      (x) => `Persona ${x.name}${tag(x.source)}: ${x.snapshot}. Demographics: ${x.demographics}. Interests: ${x.interests.join(", ")}. Pain points: ${x.painPoints.join(", ")}. Motivations: ${x.motivations.join(", ")}.`,
    ),
    `Audience interests: ${list(p.audience.interests)}`,
    `Pain points: ${list(p.audience.painPoints)}`,
    `Buying motivations: ${list(p.audience.motivations)}`,
    head("communication", "Communication"),
    `Voice: ${f(p.communication.voice)}`,
    `Tone: ${f(p.communication.tone)}`,
    `Style: ${f(p.communication.style)}`,
    `Preferred vocabulary: ${p.communication.vocabulary.join(", ")}`,
    `Avoid: ${p.communication.avoid.join(", ")}`,
    `Do: ${p.communication.do.join("; ")}`,
    `Don't: ${p.communication.dont.join("; ")}`,
    `Sounds like: ${p.communication.sampleLines.map((l) => `"${l}"`).join(" ")}`,
    head("visual", "Visual identity"),
    `Palette: ${p.visual.palette.map((c) => `${c.hex} ${c.name} (${c.role}: ${c.usage})${tag(c.source)}`).join("; ")}`,
    `Typography: headings ${p.visual.typography.heading}, body ${p.visual.typography.body}; ${p.visual.typography.characteristics}${tag(p.visual.typography.source)}`,
    `Imagery: ${f(p.visual.imagery)}`,
    `Design preferences: ${list(p.visual.designPreferences)}`,
    `Logo usage: ${f(p.visual.logoUsage)}`,
    `Creative direction: ${p.visual.creativeDirection}`,
    `Preferred creative styles: ${p.visual.preferredStyles.join(", ")}`,
    head("marketing", "Marketing intelligence"),
    `Objectives: ${list(p.marketing.objectives)}`,
    `Content pillars: ${p.marketing.contentPillars.map((x) => `${x.name} – ${x.description}${tag(x.source)}`).join("; ")}`,
    `Platforms: ${p.marketing.platforms.map((x) => `${x.platform}: ${x.role}${tag(x.source)}`).join("; ")}`,
    `Campaign opportunities: ${p.marketing.campaignOpportunities.map((x) => `${x.title}${tag(x.source)}`).join("; ")}`,
    `Competitors: ${p.competitors.map((c) => `${c.name} (${c.positioning}; we differ: ${c.howWeDiffer})`).join("; ")}`,
  ];
  return lines.filter((l) => !/: $/.test(l)).join("\n");
}
