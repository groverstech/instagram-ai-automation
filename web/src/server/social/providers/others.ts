import crypto from "node:crypto";
import { jsonFetch, form } from "../http";
import { PlatformError, PublishNotSupported, type SocialProvider } from "../types";

// ---------------- LinkedIn ----------------
const LI_VERSION = process.env.LINKEDIN_VERSION ?? "202510";
const LI_SCOPES = "openid profile w_member_social";

export const linkedin: SocialProvider = {
  id: "linkedin",
  label: "LinkedIn",
  oauthFamily: "linkedin",
  envKeys: ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"],
  capabilities: {
    publishImage: "supported",
    publishCarousel: "requires_app_review",
    publishVideo: "supported",
    scheduleNative: "unsupported",
    postAnalytics: "requires_app_review",
    accountAnalytics: "requires_app_review",
    notes: "Posts to the connected member's profile. Company Page posting and analytics need LinkedIn Community Management API access.",
  },
  configured: () => Boolean(process.env.LINKEDIN_CLIENT_ID && process.env.LINKEDIN_CLIENT_SECRET),
  authorizeUrl({ state, redirectUri }) {
    return `https://www.linkedin.com/oauth/v2/authorization?${form({ response_type: "code", client_id: process.env.LINKEDIN_CLIENT_ID!, redirect_uri: redirectUri, state, scope: LI_SCOPES })}`;
  },
  async exchangeCode({ code, redirectUri }) {
    const r = await jsonFetch<{ access_token: string; expires_in: number; refresh_token?: string; scope?: string }>("https://www.linkedin.com/oauth/v2/accessToken", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: process.env.LINKEDIN_CLIENT_ID!, client_secret: process.env.LINKEDIN_CLIENT_SECRET! }),
    });
    return { accessToken: r.access_token, refreshToken: r.refresh_token, expiresAt: new Date(Date.now() + r.expires_in * 1000), scopes: r.scope ?? LI_SCOPES };
  },
  async discoverAccounts(token) {
    const me = await jsonFetch<{ sub: string; name: string; picture?: string }>("https://api.linkedin.com/v2/userinfo", { headers: { authorization: `Bearer ${token.accessToken}` } });
    return [{ platform: "linkedin", externalId: `urn:li:person:${me.sub}`, name: me.name, avatarUrl: me.picture, token }];
  },
  async publish(account, input) {
    const h = { authorization: `Bearer ${account.accessToken}`, "LinkedIn-Version": LI_VERSION, "X-Restli-Protocol-Version": "2.0.0", "content-type": "application/json" };
    const init = await jsonFetch<{ value: { uploadUrl: string; image: string } }>("https://api.linkedin.com/rest/images?action=initializeUpload", {
      method: "POST",
      headers: h,
      body: JSON.stringify({ initializeUploadRequest: { owner: account.externalId } }),
    });
    const up = await fetch(init.value.uploadUrl, { method: "PUT", headers: { authorization: `Bearer ${account.accessToken}` }, body: new Uint8Array(await input.image()) });
    if (!up.ok) throw new PlatformError(`LinkedIn image upload failed (${up.status})`, up.status);
    const res = await fetch("https://api.linkedin.com/rest/posts", {
      method: "POST",
      headers: h,
      body: JSON.stringify({
        author: account.externalId,
        commentary: input.caption,
        visibility: "PUBLIC",
        distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
        content: { media: { id: init.value.image, title: input.title ?? "" } },
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false,
      }),
    });
    if (!res.ok) throw new PlatformError(`LinkedIn post failed (${res.status}): ${(await res.text()).slice(0, 300)}`, res.status);
    const urn = res.headers.get("x-restli-id") ?? "";
    return { externalId: urn, url: urn ? `https://www.linkedin.com/feed/update/${urn}` : undefined };
  },
};

