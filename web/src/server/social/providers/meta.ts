import { jsonFetch, form } from "../http";
import { PlatformError, type SocialProvider, type TokenSet, type DiscoveredAccount } from "../types";

const V = process.env.META_GRAPH_VERSION ?? "v23.0";
const G = `https://graph.facebook.com/${V}`;
const SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "read_insights",
  "business_management",
  "instagram_basic",
  "instagram_content_publish",
  "instagram_manage_insights",
].join(",");

const configured = () => Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET);

function authorizeUrl({ state, redirectUri }: { state: string; redirectUri: string }) {
  const u = new URL(`https://www.facebook.com/${V}/dialog/oauth`);
  u.search = form({ client_id: process.env.META_APP_ID!, redirect_uri: redirectUri, state, scope: SCOPES, response_type: "code" }).toString();
  return u.toString();
}

async function exchangeCode({ code, redirectUri }: { code: string; redirectUri: string }): Promise<TokenSet> {
  const short = await jsonFetch<{ access_token: string }>(
    `${G}/oauth/access_token?${form({ client_id: process.env.META_APP_ID!, client_secret: process.env.META_APP_SECRET!, redirect_uri: redirectUri, code })}`,
  );
  // Exchange for a long-lived (~60 day) user token; Page tokens derived from it don't expire.
  const long = await jsonFetch<{ access_token: string; expires_in?: number }>(
    `${G}/oauth/access_token?${form({ grant_type: "fb_exchange_token", client_id: process.env.META_APP_ID!, client_secret: process.env.META_APP_SECRET!, fb_exchange_token: short.access_token })}`,
  );
  return { accessToken: long.access_token, expiresAt: long.expires_in ? new Date(Date.now() + long.expires_in * 1000) : undefined, scopes: SCOPES };
}

type Page = {
  id: string;
  name: string;
  access_token: string;
  picture?: { data?: { url?: string } };
  instagram_business_account?: { id: string; username?: string; name?: string; profile_picture_url?: string };
};

async function pages(token: TokenSet): Promise<Page[]> {
  const res = await jsonFetch<{ data: Page[] }>(
    `${G}/me/accounts?${form({ fields: "id,name,access_token,picture,instagram_business_account{id,username,name,profile_picture_url}", access_token: token.accessToken, limit: "100" })}`,
  );
  return res.data ?? [];
}

export const facebook: SocialProvider = {
  id: "facebook",
  label: "Facebook",
  oauthFamily: "meta",
  envKeys: ["META_APP_ID", "META_APP_SECRET"],
  capabilities: {
    publishImage: "supported",
    publishCarousel: "supported",
    publishVideo: "supported",
    scheduleNative: "supported",
    postAnalytics: "supported",
    accountAnalytics: "supported",
    notes: "Publishes to Facebook Pages you manage. Personal profiles can't be posted to via the API.",
  },
  configured,
  authorizeUrl,
  exchangeCode,
  async discoverAccounts(token) {
    return (await pages(token)).map(
      (p): DiscoveredAccount => ({
        platform: "facebook",
        externalId: p.id,
        name: p.name,
        avatarUrl: p.picture?.data?.url,
        token: { accessToken: p.access_token, scopes: token.scopes },
      }),
    );
  },
  async publish(account, input) {
    const r = await jsonFetch<{ id: string; post_id?: string }>(`${G}/${account.externalId}/photos`, {
      method: "POST",
      body: form({ url: input.imageUrl, message: input.caption, access_token: account.accessToken }),
    });
    const postId = r.post_id ?? r.id;
    return { externalId: postId, url: `https://www.facebook.com/${postId}` };
  },
  async postMetrics(account, externalId) {
    const r = await jsonFetch<{ reactions?: { summary?: { total_count?: number } }; comments?: { summary?: { total_count?: number } }; shares?: { count?: number } }>(
      `${G}/${externalId}?${form({ fields: "reactions.summary(true).limit(0),comments.summary(true).limit(0),shares", access_token: account.accessToken })}`,
    );
    let reach: number | null = null;
    let impressions: number | null = null;
    try {
      const ins = await jsonFetch<{ data: { name: string; values: { value: number }[] }[] }>(
        `${G}/${externalId}/insights?${form({ metric: "post_impressions_unique,post_impressions", access_token: account.accessToken })}`,
      );
      for (const m of ins.data) {
        if (m.name === "post_impressions_unique") reach = m.values[0]?.value ?? null;
        if (m.name === "post_impressions") impressions = m.values[0]?.value ?? null;
      }
    } catch {
      /* insights may be unavailable for small pages; keep counts we have */
    }
    return { likes: r.reactions?.summary?.total_count ?? null, comments: r.comments?.summary?.total_count ?? null, shares: r.shares?.count ?? 0, reach, impressions };
  },
  async accountMetrics(account) {
    const r = await jsonFetch<{ followers_count?: number; fan_count?: number }>(`${G}/${account.externalId}?${form({ fields: "followers_count,fan_count", access_token: account.accessToken })}`);
    return { followers: r.followers_count ?? r.fan_count ?? null };
  },
};

