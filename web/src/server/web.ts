import "server-only";
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";

/**
 * SSRF-safe fetching of public web pages (used to read a brand's website).
 *
 * Defences, in order, for every hop (initial URL and each redirect):
 *  1. URL policy: http/https only, ports 80/443 only, no credentials, no internal hostnames.
 *  2. DNS resolved once by us; EVERY returned address must be public (BlockList below).
 *  3. The TCP connection is pinned to the validated address (custom `lookup`), so the
 *     hostname is never re-resolved: this closes the DNS-rebinding window. TLS still verifies
 *     the certificate against the hostname (SNI), and the Host header is the hostname.
 *  4. Redirects are never followed automatically; each Location is re-validated from step 1.
 *  5. Total timeout, response-size cap, content-type allowlist.
 */

export const LIMITS = { maxRedirects: 4, maxBytes: 400_000, timeoutMs: 8000 } as const;

const blocked = new net.BlockList();
for (const [net4, prefix] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, incl. cloud metadata 169.254.169.254
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
] as const) {
  blocked.addSubnet(net4, prefix, "ipv4");
}
for (const [net6, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["64:ff9b::", 96], // NAT64
  ["64:ff9b:1::", 48], // local-use NAT64
  ["100::", 64], // discard
  ["2001::", 23], // IETF protocol assignments (incl. Teredo)
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4 (can embed private IPv4)
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
] as const) {
  blocked.addSubnet(net6, prefix, "ipv6");
}

// Kept separate: Node's BlockList treats every IPv4 address as IPv4-mapped IPv6, so adding
// ::ffff:0:0/96 to the main list would match ALL IPv4 addresses.
const ipv4Mapped = new net.BlockList();
ipv4Mapped.addSubnet("::ffff:0:0", 96, "ipv6");

/** True for any address that is not a globally routable unicast address. */
export function isPrivateAddress(ip: string): boolean {
  const addr = ip.replace(/^\[|\]$/g, "").toLowerCase();
  if (net.isIPv4(addr)) return blocked.check(addr, "ipv4");
  if (net.isIPv6(addr)) return ipv4Mapped.check(addr, "ipv6") || blocked.check(addr, "ipv6"); // never connect via IPv4-mapped notation
  return true;
}

const INTERNAL_HOST = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain|home\.arpa)$/i;
const METADATA_HOSTS = new Set(["metadata", "metadata.google.internal", "metadata.goog", "instance-data", "instance-data.ec2.internal"]);

export class UnsafeUrlError extends Error {}

/** Syntactic URL policy (no DNS). Returns the normalised hostname. */
export function checkUrlPolicy(url: URL): string {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new UnsafeUrlError("Only http(s) URLs can be fetched.");
  if (url.username || url.password) throw new UnsafeUrlError("URLs with credentials can't be fetched.");
  if (url.port && url.port !== "80" && url.port !== "443") throw new UnsafeUrlError("Only standard ports can be fetched.");
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!host) throw new UnsafeUrlError("Missing host.");
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new UnsafeUrlError("This address isn't publicly reachable.");
    return host;
  }
  if (!host.includes(".") || INTERNAL_HOST.test(host) || METADATA_HOSTS.has(host)) throw new UnsafeUrlError("Internal hostnames can't be fetched.");
  return host;
}

export type Resolved = { address: string; family: 4 | 6 };
export type Resolver = (host: string) => Promise<Resolved[]>;

const systemResolver: Resolver = async (host) =>
  (await dns.lookup(host, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));

/** Resolve once and require EVERY address to be public (mixed answers are rejected). */
export async function resolvePublic(host: string, resolver: Resolver = systemResolver): Promise<Resolved> {
  if (net.isIP(host)) return { address: host, family: net.isIPv6(host) ? 6 : 4 };
  let addrs: Resolved[];
  try {
    addrs = await resolver(host);
  } catch {
    throw new UnsafeUrlError("The hostname couldn't be resolved.");
  }
  if (!addrs.length) throw new UnsafeUrlError("The hostname couldn't be resolved.");
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new UnsafeUrlError("This hostname resolves to a non-public address.");
  return addrs[0];
}

export type PinnedResponse = { status: number; location: string | null; contentType: string; body: string };
export type Requester = (url: URL, pinned: Resolved, signal: AbortSignal) => Promise<PinnedResponse>;

/** HTTP(S) GET connected to a pre-validated IP. Never follows redirects; caps the body. */
export const requestPinned: Requester = (url, pinned, signal) =>
  new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      {
        method: "GET",
        headers: { "user-agent": "BrandPilotBot/0.1 (+brand research)", accept: "text/html,text/plain" },
        // Pin the connection: the hostname is NOT resolved again at connect time.
        lookup: (_h, opts, cb) => {
          const o = opts as { all?: boolean };
          if (o?.all) (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [{ address: pinned.address, family: pinned.family }]);
          else cb(null, pinned.address, pinned.family);
        },
        signal,
        agent: false,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = (res.headers.location as string | undefined) ?? null;
        const contentType = String(res.headers["content-type"] ?? "");
        if ((status >= 300 && status < 400) || status >= 400 || !/^text\/(html|plain)/i.test(contentType)) {
          res.destroy();
          return resolve({ status, location, contentType, body: "" });
        }
        const declared = Number(res.headers["content-length"] ?? 0);
        if (declared > LIMITS.maxBytes * 10) {
          res.destroy();
          return resolve({ status: 413, location: null, contentType, body: "" });
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (c: Buffer) => {
          chunks.push(c);
          total += c.length;
          if (total >= LIMITS.maxBytes) res.destroy(); // stop reading; keep what we have
        });
        const done = () => resolve({ status, location, contentType, body: Buffer.concat(chunks).subarray(0, LIMITS.maxBytes).toString("utf8") });
        res.on("end", done);
        res.on("close", done);
        res.on("error", done);
      },
    );
    req.on("error", reject);
    req.end();
  });

/**
 * Fetch a public web page as plain text. Returns null on any failure or policy violation.
 * Dependencies are injectable for tests.
 */
export async function fetchPublicText(
  rawUrl: string,
  maxChars = 8000,
  deps: { resolver?: Resolver; requester?: Requester; timeoutMs?: number } = {},
): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
  } catch {
    return null;
  }
  const signal = AbortSignal.timeout(deps.timeoutMs ?? LIMITS.timeoutMs);
  try {
    for (let hop = 0; hop <= LIMITS.maxRedirects; hop++) {
      const host = checkUrlPolicy(url);
      const pinned = await resolvePublic(host, deps.resolver);
      const res = await (deps.requester ?? requestPinned)(url, pinned, signal);
      if (res.status >= 300 && res.status < 400) {
        if (!res.location) return null;
        url = new URL(res.location, url);
        continue;
      }
      if (res.status !== 200 || !res.body) return null;
      return htmlToText(res.body).slice(0, maxChars);
    }
    return null; // too many redirects
  } catch {
    return null;
  }
}

/** Kept for callers/tests that validate a URL fully (policy + DNS) without fetching. */
export async function assertPublicUrl(url: URL, resolver?: Resolver): Promise<void> {
  await resolvePublic(checkUrlPolicy(url), resolver);
}

export function htmlToText(html: string): string {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "";
  const desc = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i)?.[1] ?? "";
  const body = html
    .replace(/<(script|style|noscript|svg|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|p|div|li|h[1-6]|section|article)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
  return [title && `Title: ${title.trim()}`, desc && `Description: ${desc.trim()}`, body].filter(Boolean).join("\n");
}
