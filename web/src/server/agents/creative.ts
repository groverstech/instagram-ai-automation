import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import { llm } from "../ai/llm";
import { imageProvider } from "../ai/image";
import { AGENTS } from "./registry";
import { runAgent, type RunScope } from "./orchestrator";
import { buildContext, renderContext } from "./context";
import { CarouselConcepts, CreativeConcepts, type CarouselConcept, type CreativeConcept } from "./schemas";
import type { Brand, Creative, CreativeSlide, LogoPlacement, VisualSource } from "../db/schema";
import { z } from "zod";
import { LAYOUTS } from "./schemas";
import { UserFacingError } from "../jobs/engine";
import { generateVisual } from "../creative/visuals";
import { FORMAT_IDS, STYLE_IDS, formatById, objectiveLabel, styleById } from "@/lib/domain";
import { remember } from "../memory";

export type CreativeRequest = {
  brief: string;
  format: string;
  style: string;
  count: number;
  objective?: string;
  campaignId?: string | null;
  generateImages?: boolean;
  kind?: "single" | "carousel";
  /** Carousel: total slides including the cover (3–8). */
  slideCount?: number;
  visualSource?: VisualSource;
  /** brand_photo: specific approved photos to use (else rotated through all approved photos). */
  sourceAssetIds?: string[];
  logoPlacement?: LogoPlacement;
  strategyId?: string | null;
  calendarEntryId?: string | null;
  /** Extra brief context from the strategy (pillar, hook, caption direction…). */
  strategyContext?: string;
  /** Index of the batch item that created it (creative_batch jobs). */
  batchItem?: number;
};

/** Default visual source when the caller doesn't choose: AI if configured, else type-led. */
export function defaultVisualSource(): VisualSource {
  return imageProvider() ? "ai" : "typographic";
}

/**
 * Creative Director: concepts only (no images). Inserts draft creatives and returns the rows.
 * With `taskId`, rows are stamped so a recovered job never creates them twice.
 */
export async function createConcepts(scope: RunScope, brand: Brand, req: CreativeRequest) {
  const count = Math.max(1, Math.min(req.count, 6));
  const fmtDef = formatById(req.format);
  const style = styleById(req.style);
  const carousel = req.kind === "carousel";
  const slides = Math.max(3, Math.min(req.slideCount ?? 5, 8));
  const ctx = await buildContext(brand, `creative concepts ${style.label} ${req.brief}`);
  const prompt = `${renderContext(ctx)}

Develop ${count} distinct creative concept${count === 1 ? "" : "s"} for: ${fmtDef.label} (${fmtDef.w}×${fmtDef.h})${carousel ? `, as a ${slides}-slide carousel` : ""}.
Creative style: ${style.label} — ${style.hint}.
${req.objective ? `Objective: ${objectiveLabel(req.objective)}.` : ""}
Brief: ${req.brief}
${req.strategyContext ? `<from_approved_strategy note="the creative must deliver this">\n${req.strategyContext}\n</from_approved_strategy>` : ""}

Rules:
- palette.background / foreground / accent must be hex colours taken from or harmonious with the brand palette; foreground must be legible on background (WCAG AA).
- layout options: hero_overlay (full-bleed image, text over a gradient), split (image one side, text panel other), frame (image inset in a coloured frame), typographic (type-led, image as small accent or none), editorial_column (magazine column with image), badge (product hero with an offer badge). Vary layouts across concepts.
- imagePrompt: 60-120 words of art direction in the requested style and the brand's imagery language. Leave clear negative space where the layout places text. No text, letters, logos or watermarks in the image.
- Each concept must take a different creative angle on the brief.${carousel ? `
- The concept fields are the carousel COVER. slides: exactly ${slides - 1} further slides that tell one story (hook → value → proof → call to action on the last slide). Slide headlines ≤ 8 words; body 1–2 sentences; imagePrompt only where a photo genuinely helps, else "".` : ""}`;

  const { runId, data } = await runAgent(scope, "creative_director", `${count}× ${fmtDef.label}${carousel ? ` carousel (${slides} slides)` : ""} · ${style.label}`, { brief: req.brief.slice(0, 300), format: req.format, style: req.style, count, kind: req.kind ?? "single", strategyId: req.strategyId ?? undefined }, () =>
    carousel
      ? llm().structured({ route: "creative.concepts",
          system: AGENTS.creative_director.system,
          prompt,
          schema: CarouselConcepts,
          effort: AGENTS.creative_director.effort,
          mock: () => ({ concepts: Array.from({ length: count }, (_, i) => ({ ...mockConcept(brand, req.brief, i), slides: mockSlides(slides - 1) })) }),
        })
      : llm().structured({ route: "creative.concepts",
          system: AGENTS.creative_director.system,
          prompt,
          schema: CreativeConcepts,
          effort: AGENTS.creative_director.effort,
          mock: () => ({ concepts: Array.from({ length: count }, (_, i) => mockConcept(brand, req.brief, i)) }),
        }),
  );

  const db = await getDb();
  const visualSource = req.visualSource ?? defaultVisualSource();
  return db
    .insert(schema.creatives)
    .values(
      data.concepts.slice(0, count).map((c, i) => {
        const { slides: slideList, ...concept } = c as CarouselConcept;
        return {
          brandId: brand.id,
          campaignId: req.campaignId ?? null,
          format: fmtDef.id,
          style: style.id,
          kind: carousel ? ("carousel" as const) : ("single" as const),
          slides: carousel ? (slideList ?? []).slice(0, 7).map((x) => ({ headline: x.headline, body: x.body, imagePrompt: x.imagePrompt || undefined })) : [],
          concept: { ...concept, brief: req.brief, objective: req.objective ?? null, ...(req.batchItem !== undefined ? { batchItem: req.batchItem } : {}) },
          visualSource,
          sourceAssetId: req.sourceAssetIds?.length ? req.sourceAssetIds[i % req.sourceAssetIds.length] : null,
          logoPlacement: req.logoPlacement ?? "top_left",
          strategyId: req.strategyId ?? null,
          calendarEntryId: req.calendarEntryId ?? null,
          taskId: scope.taskId ?? null,
          runId,
        };
      }),
    )
    .returning();
}

