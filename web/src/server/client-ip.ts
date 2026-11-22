/**
 * The client's IP address, for rate limits and login protection.
 *
 * `X-Forwarded-For` is a list that every proxy *appends* to, so its leftmost entries are
 * whatever the client sent and can't be trusted. The trustworthy entry is the one added by the
 * last proxy we control: counting from the right by the number of trusted proxy hops.
 *
 *   CLIENT_IP_HEADER    a header your edge sets to the real client IP and strips from requests,
 *                       e.g. `cf-connecting-ip` behind Cloudflare. Takes precedence.
 *   TRUSTED_PROXY_HOPS  how many proxies you control append to X-Forwarded-For (default 1:
 *                       one load balancer). 0 = no proxy: X-Forwarded-For is ignored.
 *
 * Edge-safe: no Node APIs, no server-only imports (it runs in middleware too).
 */
type Env = Record<string, string | undefined>;

const MAX_LEN = 64;
const clean = (v: string | null | undefined) => {
  const s = (v ?? "").trim();
  return s && s.length <= MAX_LEN && /^[0-9a-fA-F:.]+$/.test(s) ? s : null;
};

export function clientIp(headers: Headers, env: Env = process.env): string {
  const custom = env.CLIENT_IP_HEADER?.trim().toLowerCase();
  if (custom) return clean(headers.get(custom)) ?? "unknown";

  const hops = /^\d+$/.test(env.TRUSTED_PROXY_HOPS ?? "") ? Number(env.TRUSTED_PROXY_HOPS) : 1;
  if (hops === 0) return "unknown";
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((p) => p.trim()).filter(Boolean);
    // The entry appended by the outermost trusted proxy. With fewer entries than hops, the list is
    // shorter than our own proxy chain, so the first entry is the best available.
    const pick = parts.length >= hops ? parts[parts.length - hops] : parts[0];
    const ip = clean(pick);
    if (ip) return ip;
  }
  return clean(headers.get("x-real-ip")) ?? "unknown";
}
