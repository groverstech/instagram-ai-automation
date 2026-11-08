import { defineConfig } from "vitest/config";
import path from "node:path";

// Live tests call real, paid AI providers. Never run in CI: `npm run test:live` only.
export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src"), "server-only": path.resolve(import.meta.dirname, "src/test/empty.ts") } },
  test: { environment: "node", include: ["src/**/*.live.ts"], testTimeout: 300_000, fileParallelism: false },
});
