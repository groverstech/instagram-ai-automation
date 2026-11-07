import { z } from "zod";
import { FORMAT_IDS, OBJECTIVES, PLATFORM_IDS } from "@/lib/domain";

// Note: these schemas are sent to Claude as structured-output JSON Schemas. Keep them to
// plain objects/arrays/enums (no numeric/length constraints) so they stay within the
// supported subset; length guidance lives in the prompts.

const platform = z.enum(PLATFORM_IDS);
const format = z.enum(FORMAT_IDS);
const objective = z.enum(OBJECTIVES);

export const AssetAnalysis = z.object({
  description: z.string(),
  palette: z.array(z.string()).describe("hex colours, most dominant first; empty for text documents"),
  typography: z.string(),
  aesthetic: z.string(),
  notableElements: z.array(z.string()),
  extractedFacts: z.array(z.string()).describe("Explicit brand facts or rules stated in the asset (values, tone rules, colour codes, logo rules, audience, claims)"),
});
export type AssetAnalysis = z.infer<typeof AssetAnalysis>;

// The Brand Intelligence Profile schema (v2) lives in @/lib/brand-profile; re-exported for agents.
export { BrandProfileV2 as BrandProfile } from "@/lib/brand-profile";

export const BrandAnswer = z.object({
  answer: z.string().describe("Plain-text answer, short paragraphs or simple '- ' bullets"),
  basis: z.enum(["brand_knowledge", "mixed", "general_guidance"]),
  usedSections: z.array(z.enum(["identity", "audience", "communication", "visual", "marketing", "memory", "assets"])),
  unconfirmed: z.boolean().describe("True if the answer relies on AI suggestions the user hasn't confirmed"),
  missingInfo: z.array(z.string()).describe("Brand information that would improve this answer"),
  followUps: z.array(z.string()),
});
export type BrandAnswer = z.infer<typeof BrandAnswer>;

/** Legacy (schemaVersion 1) monthly strategy. New strategies use src/lib/strategy.ts. */
export const Strategy = z.object({
  summary: z.string(),
  monthlyFocus: z.string(),
  pillars: z.array(
    z.object({ name: z.string(), description: z.string(), sharePercent: z.number(), exampleIdeas: z.array(z.string()) }),
  ),
  cadence: z.array(
    z.object({ platform, postsPerWeek: z.number(), bestTimes: z.array(z.string()), formats: z.array(z.string()), approach: z.string() }),
  ),
  trends: z.array(z.object({ trend: z.string(), relevance: z.string(), howToUse: z.string() })),
  moments: z.array(z.object({ date: z.string().describe("YYYY-MM-DD"), name: z.string(), idea: z.string() })),
  campaignIdeas: z.array(z.object({ name: z.string(), objective, concept: z.string() })),
  promotions: z.array(z.string()),
  engagementTactics: z.array(z.string()),
  collaborations: z.array(z.object({ type: z.string(), profile: z.string(), idea: z.string() })),
  kpis: z.array(z.string()),
  rationale: z.string(),
});
export type Strategy = z.infer<typeof Strategy>;

export const PlannedPost = z.object({
  date: z.string().describe("YYYY-MM-DD"),
  time: z.string().describe("HH:MM 24h, local to the brand's market"),
  platform,
  format,
  pillar: z.string(),
  objective,
  title: z.string(),
  brief: z.string(),
  rationale: z.string(),
});
export type PlannedPost = z.infer<typeof PlannedPost>;
export const CalendarPlan = z.object({ posts: z.array(PlannedPost), rationale: z.string() });
export type CalendarPlan = z.infer<typeof CalendarPlan>;

export const Copy = z.object({
  primary: z.string(),
  alternatives: z.array(z.string()),
  short: z.string(),
  long: z.string(),
  hooks: z.array(z.string()),
  cta: z.string(),
  hashtags: z.array(z.string()),
  keywords: z.array(z.string()),
  platformVariants: z.array(z.object({ platform, copy: z.string() })),
  rationale: z.string(),
});
export type Copy = z.infer<typeof Copy>;

export const LAYOUTS = ["hero_overlay", "split", "frame", "typographic", "editorial_column", "badge"] as const;

export const CreativeConcept = z.object({
  title: z.string(),
  headline: z.string(),
  subline: z.string(),
  cta: z.string(),
  layout: z.enum(LAYOUTS),
  palette: z.object({ background: z.string(), foreground: z.string(), accent: z.string() }),
  imagePrompt: z.string(),
  imageTreatment: z.string(),
  rationale: z.string(),
});
export type CreativeConcept = z.infer<typeof CreativeConcept>;
export const CreativeConcepts = z.object({ concepts: z.array(CreativeConcept) });

export const CampaignPlan = z.object({
  name: z.string(),
  theme: z.string(),
  bigIdea: z.string(),
  audience: z.string(),
  keyMessages: z.array(z.string()),
  phases: z.array(z.object({ name: z.string(), startDay: z.number(), endDay: z.number(), goal: z.string() })),
  posts: z.array(
    z.object({
      day: z.number().describe("0-based day offset from campaign start"),
      time: z.string(),
      platform,
      format,
      pillar: z.string(),
      objective,
      title: z.string(),
      brief: z.string(),
    }),
  ),
  kpis: z.array(z.string()),
  rationale: z.string(),
});
export type CampaignPlan = z.infer<typeof CampaignPlan>;

export const Insights = z.object({
  summary: z.string(),
  findings: z.array(
    z.object({ title: z.string(), detail: z.string(), evidence: z.string(), confidence: z.enum(["high", "medium", "low"]) }),
  ),
  recommendations: z.array(z.object({ action: z.string(), why: z.string(), expectedImpact: z.string() })),
  nextContent: z.array(z.object({ title: z.string(), platform, pillar: z.string(), why: z.string() })),
  dataNotes: z.string(),
});
export type Insights = z.infer<typeof Insights>;

export const CompetitorAnalysis = z.object({
  summary: z.string(),
  positioning: z.string(),
  contentThemes: z.array(z.string()),
  creativeStyles: z.array(z.string()),
  postingPatterns: z.string(),
  engagementPatterns: z.string(),
  campaignApproaches: z.array(z.string()),
  strengths: z.array(z.string()),
  weaknesses: z.array(z.string()),
  contentGaps: z.array(z.string()),
  differentiation: z.array(z.object({ move: z.string(), why: z.string() })),
  confidenceNote: z.string(),
});
export type CompetitorAnalysis = z.infer<typeof CompetitorAnalysis>;

export const ContentIdeas = z.object({
  ideas: z.array(
    z.object({ title: z.string(), platform, format, pillar: z.string(), objective, hook: z.string(), why: z.string() }),
  ),
});
export type ContentIdeas = z.infer<typeof ContentIdeas>;
