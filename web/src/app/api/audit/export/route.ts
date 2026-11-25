import { NextResponse } from "next/server";
import { getSession } from "@/server/auth/session";
import { AccessError } from "@/server/auth/guard";
import { StepUpRequired } from "@/server/auth/step-up";
import { auditExportFor } from "@/server/audit";
import { appUrl } from "@/server/social/service";

/** GET /api/audit/export?workspace=<id>&format=csv|json&days=<n>: Security log export (audit.ts). */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const session = await getSession();
  if (!session) return NextResponse.redirect(`${appUrl()}/login`);
  const format = url.searchParams.get("format") === "json" ? "json" : "csv";
  const days = Number(url.searchParams.get("days") ?? "365");
  try {
    const out = await auditExportFor(session, url.searchParams.get("workspace") ?? "", { format, sinceDays: Number.isFinite(days) ? days : 365 });
    return new NextResponse(out.body, {
      headers: { "content-type": out.contentType, "content-disposition": `attachment; filename="${out.filename}"`, "cache-control": "no-store" },
    });
  } catch (e) {
    if (e instanceof StepUpRequired) return NextResponse.redirect(`${appUrl()}/account/verify?next=${encodeURIComponent(url.pathname + url.search)}`);
    if (e instanceof AccessError) return NextResponse.json({ error: "Not allowed." }, { status: 403 });
    throw e;
  }
}
