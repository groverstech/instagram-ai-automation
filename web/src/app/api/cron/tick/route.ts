import crypto from "node:crypto";
import { tick } from "@/server/jobs/handlers";

export const runtime = "nodejs";

/** External scheduler entry point (Vercel Cron, GitHub Actions, etc.). */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const got = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!secret || got.length !== secret.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(secret))) {
    return new Response("Unauthorized", { status: 401 });
  }
  const results = await tick();
  return Response.json({ ran: results.length, results });
}
