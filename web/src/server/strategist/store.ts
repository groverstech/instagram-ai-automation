import "server-only";
import { and, desc, eq, inArray, max, ne, sql } from "drizzle-orm";
import { format as fmt, parseISO } from "date-fns";
import { getDb, schema } from "../db/client";
import type { StrategyRow } from "../db/schema";
import { remember } from "../memory";
import { roleAtLeast, type Role } from "@/lib/roles";
import {
  CalendarEntryEdit,
  EDIT_SCHEMAS,
  PILLAR_MAX,
  PILLAR_MIN,
  SECTION_KEYS,
  SECTION_META,
  compareDocs,
  downstreamOf,
  duplicateEntries,
  emptyDoc,
  isDocV2,
  missingSections,
  type CalendarEntry,
  type EditableSection,
  type Envelope,
  type SectionData,
  type SectionKey,
  type StrategyDoc,
  type StrategyInputs,
} from "@/lib/strategy";
import { normalizeShares } from "./agents";

export class StrategyError extends Error {}

export type Actor = { userId: string; role: Role };
type Source = "ai" | "user" | "restore" | "status";

const uid = () => crypto.randomUUID().slice(0, 12);
const STALE_TASK_MS = 10 * 60 * 1000;

export function docOf(row: StrategyRow): StrategyDoc {
  if (!isDocV2(row.data, row.schemaVersion)) throw new StrategyError("This is a legacy monthly strategy. Create a new strategy to use the Marketing Strategist.");
  return row.data as unknown as StrategyDoc;
}

export async function getStrategy(brandId: string, id: string) {
  const db = await getDb();
  const [row] = await db.select().from(schema.strategies).where(and(eq(schema.strategies.id, id), eq(schema.strategies.brandId, brandId)));
  return row ?? null;
}

export async function listVersions(brandId: string) {
  const db = await getDb();
  return db
    .select({ id: schema.strategies.id, version: schema.strategies.version, title: schema.strategies.title, status: schema.strategies.status, schemaVersion: schema.strategies.schemaVersion, month: schema.strategies.month, createdAt: schema.strategies.createdAt, updatedAt: schema.strategies.updatedAt, approvedAt: schema.strategies.approvedAt, parentId: schema.strategies.parentId })
    .from(schema.strategies)
    .where(eq(schema.strategies.brandId, brandId))
    .orderBy(desc(schema.strategies.version), desc(schema.strategies.createdAt));
}

/** The strategy agents should build on: the approved v2 strategy, else the latest non-archived one. */
export async function currentStrategy(brandId: string) {
  const db = await getDb();
  const rows = await db.select().from(schema.strategies).where(and(eq(schema.strategies.brandId, brandId), ne(schema.strategies.status, "archived"))).orderBy(desc(schema.strategies.version), desc(schema.strategies.createdAt)).limit(20);
  return rows.find((r) => r.status === "approved") ?? rows[0] ?? null;
}

export async function revisions(brandId: string, strategyId: string, limit = 100) {
  const db = await getDb();
  return db
    .select({ id: schema.strategyRevisions.id, rev: schema.strategyRevisions.rev, source: schema.strategyRevisions.source, action: schema.strategyRevisions.action, sections: schema.strategyRevisions.sections, note: schema.strategyRevisions.note, actorId: schema.strategyRevisions.actorId, actorName: schema.users.name, createdAt: schema.strategyRevisions.createdAt })
    .from(schema.strategyRevisions)
    .leftJoin(schema.users, eq(schema.users.id, schema.strategyRevisions.actorId))
    .where(and(eq(schema.strategyRevisions.strategyId, strategyId), eq(schema.strategyRevisions.brandId, brandId)))
    .orderBy(desc(schema.strategyRevisions.rev), desc(schema.strategyRevisions.createdAt))
    .limit(limit);
}

export async function activeTask(brandId: string, strategyId: string) {
  const db = await getDb();
  const [t] = await db
    .select()
    .from(schema.aiTasks)
    .where(and(eq(schema.aiTasks.brandId, brandId), eq(schema.aiTasks.strategyId, strategyId), inArray(schema.aiTasks.status, ["queued", "running"])))
    .orderBy(desc(schema.aiTasks.createdAt))
    .limit(1);
  if (!t) return null;
  const beat = (t.heartbeatAt ?? t.createdAt).getTime();
  return Date.now() - beat > STALE_TASK_MS ? null : t;
}

