import { desc, eq } from "drizzle-orm";
import { requireActiveBrand } from "@/server/auth/guard";
import { getDb, schema } from "@/server/db/client";
import { StrategyView } from "@/components/strategy/view";
import type { Strategy } from "@/server/agents/schemas";

export default async function Page() {
  const { brand, role } = await requireActiveBrand();
  const db = await getDb();
  const rows = await db.select().from(schema.strategies).where(eq(schema.strategies.brandId, brand.id)).orderBy(desc(schema.strategies.createdAt)).limit(12);
  return (
    <StrategyView
      brandId={brand.id}
      role={role}
      platforms={brand.platforms}
      strategies={rows.map((r) => ({ id: r.id, month: r.month, status: r.status, createdAt: r.createdAt, data: r.data as Strategy }))}
    />
  );
}
