import { desc, eq } from "drizzle-orm";
import { requireActiveBrand } from "@/server/auth/guard";
import { getDb, schema } from "@/server/db/client";
import { latestProfile, profileOf } from "@/server/agents/context";
import { profileHistory } from "@/server/agents/brand";
import { brandChatHistory } from "@/server/agents/brand-qa";
import { listMemories } from "@/server/memory";
import { aiStatus } from "@/server/ai/llm";
import { BrandWorkspace } from "@/components/brand/workspace";
import { brandIntelligenceScore, type SectionStatus } from "@/lib/brand-profile";

export default async function Page({ searchParams }: { searchParams: Promise<{ analysisError?: string; fresh?: string; tab?: string }> }) {
  const sp = await searchParams;
  const { brand, role } = await requireActiveBrand();
  const db = await getDb();
  const [{ latest, approved }, history, assets, memories, chat] = await Promise.all([
    latestProfile(brand.id),
    profileHistory(brand.id),
    db.select().from(schema.brandAssets).where(eq(schema.brandAssets.brandId, brand.id)).orderBy(desc(schema.brandAssets.createdAt)),
    listMemories(brand.id, undefined, 120),
    brandChatHistory(brand.id, 40),
  ]);
  const profile = profileOf(latest);
  const sectionStatus = (latest?.sectionStatus ?? {}) as SectionStatus;
  const score = brandIntelligenceScore({
    brand,
    assets: assets.map((a) => ({ kind: a.kind, status: a.status, analyzed: Boolean(a.analysis) })),
    profile,
    sectionStatus,
    approved: Boolean(approved),
    memories: memories.length,
  });

  return (
    <BrandWorkspace
      role={role}
      brand={brand}
      ai={aiStatus()}
      profile={latest && profile ? { id: latest.id, version: latest.version, status: latest.status, data: profile, sectionStatus } : null}
      profileUnreadable={Boolean(latest && !profile)}
      approvedVersion={approved?.version ?? null}
      history={history}
      score={score}
      assets={assets.map((a) => ({ id: a.id, kind: a.kind, name: a.name, mime: a.mime, size: a.size, status: a.status, analysis: a.analysis, analysisError: a.analysisError, createdAt: a.createdAt }))}
      memories={memories}
      chat={chat.map((m) => ({ id: m.id, role: m.role, content: m.content, meta: m.meta }))}
      analysisError={sp.analysisError}
      fresh={Boolean(sp.fresh)}
      initialTab={sp.tab}
    />
  );
}