export async function createStrategy(brandId: string, actorId: string, inputs: StrategyInputs, assumptions: string[], profileRef: StrategyDoc["profileRef"]) {
  const db = await getDb();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"strategy-version:" + brandId}))`);
    const [{ v }] = await tx.select({ v: max(schema.strategies.version) }).from(schema.strategies).where(eq(schema.strategies.brandId, brandId));
    const version = (v ?? 0) + 1;
    const doc = emptyDoc(inputs, assumptions, profileRef);
    const start = parseISO(inputs.startDate);
    const [row] = await tx
      .insert(schema.strategies)
      .values({ brandId, month: fmt(start, "yyyy-MM"), status: "draft", data: doc as unknown as Record<string, unknown>, schemaVersion: 2, version, title: `Strategy v${version} · from ${fmt(start, "d MMM yyyy")}`, accountType: inputs.accountType, createdBy: actorId, rev: 1 })
      .returning();
    await tx.insert(schema.strategyRevisions).values({ strategyId: row.id, brandId, rev: 1, source: "user", action: "Created strategy", sections: [], actorId, snapshot: doc as unknown as Record<string, unknown> });
    return row;
  });
}

type MutateOpts = { source: Source; action: string; sections?: SectionKey[]; note?: string; expectRev?: number; statuses?: StrategyRow["status"][]; ignoreTask?: boolean };

/**
 * The single write path for strategy documents. Row-locked, brand-scoped, optimistic-concurrency
 * checked, and every change appends a restorable revision. Approved and archived strategies are
 * read-only here: changing them requires creating a new version.
 */
export async function mutate(brandId: string, id: string, actorId: string | null, opts: MutateOpts, fn: (doc: StrategyDoc, row: StrategyRow) => { doc: StrategyDoc; patch?: Partial<typeof schema.strategies.$inferInsert> } | Promise<{ doc: StrategyDoc; patch?: Partial<typeof schema.strategies.$inferInsert> }>) {
  if (!opts.ignoreTask && opts.source !== "ai" && (await activeTask(brandId, id))) throw new StrategyError("The AI is still working on this strategy. Wait for it to finish, then make your changes.");
  const db = await getDb();
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(schema.strategies).where(and(eq(schema.strategies.id, id), eq(schema.strategies.brandId, brandId))).for("update");
    if (!row) throw new StrategyError("Strategy not found.");
    const allowed = opts.statuses ?? ["draft", "under_review"];
    if (!allowed.includes(row.status)) {
      throw new StrategyError(
        row.status === "approved"
          ? "This strategy is approved and locked. Create a new version to make changes; the approved version stays active until the new one is approved."
          : row.status === "archived"
            ? "This strategy is archived. Restore it as a new version to work on it."
            : `This action isn't available while the strategy is ${row.status.replace("_", " ")}.`,
      );
    }
    if (opts.expectRev !== undefined && opts.expectRev !== row.rev) throw new StrategyError("This strategy was changed by someone else (or the AI) since you opened it. Reload to see the latest version.");
    const { doc, patch } = await fn(structuredClone(docOf(row)), row);
    const rev = row.rev + 1;
    const [updated] = await tx
      .update(schema.strategies)
      .set({ ...patch, data: doc as unknown as Record<string, unknown>, rev, updatedAt: new Date() })
      .where(eq(schema.strategies.id, id))
      .returning();
    await tx.insert(schema.strategyRevisions).values({ strategyId: id, brandId, rev, source: opts.source, action: opts.action, sections: opts.sections ?? [], note: opts.note ?? null, actorId, snapshot: doc as unknown as Record<string, unknown> });
    return updated;
  });
}

function markStale(doc: StrategyDoc, key: SectionKey) {
  for (const d of downstreamOf(key)) {
    const env = doc.sections[d];
    if (env) env.stale = true;
  }
}

