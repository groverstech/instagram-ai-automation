import { defineConfig } from "vitest/config";
import path from "node:path";

// Live tests call real, paid AI providers. Never run in CI: `npm run test:live` only.
// paid-run.setup.ts runs first in every live test file and refuses the run without a valid,
// unexhausted spending cap (AI_SPEND_CAP_USD, AI_SPEND_CAP_SINCE) and a persistent usage ledger.
export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src"), "server-only": path.resolve(import.meta.dirname, "src/test/empty.ts") } },
  test: { environment: "node", include: ["src/**/*.live.ts"], setupFiles: ["src/server/live/paid-run.setup.ts"], testTimeout: 300_000, fileParallelism: false },
});
