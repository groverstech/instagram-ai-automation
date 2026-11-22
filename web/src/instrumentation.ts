export async function register() {
  // In-process scheduler. Embedded Postgres (PGlite) is single-process, so jobs run inside
  // the web server by default. With DATABASE_URL set you can disable this
  // (RUN_JOBS_IN_PROCESS=false) and run `npm run worker` or hit /api/cron/tick instead.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Configuration problems are logged; in staging/production (DEPLOY_ENV) errors stop the process.
    const { enforceConfig } = await import("./server/config");
    enforceConfig("web");
    // Staging (or AI_SPEND_CAP_REQUIRED=true): block any provider request that doesn't hold a
    // spend-cap reservation, i.e. that didn't go through the executor's accounting (paid-run-guard.ts).
    const { spendCapRequired } = await import("./server/ai/spend-cap");
    if (spendCapRequired()) {
      const { installPaidRequestGuard } = await import("./server/ai/paid-run-guard");
      await installPaidRequestGuard();
    }
    if (process.env.RUN_JOBS_IN_PROCESS === "false") return;
    const { tick } = await import("./server/jobs/handlers");
    const { log } = await import("./server/log");
    const g = globalThis as unknown as { __bpTicker?: NodeJS.Timeout };
    if (g.__bpTicker) return;
    // Recover strategist jobs interrupted by the previous process shortly after start.
    setTimeout(() => {
      import("./server/jobs/all")
        .then((m) => m.recoverDueTasks())
        .catch((e) => log.error("jobs.boot_recovery_failed", { error: e instanceof Error ? e.message : String(e) }));
    }, 5_000);
    g.__bpTicker = setInterval(() => {
      tick().catch((e) => log.error("jobs.tick_failed", { error: e instanceof Error ? e.message : String(e) }));
    }, 30_000);
  }
}

/**
 * Unhandled errors in route handlers, server components and actions (Next.js hook): reported
 * through the monitoring hook with the route, never with request bodies or headers.
 */
export async function onRequestError(err: unknown, request: { path: string; method: string }, context: { routerKind: string; routePath: string; routeType: string }) {
  // This exact `if` shape lets Next drop the Node-only import from the edge bundle.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { captureError } = await import("./server/monitoring");
    captureError(err, { where: "request", method: request.method, route: context.routePath, routeType: context.routeType });
  }
}
