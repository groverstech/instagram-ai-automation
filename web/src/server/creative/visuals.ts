import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import { imagePrice, imageProvider, ImageProviderUnavailable, type ImageSize } from "../ai/image";
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

/** Generate one AI image through the ledger (agent_runs), store it, return the storage key. */
async function aiImage(scope: RunScope, brand: Brand, creative: Creative, prompt: string, label: string) {
  const provider = imageProvider();
  if (!provider) throw new ImageProviderUnavailable("No image provider is configured.");
  const size = sizeFor(creative.format);
  // One retry on transient failures (no response, 429, 5xx); refusals and 4xx are not retried.
  const { data } = await runAgent(scope, "design_generation", label, { creativeId: creative.id, provider: provider.name, size }, async () => {
    const img = await provider.generate(prompt, size);
    const key = `brands/${brand.id}/creatives/${creative.id}-${crypto.randomUUID().slice(0, 8)}.png`;
    await storage.put(key, img.data, img.mime);
    const price = imagePrice(size);
    return {
      data: { key },
      provider: provider.name,
      usage: { images: 1, imageModel: img.model, ...(price === null ? { unpricedImages: 1 } : { imageCostUsd: price }) },
    };
  }, { retries: 1 });
  return data.key;
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

/**
 * Produce the creative's visual(s) for its visual source. Idempotent per call site: callers in
 * jobs skip creatives that already have a visual.
 *  - typographic: no image (type-led layout; not a placeholder)
 *  - brand_photo: an approved product/reference photo of the brand (chosen, or picked in rotation)
 *  - ai: an AI-generated image from the concept's art direction (cover, plus slides when asked)
 */
export async function generateVisual(scope: RunScope, brand: Brand, creative: Creative, opts: { rotation?: number; slideVisuals?: boolean } = {}) {
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
