import { getDb } from "@/server/db/client";
import { verify } from "@/server/crypto";
import { NotApprovedContentError, renderApproved } from "@/server/social/approval";
import { toPublishJpeg } from "@/server/creative/publish-media";

export const runtime = "nodejs";

/**
 * Signed, expiring URL that social platforms fetch a post's image from when publishing.
 *
 * Each link is bound to one approved version of one post (review M-1): `p` is the post and `h` the
 * approval hash it was issued for (social/service.ts publicMediaUrl). The image is served only while
 * the post still carries that approval and its post, creative and brand still hash to it, checked
 * before and after rendering; otherwise 409 and nothing is served, so a change made while a platform
 * is fetching can't reach it. Links without that binding (issued before) are refused.
 *
 * `<token>.jpg` serves sRGB JPEG, which Instagram requires; `<token>.png` serves PNG. Never cached:
 * a later request must be checked again.
 */
export async function GET(_: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const jpeg = !token.endsWith(".png");
  const claims = verify<{ p?: string; h?: string }>(token.replace(/\.(png|jpe?g)$/, ""));
  if (!claims) return new Response("Link expired or invalid", { status: 403 });
  if (typeof claims.p !== "string" || typeof claims.h !== "string" || !/^[0-9a-f]{64}$/.test(claims.h)) return new Response("Link expired or invalid", { status: 403 });
  let png: Buffer;
  try {
    png = await renderApproved(await getDb(), claims.p, claims.h);
  } catch (e) {
    if (e instanceof NotApprovedContentError) return new Response("This content is no longer approved", { status: 409, headers: { "cache-control": "no-store" } });
    throw e;
  }
  const body = jpeg ? await toPublishJpeg(png) : png;
  return new Response(new Uint8Array(body), { headers: { "content-type": jpeg ? "image/jpeg" : "image/png", "cache-control": "no-store" } });
}