export const instagram: SocialProvider = {
  id: "instagram",
  label: "Instagram",
  oauthFamily: "meta",
  envKeys: ["META_APP_ID", "META_APP_SECRET"],
  capabilities: {
    publishImage: "supported",
    publishCarousel: "supported",
    publishVideo: "supported",
    scheduleNative: "unsupported",
    postAnalytics: "supported",
    accountAnalytics: "supported",
    notes: "Requires an Instagram Business or Creator account linked to a Facebook Page. Stories need the Reels/Stories publishing permission. Scheduling is handled by BrandPilot's scheduler.",
  },
  configured,
  authorizeUrl,
  exchangeCode,
  async discoverAccounts(token) {
    return (await pages(token))
      .filter((p) => p.instagram_business_account)
      .map(
        (p): DiscoveredAccount => ({
          platform: "instagram",
          externalId: p.instagram_business_account!.id,
          name: p.instagram_business_account!.name ?? p.instagram_business_account!.username ?? p.name,
          handle: p.instagram_business_account!.username,
          avatarUrl: p.instagram_business_account!.profile_picture_url,
          token: { accessToken: p.access_token, scopes: token.scopes },
          meta: { pageId: p.id },
        }),
      );
  },
  async publish(account, input) {
    const container = await jsonFetch<{ id: string }>(`${G}/${account.externalId}/media`, {
      method: "POST",
      body: form({ image_url: input.imageUrl, caption: input.caption, access_token: account.accessToken }),
    });
    // Wait for Instagram to fetch and process the image.
    for (let i = 0; i < 10; i++) {
      const s = await jsonFetch<{ status_code?: string; status?: string }>(`${G}/${container.id}?${form({ fields: "status_code,status", access_token: account.accessToken })}`);
      if (s.status_code === "FINISHED") break;
      if (s.status_code === "ERROR" || s.status_code === "EXPIRED") throw new PlatformError(`Instagram couldn't process the image: ${s.status ?? s.status_code}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
    const pub = await jsonFetch<{ id: string }>(`${G}/${account.externalId}/media_publish`, {
      method: "POST",
      body: form({ creation_id: container.id, access_token: account.accessToken }),
    });
    const info = await jsonFetch<{ permalink?: string }>(`${G}/${pub.id}?${form({ fields: "permalink", access_token: account.accessToken })}`).catch(() => ({ permalink: undefined }));
    return { externalId: pub.id, url: info.permalink };
  },
  async postMetrics(account, externalId) {
    const base = await jsonFetch<{ like_count?: number; comments_count?: number }>(`${G}/${externalId}?${form({ fields: "like_count,comments_count", access_token: account.accessToken })}`);
    const out: Record<string, number | null> = { likes: base.like_count ?? null, comments: base.comments_count ?? null };
    try {
      const ins = await jsonFetch<{ data: { name: string; values?: { value: number }[]; total_value?: { value: number } }[] }>(
        `${G}/${externalId}/insights?${form({ metric: "reach,views,saved,shares", access_token: account.accessToken })}`,
      );
      for (const m of ins.data) {
        const v = m.values?.[0]?.value ?? m.total_value?.value ?? null;
        if (m.name === "reach") out.reach = v;
        if (m.name === "views") out.impressions = v;
        if (m.name === "saved") out.saves = v;
        if (m.name === "shares") out.shares = v;
      }
    } catch {
      /* insights need instagram_manage_insights and a business account */
    }
    return out;
  },
  async accountMetrics(account) {
    const r = await jsonFetch<{ followers_count?: number }>(`${G}/${account.externalId}?${form({ fields: "followers_count", access_token: account.accessToken })}`);
    const out: { followers: number | null; profileVisits?: number | null; reach?: number | null } = { followers: r.followers_count ?? null };
    try {
      const ins = await jsonFetch<{ data: { name: string; total_value?: { value: number } }[] }>(
        `${G}/${account.externalId}/insights?${form({ metric: "reach,profile_views", period: "day", metric_type: "total_value", access_token: account.accessToken })}`,
      );
      for (const m of ins.data) {
        if (m.name === "reach") out.reach = m.total_value?.value ?? null;
        if (m.name === "profile_views") out.profileVisits = m.total_value?.value ?? null;
      }
    } catch {
      /* optional */
    }
    return out;
  },
};
