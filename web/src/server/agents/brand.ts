import "server-only";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import { llm, type ImageInput } from "../ai/llm";
import { storage } from "../storage";
import { fetchPublicText } from "../web";
import { remember } from "../memory";
import { AGENTS } from "./registry";
import { runAgent, type RunScope } from "./orchestrator";
import { buildContext, latestProfile, renderContext } from "./context";
import { AssetAnalysis, BrandProfile } from "./schemas";
import type { Brand } from "../db/schema";
import { STYLE_IDS } from "@/lib/domain";
import { splitList } from "@/lib/utils";

const VISION_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** Vision pass over uploaded assets that haven't been analysed yet. */
export async function analyzeAssets(scope: RunScope, brand: Brand) {
  const db = await getDb();
  const pending = await db
    .select()
    .from(schema.brandAssets)
    .where(and(eq(schema.brandAssets.brandId, brand.id), isNull(schema.brandAssets.analysis)))
    .limit(8);
  const out: { name: string; kind: string; analysis: AssetAnalysis }[] = [];
  for (const asset of pending) {
    const isPdf = asset.mime === "application/pdf";
    if (!VISION_MIMES.has(asset.mime) && !isPdf) continue;
    const bytes = await storage.get(asset.path);
    if (bytes.length > 20 * 1024 * 1024) continue;
    const { data } = await runAgent(scope, "brand_intelligence", `Analyse ${asset.kind}: ${asset.name}`, { assetId: asset.id }, () =>
      llm().structured({
        system: AGENTS.brand_intelligence.system,
        prompt: `This is the brand's ${asset.kind} ("${asset.name}") for ${brand.name}. Describe its visual identity for a design team: what it shows, dominant colours as hex codes, typography character, overall aesthetic, and distinctive elements that must stay consistent across future creatives.${isPdf ? " It is a brand guidelines document: extract the stated rules (colours, fonts, logo usage, tone)." : ""}`,
        images: [{ mime: asset.mime as ImageInput["mime"], base64: bytes.toString("base64") }],
        schema: AssetAnalysis,
        effort: "low",
        mock: () => ({
          description: `${asset.kind} for ${brand.name}`,
          palette: brand.colors.length ? brand.colors : ["#1F1D1A", "#F4EFE8", "#B08D57"],
          typography: brand.fonts.heading ?? "Refined serif headings with clean sans body",
          aesthetic: "Calm, premium, uncluttered",
          notableElements: ["Generous negative space"],
        }),
      }),
    );
    await db.update(schema.brandAssets).set({ analysis: data }).where(eq(schema.brandAssets.id, asset.id));
    out.push({ name: asset.name, kind: asset.kind, analysis: data });
  }
  return out;
}

export async function generateBrandProfile(scope: RunScope, brand: Brand) {
  await analyzeAssets(scope, brand);
  const db = await getDb();
  const assets = await db.select().from(schema.brandAssets).where(eq(schema.brandAssets.brandId, brand.id));
  const site = brand.website ? await fetchPublicText(brand.website) : null;
  const ctx = await buildContext(brand, "brand identity, positioning, voice, visual identity");

  const assetNotes = assets
    .filter((a) => a.analysis)
    .map((a) => `- ${a.kind} "${a.name}": ${JSON.stringify(a.analysis)}`)
    .join("\n");

  const prompt = `${renderContext(ctx)}

${site ? `<website_excerpt url="${brand.website}">\n${site}\n</website_excerpt>` : "(Website could not be fetched or was not provided.)"}

${assetNotes ? `<uploaded_asset_analysis>\n${assetNotes}\n</uploaded_asset_analysis>` : "(No visual assets analysed yet.)"}

Build the Brand Intelligence Profile.
- personas: 2-3 distinct, realistic personas.
- voice.do / voice.dont: 4-6 concrete rules each; sampleLines: 3 lines written in the voice.
- visualIdentity.palette: use the brand's own colours (from inputs or assets) and give each a usage role.
- preferredStyles: 2-3 of: ${STYLE_IDS.join(", ")}.
- competitorPositioning: one entry per named competitor (empty if none named).
- contentOpportunities: 5 specific opportunities.
- rationale: what you based the profile on and what is assumed.`;

  const { runId, data } = await runAgent(scope, "brand_intelligence", "Generate Brand Intelligence Profile", { brandId: brand.id }, () =>
    llm().structured({ system: AGENTS.brand_intelligence.system, prompt, schema: BrandProfile, effort: AGENTS.brand_intelligence.effort, mock: () => mockProfile(brand) }),
  );

  const { latest } = await latestProfile(brand.id);
  const [row] = await db
    .insert(schema.brandProfiles)
    .values({ brandId: brand.id, version: (latest?.version ?? 0) + 1, status: "draft", data, runId })
    .returning();
  return row;
}

export async function saveProfileEdits(brandId: string, profileId: string, data: BrandProfile) {
  const db = await getDb();
  const parsed = BrandProfile.parse(data);
  await db
    .update(schema.brandProfiles)
    .set({ data: parsed })
    .where(and(eq(schema.brandProfiles.id, profileId), eq(schema.brandProfiles.brandId, brandId)));
}