// ---------------- Pinterest ----------------
export const pinterest: SocialProvider = {
  id: "pinterest",
  label: "Pinterest",
  oauthFamily: "pinterest",
  envKeys: ["PINTEREST_CLIENT_ID", "PINTEREST_CLIENT_SECRET"],
  capabilities: {
    publishImage: "supported",
    publishCarousel: "supported",
    publishVideo: "requires_app_review",
    scheduleNative: "unsupported",
    postAnalytics: "supported",
    accountAnalytics: "supported",
    notes: "Pins go to the board selected on the account (defaults to your first board). Trial apps can only create pins visible to you until Standard access is approved.",
  },
  configured: () => Boolean(process.env.PINTEREST_CLIENT_ID && process.env.PINTEREST_CLIENT_SECRET),
  authorizeUrl({ state, redirectUri }) {
    return `https://www.pinterest.com/oauth/?${form({ client_id: process.env.PINTEREST_CLIENT_ID!, redirect_uri: redirectUri, response_type: "code", scope: "boards:read,pins:read,pins:write,user_accounts:read", state })}`;
  },
  async exchangeCode({ code, redirectUri }) {
    const basic = Buffer.from(`${process.env.PINTEREST_CLIENT_ID}:${process.env.PINTEREST_CLIENT_SECRET}`).toString("base64");
    const r = await jsonFetch<{ access_token: string; refresh_token?: string; expires_in?: number; scope?: string }>("https://api.pinterest.com/v5/oauth/token", {
      method: "POST",
      headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" },
      body: form({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
    });
    return { accessToken: r.access_token, refreshToken: r.refresh_token, expiresAt: r.expires_in ? new Date(Date.now() + r.expires_in * 1000) : undefined, scopes: r.scope };
  },
  async discoverAccounts(token) {
    const h = { authorization: `Bearer ${token.accessToken}` };
    const me = await jsonFetch<{ username: string; profile_image?: string }>("https://api.pinterest.com/v5/user_account", { headers: h });
    const boards = await jsonFetch<{ items: { id: string; name: string }[] }>("https://api.pinterest.com/v5/boards?page_size=50", { headers: h });
    return [{ platform: "pinterest", externalId: me.username, name: me.username, handle: me.username, avatarUrl: me.profile_image, token, meta: { boards: boards.items, boardId: boards.items[0]?.id } }];
  },
  async publish(account, input) {
    const boardId = account.meta.boardId as string | undefined;
    if (!boardId) throw new PlatformError("No Pinterest board selected for this account. Create a board on Pinterest and reconnect.");
    const r = await jsonFetch<{ id: string }>("https://api.pinterest.com/v5/pins", {
      method: "POST",
      headers: { authorization: `Bearer ${account.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ board_id: boardId, title: (input.title ?? "").slice(0, 100), description: input.caption.slice(0, 800), media_source: { source_type: "image_url", url: input.imageUrl } }),
    });
    return { externalId: r.id, url: `https://www.pinterest.com/pin/${r.id}/` };
  },
  async postMetrics(account, externalId) {
    const end = new Date().toISOString().slice(0, 10);
    const start = new Date(Date.now() - 89 * 864e5).toISOString().slice(0, 10);
    const r = await jsonFetch<{ all?: { lifetime_metrics?: Record<string, number> } }>(
      `https://api.pinterest.com/v5/pins/${externalId}/analytics?${form({ start_date: start, end_date: end, metric_types: "IMPRESSION,SAVE,PIN_CLICK,OUTBOUND_CLICK" })}`,
      { headers: { authorization: `Bearer ${account.accessToken}` } },
    );
    const m = r.all?.lifetime_metrics ?? {};
    return { impressions: m.IMPRESSION ?? null, saves: m.SAVE ?? null, linkClicks: m.OUTBOUND_CLICK ?? null };
  },
};

// ---------------- YouTube ----------------
export const youtube: SocialProvider = {
  id: "youtube",
  label: "YouTube",
  oauthFamily: "google",
  envKeys: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
  capabilities: {
    publishImage: "unsupported",
    publishCarousel: "unsupported",
    publishVideo: "supported",
    scheduleNative: "supported",
    postAnalytics: "supported",
    accountAnalytics: "supported",
    notes: "The YouTube Data API only accepts video uploads. Use Creative Studio thumbnails with your video upload; community posts can't be created via the API.",
  },
  configured: () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
  authorizeUrl({ state, redirectUri, codeChallenge }) {
    return `https://accounts.google.com/o/oauth2/v2/auth?${form({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.upload",
      access_type: "offline",
      prompt: "consent",
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    })}`;
  },
  async exchangeCode({ code, redirectUri, codeVerifier }) {
    const r = await jsonFetch<{ access_token: string; refresh_token?: string; expires_in: number; scope?: string }>("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({ code, client_id: process.env.GOOGLE_CLIENT_ID!, client_secret: process.env.GOOGLE_CLIENT_SECRET!, redirect_uri: redirectUri, grant_type: "authorization_code", code_verifier: codeVerifier }),
    });
    return { accessToken: r.access_token, refreshToken: r.refresh_token, expiresAt: new Date(Date.now() + r.expires_in * 1000), scopes: r.scope };
  },
  async discoverAccounts(token) {
    const r = await jsonFetch<{ items?: { id: string; snippet: { title: string; customUrl?: string; thumbnails?: { default?: { url: string } } }; statistics?: { subscriberCount?: string } }[] }>(
      "https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true",
      { headers: { authorization: `Bearer ${token.accessToken}` } },
    );
    return (r.items ?? []).map((c) => ({ platform: "youtube", externalId: c.id, name: c.snippet.title, handle: c.snippet.customUrl, avatarUrl: c.snippet.thumbnails?.default?.url, token }));
  },
  async publish() {
    throw new PublishNotSupported("YouTube only accepts video uploads through its API. Image posts can't be published there.");
  },
  async accountMetrics(account) {
    const r = await jsonFetch<{ items?: { statistics?: { subscriberCount?: string } }[] }>(
      `https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${account.externalId}`,
      { headers: { authorization: `Bearer ${account.accessToken}` } },
    );
    const n = r.items?.[0]?.statistics?.subscriberCount;
    return { followers: n ? Number(n) : null };
  },
};

// ---------------- TikTok ----------------
export const tiktok: SocialProvider = {
  id: "tiktok",
  label: "TikTok",
  oauthFamily: "tiktok",
  envKeys: ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"],
  capabilities: {
    publishImage: "requires_app_review",
    publishCarousel: "requires_app_review",
    publishVideo: "requires_app_review",
    scheduleNative: "unsupported",
    postAnalytics: "requires_app_review",
    accountAnalytics: "supported",
    notes: "TikTok's Content Posting API needs an audited app and a verified media domain. Until then posts from unaudited apps are restricted to private visibility; set TIKTOK_DIRECT_POST_APPROVED=true once approved.",
  },
  configured: () => Boolean(process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET),
  authorizeUrl({ state, redirectUri, codeChallenge }) {
    return `https://www.tiktok.com/v2/auth/authorize/?${form({ client_key: process.env.TIKTOK_CLIENT_KEY!, scope: "user.info.basic,user.info.stats,video.publish", response_type: "code", redirect_uri: redirectUri, state, code_challenge: codeChallenge, code_challenge_method: "S256" })}`;
  },
  async exchangeCode({ code, redirectUri, codeVerifier }) {
    const r = await jsonFetch<{ access_token: string; refresh_token?: string; expires_in: number; scope?: string; open_id: string }>("https://open.tiktokapis.com/v2/oauth/token/", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({ client_key: process.env.TIKTOK_CLIENT_KEY!, client_secret: process.env.TIKTOK_CLIENT_SECRET!, code, grant_type: "authorization_code", redirect_uri: redirectUri, code_verifier: codeVerifier }),
    });
    return { accessToken: r.access_token, refreshToken: r.refresh_token, expiresAt: new Date(Date.now() + r.expires_in * 1000), scopes: r.scope };
  },
  async discoverAccounts(token) {
    const r = await jsonFetch<{ data: { user: { open_id: string; display_name: string; avatar_url?: string; username?: string } } }>(
      "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url,username",
      { headers: { authorization: `Bearer ${token.accessToken}` } },
    );
    const u = r.data.user;
    return [{ platform: "tiktok", externalId: u.open_id, name: u.display_name, handle: u.username, avatarUrl: u.avatar_url, token }];
  },
  async publish(account, input) {
    if (process.env.TIKTOK_DIRECT_POST_APPROVED !== "true") {
      throw new PublishNotSupported("TikTok publishing is disabled until your TikTok app passes the Content Posting API audit.");
    }
    const r = await jsonFetch<{ data: { publish_id: string } }>("https://open.tiktokapis.com/v2/post/publish/content/init/", {
      method: "POST",
      headers: { authorization: `Bearer ${account.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        post_info: { title: (input.title ?? "").slice(0, 90), description: input.caption.slice(0, 4000), privacy_level: "PUBLIC_TO_EVERYONE", disable_comment: false, auto_add_music: true },
        source_info: { source: "PULL_FROM_URL", photo_cover_index: 0, photo_images: [input.imageUrl] },
        post_mode: "DIRECT_POST",
        media_type: "PHOTO",
      }),
    });
    return { externalId: r.data.publish_id };
  },
};

export function pkce() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}
