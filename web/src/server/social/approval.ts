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

/**
 * A post as it stands in the database now, with the exact creative and brand rows the hash was
 * computed from. Callers that go on to publish or render use these rows, not a second read, so
 * what's hashed and what's used can't differ (review M-1). Inside a transaction, pass it.
 */
export async function approvalSnapshot(db: Reader, post: Post): Promise<{ hash: string; creative: Creative | null; brand: Brand | null }> {
  const [creative] = post.creativeId ? await db.select().from(schema.creatives).where(eq(schema.creatives.id, post.creativeId)) : [];
  const [brand] = await db.select().from(schema.brands).where(eq(schema.brands.id, post.brandId));
  const logos = await db
    .select({ path: schema.brandAssets.path })
    .from(schema.brandAssets)
    .where(and(eq(schema.brandAssets.brandId, post.brandId), eq(schema.brandAssets.kind, "logo")))
    .orderBy(asc(schema.brandAssets.path));
  return { hash: approvalHash(post, creative ?? null, brand ?? null, logos.map((l) => l.path)), creative: creative ?? null, brand: brand ?? null };
}

/** The hash of a post as it stands in the database now (inside a transaction, pass it). */
export async function currentApprovalHash(db: Reader, post: Post): Promise<string> {
  return (await approvalSnapshot(db, post)).hash;
}

/** The content no longer matches the approval the media link or publish was issued for. */
export class NotApprovedContentError extends Error {}

/**
 * Render the image of exactly the approved version of a post (review M-1), for the public media
 * link platforms fetch and for in-process uploads. Refuses unless the post still carries
 * `expectedHash` as its approval and its current content still hashes to it, both before and after
 * rendering, at the post's own format (the renderer reads the logo itself; storage keys are never reused, so equal hashes
 * before and after mean the rendered image is the approved one).
 */
export async function renderApproved(db: Reader, postId: string, expectedHash: string): Promise<Buffer> {
  const check = async () => {
    const [post] = await db.select().from(schema.posts).where(eq(schema.posts.id, postId));
    if (!post || !post.approvedContentHash || post.approvedContentHash !== expectedHash) throw new NotApprovedContentError("This post's approval has been withdrawn or replaced.");
    const snap = await approvalSnapshot(db, post);
    if (snap.hash !== expectedHash || !snap.creative || !snap.brand) throw new NotApprovedContentError("This post, its creative or the brand's look changed after it was approved.");
    return { post, snap };
  };
  const { post, snap } = await check();
  const { renderCreativePng } = await import("../creative/render");
  const png = await renderCreativePng(snap.creative!, snap.brand!, post.format);
  await check();
  return png;
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
