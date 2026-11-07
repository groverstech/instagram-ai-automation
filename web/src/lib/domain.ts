export const PLATFORMS = [
  { id: "instagram", label: "Instagram", color: "#E1306C" },
  { id: "facebook", label: "Facebook", color: "#1877F2" },
  { id: "linkedin", label: "LinkedIn", color: "#0A66C2" },
  { id: "youtube", label: "YouTube", color: "#FF0000" },
  { id: "pinterest", label: "Pinterest", color: "#E60023" },
  { id: "tiktok", label: "TikTok", color: "#111111" },
] as const;
export type PlatformId = (typeof PLATFORMS)[number]["id"];
export const PLATFORM_IDS = PLATFORMS.map((p) => p.id) as [PlatformId, ...PlatformId[]];
export const platformLabel = (id: string) => PLATFORMS.find((p) => p.id === id)?.label ?? id;
export const platformColor = (id: string) => PLATFORMS.find((p) => p.id === id)?.color ?? "#888";

export const FORMATS = [
  { id: "instagram_post", label: "Instagram post", w: 1080, h: 1350, platform: "instagram" },
  { id: "instagram_square", label: "Instagram square", w: 1080, h: 1080, platform: "instagram" },
  { id: "instagram_carousel", label: "Instagram carousel", w: 1080, h: 1350, platform: "instagram" },
  { id: "instagram_story", label: "Instagram story", w: 1080, h: 1920, platform: "instagram" },
  { id: "facebook_post", label: "Facebook creative", w: 1200, h: 1200, platform: "facebook" },
  { id: "linkedin_post", label: "LinkedIn post", w: 1200, h: 1200, platform: "linkedin" },
  { id: "banner", label: "Promotional banner", w: 1600, h: 900, platform: "facebook" },
  { id: "product_ad", label: "Product advertisement", w: 1080, h: 1080, platform: "instagram" },
  { id: "event", label: "Event announcement", w: 1080, h: 1350, platform: "instagram" },
  { id: "festival", label: "Festival creative", w: 1080, h: 1350, platform: "instagram" },
  { id: "youtube_thumbnail", label: "YouTube thumbnail", w: 1280, h: 720, platform: "youtube" },
  { id: "pinterest_pin", label: "Pinterest pin", w: 1000, h: 1500, platform: "pinterest" },
] as const;
export type FormatId = (typeof FORMATS)[number]["id"];
export const FORMAT_IDS = FORMATS.map((f) => f.id) as [FormatId, ...FormatId[]];
export const formatById = (id: string) => FORMATS.find((f) => f.id === id) ?? FORMATS[0];

export const STYLES = [
  { id: "minimalist_luxury", label: "Minimalist luxury", hint: "vast negative space, hairline type, muted tones, one hero object" },
  { id: "premium_editorial", label: "Premium editorial", hint: "magazine grid, serif display type, art-directed photography" },
  { id: "modern_corporate", label: "Modern corporate", hint: "clean geometry, confident sans type, structured information" },
  { id: "bold_vibrant", label: "Bold & vibrant", hint: "saturated colour blocks, oversized type, high contrast" },
  { id: "clean_sophisticated", label: "Clean & sophisticated", hint: "balanced whitespace, soft light, refined palette" },
  { id: "artistic_experimental", label: "Artistic & experimental", hint: "unexpected crops, layered textures, expressive type" },
  { id: "playful_youthful", label: "Playful & youthful", hint: "rounded shapes, cheerful colour, casual voice" },
  { id: "luxury_lifestyle", label: "Luxury lifestyle", hint: "aspirational scenes, warm golden light, cinematic depth" },
] as const;
export type StyleId = (typeof STYLES)[number]["id"];
export const STYLE_IDS = STYLES.map((s) => s.id) as [StyleId, ...StyleId[]];
export const styleById = (id: string) => STYLES.find((s) => s.id === id) ?? STYLES[0];

export const OBJECTIVES = ["awareness", "engagement", "education", "lead_generation", "sales", "community"] as const;
export type Objective = (typeof OBJECTIVES)[number];
export const objectiveLabel = (o: string) =>
  ({ awareness: "Brand awareness", engagement: "Engagement", education: "Education", lead_generation: "Lead generation", sales: "Sales", community: "Community" })[o] ?? o;

export const CAMPAIGN_TYPES = ["launch", "promotion", "awareness", "seasonal", "engagement", "other"] as const;

export const POST_STATUS_META: Record<string, { label: string; tone: string }> = {
  draft: { label: "Draft", tone: "neutral" },
  pending_approval: { label: "Needs approval", tone: "warn" },
  approved: { label: "Approved", tone: "info" },
  scheduled: { label: "Scheduled", tone: "accent" },
  publishing: { label: "Publishing", tone: "accent" },
  published: { label: "Published", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
};
