import JSZip from "jszip";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db/client";
import { requireBrand } from "@/server/auth/guard";
import { enforce, RateLimitError } from "@/server/ratelimit";
import { renderCreativePng, slideCount } from "@/server/creative/render";
import { FORMAT_IDS, formatById } from "@/lib/domain";

export const runtime = "nodejs";

/** Download every slide of a creative (and its caption) as one ZIP. Brand access required. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const url = new URL(req.url);
  const format = url.searchParams.get("format") ?? undefined;
  if (format && !(FORMAT_IDS as readonly string[]).includes(format)) return new Response("Unknown format", { status: 400 });
  const db = await getDb();
  const [c] = await db.select().from(schema.creatives).where(eq(schema.creatives.id, id));
  if (!c) return new Response("Not found", { status: 404 });
  let brand;
  try {
    const access = await requireBrand(c.brandId, "viewer");
    brand = access.brand;
    // Each slide is a render; count them all against the render limit.
    for (let i = 0; i < slideCount(c); i++) await enforce("render", { userId: access.session.user.id });
  } catch (e) {
    if (e instanceof RateLimitError) return new Response(e.message, { status: 429, headers: { "retry-after": String(e.retryAfter) } });
    return new Response("Forbidden", { status: 403 });
  }
  const f = formatById(format ?? c.format);
  const title = String((c.concept as { title?: string }).title ?? "creative");
  const slug = `${brand.name}-${title}-${f.w}x${f.h}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const zip = new JSZip();
  for (let i = 0; i < slideCount(c); i++) {
    zip.file(`${slug}-${String(i + 1).padStart(2, "0")}.png`, await renderCreativePng(c, brand, format, i));
  }
  const copy = c.copy as { primary?: string; hashtags?: string[]; cta?: string } | null;
  if (copy?.primary) zip.file("caption.txt", `${copy.primary}\n\n${(copy.hashtags ?? []).map((h) => `#${h}`).join(" ")}\n`);
  const body = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  return new Response(body as unknown as BodyInit, {
    headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${slug}.zip"`, "cache-control": "private, no-store" },
  });
}
