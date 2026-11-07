import { NextResponse, type NextRequest } from "next/server";

/**
 * Coarse per-IP flood protection in front of the app. Returns HTTP 429 with Retry-After.
 * In-memory and per instance; the precise per-user / per-organisation limits are enforced in
 * Postgres (src/server/ratelimit.ts) and are shared across instances.
 */
const WINDOW_MS = 60_000;
const LIMITS = { mutate: 120, api: 600 }; // POST/PUT/PATCH/DELETE (incl. server actions), and /api GETs, per IP per minute
const hits = new Map<string, { start: number; n: number }>();

function take(key: string, limit: number, now: number) {
  const cur = hits.get(key);
  if (!cur || now - cur.start >= WINDOW_MS) {
    hits.set(key, { start: now, n: 1 });
    if (hits.size > 50_000) for (const [k, v] of hits) if (now - v.start >= WINDOW_MS) hits.delete(k);
    return 0;
  }
  cur.n++;
  return cur.n > limit ? Math.ceil((cur.start + WINDOW_MS - now) / 1000) : 0;
}

export function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;
  // Machine-to-machine endpoints with their own authentication.
  if (path === "/api/billing/webhook" || path === "/api/cron/tick") return NextResponse.next();
  const mutating = !["GET", "HEAD", "OPTIONS"].includes(req.method);
  if (!mutating && !path.startsWith("/api/")) return NextResponse.next();
  const ip = (req.headers.get("x-forwarded-for")?.split(",")[0] ?? req.headers.get("x-real-ip") ?? "unknown").trim();
  const kind = mutating ? "mutate" : "api";
  const retryAfter = take(`${kind}:${ip}`, LIMITS[kind], Date.now());
  if (retryAfter) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down and try again shortly.", retryAfter },
      { status: 429, headers: { "retry-after": String(retryAfter) } },
    );
  }
  return NextResponse.next();
}

export const config = {
  // Skip static files, images, icons, manifest and asset links (PWA/TWA must never be throttled here).
  matcher: ["/((?!_next/static|_next/image|icons/|icon|apple-icon|manifest.webmanifest|\\.well-known/|favicon).*)"],
};
