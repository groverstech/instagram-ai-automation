/**
 * Plan keys. Plan names, prices, limits and included credits are configuration in the `plans`
 * table (src/server/credits.ts; PR 4.5), no longer hardcoded here.
 */
export type PlanId = "starter" | "growth" | "agency";
