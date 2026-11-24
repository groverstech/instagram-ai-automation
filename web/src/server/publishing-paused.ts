import "server-only";
import { asc, inArray } from "drizzle-orm";
import { schema, type DB } from "./db/client";

/**
 * The emergency-pause check shared by every publishing path, including the standalone worker, so it
 * has no web-app dependencies. Pausing and resuming live in publishing-pause.ts.
 */
export class PublishingPausedError extends Error {}

type BrandRow = typeof schema.brands.$inferSelect;

export function pausedMessage(brand: Pick<BrandRow, "name">) {
  return `Publishing is paused for ${brand.name}. An admin can resume it in the Content Calendar.`;
}

/** Throws when the brand's publishing is paused. */
export function assertNotPaused(brand: Pick<BrandRow, "name" | "publishingPausedAt">) {
  if (brand.publishingPausedAt) throw new PublishingPausedError(pausedMessage(brand));
}

/** Scope of an operator stop (publishing_stops.scope): every organisation, or one. */
export const STOP_ALL = "all";
export const orgStopScope = (workspaceId: string) => `org:${workspaceId}`;

type StopRow = typeof schema.publishingStops.$inferSelect;

/**
 * The operator emergency stop covering this organisation, if any (review M-3). Independent of the
 * brand's own pause: a brand admin's "Resume publishing" never clears it.
 */
export async function operatorStopFor(db: Pick<DB, "select">, workspaceId: string): Promise<StopRow | null> {
  const [row] = await db
    .select()
    .from(schema.publishingStops)
    .where(inArray(schema.publishingStops.scope, [STOP_ALL, orgStopScope(workspaceId)]))
    .orderBy(asc(schema.publishingStops.setAt))
    .limit(1);
  return row ?? null;
}

export function stoppedMessage(stop: Pick<StopRow, "reason">) {
  return `Publishing is stopped by the BrandPilot team: ${stop.reason}. Only the BrandPilot team can lift this stop.`;
}

/** Throws when the brand is paused or covered by an operator stop: every publishing entry point. */
export async function assertPublishingAllowed(db: Pick<DB, "select">, brand: Pick<BrandRow, "name" | "publishingPausedAt" | "workspaceId">) {
  assertNotPaused(brand);
  const stop = await operatorStopFor(db, brand.workspaceId);
  if (stop) throw new PublishingPausedError(stoppedMessage(stop));
}
