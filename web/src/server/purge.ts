import "server-only";
import { eq } from "drizzle-orm";
import { getDb, schema } from "./db/client";
import { cancelJobs } from "./jobs/queue";
import { log } from "./log";
import { storage } from "./storage";

/**
 * The data-removal part of deletion (deletion.ts), with no request or permission handling, so
 * operator tools can use it too (reviewer.ts). Callers authorise and check blockers first.
 */
/** Delete one brand's data and files. The caller has authorised the deletion and checked blockers. */
export async function purgeBrand(brandId: string): Promise<{ filesRemoved: boolean }> {
  const db = await getDb();
  const postIds = new Set((await db.select({ id: schema.posts.id }).from(schema.posts).where(eq(schema.posts.brandId, brandId))).map((p) => p.id));
  await cancelJobs("publish_post", (p) => postIds.has(String(p.postId)));
  await cancelJobs("sync_metrics", (p) => p.brandId === brandId);
  await db.update(schema.sessions).set({ activeBrandId: null }).where(eq(schema.sessions.activeBrandId, brandId));
  // Credit caps and alerts are keyed by brand id without a foreign key ("" is the organisation).
  await db.delete(schema.creditLimits).where(eq(schema.creditLimits.brandId, brandId));
  await db.delete(schema.usageAlerts).where(eq(schema.usageAlerts.brandId, brandId));
  // Everything else that belongs to the brand references it with ON DELETE CASCADE.
  await db.delete(schema.brands).where(eq(schema.brands.id, brandId));
  try {
    await storage.removePrefix(`brands/${brandId}`);
    return { filesRemoved: true };
  } catch (e) {
    // The database rows are gone; leftover files are only reachable by their key. Log for an operator.
    log.error("deletion.files_failed", { brandId, error: e instanceof Error ? e.message : String(e) });
    return { filesRemoved: false };
  }
}

/** Delete an organisation's brands, files and the organisation itself. Callers authorise first (also used by operator tools). */
export async function purgeWorkspace(workspaceId: string) {
  const db = await getDb();
  const brands = await db.select({ id: schema.brands.id }).from(schema.brands).where(eq(schema.brands.workspaceId, workspaceId));
  let filesRemoved = true;
  for (const b of brands) filesRemoved = (await purgeBrand(b.id)).filesRemoved && filesRemoved;
  await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)); // members and invitations cascade
  return { brands: brands.length, filesRemoved };
}

