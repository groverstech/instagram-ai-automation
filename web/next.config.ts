import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@electric-sql/pglite", "@electric-sql/pglite-pgvector", "postgres"],
  experimental: { serverActions: { bodySizeLimit: "20mb" } },
};

export default nextConfig;
