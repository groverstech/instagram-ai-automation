export async function register() {
  // In-process scheduler. Embedded Postgres (PGlite) is single-process, so jobs run inside
  // the web server by default. With DATABASE_URL set you can disable this
  // (RUN_JOBS_IN_PROCESS=false) and run `npm run worker` or hit /api/cron/tick instead.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (process.env.RUN_JOBS_IN_PROCESS === "false") return;
    const { tick } = await import("./server/jobs/handlers");
    const { log } = await import("./server/log");
    const g = globalThis as unknown as { __bpTicker?: NodeJS.Timeout };
    if (g.__bpTicker) return;
    // Recover strategist jobs interrupted by the previous process shortly after start.
    setTimeout(() => {
      import("./server/strategist/workflow")
        .then((m) => m.recoverDueTasks())
        .catch((e) => log.error("strategist.boot_recovery_failed", { error: e instanceof Error ? e.message : String(e) }));
    }, 5_000);
    g.__bpTicker = setInterval(() => {
      tick().catch((e) => log.error("jobs.tick_failed", { error: e instanceof Error ? e.message : String(e) }));
    }, 30_000);
  }
}
