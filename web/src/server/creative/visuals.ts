import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import { imageProvider, ImageProviderUnavailable, MOCK_IMAGE_PROVIDER, type ImageSize } from "../ai/image";
import { storage } from "../storage";
import { runAgent, type RunScope } from "../agents/orchestrator";
import type { CreativeConcept } from "../agents/schemas";
import type { Brand, Creative, CreativeSlide } from "../db/schema";
import { formatById, styleById } from "@/lib/domain";
import { UserFacingError } from "../jobs/engine";

/** Asset kinds that may be used as a creative's visual, and the image types the renderer can embed. */
export const PHOTO_KINDS = ["product", "reference", "creative", "post"] as const;
const PHOTO_MIMES = ["image/png", "image/jpeg", "image/webp"];

export function sizeFor(format: string): ImageSize {
  const f = formatById(format);
  if (f.h > f.w * 1.1) return "1024x1536";
  if (f.w > f.h * 1.1) return "1536x1024";
  return "1024x1024";
}

/** Approved brand photos that can be used as visuals, newest first. Brand-scoped. */
export async function brandPhotos(brandId: string) {
  const db = await getDb();
  const rows = await db
    .select({ id: schema.brandAssets.id, name: schema.brandAssets.name, kind: schema.brandAssets.kind, mime: schema.brandAssets.mime, path: schema.brandAssets.path, createdAt: schema.brandAssets.createdAt })
    .from(schema.brandAssets)
    .where(and(eq(schema.brandAssets.brandId, brandId), eq(schema.brandAssets.status, "approved"), inArray(schema.brandAssets.kind, [...PHOTO_KINDS])));
  return rows.filter((r) => PHOTO_MIMES.includes(r.mime)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/** Check (and return) a brand photo the user picked: same brand, approved, embeddable. */
export async function assertBrandPhoto(brandId: string, assetId: string) {
  const photo = (await brandPhotos(brandId)).find((p) => p.id === assetId);
  if (!photo) throw new UserFacingError("That photo isn't an approved image asset of this brand.");
  return photo;
}

function imagePromptFor(c: CreativeConcept, styleId: string, override?: string) {
  const style = styleById(styleId);
  return [
    override || c.imagePrompt,
    `Style: ${style.label}, ${style.hint}.`,
    c.imageTreatment && `Treatment: ${c.imageTreatment}.`,
    `Colour mood harmonises with ${c.palette.background}, ${c.palette.accent}.`,
    "Photorealistic, professional commercial quality. Absolutely no text, letters, numbers, logos or watermarks.",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Generate one AI image (or, with `source`, a variation of an existing one) through the run
 * ledger, store it through the storage abstraction, and return the storage key. Retries happen
 * in the provider executor (ai/call.ts): rate limits and server errors are retried; a timed-out
 * image request is not, because it may already have been created and charged.
 */
async function aiImage(scope: RunScope, brand: Brand, creative: Creative, prompt: string, label: string, source?: { data: Buffer; mime: string }) {
  const provider = imageProvider();
  if (!provider) throw new ImageProviderUnavailable("No image provider is configured.");
  const size = sizeFor(creative.format);
  const { data } = await runAgent(scope, "design_generation", label, { creativeId: creative.id, provider: provider.name, size, variation: Boolean(source) }, async () => {
    const img = source ? await provider.edit(prompt, source, size) : await provider.generate(prompt, size);
    const key = `brands/${brand.id}/creatives/${creative.id}-${crypto.randomUUID().slice(0, 8)}.png`;
    await storage.put(key, img.data, img.mime);
    // A demo placeholder costs nothing and isn't an image generation: no billable usage.
    if (provider.name === MOCK_IMAGE_PROVIDER) return { data: { key }, provider: provider.name };
    return { data: { key }, provider: `openai:${img.model}`, usage: img.usage };
  });
  return data.key;
}

/**
 * A variation of a creative's AI image (creative iterations): the current image goes to the
 * image model with the concept's art direction and an optional new direction, and the result
 * replaces the cover. Brand colours, logo and text are still composited by our renderer.
 */
export async function aiVariation(scope: RunScope, brand: Brand, creative: Creative, direction?: string) {
  if (creative.visualSource !== "ai" || !creative.imagePath) throw new UserFacingError("Variations are for creatives with an AI-generated image. Generate one first.");
  const c = creative.concept as CreativeConcept;
  const before = (await currentRow(creative.id)) ?? creative;
  const source = await storage.get(creative.imagePath);
  const prompt = [
    "Create a fresh variation of this image for the same campaign: keep the subject, mood and quality, vary the composition and framing.",
    direction?.trim() && `Direction for this variation: ${direction.trim()}`,
    imagePromptFor(c, creative.style),
  ]
    .filter(Boolean)
    .join(" ");
  const db = await getDb();
  try {
    const key = await aiImage(scope, brand, creative, prompt, `Variation for "${c.title}"`, { data: source, mime: creative.imagePath.endsWith(".jpg") ? "image/jpeg" : "image/png" });
    await db.update(schema.creatives).set({ imagePath: key, imageProvider: imageProvider()?.name ?? "ai", imageError: null, updatedAt: new Date() }).where(eq(schema.creatives.id, creative.id));
  } catch (e) {
    // The current image stays; only the error is shown.
    await db.update(schema.creatives).set({ imageError: e instanceof Error ? e.message : String(e), updatedAt: new Date() }).where(eq(schema.creatives.id, creative.id));
    throw e;
  }
  const after = await currentRow(creative.id);
  if (after) await pruneCreativeFiles(before, after);
}

/** Copy an approved brand photo into the creative's storage (survives asset deletion). */
async function photoCopy(brand: Brand, creative: Creative, assetId: string) {
  const photo = await assertBrandPhoto(brand.id, assetId);
  const src = await storage.get(photo.path);
  // Normalise for the renderer: respect EXIF orientation, cap the size, and store JPEG or PNG
  // (it can't decode WebP).
  const { default: sharp } = await import("sharp");
  const img = sharp(src).rotate().resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true });
  const jpeg = photo.mime === "image/jpeg";
  const buf = jpeg ? await img.jpeg({ quality: 88 }).toBuffer() : await img.png().toBuffer();
  const key = `brands/${brand.id}/creatives/${creative.id}-photo-${assetId.slice(0, 8)}.${jpeg ? "jpg" : "png"}`;
  await storage.put(key, buf, jpeg ? "image/jpeg" : "image/png");
  return key;
}

type FileRefs = { id: string; brandId: string; imagePath: string | null; slides: CreativeSlide[] | unknown };
/** Stored files this creative owns: its cover and slide visuals, under its own storage prefix only. */
export function ownedFiles(c: FileRefs): string[] {
  const prefix = `brands/${c.brandId}/creatives/${c.id}`;
  const slides = Array.isArray(c.slides) ? (c.slides as CreativeSlide[]) : [];
  return [c.imagePath, ...slides.map((s) => s.imagePath)].filter((k): k is string => Boolean(k && k.startsWith(prefix)));
}

/**
 * Remove files the creative referenced `before` and no longer references `after` (a replaced
 * visual), or all of them when `after` is null (the creative was deleted). Best effort: a failed
 * delete leaves an orphan file, never a broken creative.
 */
export async function pruneCreativeFiles(before: FileRefs, after: FileRefs | null) {
  const keep = new Set(after ? ownedFiles(after) : []);
  for (const key of new Set(ownedFiles(before))) {
    if (keep.has(key)) continue;
    await storage.remove(key).catch((e) => console.warn(JSON.stringify({ event: "storage.remove_failed", key, error: e instanceof Error ? e.message : String(e) })));
  }
}

async function currentRow(id: string) {
  const db = await getDb();
  const [row] = await db.select().from(schema.creatives).where(eq(schema.creatives.id, id));
  return row ?? null;
}

/**
 * Produce the creative's visual(s) for its visual source. Idempotent per call site: callers in
 * jobs skip creatives that already have a visual.
 *  - typographic: no image (type-led layout; not a placeholder)
 *  - brand_photo: an approved product/reference photo of the brand (chosen, or picked in rotation)
 *  - ai: an AI-generated image from the concept's art direction (cover, plus slides when asked)
 */
export async function generateVisual(scope: RunScope, brand: Brand, creative: Creative, opts: { rotation?: number; slideVisuals?: boolean } = {}) {
  const before = (await currentRow(creative.id)) ?? creative;
  await produceVisual(scope, brand, creative, opts);
  // Only after the new visual is saved: drop the files it replaced.
  const after = await currentRow(creative.id);
  if (after) await pruneCreativeFiles(before, after);
}

async function produceVisual(scope: RunScope, brand: Brand, creative: Creative, opts: { rotation?: number; slideVisuals?: boolean }) {
  const db = await getDb();
  const c = creative.concept as CreativeConcept;
  const slides = (creative.slides ?? []) as CreativeSlide[];
  if (creative.visualSource === "typographic") {
    await db.update(schema.creatives).set({ imagePath: null, imageProvider: "none", imageError: null, updatedAt: new Date() }).where(eq(schema.creatives.id, creative.id));
    return;
  }
  if (creative.visualSource === "brand_photo") {
    const photos = await brandPhotos(brand.id);
    if (!photos.length) throw new UserFacingError("This brand has no approved product or reference photos yet. Upload and approve some in My Brand, or choose another visual source.");
    const coverId = creative.sourceAssetId ?? photos[(opts.rotation ?? 0) % photos.length].id;
    const cover = await photoCopy(brand, creative, coverId);
    const nextSlides = opts.slideVisuals
      ? await Promise.all(slides.map(async (s, i) => ({ ...s, imagePath: photos.length > 1 ? await photoCopy(brand, creative, photos[((opts.rotation ?? 0) + i + 1) % photos.length].id) : null, imageError: null })))
      : slides;
    await db.update(schema.creatives).set({ imagePath: cover, sourceAssetId: coverId, imageProvider: "brand_photo", imageError: null, slides: nextSlides, updatedAt: new Date() }).where(eq(schema.creatives.id, creative.id));
    return;
  }
  // AI imagery
  try {
    const cover = await aiImage(scope, brand, creative, imagePromptFor(c, creative.style), `Image for "${c.title}"`);
    await db.update(schema.creatives).set({ imagePath: cover, imageProvider: imageProvider()?.name ?? "ai", imageError: null, updatedAt: new Date() }).where(eq(schema.creatives.id, creative.id));
    if (opts.slideVisuals) {
      const next: CreativeSlide[] = [];
      for (const [i, s] of slides.entries()) {
        if (!s.imagePrompt) {
          next.push(s);
          continue;
        }
        const key = await aiImage(scope, brand, creative, imagePromptFor(c, creative.style, s.imagePrompt), `Slide ${i + 2} image for "${c.title}"`);
        next.push({ ...s, imagePath: key, imageError: null });
        await db.update(schema.creatives).set({ slides: [...next, ...slides.slice(i + 1)], updatedAt: new Date() }).where(eq(schema.creatives.id, creative.id));
      }
    }
  } catch (e) {
    await db.update(schema.creatives).set({ imageError: e instanceof Error ? e.message : String(e), imageProvider: imageProvider()?.name ?? "none", updatedAt: new Date() }).where(eq(schema.creatives.id, creative.id));
    throw e;
  }
}
