import { version } from "@/server/health";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Liveness: the process is up and serving requests. No dependencies, so it never flaps. */
export function GET() {
  return Response.json({ status: "ok", version: version() }, { headers: { "cache-control": "no-store" } });
}
