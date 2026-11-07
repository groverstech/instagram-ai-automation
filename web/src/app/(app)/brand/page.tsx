import { desc, eq } from "drizzle-orm";
import { requireActiveBrand } from "@/server/auth/guard";
import { getDb, schema } from "@/server/db/client";
import { latestProfile } from "@/server/agents/context";
import { profileHistory } from "@/server/agents/brand";
import { listMemories } from "@/server/memory";
import { BrandWorkspace } from "@/components/brand/workspace";
import type { BrandProfile } from "@/server/agents/schemas";

export default async function Page({ searchParams }: { searchParams: Promise<{ analysisError?: string; fresh?: string }> }) {
  const sp = await searchParams;
  const { brand, role } = await requireActiveBrand();
  const db = await getDb();
  const [{ latest, approved }, history, assets, memories] = await Promise.all([
    latestProfile(brand.id),
    profileHistory(brand.id),
    db.select().from(schema.brandAssets).where(eq(schema.brandAssets.brandId, brand.id)).orderBy(desc(schema.brandAssets.createdAt)),
    listMemories(brand.id, undefined, 80),
  ]);
  return (
    <BrandWorkspace
      role={role}
      brand={brand}
      profile={latest ? { id: latest.id, version: latest.version, status: latest.status, data: latest.data as BrandProfile } : null}
      approvedVersion={approved?.version ?? null}
      history={history}
      assets={assets.map((a) => ({ id: a.id, kind: a.kind, name: a.name, mime: a.mime, analysis: a.analysis }))}
      memories={memories}
      analysisError={sp.analysisError}
      fresh={Boolean(sp.fresh)}
    />
  );
}
