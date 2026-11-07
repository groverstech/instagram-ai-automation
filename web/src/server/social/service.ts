import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import { decrypt, encrypt, sign } from "../crypto";
import { provider } from "./registry";
import { PublishNotSupported, type AccountForUse, type DiscoveredAccount } from "./types";
import { renderCreativePng } from "../creative/render";
import { remember } from "../memory";

export function appUrl() {
  return (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

export function isPublicAppUrl() {
  try {
    const u = new URL(appUrl());
    return u.protocol === "https:" && !["localhost", "127.0.0.1"].includes(u.hostname);
  } catch {
    return false;
  }
}

/** Signed URL platforms can fetch the rendered creative from (valid 24h). */
export function publicMediaUrl(creativeId: string, format?: string) {
  const token = sign({ c: creativeId, f: format ?? null, exp: Date.now() + 24 * 3600 * 1000 });
  return `${appUrl()}/api/public/media/${token}.png`;
}

export async function saveAccounts(brandId: string, userId: string, accounts: DiscoveredAccount[]) {
  const db = await getDb();
  for (const a of accounts) {
    const values = {
      brandId,
      platform: a.platform,
      externalId: a.externalId,
      name: a.name,
      handle: a.handle ?? null,
      avatarUrl: a.avatarUrl ?? null,
      accessTokenEnc: encrypt(a.token.accessToken),
      refreshTokenEnc: a.token.refreshToken ? encrypt(a.token.refreshToken) : null,
      expiresAt: a.token.expiresAt ?? null,
      scopes: a.token.scopes ?? null,
      status: "active" as const,
      meta: a.meta ?? {},
      connectedBy: userId,
    };
    await db
      .insert(schema.socialAccounts)
      .values(values)
      .onConflictDoUpdate({
        target: [schema.socialAccounts.brandId, schema.socialAccounts.platform, schema.socialAccounts.externalId],
        set: values,
      });
  }
}

export function toUsable(a: typeof schema.socialAccounts.$inferSelect): AccountForUse {
  return { id: a.id, platform: a.platform, externalId: a.externalId, accessToken: decrypt(a.accessTokenEnc), meta: a.meta };
}

/**
 * Publish a post. Preconditions (enforced here, not just in the UI):
 * approved or scheduled status, a creative, and an active account on the same platform.
 * The platform's real response is stored; failures are recorded, never masked.
 */
export async function publishPost(postId: string) {
  const db = await getDb();
  const [post] = await db.select().from(schema.posts).where(eq(schema.posts.id, postId));
  if (!post) throw new Error("Post not found");
  if (!["approved", "scheduled", "failed"].includes(post.status)) throw new Error(`Post must be approved before publishing (current status: ${post.status}).`);
  if (!post.approvedAt) throw new Error("Post has no recorded approval.");

  const fail = async (msg: string) => {
    await db.update(schema.posts).set({ status: "failed", publishError: msg }).where(eq(schema.posts.id, postId));
    return { ok: false as const, error: msg };
  };

  if (!post.creativeId) return fail("Attach a creative before publishing.");
  if (!post.socialAccountId) return fail("Choose a connected account for this post.");
  const [acct] = await db
    .select()
    .from(schema.socialAccounts)
    .where(and(eq(schema.socialAccounts.id, post.socialAccountId), eq(schema.socialAccounts.brandId, post.brandId)));
  if (!acct || acct.status !== "active") return fail("The selected account is disconnected. Reconnect it in Social Accounts.");
  if (acct.platform !== post.platform) return fail("The selected account is on a different platform than the post.");
  const p = provider(acct.platform);
  if (!p.publish || p.capabilities.publishImage === "unsupported") return fail(`${p.label} doesn't support publishing image posts through its API.`);
  if (["instagram", "pinterest", "facebook", "tiktok"].includes(p.id) && !isPublicAppUrl()) {
    return fail(`${p.label} downloads the image from a public URL. Set APP_URL to your public https domain before publishing.`);
  }

  const [creative] = await db.select().from(schema.creatives).where(eq(schema.creatives.id, post.creativeId));
  const [brand] = await db.select().from(schema.brands).where(eq(schema.brands.id, post.brandId));
  await db.update(schema.posts).set({ status: "publishing", publishError: null }).where(eq(schema.posts.id, postId));

  const caption = [post.caption ?? "", post.hashtags.length ? post.hashtags.map((h) => `#${h.replace(/^#/, "")}`).join(" ") : ""].filter(Boolean).join("\n\n");
  try {
    const res = await p.publish(toUsable(acct), {
      caption,
      title: post.title ?? undefined,
      imageUrl: publicMediaUrl(creative.id, post.format),
      image: () => renderCreativePng(creative, brand, post.format),
    });
    await db
      .update(schema.posts)
      .set({ status: "published", externalId: res.externalId, externalUrl: res.url ?? null, publishedAt: new Date(), publishError: null })
      .where(eq(schema.posts.id, postId));
    return { ok: true as const, ...res };
  } catch (e) {
    const msg = e instanceof PublishNotSupported ? e.message : `Publishing failed: ${e instanceof Error ? e.message : String(e)}`;
    return fail(msg);
  }
}

/** Pull real metrics for published posts and accounts. Writes source='platform'. */
export async function syncMetrics(brandId: string) {
  const db = await getDb();
  const accounts = await db
    .select()
    .from(schema.socialAccounts)
    .where(and(eq(schema.socialAccounts.brandId, brandId), eq(schema.socialAccounts.status, "active")));
  const today = new Date().toISOString().slice(0, 10);
  const report = { accounts: 0, posts: 0, errors: [] as string[] };
  for (const acct of accounts) {
    const p = provider(acct.platform);
    const usable = toUsable(acct);
    if (p.accountMetrics) {
      try {
        const m = await p.accountMetrics(usable);
        await db
          .insert(schema.accountMetrics)
          .values({ socialAccountId: acct.id, date: today, followers: m.followers ?? null, profileVisits: m.profileVisits ?? null, reach: m.reach ?? null, impressions: m.impressions ?? null })
          .onConflictDoUpdate({
            target: [schema.accountMetrics.socialAccountId, schema.accountMetrics.date],
            set: { followers: m.followers ?? null, profileVisits: m.profileVisits ?? null, reach: m.reach ?? null, impressions: m.impressions ?? null },
          });
        report.accounts++;
      } catch (e) {
        report.errors.push(`${p.label} account: ${(e as Error).message}`);
      }
    }
    if (!p.postMetrics) continue;
    const published = await db
      .select()
      .from(schema.posts)
      .where(and(eq(schema.posts.socialAccountId, acct.id), eq(schema.posts.status, "published")));
    for (const post of published) {
      if (!post.externalId) continue;
      try {
        const m = await p.postMetrics(usable, post.externalId);
        const interactions = (m.likes ?? 0) + (m.comments ?? 0) + (m.shares ?? 0) + (m.saves ?? 0);
        const denom = m.reach ?? m.impressions ?? null;
        await db.insert(schema.postMetrics).values({
          postId: post.id,
          reach: m.reach ?? null,
          impressions: m.impressions ?? null,
          likes: m.likes ?? null,
          comments: m.comments ?? null,
          shares: m.shares ?? null,
          saves: m.saves ?? null,
          videoViews: m.videoViews ?? null,
          linkClicks: m.linkClicks ?? null,
          engagementRate: denom ? interactions / denom : null,
          source: "platform",
        });
        report.posts++;
      } catch (e) {
        report.errors.push(`${p.label} post ${post.id.slice(0, 8)}: ${(e as Error).message}`);
      }
    }
  }
  return report;
}

/** Approval checkpoint: records who approved and teaches brand memory. */
export async function approvePost(brandId: string, postId: string, userId: string) {
  const db = await getDb();
  const [p] = await db
    .update(schema.posts)
    .set({ status: "approved", approvedBy: userId, approvedAt: new Date() })
    .where(and(eq(schema.posts.id, postId), eq(schema.posts.brandId, brandId)))
    .returning();
  if (p?.caption) {
    await remember(brandId, [{ kind: "approval", content: `Approved ${p.platform} caption (${p.objective ?? "general"}): "${p.caption.slice(0, 280)}"`, source: "post:approved", weight: 1.2 }]);
  }
  return p;
}
