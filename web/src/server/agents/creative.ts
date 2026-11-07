import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import { llm } from "../ai/llm";
import { imageProvider, type ImageSize } from "../ai/image";
import { storage } from "../storage";
import { AGENTS } from "./registry";
import { runAgent, type RunScope } from "./orchestrator";
import { buildContext, renderContext } from "./context";
import { CreativeConcepts, type CreativeConcept } from "./schemas";
import type { Brand, Creative } from "../db/schema";
import { formatById, objectiveLabel, styleById } from "@/lib/domain";
import { remember } from "../memory";

export type CreativeRequest = {
  brief: string;
  format: string;
  style: string;
  count: number;
  objective?: string;
  campaignId?: string | null;
  generateImages?: boolean;
};

export async function generateCreatives(scope: RunScope, brand: Brand, req: CreativeRequest) {
  const count = Math.max(1, Math.min(req.count, 6));
  const fmtDef = formatById(req.format);
  const style = styleById(req.style);
  const ctx = await buildContext(brand, `creative concepts ${style.label} ${req.brief}`);
  const prompt = `${renderContext(ctx)}

Develop ${count} distinct creative concepts for: ${fmtDef.label} (${fmtDef.w}×${fmtDef.h}).
Creative style: ${style.label} — ${style.hint}.
${req.objective ? `Objective: ${objectiveLabel(req.objective)}.` : ""}
Brief: ${req.brief}

Rules:
- palette.background / foreground / accent must be hex colours taken from or harmonious with the brand palette; foreground must be legible on background (WCAG AA).
- layout options: hero_overlay (full-bleed image, text over a gradient), split (image one side, text panel other), frame (image inset in a coloured frame), typographic (type-led, image as small accent or none), editorial_column (magazine column with image), badge (product hero with an offer badge). Vary layouts across concepts.
- imagePrompt: 60-120 words of art direction in the requested style and the brand's imagery language. Leave clear negative space where the layout places text. No text, letters, logos or watermarks in the image.
- Each concept must take a different creative angle on the brief.`;

  const { runId, data } = await runAgent(scope, "creative_director", `${count}× ${fmtDef.label} · ${style.label}`, req, () =>
    llm().structured({
      system: AGENTS.creative_director.system,
      prompt,
      schema: CreativeConcepts,
      effort: AGENTS.creative_director.effort,
      mock: () => ({ concepts: Array.from({ length: count }, (_, i) => mockConcept(brand, req.brief, i)) }),
    }),
  );

  const db = await getDb();
  const rows = await db
    .insert(schema.creatives)
    .values(
      data.concepts.slice(0, count).map((c) => ({
        brandId: brand.id,
        campaignId: req.campaignId ?? null,
        format: fmtDef.id,
        style: style.id,
        concept: { ...c, brief: req.brief, objective: req.objective ?? null },
        runId,
      })),
    )
    .returning();

  if (req.generateImages !== false) {
    await Promise.all(rows.map((r) => generateCreativeImage({ ...scope, parentId: runId }, brand, r).catch(() => null)));
  }
  return rows.map((r) => r.id);
}

function sizeFor(format: string): ImageSize {
  const f = formatById(format);
  if (f.h > f.w * 1.1) return "1024x1536";
  if (f.w > f.h * 1.1) return "1536x1024";
  return "1024x1024";
}

/** Design Generation Agent: image from art direction; brand layout is composited at render time. */
export async function generateCreativeImage(scope: RunScope, brand: Brand, creative: Creative) {
  const provider = imageProvider();
  const db = await getDb();
  if (!provider) {
    await db
      .update(schema.creatives)
      .set({ imageProvider: "none", imageError: null })
      .where(eq(schema.creatives.id, creative.id));
    return null;
  }
  const c = creative.concept as CreativeConcept;
  const style = styleById(creative.style);
  const prompt = [
    c.imagePrompt,
    `Style: ${style.label}, ${style.hint}.`,
    c.imageTreatment && `Treatment: ${c.imageTreatment}.`,
    `Colour mood harmonises with ${c.palette.background}, ${c.palette.accent}.`,
    "Photorealistic, professional commercial quality. Absolutely no text, letters, numbers, logos or watermarks.",
  ]
    .filter(Boolean)
    .join(" ");
  try {
    const { data } = await runAgent(scope, "design_generation", `Image for "${c.title}"`, { creativeId: creative.id, provider: provider.name }, async () => {
      const img = await provider.generate(prompt, sizeFor(creative.format));
      const key = `brands/${brand.id}/creatives/${creative.id}-${Date.now()}.png`;
      await storage.put(key, img.data, img.mime);
      return { data: { key }, provider: provider.name };
    });
    await db
      .update(schema.creatives)
      .set({ imagePath: data.key, imageProvider: provider.name, imageError: null })
      .where(eq(schema.creatives.id, creative.id));
    return data.key;
  } catch (e) {
    await db
      .update(schema.creatives)
      .set({ imageError: e instanceof Error ? e.message : String(e), imageProvider: provider.name })
      .where(eq(schema.creatives.id, creative.id));
    throw e;
  }
}

export async function createVariation(scope: RunScope, brand: Brand, parent: Creative, direction: string) {
  const c = parent.concept as CreativeConcept & { brief?: string };
  const ids = await generateCreatives(scope, brand, {
    brief: `Variation of an existing concept. Keep its core idea but explore: ${direction || "a fresh composition and headline"}.\nOriginal concept: ${JSON.stringify({ title: c.title, headline: c.headline, subline: c.subline, layout: c.layout })}\nOriginal brief: ${c.brief ?? ""}`,
    format: parent.format,
    style: parent.style,
    count: 1,
    campaignId: parent.campaignId,
  });
  const db = await getDb();
  for (const id of ids) await db.update(schema.creatives).set({ parentId: parent.id }).where(eq(schema.creatives.id, id));
  return ids;
}

export async function updateConcept(brandId: string, creativeId: string, patch: Partial<CreativeConcept> & { style?: string; format?: string }) {
  const db = await getDb();
  const [cur] = await db
    .select()
    .from(schema.creatives)
    .where(and(eq(schema.creatives.id, creativeId), eq(schema.creatives.brandId, brandId)));
  if (!cur) throw new Error("Creative not found");
  const { style, format, ...conceptPatch } = patch;
  const before = cur.concept as CreativeConcept;
  await db
    .update(schema.creatives)
    .set({
      concept: { ...before, ...conceptPatch },
      ...(style ? { style } : {}),
      ...(format ? { format } : {}),
    })
    .where(eq(schema.creatives.id, creativeId));
  if (conceptPatch.headline && conceptPatch.headline !== before.headline) {
    await remember(brandId, [
      { kind: "feedback", content: `User rewrote a headline from "${before.headline}" to "${conceptPatch.headline}"`, source: "creative:edit", weight: 1.2 },
    ]);
  }
}

export async function setCreativeStatus(brandId: string, creativeId: string, status: "approved" | "rejected" | "draft") {
  const db = await getDb();
  const [row] = await db
    .update(schema.creatives)
    .set({ status })
    .where(and(eq(schema.creatives.id, creativeId), eq(schema.creatives.brandId, brandId)))
    .returning();
  if (row && status !== "draft") {
    const c = row.concept as CreativeConcept;
    await remember(brandId, [
      {
        kind: status === "approved" ? "approval" : "feedback",
        content: `${status === "approved" ? "Approved" : "Rejected"} creative: ${styleById(row.style).label}, ${c.layout} layout, headline "${c.headline}"`,
        source: `creative:${status}`,
        weight: status === "approved" ? 1.2 : 1,
      },
    ]);
  }
  return row;
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
