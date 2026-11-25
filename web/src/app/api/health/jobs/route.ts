import { authenticateCron } from "@/server/cron-auth";
import { jobHealth } from "@/server/jobs/health";
import { captureError } from "@/server/monitoring";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

/**
 * GET /api/health/jobs (Authorization: Bearer $CRON_SECRET): background-job health for an uptime
 * monitor. 200 when healthy, 503 when jobs are overdue or stuck (src/server/jobs/health.ts). Counts
 * only; no job contents.
 */
export async function GET(req: Request) {
  const auth = await authenticateCron(req);
  if (!auth.ok) return new Response(auth.status === 503 ? "Cron is not configured" : "Unauthorized", { status: auth.status, headers: NO_STORE });
  try {
    const h = await jobHealth();
    return Response.json(h, { status: h.ok ? 200 : 503, headers: NO_STORE });
  } catch (e) {
    const reference = captureError(e, { where: "health.jobs" });
    return Response.json({ ok: false, error: "Job health check failed", reference }, { status: 503, headers: NO_STORE });
  }
}
