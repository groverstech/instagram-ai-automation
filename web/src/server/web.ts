import "server-only";
import dns from "node:dns/promises";
import net from "node:net";

const MAX_REDIRECTS = 4;
const MAX_BYTES = 400_000;

/** True for loopback, private, link-local, CGNAT, multicast, reserved and unspecified addresses. */
export function isPrivateAddress(ip: string): boolean {
  let v = ip.toLowerCase();
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) v = mapped[1];
  if (net.isIPv4(v)) {
    const [a, b] = v.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (net.isIPv6(v)) {
    return v === "::" || v === "::1" || v.startsWith("fc") || v.startsWith("fd") || /^fe[89ab]/.test(v) || v.startsWith("ff") || v.startsWith("::ffff:") || v.startsWith("64:ff9b:");
  }
  return true;
}

/** Validate a URL for server-side fetching: http(s) on standard ports, resolving only to public addresses. */
export async function assertPublicUrl(url: URL): Promise<void> {
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only http(s) URLs can be fetched.");
  if (url.port && !["80", "443"].includes(url.port)) throw new Error("Only standard ports can be fetched.");
  if (url.username || url.password) throw new Error("URLs with credentials can't be fetched.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true, verbatim: true });
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw new Error("This address isn't publicly reachable.");
}

/**
 * Fetch a public web page as plain text (SSRF-guarded). Every redirect hop is re-validated, so a
 * public page can't bounce the server to an internal address. Returns null on any failure.
 *
 * Residual risk: DNS can change between validation and connection (rebinding). Run the app
 * where outbound traffic to internal networks is also blocked at the network layer.
 */
export async function fetchPublicText(rawUrl: string, maxChars = 8000): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
  } catch {
    return null;
  }
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await assertPublicUrl(url);
      const res = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(8000),
        headers: { "user-agent": "BrandPilotBot/0.1 (+brand research)", accept: "text/html,text/plain" },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        await res.body?.cancel();
        if (!loc) return null;
        url = new URL(loc, url);
        continue;
      }
      if (!res.ok || !(res.headers.get("content-type") ?? "").includes("text")) {
        await res.body?.cancel();
        return null;
      }
      const html = await readCapped(res, MAX_BYTES);
      return htmlToText(html).slice(0, maxChars);
    }
    return null;
  } catch {
    return null;
  }
}

async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  await reader.cancel().catch(() => {});
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, max));
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