/** Store an AI-generated section (workflow). Downstream sections are flagged as possibly stale. */
export async function writeAiSection<K extends SectionKey>(brandId: string, id: string, key: K, data: SectionData[K], meta: { runId: string | null; provider: string | null; actorId: string }) {
  return mutate(brandId, id, meta.actorId, { source: "ai", action: `Generated ${SECTION_META[key].label.toLowerCase()}`, sections: [key] }, (doc) => {
    const env: Envelope<SectionData[K]> = { data, origin: "ai", generatedAt: new Date().toISOString(), runId: meta.runId, provider: meta.provider, editedAt: null, editedBy: null, stale: false };
    (doc.sections as Record<string, unknown>)[key] = env;
    markStale(doc, key);
    return { doc };
  });
}

const contentKey = (o: Record<string, unknown>) => JSON.stringify(o, (k, v) => (k === "id" || k === "approved" ? undefined : v));

/** Keep server-owned fields (ids, approval) when the user edits a list; edited items lose approval. */
function mergeItems<T extends { id: string; approved?: boolean }>(prev: T[], next: (Omit<T, "id" | "approved"> & { id?: string })[], approvable: boolean): T[] {
  const byId = new Map(prev.map((p) => [p.id, p]));
  return next.map((n) => {
    const old = n.id ? byId.get(n.id) : undefined;
    const merged = { ...(old ?? {}), ...n, id: old?.id ?? uid() } as unknown as T;
    if (approvable) (merged as { approved?: boolean }).approved = Boolean(old?.approved && contentKey(old as Record<string, unknown>) === contentKey(merged as Record<string, unknown>));
    return merged;
  });
}

/** Apply a user edit to one section, validated against strict edit schemas. */
export function applyEdit(doc: StrategyDoc, key: EditableSection, raw: unknown): SectionData[EditableSection] {
  const env = doc.sections[key];
  if (!env) throw new StrategyError("Generate this section before editing it.");
  const input = EDIT_SCHEMAS[key].parse(raw);
  switch (key) {
    case "research": {
      const prev = doc.sections.research!.data;
      const i = input as typeof EDIT_SCHEMAS.research._output;
      const f = new Map(i.findings.map((x) => [x.id, x]));
      const c = new Map(i.competitors.map((x) => [x.id, x]));
      // Users can reword and remove findings, but can't mark anything as verified or add sources.
      return {
        ...prev,
        summary: i.summary,
        industryOverview: i.industryOverview,
        openQuestions: i.openQuestions,
        findings: prev.findings.filter((x) => f.has(x.id)).map((x) => ({ ...x, title: f.get(x.id)!.title, detail: f.get(x.id)!.detail })),
        competitors: prev.competitors.filter((x) => c.has(x.id)).map((x) => ({ ...x, ...c.get(x.id)!, id: x.id })),
      };
    }
    case "audience": {
      const i = input as typeof EDIT_SCHEMAS.audience._output;
      if (!i.personas.length) throw new StrategyError("Keep at least one persona.");
      return { overview: i.overview, insights: i.insights, segments: i.segments, personas: mergeItems(doc.sections.audience!.data.personas, i.personas, true) };
    }
    case "objectives": {
      const i = input as typeof EDIT_SCHEMAS.objectives._output;
      return { businessObjectives: i.businessObjectives, marketingObjectives: mergeItems(doc.sections.objectives!.data.marketingObjectives.map((o) => ({ ...o })), i.marketingObjectives, false) };
    }
    case "strategy": {
      const i = input as typeof EDIT_SCHEMAS.strategy._output;
      return { ...i, channels: i.channels.filter((c) => doc.inputs.platforms.includes(c.platform)) };
    }
    case "pillars": {
      const i = input as typeof EDIT_SCHEMAS.pillars._output;
      if (!i.pillars.length) throw new StrategyError("Keep at least one content pillar.");
      if (i.pillars.length > PILLAR_MAX) throw new StrategyError(`A strategy can have at most ${PILLAR_MAX} pillars.`);
      const names = i.pillars.map((p) => p.name.toLowerCase());
      if (new Set(names).size !== names.length) throw new StrategyError("Pillar names must be unique.");
      return { rationale: i.rationale, pillars: normalizeShares(mergeItems(doc.sections.pillars!.data.pillars, i.pillars, true)) };
    }
    case "campaigns": {
      const i = input as typeof EDIT_SCHEMAS.campaigns._output;
      return { campaigns: mergeItems(doc.sections.campaigns!.data.campaigns, i.campaigns, true) };
    }
  }
}

