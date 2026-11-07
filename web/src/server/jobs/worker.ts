// Standalone worker for Postgres deployments: `npm run worker`.
// Not for PGlite (single-process) — the web server runs jobs in-process there.
import { tick } from "./handlers";

if (!process.env.DATABASE_URL) {
  console.error("The standalone worker needs DATABASE_URL. With embedded PGlite, jobs run inside the web server.");
  process.exit(1);
}

async function loop() {
  for (;;) {
    try {
      const r = await tick();
      if (r.length) console.log(`[worker] ran ${r.length} job(s)`, r);
    } catch (e) {
      console.error("[worker]", e);
    }
    await new Promise((r) => setTimeout(r, 15_000));
  }
}
loop();
