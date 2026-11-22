import "server-only";
import type { schema } from "./db/client";

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