export async function editSection(brandId: string, id: string, actor: Actor, key: EditableSection, raw: unknown, expectRev: number) {
  if (!roleAtLeast(actor.role, "editor")) throw new StrategyError("Editing needs the editor role.");
  return mutate(brandId, id, actor.userId, { source: "user", action: `Edited ${SECTION_META[key].label.toLowerCase()}`, sections: [key], expectRev }, (doc) => {
    const data = applyEdit(doc, key, raw);
    const env = doc.sections[key]!;
    (doc.sections as Record<string, unknown>)[key] = { ...env, data, origin: env.origin === "ai" ? "mixed" : env.origin, editedAt: new Date().toISOString(), editedBy: actor.userId, stale: false };
    markStale(doc, key);
    return { doc };
  });
}

/** Approve or un-approve a persona, pillar or campaign concept. */
export async function setItemApproval(brandId: string, id: string, actor: Actor, key: "audience" | "pillars" | "campaigns", itemId: string, approved: boolean, expectRev: number) {
  if (!roleAtLeast(actor.role, "admin")) throw new StrategyError("Approving needs the admin role.");
  return mutate(brandId, id, actor.userId, { source: "user", action: `${approved ? "Approved" : "Unapproved"} ${key === "audience" ? "persona" : key === "pillars" ? "pillar" : "campaign"}`, sections: [key], expectRev }, (doc) => {
    const env = doc.sections[key];
    if (!env) throw new StrategyError("Section not found.");
    const list = key === "audience" ? doc.sections.audience!.data.personas : key === "pillars" ? doc.sections.pillars!.data.pillars : doc.sections.campaigns!.data.campaigns;
    const item = (list as { id: string; approved: boolean }[]).find((x) => x.id === itemId);
    if (!item) throw new StrategyError("Item not found.");
    item.approved = approved;
    return { doc };
  });
}

// ---------- Calendar entries ----------

function calendarOf(doc: StrategyDoc) {
  const c = doc.sections.calendar;
  if (!c) throw new StrategyError("Generate the calendar first.");
  return c;
}
function checkEntry(doc: StrategyDoc, e: CalendarEntryEdit, selfId?: string) {
  const cal = calendarOf(doc).data;
  const start = Date.parse(`${cal.startDate}T00:00:00Z`);
  const t = Date.parse(`${e.date}T00:00:00Z`);
  if (t < start || t > start + (cal.days - 1) * 864e5) throw new StrategyError(`Dates must be within the 30-day window starting ${cal.startDate}.`);
  if (!cal.platforms.includes(e.platform)) throw new StrategyError("That platform isn't part of this strategy.");
  const others = cal.entries.filter((x) => x.id !== selfId);
  if (duplicateEntries([...others, e]).includes(others.length)) throw new StrategyError("Another entry already uses this hook or concept. Each post, including cross-platform versions, needs its own angle.");
}
function touchCalendar(doc: StrategyDoc, actorId: string) {
  const env = calendarOf(doc);
  env.origin = env.origin === "ai" ? "mixed" : env.origin;
  env.editedAt = new Date().toISOString();
  env.editedBy = actorId;
  env.data.entries.sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));
}

export async function upsertEntry(brandId: string, id: string, actor: Actor, entryId: string | null, raw: unknown, expectRev: number) {
  if (!roleAtLeast(actor.role, "editor")) throw new StrategyError("Editing needs the editor role.");
  const e = CalendarEntryEdit.parse(raw);
  return mutate(brandId, id, actor.userId, { source: "user", action: entryId ? `Edited calendar entry ${e.date}` : `Added calendar entry ${e.date}`, sections: ["calendar"], expectRev }, (doc) => {
    checkEntry(doc, e, entryId ?? undefined);
    const cal = calendarOf(doc).data;
    if (entryId) {
      const i = cal.entries.findIndex((x) => x.id === entryId);
      if (i < 0) throw new StrategyError("Entry not found.");
      cal.entries[i] = { ...e, id: entryId };
    } else cal.entries.push({ ...e, id: uid() });
    touchCalendar(doc, actor.userId);
    return { doc };
  });
}