/** Concepts + visuals in one call (assistant, campaign manager). The studio uses background jobs. */
export async function generateCreatives(scope: RunScope, brand: Brand, req: CreativeRequest) {
  const rows = await createConcepts(scope, brand, req);
  if (req.generateImages !== false) {
    await Promise.all(rows.map((r, i) => generateVisual({ ...scope, parentId: r.runId ?? undefined }, brand, r, { rotation: i }).catch(() => null)));
  }
  return rows.map((r) => r.id);
}

/** Regenerate a creative's visual (Design Generation Agent, brand photo or type-led). */
export async function generateCreativeImage(scope: RunScope, brand: Brand, creative: Creative) {
  await generateVisual(scope, brand, creative, { slideVisuals: creative.kind === "carousel" });
  return true;
}

export async function createVariation(scope: RunScope, brand: Brand, parent: Creative, direction: string) {
  const c = parent.concept as CreativeConcept & { brief?: string };
  const ids = await generateCreatives(scope, brand, {
    brief: `Variation of an existing concept. Keep its core idea but explore: ${direction || "a fresh composition and headline"}.\nOriginal concept: ${JSON.stringify({ title: c.title, headline: c.headline, subline: c.subline, layout: c.layout })}\nOriginal brief: ${c.brief ?? ""}`,
    format: parent.format,
    style: parent.style,
    count: 1,
    campaignId: parent.campaignId,
    kind: parent.kind,
    slideCount: parent.kind === "carousel" ? 1 + (parent.slides?.length ?? 4) : undefined,
    visualSource: parent.visualSource,
    logoPlacement: parent.logoPlacement,
    strategyId: parent.strategyId,
    calendarEntryId: parent.calendarEntryId,
  });
  const db = await getDb();
  for (const id of ids) await db.update(schema.creatives).set({ parentId: parent.id }).where(eq(schema.creatives.id, id));
  return ids;
}

const HEX = z.string().regex(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i, "Use a hex colour like #1F1D1A");
const T = (max: number) => z.string().trim().max(max);
/** What a user may change on a creative (strict; server-owned fields can't be set). */
export const CreativeEdit = z
  .object({
    title: T(120),
    headline: T(140).min(1),
    subline: T(300),
    cta: T(60),
    layout: z.enum(LAYOUTS),
    palette: z.object({ background: HEX, foreground: HEX, accent: HEX }),
    imagePrompt: T(1500),
    style: z.enum(STYLE_IDS),
    format: z.enum(FORMAT_IDS),
    logoPlacement: z.enum(["top_left", "top_right", "bottom_left", "bottom_right", "none"]),
    slides: z.array(z.object({ headline: T(120).min(1), body: T(400), imagePrompt: T(1500).optional() })).min(2).max(7),
  })
  .partial();
export type CreativeEdit = z.infer<typeof CreativeEdit>;

