import { NextResponse } from "next/server";
import { getSession } from "@/server/auth/session";
import { AccessError } from "@/server/auth/guard";
import { StepUpRequired } from "@/server/auth/step-up";
import { RateLimitError } from "@/server/ratelimit";
import { ExportBusyError, exportWorkspaceFor } from "@/server/tenant-export";
import { appUrl } from "@/server/social/service";

/** GET /api/workspace/export?workspace=<id>: the organisation's data as a ZIP (tenant-export.ts). */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const session = await getSession();
  if (!session) return NextResponse.redirect(`${appUrl()}/login`);
  try {
    const out = await exportWorkspaceFor(session, url.searchParams.get("workspace") ?? "");
    return new NextResponse(new Uint8Array(out.body), {
      headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${out.filename}"`, "cache-control": "no-store" },
    });
  } catch (e) {
    if (e instanceof StepUpRequired) return NextResponse.redirect(`${appUrl()}/account/verify?next=${encodeURIComponent(url.pathname + url.search)}`);
    if (e instanceof AccessError) return NextResponse.json({ error: e.message || "Not allowed." }, { status: 403 });
    if (e instanceof ExportBusyError) return NextResponse.json({ error: e.message }, { status: 503, headers: { "retry-after": "60" } });
    if (e instanceof RateLimitError) return NextResponse.json({ error: e.message }, { status: 429, headers: { "retry-after": String(e.retryAfter) } });
    throw e;
  }
}
