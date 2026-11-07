import { z } from "zod";
import { FORMAT_IDS, OBJECTIVES, PLATFORM_IDS, STYLE_IDS } from "@/lib/domain";

// Note: these schemas are sent to Claude as structured-output JSON Schemas. Keep them to
// plain objects/arrays/enums (no numeric/length constraints) so they stay within the
// supported subset; length guidance lives in the prompts.

const platform = z.enum(PLATFORM_IDS);
const format = z.enum(FORMAT_IDS);
const objective = z.enum(OBJECTIVES);

export const AssetAnalysis = z.object({
  description: z.string(),
  palette: z.array(z.string()).describe("hex colours, most dominant first"),
  typography: z.string(),
  aesthetic: z.string(),
  notableElements: z.array(z.string()),
});
export type AssetAnalysis = z.infer<typeof AssetAnalysis>;

export const BrandProfile = z.object({
  summary: z.string(),
  personality: z.object({ archetype: z.string(), traits: z.array(z.string()), description: z.string() }),
  positioning: z.object({ statement: z.string(), category: z.string(), differentiators: z.array(z.string()) }),
  usps: z.array(z.string()),
  personas: z.array(
    z.object({
      name: z.string(),
      snapshot: z.string(),
      goals: z.array(z.string()),
      painPoints: z.array(z.string()),
      channels: z.array(z.string()),
    }),
  ),
  painPoints: z.array(z.string()),
  voice: z.object({
    description: z.string(),
    do: z.array(z.string()),
    dont: z.array(z.string()),
    vocabulary: z.array(z.string()),
    sampleLines: z.array(z.string()),
  }),
  visualIdentity: z.object({
    palette: z.array(z.object({ hex: z.string(), name: z.string(), usage: z.string() })),
    typography: z.object({ heading: z.string(), body: z.string(), notes: z.string() }),
    imagery: z.string(),
    layout: z.string(),
    logoUsage: z.string(),
  }),
  preferredStyles: z.array(z.enum(STYLE_IDS)),
  competitorPositioning: z.array(z.object({ name: z.string(), positioning: z.string(), howWeDiffer: z.string() })),
  contentOpportunities: z.array(z.object({ title: z.string(), why: z.string() })),
  rationale: z.string(),
});
export type BrandProfile = z.infer<typeof BrandProfile>;

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
