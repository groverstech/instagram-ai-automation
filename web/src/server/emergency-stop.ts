import "server-only";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { getDb, schema } from "./db/client";
import { cancelJobs, enqueue } from "./jobs/queue";
import { audit } from "./audit";
import { log } from "./log";
import { STOP_ALL, operatorStopFor, orgStopScope } from "./publishing-paused";

/**
 * Operator emergency stop (reviews M4 and M-3): stop publishing for every organisation, or one, at
 * once. It's recorded in `publishing_stops`, separately from each brand's own pause:
 *
 * - every publishing path refuses while a stop covers the brand's organisation (the publish claim,
 *   the final check immediately before the request that makes a post public, scheduling, "publish
 *   now", the autonomy policy); brands created during a stop are covered too;
 * - queued publish jobs of the covered brands are cancelled;
 * - a Security-log event (`publishing.emergency_stop`) is written for each covered organisation.
 *
 * Brand admins can't lift it: "Resume publishing" in the app only clears the brand's own pause.
 * Only `clearStop` (the operator command) lifts it; it re-queues scheduled posts that are still in
 * the future and returns missed ones to "approved", for brands that aren't paused by their own
 * admins and aren't still covered by another stop, and audits `publishing.emergency_resume`.
 *
 * A request already sent to a platform can't be recalled.
 */
export type StopScope = { workspaceId?: string | null };

const scopeOf = (s: StopScope) => (s.workspaceId ? orgStopScope(s.workspaceId) : STOP_ALL);

function required(by: string, reason: string) {
  const b = by.trim();
  const r = reason.trim();
  if (!b) throw new Error("--by <your name> is required: it's recorded with the stop.");
  if (!r) throw new Error("--reason is required: it's shown on every stopped brand and recorded.");
  return { by: b.slice(0, 100), reason: r.slice(0, 300) };
}

async function organisationsIn(scope: StopScope) {
  const db = await getDb();
  if (scope.workspaceId) {
    const [w] = await db.select({ id: schema.workspaces.id }).from(schema.workspaces).where(eq(schema.workspaces.id, scope.workspaceId));
    if (!w) throw new Error(`No organisation with id ${scope.workspaceId}.`);
    return [w.id];
  }
  return (await db.select({ id: schema.workspaces.id }).from(schema.workspaces)).map((w) => w.id);
}

export async function emergencyStop(input: { by: string; reason: string } & StopScope) {
  const { by, reason } = required(input.by, input.reason);
  const orgs = await organisationsIn(input);
  const db = await getDb();
  const scope = scopeOf(input);
  const [created] = await db.insert(schema.publishingStops).values({ scope, reason, setBy: by }).onConflictDoNothing().returning();
  if (!created) throw new Error(`A stop with this scope (${scope}) is already in force. Check \`status\`.`);
  // From here every publishing path refuses. Cancel what's queued for the covered brands.
  const brands = orgs.length ? await db.select({ id: schema.brands.id, workspaceId: schema.brands.workspaceId }).from(schema.brands).where(inArray(schema.brands.workspaceId, orgs)) : [];
  let cancelled = 0;
  if (brands.length) {
    const postIds = new Set((await db.select({ id: schema.posts.id }).from(schema.posts).where(inArray(schema.posts.brandId, brands.map((b) => b.id)))).map((p) => p.id));
    const queued = () => db.$count(schema.jobs, and(eq(schema.jobs.type, "publish_post"), eq(schema.jobs.status, "queued")));
    const before = await queued();
    await cancelJobs("publish_post", (p) => postIds.has(String(p.postId)));
    cancelled = before - (await queued());
  }
  const perOrg = new Map(orgs.map((o) => [o, 0]));
  for (const b of brands) perOrg.set(b.workspaceId, (perOrg.get(b.workspaceId) ?? 0) + 1);
  for (const [workspaceId, n] of perOrg) {
    await audit({ action: "publishing.emergency_stop", workspaceId, actorType: "system", targetType: "workspace", targetId: workspaceId, details: { brands: n, by, reason, scope } });
  }
  log.error("publishing.emergency_stop", { scope, brands: brands.length, organisations: perOrg.size, cancelledJobs: cancelled, by });
  return { scope, brands: brands.length, organisations: perOrg.size, cancelledJobs: cancelled };
}

/**
 * Lift an operator stop (the operator command only; there's no path to this from the web app).
 * Brands then publish again unless their own admins paused them or another stop still covers them.
 */
export async function clearStop(input: { by: string; reason: string } & StopScope, now = new Date()) {
  const { by, reason } = required(input.by, input.reason);
  const db = await getDb();
  const scope = scopeOf(input);
  const [removed] = await db.delete(schema.publishingStops).where(eq(schema.publishingStops.scope, scope)).returning();
  if (!removed) throw new Error(`No stop with this scope (${scope}) is in force. Check \`status\`.`);
  const orgs = await organisationsIn(input).catch(() => [] as string[]);
  let requeued = 0;
  let unscheduled = 0;
  for (const workspaceId of orgs) {
    // Still covered (the other scope is in force): nothing is re-queued for this organisation yet.
    const still = await operatorStopFor(db, workspaceId);
    const brands = await db.select({ id: schema.brands.id }).from(schema.brands).where(and(eq(schema.brands.workspaceId, workspaceId), isNull(schema.brands.publishingPausedAt)));
    let r = 0;
    let u = 0;
    if (!still && brands.length) {
      const scheduled = await db
        .select({ id: schema.posts.id, scheduledAt: schema.posts.scheduledAt })
        .from(schema.posts)
        .where(and(inArray(schema.posts.brandId, brands.map((b) => b.id)), eq(schema.posts.status, "scheduled")));
      const future = scheduled.filter((p) => p.scheduledAt && p.scheduledAt > now);
      const missed = scheduled.filter((p) => !p.scheduledAt || p.scheduledAt <= now);
      // Like an in-app resume: future posts are queued again (once), missed ones wait for a person.
      await cancelJobs("publish_post", (p) => future.some((f) => f.id === String(p.postId)));
      for (const p of future) await enqueue("publish_post", { postId: p.id }, p.scheduledAt!);
      if (missed.length) await db.update(schema.posts).set({ status: "approved" }).where(and(inArray(schema.posts.id, missed.map((p) => p.id)), eq(schema.posts.status, "scheduled")));
      r = future.length;
      u = missed.length;
    }
    requeued += r;
    unscheduled += u;
    await audit({ action: "publishing.emergency_resume", workspaceId, actorType: "system", targetType: "workspace", targetId: workspaceId, details: { by, reason, scope, stoppedBy: removed.setBy, stoppedAt: removed.setAt.toISOString(), requeued: r, unscheduled: u, stillStopped: Boolean(still) } });
  }
  log.warn("publishing.emergency_resume", { scope, organisations: orgs.length, requeued, unscheduled, by });
  return { scope, organisations: orgs.length, requeued, unscheduled };
}

/** Operator stops in force and brands paused by their own admins (for the operator's status view). */
export async function stopStatus() {
  const db = await getDb();
  const stops = await db.select().from(schema.publishingStops);
  const paused = await db
    .select({ id: schema.brands.id, name: schema.brands.name, workspace: schema.workspaces.name, at: schema.brands.publishingPausedAt, reason: schema.brands.publishingPauseReason })
    .from(schema.brands)
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.brands.workspaceId))
    .where(isNotNull(schema.brands.publishingPausedAt));
  return { stops, paused };
}
