import { readiness } from "@/server/health";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Readiness: 200 when this instance can serve traffic, 503 otherwise (see src/server/health.ts). */
export async function GET() {
  const r = await readiness();
  return Response.json(r, { status: r.status === "ready" ? 200 : 503, headers: { "cache-control": "no-store" } });
}