export async function deleteEntry(brandId: string, id: string, actor: Actor, entryId: string, expectRev: number) {
  if (!roleAtLeast(actor.role, "editor")) throw new StrategyError("Editing needs the editor role.");
  return mutate(brandId, id, actor.userId, { source: "user", action: "Deleted calendar entry", sections: ["calendar"], expectRev }, (doc) => {
    const cal = calendarOf(doc).data;
    const before = cal.entries.length;
    cal.entries = cal.entries.filter((x) => x.id !== entryId);
    if (cal.entries.length === before) throw new StrategyError("Entry not found.");
    touchCalendar(doc, actor.userId);
    return { doc };
  });
}

export async function replaceEntryFromAi(brandId: string, id: string, actorId: string, entry: CalendarEntry, runId: string) {
  return mutate(brandId, id, actorId, { source: "ai", action: `Regenerated calendar entry ${entry.date}`, sections: ["calendar"], note: `run ${runId}` }, (doc) => {
    const cal = calendarOf(doc).data;
    const i = cal.entries.findIndex((x) => x.id === entry.id);
    if (i < 0) throw new StrategyError("Entry not found.");
    cal.entries[i] = entry;
    const env = calendarOf(doc);
    env.origin = "mixed";
    return { doc };
  });
}

// ---------- Status workflow ----------

/** Why a strategy can't be approved yet; empty when it can. */
export function approvalBlockers(doc: StrategyDoc): string[] {
  const out: string[] = [];
  const missing = missingSections(doc);
  if (missing.length) out.push(`Missing sections: ${missing.map((k) => SECTION_META[k].label).join(", ")}.`);
  const n = doc.sections.pillars?.data.pillars.length ?? 0;
  if (doc.sections.pillars && (n < PILLAR_MIN || n > PILLAR_MAX)) out.push(`A strategy needs ${PILLAR_MIN}–${PILLAR_MAX} content pillars (it has ${n}).`);
  if (doc.sections.calendar && !doc.sections.calendar.data.entries.length) out.push("The calendar has no entries.");
  return out;
}

export async function submitForReview(brandId: string, id: string, actor: Actor, expectRev: number, note?: string) {
  if (!roleAtLeast(actor.role, "editor")) throw new StrategyError("Submitting needs the editor role.");
  return mutate(brandId, id, actor.userId, { source: "status", action: "Submitted for review", expectRev, note, statuses: ["draft"] }, (doc) => {
    const b = approvalBlockers(doc);
    if (b.length) throw new StrategyError(b.join(" "));
    return { doc, patch: { status: "under_review", submittedBy: actor.userId, revisionNote: null } };
  });
}

export async function requestRevisions(brandId: string, id: string, actor: Actor, note: string, expectRev: number) {
  if (!roleAtLeast(actor.role, "admin")) throw new StrategyError("Requesting revisions needs the admin role.");
  if (!note.trim()) throw new StrategyError("Say what should change.");
  return mutate(brandId, id, actor.userId, { source: "status", action: "Requested revisions", expectRev, note: note.trim().slice(0, 2000), statuses: ["under_review"] }, (doc) => ({ doc, patch: { status: "draft", revisionNote: note.trim().slice(0, 2000) } }));
}

export async function approveStrategy(brandId: string, id: string, actor: Actor, expectRev: number) {
  if (!roleAtLeast(actor.role, "admin")) throw new StrategyError("Approving needs the admin role.");
  const row = await mutate(brandId, id, actor.userId, { source: "status", action: "Approved", expectRev, statuses: ["draft", "under_review"] }, (doc) => {
    const b = approvalBlockers(doc);
    if (b.length) throw new StrategyError(b.join(" "));
    return { doc, patch: { status: "approved", approvedBy: actor.userId, approvedAt: new Date(), revisionNote: null } };
  });
  // The newly approved version supersedes earlier approved ones (kept, archived, restorable).
  const db = await getDb();
  const prev = await db.select({ id: schema.strategies.id }).from(schema.strategies).where(and(eq(schema.strategies.brandId, brandId), eq(schema.strategies.status, "approved"), ne(schema.strategies.id, id)));
  for (const p of prev) {
    await mutate(brandId, p.id, actor.userId, { source: "status", action: `Archived (superseded by v${row.version})`, statuses: ["approved"], ignoreTask: true }, (doc) => ({ doc, patch: { status: "archived", archivedAt: new Date() } })).catch(() => {});
  }
  const doc = docOf(row);
  const pillars = doc.sections.pillars?.data.pillars ?? [];
  await remember(brandId, [
    { kind: "approval", content: `Approved marketing strategy v${row.version}: ${doc.sections.strategy?.data.positioning.statement ?? ""}`.trim(), source: `strategy:${row.id}`, weight: 1.3 },
    { kind: "approval", content: `Approved content pillars (strategy v${row.version}): ${pillars.map((p) => `${p.name} (${p.sharePercent}%)`).join(", ")}`, source: `strategy:${row.id}`, weight: 1.3 },
  ]).catch(() => {});
  return row;
}

