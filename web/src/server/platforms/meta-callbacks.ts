import "server-only";
import crypto from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import { audit } from "../audit";
import { encrypt } from "../crypto";
import { log } from "../log";
import { appUrl } from "../social/service";

/**
 * Meta's app callbacks (PR 4.3; required for Meta App Review):
 *   - data deletion: a person asks Meta to have us delete the data we got through Facebook Login;
 *   - deauthorise: a person removed the app, so their connected accounts must stop working.
 * Both arrive as a POST with `signed_request`: `<base64url HMAC-SHA256 signature>.<base64url JSON>`,
 * signed with the app secret (META_APP_SECRET). Nothing is trusted until the signature verifies.
 * Meta identifies the person by their app-scoped user ID, which we record on every account
 * connected through that login (`social_accounts.platform_user_id`).
 */
export const META_PLATFORMS = ["facebook", "instagram"] as const;

export type MetaSignedRequest = { userId: string; issuedAt: number | null };

export class MetaCallbackNotConfigured extends Error {}

const b64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/**
 * Verify and decode a signed_request. Returns null when it's malformed, signed with another key,
 * uses another algorithm, has no user, or is older than `maxAgeSec` (or dated in the future).
 */
export function parseSignedRequest(raw: string | null | undefined, appSecret: string, now = Date.now(), maxAgeSec = 24 * 3600): MetaSignedRequest | null {
  if (!raw || typeof raw !== "string" || raw.length > 8192) return null;
  const dot = raw.indexOf(".");
  if (dot <= 0 || dot === raw.length - 1 || raw.indexOf(".", dot + 1) !== -1) return null;
  const sigPart = raw.slice(0, dot);
  const payloadPart = raw.slice(dot + 1);
  if (!/^[\w-]+=*$/.test(sigPart) || !/^[\w-]+=*$/.test(payloadPart)) return null;
  const sig = b64url(sigPart);
  const expected = crypto.createHmac("sha256", appSecret).update(payloadPart).digest();
  if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return null;
  let payload: { algorithm?: unknown; user_id?: unknown; issued_at?: unknown };
  try {
    payload = JSON.parse(b64url(payloadPart).toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  if (String(payload.algorithm ?? "").toUpperCase() !== "HMAC-SHA256") return null;
  const userId = typeof payload.user_id === "string" || typeof payload.user_id === "number" ? String(payload.user_id) : "";
  if (!/^\d{1,32}$/.test(userId)) return null;
  const issuedAt = typeof payload.issued_at === "number" ? payload.issued_at : null;
  if (issuedAt !== null) {
    const age = now / 1000 - issuedAt;
    if (age > maxAgeSec || age < -300) return null;
  }
  return { userId, issuedAt };
}

function appSecret(): string {
  const s = process.env.META_APP_SECRET?.trim();
  if (!s) throw new MetaCallbackNotConfigured("META_APP_SECRET is not set.");
  return s;
}

/** Confirmation codes people can look up on the status page: 12 characters, unambiguous alphabet. */
function confirmationCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  return Array.from(crypto.randomBytes(12), (b) => alphabet[b % alphabet.length]).join("");
}

export type DeletionOutcome = { url: string; confirmationCode: string; status: "completed" | "failed" };

/**
 * Data-deletion callback. Records the request, then deletes what we hold that came from that
 * person's Meta login: the connected Facebook Pages and Instagram accounts (tokens, names, avatars,
 * account metrics), the platform metrics of posts published through them, and the platform post
 * IDs and links on those posts. The brand's own posts and creatives stay (they were made in
 * BrandPilot), detached from the deleted accounts.
 */
export async function handleDataDeletion(signedRequest: string | null): Promise<DeletionOutcome | null> {
  const req = parseSignedRequest(signedRequest, appSecret());
  if (!req) return null;
  const db = await getDb();
  const code = confirmationCode();
  const [row] = await db.insert(schema.dataDeletionRequests).values({ platform: "meta", externalUserId: req.userId, confirmationCode: code }).returning();
  const url = `${appUrl()}/data-deletion/status?code=${code}`;
  try {
    const details = await db.transaction(async (tx) => {
      const accounts = await tx
        .select({ id: schema.socialAccounts.id, brandId: schema.socialAccounts.brandId, workspaceId: schema.brands.workspaceId })
        .from(schema.socialAccounts)
        .innerJoin(schema.brands, eq(schema.brands.id, schema.socialAccounts.brandId))
        .where(and(inArray(schema.socialAccounts.platform, [...META_PLATFORMS]), eq(schema.socialAccounts.platformUserId, req.userId)));
      const ids = accounts.map((a) => a.id);
      let posts = 0;
      let postMetrics = 0;
      if (ids.length) {
        const linked = await tx.select({ id: schema.posts.id }).from(schema.posts).where(inArray(schema.posts.socialAccountId, ids));
        const postIds = linked.map((p) => p.id);
        if (postIds.length) {
          postMetrics = (await tx.delete(schema.postMetrics).where(and(inArray(schema.postMetrics.postId, postIds), eq(schema.postMetrics.source, "platform"))).returning({ id: schema.postMetrics.id })).length;
          posts = (await tx.update(schema.posts).set({ socialAccountId: null, externalId: null, externalUrl: null }).where(inArray(schema.posts.id, postIds)).returning({ id: schema.posts.id })).length;
        }
        await tx.delete(schema.socialAccounts).where(inArray(schema.socialAccounts.id, ids));
      }
      const brands = new Map(accounts.map((a) => [a.brandId, a.workspaceId]));
      return { accounts: ids.length, posts, postMetrics, brands: [...brands] };
    });
    await db
      .update(schema.dataDeletionRequests)
      .set({ status: "completed", completedAt: new Date(), details: { accounts: details.accounts, postsDetached: details.posts, postMetricsDeleted: details.postMetrics } })
      .where(eq(schema.dataDeletionRequests.id, row.id));
    for (const [brandId, workspaceId] of details.brands) {
      await audit({ action: "social.data_deletion", workspaceId, brandId, actorType: "system", targetType: "data_deletion_request", targetId: row.id, details: { platform: "meta", confirmationCode: code } });
    }
    log.info("meta.data_deletion", { request: row.id, accounts: details.accounts, posts: details.posts, postMetrics: details.postMetrics });
    return { url, confirmationCode: code, status: "completed" };
  } catch (e) {
    await db.update(schema.dataDeletionRequests).set({ status: "failed", details: { error: "Deletion failed; it is retried by an operator." } }).where(eq(schema.dataDeletionRequests.id, row.id));
    log.error("meta.data_deletion_failed", { request: row.id, error: e instanceof Error ? e.message : String(e) });
    return { url, confirmationCode: code, status: "failed" };
  }
}

/**
 * Deauthorise callback: the person removed the app. Their connected accounts are marked revoked,
 * their tokens are destroyed, and publishing to them stops (publishing requires an active account).
 */
export async function handleDeauthorize(signedRequest: string | null): Promise<{ accounts: number } | null> {
  const req = parseSignedRequest(signedRequest, appSecret());
  if (!req) return null;
  const db = await getDb();
  const rows = await db
    .update(schema.socialAccounts)
    .set({ status: "revoked", deauthorizedAt: new Date(), accessTokenEnc: encrypt(""), refreshTokenEnc: null })
    .where(and(inArray(schema.socialAccounts.platform, [...META_PLATFORMS]), eq(schema.socialAccounts.platformUserId, req.userId)))
    .returning({ id: schema.socialAccounts.id, brandId: schema.socialAccounts.brandId, platform: schema.socialAccounts.platform });
  const ws = rows.length ? await db.select({ id: schema.brands.id, workspaceId: schema.brands.workspaceId }).from(schema.brands).where(inArray(schema.brands.id, [...new Set(rows.map((r) => r.brandId))])) : [];
  const wsOf = new Map(ws.map((b) => [b.id, b.workspaceId]));
  for (const r of rows) {
    await audit({ action: "social.deauthorized", workspaceId: wsOf.get(r.brandId) ?? null, brandId: r.brandId, actorType: "system", targetType: "social_account", targetId: r.id, details: { platform: r.platform } });
  }
  log.info("meta.deauthorize", { accounts: rows.length });
  return { accounts: rows.length };
}

/** What the public status page may show for a confirmation code: status and dates only. */
export async function deletionStatus(code: string | null | undefined) {
  if (!code || !/^[A-Z2-9]{12}$/.test(code)) return null;
  const db = await getDb();
  const [r] = await db
    .select({ status: schema.dataDeletionRequests.status, requestedAt: schema.dataDeletionRequests.requestedAt, completedAt: schema.dataDeletionRequests.completedAt })
    .from(schema.dataDeletionRequests)
    .where(eq(schema.dataDeletionRequests.confirmationCode, code));
  return r ?? null;
}