/** Approval makes the profile the brand's source of truth and seeds long-term memory. */
export async function approveProfile(brandId: string, profileId: string, userId: string) {
  const db = await getDb();
  const [p] = await db
    .select()
    .from(schema.brandProfiles)
    .where(and(eq(schema.brandProfiles.id, profileId), eq(schema.brandProfiles.brandId, brandId)));
  if (!p) throw new Error("Profile not found");
  await db
    .update(schema.brandProfiles)
    .set({ status: "superseded" })
    .where(and(eq(schema.brandProfiles.brandId, brandId), eq(schema.brandProfiles.status, "approved"), ne(schema.brandProfiles.id, profileId)));
  await db
    .update(schema.brandProfiles)
    .set({ status: "approved", approvedBy: userId, approvedAt: new Date() })
    .where(eq(schema.brandProfiles.id, profileId));
  await db.update(schema.brands).set({ onboardingComplete: true }).where(eq(schema.brands.id, brandId));

  const d = BrandProfile.parse(p.data);
  await remember(brandId, [
    { kind: "fact", content: `Positioning: ${d.positioning.statement}`, source: "profile:approved", weight: 1.5 },
    { kind: "fact", content: `USPs: ${d.usps.join("; ")}`, source: "profile:approved", weight: 1.3 },
    { kind: "preference", content: `Voice: ${d.voice.description}. Do: ${d.voice.do.join("; ")}`, source: "profile:approved", weight: 1.5 },
    { kind: "preference", content: `Never in copy: ${d.voice.dont.join("; ")}`, source: "profile:approved", weight: 1.5 },
    { kind: "preference", content: `Visual identity: ${d.visualIdentity.imagery}. Layout: ${d.visualIdentity.layout}`, source: "profile:approved", weight: 1.3 },
    ...d.personas.map((x) => ({ kind: "fact" as const, content: `Persona ${x.name}: ${x.snapshot}. Pain points: ${x.painPoints.join("; ")}`, source: "profile:approved" })),
  ]);
}

export async function profileHistory(brandId: string) {
  const db = await getDb();
  return db
    .select({ id: schema.brandProfiles.id, version: schema.brandProfiles.version, status: schema.brandProfiles.status, createdAt: schema.brandProfiles.createdAt })
    .from(schema.brandProfiles)
    .where(eq(schema.brandProfiles.brandId, brandId))
    .orderBy(desc(schema.brandProfiles.version));
}

function mockProfile(brand: Brand): BrandProfile {
  const products = splitList(brand.products);
  const colors = brand.colors.length ? brand.colors : ["#1F1D1A", "#F4EFE8", "#B08D57"];
  return {
    summary: `${brand.name} is a ${brand.industry ?? "consumer"} brand serving ${brand.targetAudience ?? "discerning customers"} in ${brand.geography ?? "its home market"}.`,
    personality: { archetype: "The Sage", traits: splitList(brand.personality).slice(0, 4).concat(["considered", "warm"]).slice(0, 4), description: brand.personality ?? "Calm, expert and generous with knowledge." },
    positioning: { statement: brand.positioning ?? `${brand.name} makes ${products[0] ?? "its category"} feel effortless.`, category: brand.category ?? brand.industry ?? "Lifestyle", differentiators: ["Craft over volume", "Honest materials", "Service people talk about"] },
    usps: products.length ? products.map((p) => `${p}, made with care`) : ["Thoughtful design", "Reliable quality"],
    personas: [
      { name: "The Intentional Buyer", snapshot: "Researches before buying, values longevity", goals: ["Buy fewer, better things"], painPoints: ["Overwhelmed by choice", "Distrusts hype"], channels: ["instagram", "pinterest"] },
      { name: "The Gift Giver", snapshot: "Looks for meaningful, presentable gifts", goals: ["Find something that feels personal"], painPoints: ["Last-minute pressure"], channels: ["instagram", "facebook"] },
    ],
    painPoints: ["Too many generic options", "Unclear quality signals"],
    voice: {
      description: brand.tone ?? "Warm, precise and quietly confident",
      do: ["Lead with a concrete detail", "Use short sentences", "Speak to one person", "Show, then tell"],
      dont: ["Hype words", "Exclamation-mark chains", "Jargon", "Fake urgency"],
      vocabulary: ["crafted", "considered", "everyday"],
      sampleLines: ["Made slowly, so it lasts.", "The detail you notice on day 300.", "Less noise. More of what matters."],
    },
    visualIdentity: {
      palette: colors.map((hex, i) => ({ hex, name: `Brand ${i + 1}`, usage: i === 0 ? "Primary / text" : i === 1 ? "Backgrounds" : "Accent" })),
      typography: { heading: brand.fonts.heading ?? "Playfair Display", body: brand.fonts.body ?? "Inter", notes: "High contrast headings, airy body" },
      imagery: "Natural light, honest textures, close-up product detail",
      layout: "Generous margins, single focal point, restrained type",
      logoUsage: "Small, bottom corner, never over busy imagery",
    },
    preferredStyles: ["minimalist_luxury", "clean_sophisticated"],
    competitorPositioning: brand.competitors.map((c) => ({ name: c, positioning: "Broad, promotion-led", howWeDiffer: "We lead with craft and story" })),
    contentOpportunities: [
      { title: "Behind the making", why: "Proves quality without claims" },
      { title: "Care rituals", why: "Useful content that earns saves" },
      { title: "Customer stories", why: "Social proof in the brand's voice" },
      { title: "Material close-ups", why: "Visual signature for the feed" },
      { title: "Seasonal edits", why: "Ties products to moments" },
    ],
    rationale: "Mock provider: built from onboarding answers only.",
  };
}
