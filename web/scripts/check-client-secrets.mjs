// Fails the build if server-only secrets could have leaked into client bundles.
// Run after `next build`: node scripts/check-client-secrets.mjs
import fs from "node:fs";
import path from "node:path";

const dir = path.join(process.cwd(), ".next", "static");
if (!fs.existsSync(dir)) {
  console.error("No .next/static directory. Run `npm run build` first.");
  process.exit(2);
}
const SERVER_ONLY_ENV = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "VOYAGE_API_KEY", "APP_SECRET", "DATABASE_URL",
  "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "META_APP_SECRET", "LINKEDIN_CLIENT_SECRET", "GOOGLE_CLIENT_SECRET",
  "PINTEREST_CLIENT_SECRET", "TIKTOK_CLIENT_SECRET", "CRON_SECRET",
];
const KEY_PATTERNS = [/sk-ant-[\w-]{20,}/, /sk_live_[\w]{16,}/, /whsec_[\w]{16,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/];
// Values of secrets set in this build environment must not appear either.
const values = SERVER_ONLY_ENV.map((k) => process.env[k]).filter((v) => v && v.length >= 12);

const problems = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(js|css|json|txt|map)$/.test(e.name)) {
      const src = fs.readFileSync(p, "utf8");
      // Reading a server-only variable from client code (help text naming a variable is fine).
      for (const name of SERVER_ONLY_ENV) if (new RegExp(`env(\\.|\\[["'])${name}\\b`).test(src)) problems.push(`${path.relative(dir, p)}: reads process.env.${name}`);
      for (const re of KEY_PATTERNS) if (re.test(src)) problems.push(`${path.relative(dir, p)}: contains a key-like string (${re})`);
      for (const v of values) if (src.includes(v)) problems.push(`${path.relative(dir, p)}: contains the value of a server secret`);
    }
  }
};
walk(dir);
if (problems.length) {
  console.error("Client bundle secret check FAILED:\n" + problems.map((p) => ` - ${p}`).join("\n"));
  process.exit(1);
}
console.log(`Client bundle secret check passed (${SERVER_ONLY_ENV.length} server-only variables, ${KEY_PATTERNS.length} key patterns).`);
