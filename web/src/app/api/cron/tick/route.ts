import { tick } from "@/server/jobs/handlers";
import { authenticateCron } from "@/server/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

/**
 * External scheduler entry point (Vercel Cron, GitHub Actions, a system cron…): runs due jobs and
 * recovers strategist jobs. Requires `Authorization: Bearer $CRON_SECRET` (32+ characters).
 * Running it more often than needed is harmless: every job is claimed atomically.
 */
export async function GET(req: Request) {
  const auth = await authenticateCron(req);
  if (!auth.ok) {
    const body = auth.status === 503 ? "Cron is not configured" : auth.status === 429 ? "Too many failed attempts" : "Unauthorized";
    return new Response(body, { status: auth.status, headers: { ...NO_STORE, ...(auth.retryAfter ? { "retry-after": String(auth.retryAfter) } : {}) } });
  }
  const results = await tick();
  return Response.json({ ran: results.length, results }, { headers: NO_STORE });
}
