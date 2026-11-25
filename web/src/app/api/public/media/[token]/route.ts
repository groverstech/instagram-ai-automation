import { eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db/client";
import { verify } from "@/server/crypto";
import { renderCreativePng } from "@/server/creative/render";
import { toPublishJpeg } from "@/server/creative/publish-media";

export const runtime = "nodejs";

/**
 * Signed, expiring, single-creative URL that social platforms fetch when publishing.
 * `<token>.jpg` serves sRGB JPEG, which Instagram requires (publicMediaUrl issues these);
 * `<token>.png` still serves PNG for links issued before the switch (they expire within 24 hours).
 */
export async function GET(_: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const jpeg = !token.endsWith(".png");
  const claims = verify<{ c: string; f: string | null }>(token.replace(/\.(png|jpe?g)$/, ""));
  if (!claims) return new Response("Link expired or invalid", { status: 403 });
  const db = await getDb();
  const [c] = await db.select().from(schema.creatives).where(eq(schema.creatives.id, claims.c));
  if (!c) return new Response("Not found", { status: 404 });
  const [brand] = await db.select().from(schema.brands).where(eq(schema.brands.id, c.brandId));
  const png = await renderCreativePng(c, brand, claims.f ?? undefined);
  const body = jpeg ? await toPublishJpeg(png) : png;
  return new Response(new Uint8Array(body), { headers: { "content-type": jpeg ? "image/jpeg" : "image/png", "cache-control": "public, max-age=3600" } });
}
