import "server-only";
import crypto from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { schema, type DB } from "../db/client";

/**
 * Approval integrity (review finding H1). An approval is for one exact version of what will be
 * published. It is recorded as a hash of everything that shapes the published post:
 *
 *   post      platform, format, caption, hashtags, title, creative, target social account
 *   creative  kind, format, style, visual source, concept (headline, palette, layout…), image,
 *             slides, logo placement, source photo
 *   brand     name, colours, fonts and logo (the renderer draws them onto the image)
 *
 * The publish claim recomputes the hash from the database and refuses (back to a person, nothing
 * sent) if it differs from the approved one. A post approved before this existed has no hash and
 * needs a fresh approval. Scheduling time is not content: it's governed by the schedule, not the
 * approval.
 */
type Post = typeof schema.posts.$inferSelect;
type Creative = typeof schema.creatives.$inferSelect;
type Brand = typeof schema.brands.$inferSelect;
type Reader = Pick<DB, "select">;

/** The post fields whose change invalidates an approval. */
export const PUBLISHED_POST_FIELDS = ["platform", "format", "caption", "hashtags", "title", "creativeId", "socialAccountId"] as const;
export type PublishedField = (typeof PUBLISHED_POST_FIELDS)[number];

// An empty string and no value are the same content (forms send "" for an empty field).
const norm = (v: unknown) => (v === undefined || v === "" ? null : v);

export function approvalHash(post: Pick<Post, PublishedField>, creative: Creative | null, brand: Pick<Brand, "name" | "colors" | "fonts"> | null, logoPaths: string[]): string {
  const body = {
    v: 1,
    post: Object.fromEntries(PUBLISHED_POST_FIELDS.map((k) => [k, norm(post[k])])),
    creative: creative
      ? {
          id: creative.id,
          kind: creative.kind,
          format: creative.format,
          style: creative.style,
          visualSource: creative.visualSource,
          concept: creative.concept,
          imagePath: creative.imagePath,
          slides: creative.slides,
          logoPlacement: creative.logoPlacement,
          sourceAssetId: creative.sourceAssetId,
        }
      : null,
    brand: brand ? { name: brand.name, colors: brand.colors, fonts: brand.fonts, logos: logoPaths } : null,
  };
  return crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

/** The hash of a post as it stands in the database now (inside a transaction, pass it). */
export async function currentApprovalHash(db: Reader, post: Post): Promise<string> {
  const [creative] = post.creativeId ? await db.select().from(schema.creatives).where(eq(schema.creatives.id, post.creativeId)) : [];
  const [brand] = await db.select({ name: schema.brands.name, colors: schema.brands.colors, fonts: schema.brands.fonts }).from(schema.brands).where(eq(schema.brands.id, post.brandId));
  const logos = await db
    .select({ path: schema.brandAssets.path })
    .from(schema.brandAssets)
    .where(and(eq(schema.brandAssets.brandId, post.brandId), eq(schema.brandAssets.kind, "logo")))
    .orderBy(asc(schema.brandAssets.path));
  return approvalHash(post, creative ?? null, brand ?? null, logos.map((l) => l.path));
}

/** Which published fields differ between two versions of a post. */
export function changedPublishedFields(before: Pick<Post, PublishedField>, after: Partial<Pick<Post, PublishedField>>): PublishedField[] {
  return PUBLISHED_POST_FIELDS.filter((k) => after[k] !== undefined && JSON.stringify(norm(after[k])) !== JSON.stringify(norm(before[k])));
}

/** The approval-related columns to clear whenever the approved content changes. */
export const CLEARED_APPROVAL = { approvedAt: null, approvedBy: null, approvedContentHash: null, autoApprovedVersion: null } as const;

/**
 * Record the hash of a post as it stands now: what an approval does, for operator tools that create
 * already-approved content (reviewer:setup) and for tests that set up approved posts directly.
 */
export async function recordApprovedContent(db: Pick<DB, "select" | "update">, postId: string) {
  const [post] = await db.select().from(schema.posts).where(eq(schema.posts.id, postId));
  if (!post) return null;
  const hash = await currentApprovalHash(db, post);
  await db.update(schema.posts).set({ approvedContentHash: hash }).where(eq(schema.posts.id, postId));
  return hash;
}
