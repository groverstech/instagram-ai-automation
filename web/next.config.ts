import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@electric-sql/pglite", "@electric-sql/pglite-pgvector", "postgres"],
  // Must exceed MAX_TOTAL_UPLOAD_BYTES (src/server/assets.ts) plus form overhead.
  experimental: { serverActions: { bodySizeLimit: "60mb" } },
};

export default nextConfig;
