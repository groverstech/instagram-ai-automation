import { NextResponse, type NextRequest } from "next/server";
import { clientIp } from "@/server/client-ip";

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

/** A request ID for tracing: keep a well-formed one from the load balancer, otherwise make one. */
function requestId(req: NextRequest) {
  const given = req.headers.get("x-request-id");
  return given && /^[\w.-]{8,128}$/.test(given) ? given : crypto.randomUUID();
}

/** Continue to the app with the request ID on both the forwarded request and the response. */
function next(req: NextRequest, id: string) {
  const headers = new Headers(req.headers);
  headers.set("x-request-id", id);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set("x-request-id", id);
  return res;
}

export function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;
  const id = requestId(req);
  // Machine-to-machine endpoints with their own authentication.
  // Health checks are polled by load balancers and monitors from a few addresses.
  if (path === "/api/billing/webhook" || path === "/api/cron/tick" || path.startsWith("/api/health/")) return next(req, id);
  const mutating = !["GET", "HEAD", "OPTIONS"].includes(req.method);
  if (!mutating && !path.startsWith("/api/")) return next(req, id);
  const ip = clientIp(req.headers);
  const kind = mutating ? "mutate" : "api";
  const retryAfter = take(`${kind}:${ip}`, LIMITS[kind], Date.now());
  if (retryAfter) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down and try again shortly.", retryAfter },
      { status: 429, headers: { "retry-after": String(retryAfter), "x-request-id": id } },
    );
  }
  return next(req, id);
}

export const config = {
  // Skip static files, images, icons, manifest and asset links (PWA/TWA must never be throttled here).
  matcher: ["/((?!_next/static|_next/image|icons/|icon|apple-icon|manifest.webmanifest|\\.well-known/|favicon).*)"],
};
