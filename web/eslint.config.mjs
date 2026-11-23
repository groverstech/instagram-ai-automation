import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

const config = [
  { ignores: [".next/**", "node_modules/**", "drizzle/**", ".data/**", "next-env.d.ts"] },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  // Browser journeys run as plain Node scripts (CommonJS), outside the app.
  { files: ["e2e/**/*.cjs"], rules: { "@typescript-eslint/no-require-imports": "off" } },
];

export default config;