/** Apply a validated user edit. Text edits teach brand memory; any edit marks the brand check stale. */
export async function updateConcept(brandId: string, creativeId: string, raw: unknown) {
  const patch = CreativeEdit.parse(raw);
  const db = await getDb();
  const [cur] = await db
    .select()
    .from(schema.creatives)
    .where(and(eq(schema.creatives.id, creativeId), eq(schema.creatives.brandId, brandId)));
  if (!cur) throw new UserFacingError("Creative not found.");
  const { style, format, logoPlacement, slides, ...conceptPatch } = patch;
  if (slides && cur.kind !== "carousel") throw new UserFacingError("Only carousels have slides.");
  const before = cur.concept as CreativeConcept;
  const prevSlides = (cur.slides ?? []) as CreativeSlide[];
  await db
    .update(schema.creatives)
    .set({
      concept: { ...before, ...conceptPatch },
      ...(style ? { style } : {}),
      ...(format ? { format } : {}),
      ...(logoPlacement ? { logoPlacement } : {}),
      // Keep generated slide images where the slide still exists.
      ...(slides ? { slides: slides.map((sl, i) => ({ ...prevSlides[i], ...sl, imagePrompt: sl.imagePrompt ?? prevSlides[i]?.imagePrompt })) } : {}),
      brandCheck: cur.brandCheck ? { ...cur.brandCheck, stale: true } : null,
      updatedAt: new Date(),
    })
    .where(eq(schema.creatives.id, creativeId));
  if (conceptPatch.headline && conceptPatch.headline !== before.headline) {
    await remember(brandId, [
      { kind: "feedback", content: `User rewrote a headline from "${before.headline}" to "${conceptPatch.headline}"`, source: "creative:edit", weight: 1.2 },
    ]);
  }
}

/**
 * Approve / reject / reset a creative. Approving one whose brand check has blocking issues needs
 * `force` (an explicit "approve anyway", admin-only at the action layer).
 */
export async function setCreativeStatus(brandId: string, creativeId: string, status: "approved" | "rejected" | "draft", opts: { force?: boolean } = {}) {
  const db = await getDb();
  const [cur] = await db.select().from(schema.creatives).where(and(eq(schema.creatives.id, creativeId), eq(schema.creatives.brandId, brandId)));
  if (!cur) throw new UserFacingError("Creative not found.");
  const check = cur.brandCheck as { blocking?: boolean; checks?: { status: string; label: string; detail: string }[]; review?: { issues: { severity: string; issue: string }[] } | null } | null;
  if (status === "approved" && check?.blocking && !opts.force) {
    const reasons = [
      ...(check.checks ?? []).filter((x) => x.status === "fail").map((x) => `${x.label}: ${x.detail}`),
      ...(check.review?.issues ?? []).filter((i) => i.severity === "blocking").map((i) => i.issue),
    ];
    throw new UserFacingError(`This creative has blocking brand issues: ${reasons.slice(0, 3).join(" · ")}. Fix them, or approve anyway (admin).`);
  }
  const [row] = await db
    .update(schema.creatives)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(schema.creatives.id, creativeId), eq(schema.creatives.brandId, brandId)))
    .returning();
  if (row && status !== "draft") {
    const c = row.concept as CreativeConcept;
    await remember(brandId, [
      {
        kind: status === "approved" ? "approval" : "feedback",
        content: `${status === "approved" ? "Approved" : "Rejected"} creative: ${styleById(row.style).label}, ${c.layout} layout, headline "${c.headline}"${opts.force ? " (approved despite brand-check issues)" : ""}`,
        source: `creative:${status}`,
        weight: status === "approved" ? 1.2 : 1,
      },
    ]);
  }
  return row;
}

function mockSlides(n: number) {
  const beats = ["Why it matters", "How it's made", "What changes for you", "Proof from customers", "Make it yours", "Care, simply", "Your next step"];
  return Array.from({ length: n }, (_, i) => ({ headline: beats[i % beats.length], body: "One clear idea per slide, in the brand's voice.", imagePrompt: i === 1 ? "Hands shaping clay on a wheel, soft side light" : "" }));
}

function mockConcept(brand: Brand, brief: string, i: number): CreativeConcept {
  const colors = brand.colors.length >= 2 ? brand.colors : ["#1F1D1A", "#F4EFE8", "#B08D57"];
  const layouts = ["hero_overlay", "split", "frame", "typographic", "editorial_column", "badge"] as const;
  const headlines = ["Made to last", "Quiet quality", "The everyday edit", "Crafted, not rushed", "New season, same care", "Small details"];
  return {
    title: `Concept ${i + 1}`,
    headline: headlines[i % headlines.length],
    subline: brief.slice(0, 80),
    cta: "Discover more",
    layout: layouts[i % layouts.length],
    palette: { background: colors[1] ?? "#F4EFE8", foreground: colors[0], accent: colors[2] ?? colors[0] },
    imagePrompt: `Soft natural light on ${brand.products ?? "the product"}, minimal set, generous negative space.`,
    imageTreatment: "Warm, slightly desaturated",
    rationale: "Mock provider.",
  };
}
