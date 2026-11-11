import { desc, eq } from "drizzle-orm";
import { requireActiveBrand } from "@/server/auth/guard";
import { getDb, schema } from "@/server/db/client";
import { imageModelLabel, imageStatus } from "@/server/ai/image";
import { imageRates } from "@/server/ai/pricing";
import { latestProfile, profileOf } from "@/server/agents/context";
import { brandPhotos } from "@/server/creative/visuals";
import { recentCreativeTasks } from "@/server/creative/jobs";
import { CreativeStudio, type StudioCreative } from "@/components/creative/studio";
import type { CreativeConcept } from "@/server/agents/schemas";

export default async function Page({ searchParams }: { searchParams: Promise<{ c?: string; brief?: string; objective?: string }> }) {
  const { c, brief, objective } = await searchParams;
  const { brand, role } = await requireActiveBrand();
  const db = await getDb();
  const [creatives, campaigns, { approved, latest }, photos, tasks] = await Promise.all([
    db.select().from(schema.creatives).where(eq(schema.creatives.brandId, brand.id)).orderBy(desc(schema.creatives.createdAt)).limit(120),
    db.select({ id: schema.campaigns.id, name: schema.campaigns.name }).from(schema.campaigns).where(eq(schema.campaigns.brandId, brand.id)).orderBy(desc(schema.campaigns.createdAt)),
    latestProfile(brand.id),
    brandPhotos(brand.id),
    recentCreativeTasks(brand.id, 3),
  ]);
  const profile = profileOf(approved ?? latest);
  const img = imageStatus();
  return (
    <CreativeStudio
      brandId={brand.id}
      role={role}
      platforms={brand.platforms}
      brandColors={brand.colors}
      initialOpen={c}
      initialBrief={brief?.slice(0, 2000)}
      initialObjective={objective}
      imageProvider={{ ...img, priced: Boolean(img.model && imageRates(img.model)), modelLabel: img.model ? imageModelLabel(img.model) : null, editModelLabel: img.editModel ? imageModelLabel(img.editModel) : null }}
      preferredStyles={profile?.visual.preferredStyles ?? []}
      campaigns={campaigns}
      photos={photos.map((p) => ({ id: p.id, name: p.name, kind: p.kind }))}
      tasks={tasks.map((t) => ({ id: t.id, status: t.status, steps: t.steps, error: t.error, costUsd: t.costUsd, attempts: t.attempts, maxAttempts: t.maxAttempts, recovering: t.recovering, createdAt: t.createdAt }))}
      creatives={creatives.map(
        (x): StudioCreative => ({
          id: x.id,
          format: x.format,
          style: x.style,
          status: x.status,
          kind: x.kind,
          slides: x.slides.map((s) => ({ headline: s.headline, body: s.body, imagePrompt: s.imagePrompt, hasImage: Boolean(s.imagePath) })),
          campaignId: x.campaignId,
          parentId: x.parentId,
          hasImage: Boolean(x.imagePath),
          imageError: x.imageError,
          imageProvider: x.imageProvider,
          visualSource: x.visualSource,
          sourceAssetId: x.sourceAssetId,
          logoPlacement: x.logoPlacement,
          strategyId: x.strategyId,
          calendarEntryId: x.calendarEntryId,
          copy: x.copy as StudioCreative["copy"],
          brandCheck: x.brandCheck as StudioCreative["brandCheck"],
          createdAt: x.createdAt,
          updatedAt: x.updatedAt,
          concept: x.concept as CreativeConcept & { brief?: string; objective?: string | null },
        }),
      )}
    />
  );
}
