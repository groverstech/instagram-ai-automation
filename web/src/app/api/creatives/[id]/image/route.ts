import { eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db/client";
import { requireBrand } from "@/server/auth/guard";
import { enforce, RateLimitError } from "@/server/ratelimit";
import { renderCreativePng, slideCount } from "@/server/creative/render";
import { FORMAT_IDS, formatById } from "@/lib/domain";

export const runtime = "nodejs";

/** Brand renderer: preview (?format=...), resize and download (?download=1) share one path. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const url = new URL(req.url);
  const db = await getDb();
  const [c] = await db.select().from(schema.creatives).where(eq(schema.creatives.id, id));
  if (!c) return new Response("Not found", { status: 404 });
  let brand;
  try {
    const access = await requireBrand(c.brandId, "viewer");
    brand = access.brand;
    await enforce("render", { userId: access.session.user.id });
  } catch (e) {
    if (e instanceof RateLimitError) return new Response(e.message, { status: 429, headers: { "retry-after": String(e.retryAfter) } });
    return new Response("Forbidden", { status: 403 });
  }
  const format = url.searchParams.get("format") ?? undefined;
  if (format && !(FORMAT_IDS as readonly string[]).includes(format)) return new Response("Unknown format", { status: 400 });
  const slide = Number(url.searchParams.get("slide") ?? 0);
  if (!Number.isInteger(slide) || slide < 0 || slide >= slideCount(c)) return new Response("Unknown slide", { status: 400 });
  const png = await renderCreativePng(c, brand, format, slide);
  const f = formatById(format ?? c.format);
  const headers: Record<string, string> = { "content-type": "image/png", "cache-control": "private, max-age=60" };
  if (url.searchParams.get("download")) {
    const slug = `${brand.name}-${(c.concept as { title?: string }).title ?? "creative"}${slideCount(c) > 1 ? `-slide-${slide + 1}` : ""}-${f.w}x${f.h}`.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    headers["content-disposition"] = `attachment; filename="${slug}.png"`;
  }
  return new Response(new Uint8Array(png), { headers });
}
