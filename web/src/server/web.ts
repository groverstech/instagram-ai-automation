import "server-only";
import dns from "node:dns/promises";
import net from "node:net";

function isPrivate(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  return v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v.startsWith("::ffff:127.") || v === "::";
}

/** Fetch a public web page as plain text. Blocks private/internal addresses (SSRF guard). */
export async function fetchPublicText(rawUrl: string, maxChars = 8000): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol)) return null;
  try {
    const addrs = await dns.lookup(url.hostname, { all: true });
    if (!addrs.length || addrs.some((a) => isPrivate(a.address))) return null;
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
      headers: { "user-agent": "BrandPilotBot/0.1 (+brand research)", accept: "text/html,text/plain" },
    });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("text")) return null;
    const html = (await res.text()).slice(0, 400_000);
    return htmlToText(html).slice(0, maxChars);
  } catch {
    return null;
  }
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
