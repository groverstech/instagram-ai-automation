import { eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db/client";
import { requireBrand } from "@/server/auth/guard";
import { renderCreativePng } from "@/server/creative/render";
import { formatById } from "@/lib/domain";

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
    ({ brand } = await requireBrand(c.brandId, "viewer"));
  } catch {
    return new Response("Forbidden", { status: 403 });
  }
  const format = url.searchParams.get("format") ?? undefined;
  const png = await renderCreativePng(c, brand, format);
  const f = formatById(format ?? c.format);
  const headers: Record<string, string> = { "content-type": "image/png", "cache-control": "private, max-age=60" };
  if (url.searchParams.get("download")) {
    const slug = `${brand.name}-${(c.concept as { title?: string }).title ?? "creative"}-${f.w}x${f.h}`.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    headers["content-disposition"] = `attachment; filename="${slug}.png"`;
  }
  return new Response(new Uint8Array(png), { headers });
}
