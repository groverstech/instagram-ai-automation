import { and, desc, eq, ne } from "drizzle-orm";
import { listAccessibleBrands, requireActiveBrand } from "@/server/auth/guard";
import { getDb, schema } from "@/server/db/client";
import { aiStatus } from "@/server/ai/llm";
import { preflight } from "@/server/strategist/preflight";
import { activeTask, approvalBlockers, getStrategy, listVersions, revisions } from "@/server/strategist/store";
import { latestTask, strategyCost } from "@/server/strategist/workflow";
import { advisorHistory } from "@/server/strategist/advisor";
import { webSearchEnabled } from "@/server/strategist/agents";
import { StrategistWorkspace } from "@/components/strategist/workspace";
import { isDocV2, type StrategyDoc } from "@/lib/strategy";
import { imageStatus } from "@/server/ai/image";
import { brandPhotos } from "@/server/creative/visuals";
import { latestProfile, profileOf } from "@/server/agents/context";

export default async function Page({ searchParams }: { searchParams: Promise<{ v?: string; new?: string; tab?: string }> }) {
  const sp = await searchParams;
  const { brand, role, session } = await requireActiveBrand();
  const [versions, pf, brands, chat] = await Promise.all([listVersions(brand.id), preflight(brand), listAccessibleBrands(session.user.id), advisorHistory(brand.id)]);
  const pick = versions.find((v) => v.id === sp.v) ?? versions.find((v) => v.status === "approved" && v.schemaVersion === 2) ?? versions.find((v) => v.schemaVersion === 2) ?? versions[0];
  const row = pick ? await getStrategy(brand.id, pick.id) : null;
  const v2 = row && isDocV2(row.data, row.schemaVersion) ? (row.data as unknown as StrategyDoc) : null;
  const [revs, task, running, cost] = row && v2 ? await Promise.all([revisions(brand.id, row.id), latestTask(brand.id, row.id), activeTask(brand.id, row.id), strategyCost(brand.id, row.id)]) : [[], null, null, null];
  const db = await getDb();
  const [linked, photos, prof] = row
    ? await Promise.all([
        db
          .select({ id: schema.creatives.id, entryId: schema.creatives.calendarEntryId, status: schema.creatives.status, format: schema.creatives.format, updatedAt: schema.creatives.updatedAt })
          .from(schema.creatives)
          .where(and(eq(schema.creatives.brandId, brand.id), eq(schema.creatives.strategyId, row.id), ne(schema.creatives.status, "rejected")))
          .orderBy(desc(schema.creatives.createdAt)),
        brandPhotos(brand.id),
        latestProfile(brand.id),
      ])
    : [[], [], null];
  const img = imageStatus();
  const preferred = prof ? (profileOf(prof.approved ?? prof.latest)?.visual.preferredStyles ?? []) : [];
  const names = row ? await db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).where(eq(schema.users.id, row.approvedBy ?? "-")) : [];
  return (
    <StrategistWorkspace
      key={row?.id ?? "none"}
      brand={{ id: brand.id, name: brand.name, platforms: brand.platforms }}
      brands={brands.map((b) => ({ id: b.brand.id, name: b.brand.name }))}
      role={role}
      ai={{ ...aiStatus(), webSearch: webSearchEnabled() }}
      preflight={pf}
      versions={versions.map((v) => ({ ...v, legacy: v.schemaVersion !== 2 }))}
      strategy={
        row && v2
          ? {
              id: row.id,
              version: row.version,
              title: row.title,
              status: row.status,
              rev: row.rev,
              revisionNote: row.revisionNote,
              approvedAt: row.approvedAt,
              approvedByName: names[0]?.name ?? null,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
              parentId: row.parentId,
              doc: v2,
              blockers: approvalBlockers(v2),
            }
          : null
      }
      legacy={row && !v2 ? { id: row.id, month: row.month, version: row.version } : null}
      revisions={revs}
      task={task ? { id: task.id, status: task.status, steps: task.steps, error: task.error, costUsd: task.costUsd, kind: task.kind, attempts: task.attempts, maxAttempts: task.maxAttempts, runAfter: task.runAfter, recovering: task.recovering } : null}
      running={Boolean(running)}
      cost={cost}
      chat={chat.map((m) => ({ id: m.id, role: m.role, content: m.content, meta: m.meta }))}
      production={{
        creatives: linked.filter((c) => c.entryId).map((c) => ({ id: c.id, entryId: c.entryId!, status: c.status, format: c.format, v: c.updatedAt.getTime() })),
        style: preferred[0] ?? "premium_editorial",
        visualSource: img.ready ? "ai" : photos.length ? "brand_photo" : "typographic",
        imageReady: img.ready,
        photos: photos.length,
      }}
      startNew={sp.new === "1"}
      initialTab={sp.tab}
    />
  );
}
