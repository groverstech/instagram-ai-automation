// Plain JavaScript on purpose: with next.config.ts, `next start` needs TypeScript at run time and
// tries to install it, which hangs a production container that has no dev dependencies.
/**
 * Security headers on every response (ADR-005). The CSP sets only directives that can't break
 * the app: no framing, no <base> or form-target hijacking, no plugins. A script-src policy needs
 * per-request nonces for Next's inline scripts and is tracked as a follow-up.
 */
const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
];

/** @type {import("next").NextConfig} */
const nextConfig = {
  serverExternalPackages: ["@electric-sql/pglite", "@electric-sql/pglite-pgvector", "postgres"],
  // Must exceed MAX_TOTAL_UPLOAD_BYTES (src/server/assets.ts) plus form overhead.
  experimental: { serverActions: { bodySizeLimit: "60mb" } },
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
