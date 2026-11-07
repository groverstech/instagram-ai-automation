import { desc, eq } from "drizzle-orm";
import { requireActiveBrand } from "@/server/auth/guard";
import { getDb, schema } from "@/server/db/client";
import { CompetitorsView } from "@/components/competitors/view";

export default async function Page() {
  const { brand, role } = await requireActiveBrand();
  const db = await getDb();
  const rows = await db.select().from(schema.competitors).where(eq(schema.competitors.brandId, brand.id)).orderBy(desc(schema.competitors.createdAt));
  const known = new Set(rows.map((r) => r.name.toLowerCase()));
  return <CompetitorsView brandId={brand.id} role={role} suggestions={brand.competitors.filter((c) => !known.has(c.toLowerCase()))} competitors={rows.map((r) => ({ id: r.id, name: r.name, url: r.url, handles: r.handles, analyzedAt: r.analyzedAt, analysis: r.analysis as never }))} />;
}