export async function archiveStrategy(brandId: string, id: string, actor: Actor, expectRev: number) {
  if (!roleAtLeast(actor.role, "admin")) throw new StrategyError("Archiving needs the admin role.");
  return mutate(brandId, id, actor.userId, { source: "status", action: "Archived", expectRev, statuses: ["draft", "under_review", "approved"] }, (doc) => ({ doc, patch: { status: "archived", archivedAt: new Date() } }));
}

/** Start a new draft version from any version (approved, archived or draft). The source is untouched. */
export async function newVersionFrom(brandId: string, sourceId: string, actor: Actor, note?: string) {
  if (!roleAtLeast(actor.role, "editor")) throw new StrategyError("Creating a version needs the editor role.");
  const src = await getStrategy(brandId, sourceId);
  if (!src) throw new StrategyError("Strategy not found.");
  const doc = docOf(src);
  const db = await getDb();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"strategy-version:" + brandId}))`);
    const [{ v }] = await tx.select({ v: max(schema.strategies.version) }).from(schema.strategies).where(eq(schema.strategies.brandId, brandId));
    const version = (v ?? 0) + 1;
    if (doc.sections.calendar) doc.sections.calendar.data.appliedAt = null;
    const [row] = await tx
      .insert(schema.strategies)
      .values({ brandId, month: src.month, status: "draft", data: doc as unknown as Record<string, unknown>, schemaVersion: 2, version, title: `Strategy v${version} · from v${src.version}`, accountType: src.accountType, createdBy: actor.userId, parentId: src.id, rev: 1 })
      .returning();
    await tx.insert(schema.strategyRevisions).values({ strategyId: row.id, brandId, rev: 1, source: "restore", action: `Created from v${src.version}`, sections: [...SECTION_KEYS.filter((k) => doc.sections[k])], note: note ?? null, actorId: actor.userId, snapshot: doc as unknown as Record<string, unknown> });
    return row;
  });
}

/** Restore an earlier revision's content into this (editable) strategy. Recorded as a new revision. */
export async function restoreRevision(brandId: string, id: string, actor: Actor, revisionId: string, expectRev: number) {
  if (!roleAtLeast(actor.role, "editor")) throw new StrategyError("Restoring needs the editor role.");
  const db = await getDb();
  const [r] = await db.select().from(schema.strategyRevisions).where(and(eq(schema.strategyRevisions.id, revisionId), eq(schema.strategyRevisions.strategyId, id), eq(schema.strategyRevisions.brandId, brandId)));
  if (!r) throw new StrategyError("Revision not found.");
  return mutate(brandId, id, actor.userId, { source: "restore", action: `Restored revision ${r.rev}`, sections: [...SECTION_KEYS], expectRev }, () => ({ doc: r.snapshot as unknown as StrategyDoc }));
}

export async function revisionSnapshot(brandId: string, strategyId: string, revisionId: string) {
  const db = await getDb();
  const [r] = await db.select().from(schema.strategyRevisions).where(and(eq(schema.strategyRevisions.id, revisionId), eq(schema.strategyRevisions.strategyId, strategyId), eq(schema.strategyRevisions.brandId, brandId)));
  return r ? (r.snapshot as unknown as StrategyDoc) : null;
}

/** Compare two strategy versions, or a version against one of its revisions. Brand-scoped. */
export async function compare(brandId: string, a: { strategyId: string; revisionId?: string }, b: { strategyId: string; revisionId?: string }) {
  const load = async (x: typeof a) => {
    if (x.revisionId) return revisionSnapshot(brandId, x.strategyId, x.revisionId);
    const row = await getStrategy(brandId, x.strategyId);
    return row ? docOf(row) : null;
  };
  const [da, db] = await Promise.all([load(a), load(b)]);
  if (!da || !db) throw new StrategyError("Version not found.");
  return compareDocs(da, db);
}

/**
 * Put an approved strategy's calendar onto the content calendar as draft posts. Re-applying replaces
 * only the still-draft posts created from this strategy; anything approved or published is kept.
 */
export async function applyCalendar(brandId: string, id: string, actor: Actor) {
  if (!roleAtLeast(actor.role, "editor")) throw new StrategyError("This needs the editor role.");
  const row = await getStrategy(brandId, id);
  if (!row) throw new StrategyError("Strategy not found.");
  if (row.status !== "approved") throw new StrategyError("Approve the strategy before adding its calendar to the content calendar.");
  const doc = docOf(row);
  const cal = doc.sections.calendar?.data;
  if (!cal?.entries.length) throw new StrategyError("The calendar is empty.");
  const db = await getDb();
  const result = await db.transaction(async (tx) => {
    const existing = await tx.select({ id: schema.posts.id, copy: schema.posts.copy, status: schema.posts.status }).from(schema.posts).where(eq(schema.posts.brandId, brandId));
    const mine = existing.filter((p) => (p.copy as { strategyId?: string }).strategyId === id);
    const removable = mine.filter((p) => p.status === "draft").map((p) => p.id);
    const keptEntryIds = new Set(mine.filter((p) => p.status !== "draft").map((p) => String((p.copy as { entryId?: string }).entryId)));
    if (removable.length) await tx.delete(schema.posts).where(and(eq(schema.posts.brandId, brandId), inArray(schema.posts.id, removable)));
    const campaigns = await tx.select({ id: schema.campaigns.id, name: schema.campaigns.name }).from(schema.campaigns).where(eq(schema.campaigns.brandId, brandId));
    const campaignId = (name: string) => (name ? (campaigns.find((c) => c.name.toLowerCase() === name.toLowerCase())?.id ?? null) : null);
    const toInsert = cal.entries.filter((e) => !keptEntryIds.has(e.id));
    if (toInsert.length) {
      await tx.insert(schema.posts).values(
        toInsert.map((e) => ({
          brandId,
          campaignId: campaignId(e.campaign),
          platform: e.platform,
          format: e.format,
          pillar: e.pillar,
          objective: e.objective,
          title: e.hook.slice(0, 140),
          scheduledAt: parseISO(`${e.date}T${e.time}:00`),
          status: "draft" as const,
          hashtags: e.hashtags,
          copy: { brief: `${e.creativeConcept}\n\nCaption direction: ${e.captionDirection}\nCTA: ${e.cta}${e.campaign ? `\nCampaign: ${e.campaign}` : ""}`, strategyId: id, entryId: e.id },
          rationale: `From marketing strategy v${row.version}`,
        })),
      );
    }
    return { added: toInsert.length, replaced: removable.length, kept: keptEntryIds.size };
  });
  // Recording appliedAt is metadata on an approved strategy, not a content change.
  await db.transaction(async (tx) => {
    const [r] = await tx.select().from(schema.strategies).where(and(eq(schema.strategies.id, id), eq(schema.strategies.brandId, brandId))).for("update");
    const d = docOf(r);
    if (d.sections.calendar) d.sections.calendar.data.appliedAt = new Date().toISOString();
    await tx.update(schema.strategies).set({ data: d as unknown as Record<string, unknown>, rev: r.rev + 1, updatedAt: new Date() }).where(eq(schema.strategies.id, id));
    await tx.insert(schema.strategyRevisions).values({ strategyId: id, brandId, rev: r.rev + 1, source: "status", action: `Added ${result.added} posts to the content calendar`, sections: ["calendar"], actorId: actor.userId, snapshot: d as unknown as Record<string, unknown> });
  });
  return result;
}
