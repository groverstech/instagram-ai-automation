import { desc, eq } from "drizzle-orm";
import { requireActiveBrand } from "@/server/auth/guard";
import { getDb, schema } from "@/server/db/client";
import { imageStatus } from "@/server/ai/image";
import { latestProfile, profileOf } from "@/server/agents/context";
import { CreativeStudio } from "@/components/creative/studio";
import type { CreativeConcept } from "@/server/agents/schemas";

export default async function Page({ searchParams }: { searchParams: Promise<{ c?: string }> }) {
  const { c } = await searchParams;
  const { brand, role } = await requireActiveBrand();
  const db = await getDb();
  const [creatives, campaigns, { approved, latest }] = await Promise.all([
    db.select().from(schema.creatives).where(eq(schema.creatives.brandId, brand.id)).orderBy(desc(schema.creatives.createdAt)).limit(120),
    db.select({ id: schema.campaigns.id, name: schema.campaigns.name }).from(schema.campaigns).where(eq(schema.campaigns.brandId, brand.id)).orderBy(desc(schema.campaigns.createdAt)),
    latestProfile(brand.id),
  ]);
  const profile = profileOf(approved ?? latest);
  return (
    <CreativeStudio
      brandId={brand.id}
      role={role}
      platforms={brand.platforms}
      initialOpen={c}
      imageProvider={imageStatus()}
      preferredStyles={profile?.visual.preferredStyles ?? []}
      campaigns={campaigns}
      creatives={creatives.map((x) => ({
        id: x.id,
        format: x.format,
        style: x.style,
        status: x.status,
        campaignId: x.campaignId,
        parentId: x.parentId,
        hasImage: Boolean(x.imagePath),
        imageError: x.imageError,
        imageProvider: x.imageProvider,
        createdAt: x.createdAt,
        concept: x.concept as CreativeConcept & { brief?: string; objective?: string | null },
      }))}
    />
  );
}
