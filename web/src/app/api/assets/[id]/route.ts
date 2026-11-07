import { eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db/client";
import { requireBrand } from "@/server/auth/guard";
import { storage } from "@/server/storage";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await getDb();
  const [a] = await db.select().from(schema.brandAssets).where(eq(schema.brandAssets.id, id));
  if (!a) return new Response("Not found", { status: 404 });
  try {
    await requireBrand(a.brandId, "viewer");
  } catch {
    return new Response("Forbidden", { status: 403 });
  }
  const buf = await storage.get(a.path);
  return new Response(new Uint8Array(buf), { headers: { "content-type": a.mime, "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" } });
}
