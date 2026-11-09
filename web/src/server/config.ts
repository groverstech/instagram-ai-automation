import "server-only";

/**
 * Deployment configuration checks (ADR-002 in docs/ARCHITECTURE_DECISIONS.md).
 *
 * `DEPLOY_ENV` says what this deployment *is*. It's independent of `NODE_ENV`, because any local
 * `next start` (demos, E2E runs) also has NODE_ENV=production:
 *   development | test | demo | staging | production   (default: development)
 *
 * With DEPLOY_ENV=staging or production, problems marked "error" stop the process at boot
 * (web, worker and migrate). In every other environment they are logged as warnings, so
 * existing local, demo and E2E setups keep working.
 *
 * Fail closed: an unrecognised DEPLOY_ENV (a typo such as "prod") is treated as strict and
 * refused, never as development. Unrecognised values of other settings are errors too, rather
 * than silently meaning a default.
 *
 * Only variable *names* are reported, never their values.
 */

export const DEPLOY_ENVS = ["development", "test", "demo", "staging", "production"] as const;
export type DeployEnv = (typeof DEPLOY_ENVS)[number];

export type ConfigProblem = { level: "error" | "warning"; key: string; message: string };

type Env = Record<string, string | undefined>;

const norm = (v: string | undefined) => (v ?? "").trim().toLowerCase();
const knownEnv = (v: string): v is DeployEnv => (DEPLOY_ENVS as readonly string[]).includes(v);

/** The deployment environment. Unset means development; an unrecognised value is reported by checkConfig. */
export function deployEnv(env: Env = process.env): DeployEnv {
  const v = norm(env.DEPLOY_ENV);
  return knownEnv(v) ? v : "development";
}

/** For logs and health output: the deployment environment, or "unknown" for an unrecognised value. */
export function deployEnvLabel(env: Env = process.env): DeployEnv | "unknown" {
  const v = norm(env.DEPLOY_ENV);
  return v && !knownEnv(v) ? "unknown" : deployEnv(env);
}

/**
 * True where configuration errors must stop the process: staging, production, and any
 * unrecognised DEPLOY_ENV (fail closed, so a typo can't switch the safeguards off).
 */
export function isStrict(env: Env = process.env) {
  const v = norm(env.DEPLOY_ENV);
  if (v && !knownEnv(v)) return true;
  return v === "staging" || v === "production";
}

/**
 * Whether the app applies database migrations itself when it first connects.
 *
 * - Staging and production: **off** unless MIGRATE_ON_START=true. Migrations run as the separate
 *   deploy step (`npm run db:migrate`, the image's `migrate` role); production refuses `true`.
 * - Elsewhere: on unless MIGRATE_ON_START=false (local, demo and E2E setups unchanged).
 * - An unrecognised value never migrates in strict environments (and is a configuration error).
 */
export function migrateOnStart(env: Env = process.env): boolean {
  const v = norm(env.MIGRATE_ON_START);
  if (v === "true") return true;
  if (v === "false") return false;
  return !isStrict(env);
}

const set = (v: string | undefined) => Boolean(v && v.trim());
const BOOL_KEYS = ["MIGRATE_ON_START", "ALLOW_LOCAL_STORAGE_IN_PRODUCTION", "AI_ALLOW_MOCK_IN_PRODUCTION", "RUN_JOBS_IN_PROCESS"] as const;

/** Validate the environment. Pure (takes the env as input) so it's easy to test. */
export function checkConfig(env: Env = process.env): ConfigProblem[] {
  const out: ConfigProblem[] = [];
  const err = (key: string, message: string) => out.push({ level: "error", key, message });
  const warn = (key: string, message: string) => out.push({ level: "warning", key, message });
  const strict = isStrict(env);
  const prod = strict || env.NODE_ENV === "production";

  const isProd = deployEnv(env) === "production";
  if (set(env.DEPLOY_ENV) && !knownEnv(norm(env.DEPLOY_ENV))) {
    err("DEPLOY_ENV", `Unknown value. Use one of: ${DEPLOY_ENVS.join(", ")}. Treated as strict until fixed.`);
  } else if (!set(env.DEPLOY_ENV) && env.NODE_ENV === "production") {
    warn("DEPLOY_ENV", "Not set: running without the staging/production safeguards. Set DEPLOY_ENV=production (or staging) on real deployments; demo for demos.");
  }

  // Yes/no settings: anything other than true/false is a mistake, not a silent "no".
  for (const k of BOOL_KEYS) {
    if (set(env[k]) && !["true", "false"].includes(norm(env[k]))) err(k, "Must be `true` or `false`.");
  }

  // Secrets used to encrypt OAuth tokens and sign links.
  if (!set(env.APP_SECRET) || (env.APP_SECRET ?? "").length < 32) {
    (prod ? err : warn)("APP_SECRET", "Must be set to a random value of at least 32 characters (e.g. `openssl rand -base64 48`).");
  }

  // Database: PGlite is single-process and for development only.
  if (!set(env.DATABASE_URL)) {
    (strict ? err : warn)("DATABASE_URL", "Not set: using embedded PGlite, which is for development and demos only. Production needs managed Postgres with pgvector.");
  } else if (!/^postgres(ql)?:\/\//i.test(env.DATABASE_URL!)) {
    err("DATABASE_URL", "Must be a postgres:// or postgresql:// URL.");
  }

  // Storage: production must not depend on one server's local disk (ADR-004).
  const driver = norm(env.STORAGE_DRIVER) || "local";
  if (!["local", "s3"].includes(driver)) err("STORAGE_DRIVER", "Use `local` or `s3`.");
  if (driver === "s3") {
    err("STORAGE_DRIVER", "The S3/R2 storage adapter arrives in PR 4.2. Until then only `local` is available.");
  } else if (strict && norm(env.ALLOW_LOCAL_STORAGE_IN_PRODUCTION) !== "true") {
    err(
      "STORAGE_DRIVER",
      "Local-disk storage can't be used in staging/production: files would live on one server and be lost on redeploy. Configure object storage (Cloudflare R2, PR 4.2), or set ALLOW_LOCAL_STORAGE_IN_PRODUCTION=true only for a single-instance pilot with a persistent, backed-up volume.",
    );
  } else if (prod && driver === "local") {
    warn("STORAGE_DRIVER", "Local-disk storage: back up STORAGE_DIR and run a single instance (or a shared volume).");
  }

  // AI mode: demo output must never reach real users. Mirrors src/server/ai/mode.ts: with
  // NODE_ENV=production, AI_PROVIDER=mock only takes effect with AI_ALLOW_MOCK_IN_PRODUCTION=true;
  // otherwise the real provider is used and needs credentials.
  const mockRequested = env.AI_PROVIDER === "mock";
  const mockEffective = mockRequested && (env.NODE_ENV !== "production" || env.AI_ALLOW_MOCK_IN_PRODUCTION === "true");
  if (set(env.AI_PROVIDER) && !["anthropic", "mock"].includes(env.AI_PROVIDER!)) err("AI_PROVIDER", "Use `anthropic` (or leave unset) for Claude, or `mock` for demos.");
  if (mockRequested && isProd) err("AI_PROVIDER", "Demo mode (mock) can't run in production. Remove AI_PROVIDER=mock.");
  else if (mockRequested && !mockEffective) warn("AI_PROVIDER", "AI_PROVIDER=mock is ignored with NODE_ENV=production unless AI_ALLOW_MOCK_IN_PRODUCTION=true; the real AI provider is used.");
  if (!mockEffective && !set(env.ANTHROPIC_API_KEY) && !set(env.ANTHROPIC_AUTH_TOKEN)) {
    (strict ? err : warn)("ANTHROPIC_API_KEY", "No Anthropic credentials: AI features are unavailable. Real-provider validation stays pending until it's configured.");
  }
  if (env.AI_ALLOW_MOCK_IN_PRODUCTION === "true" && isProd) {
    err("AI_ALLOW_MOCK_IN_PRODUCTION", "Must not be set in production.");
  }
  const imageProvider = norm(env.IMAGE_PROVIDER) || "openai";
  if (!["openai", "none"].includes(imageProvider)) err("IMAGE_PROVIDER", "Use `openai`, or `none` to turn AI images off.");
  else if (imageProvider === "openai" && !set(env.OPENAI_API_KEY)) {
    warn("OPENAI_API_KEY", "Not set: AI images are unavailable (brand-photo and type-led creatives still work).");
  }

  // Public URL: platforms fetch media from it, OAuth redirects use it.
  if (!set(env.APP_URL)) (strict ? err : warn)("APP_URL", "Set the public base URL (https://…).");
  else if (strict && !/^https:\/\//i.test(env.APP_URL!)) err("APP_URL", "Must be https in staging/production.");

  // Machine endpoints.
  if (set(env.CRON_SECRET) && (env.CRON_SECRET ?? "").length < 32) err("CRON_SECRET", "Must be at least 32 characters; shorter secrets are refused by /api/cron/tick.");

  // Proxy trust for client IPs (rate limits, login protection).
  const hops = env.TRUSTED_PROXY_HOPS;
  if (hops !== undefined && !/^\d+$/.test(hops)) err("TRUSTED_PROXY_HOPS", "Must be a whole number (0 = no proxy).");
  if (strict && hops === undefined && !set(env.CLIENT_IP_HEADER)) {
    warn("TRUSTED_PROXY_HOPS", "Not set: assuming one proxy in front of the app. Set it (or CLIENT_IP_HEADER) to match your load balancer/CDN.");
  }

  // Migrations: in staging/production they run as a separate deploy step (ADR-003).
  if (strict && norm(env.MIGRATE_ON_START) === "true") {
    (isProd ? err : warn)("MIGRATE_ON_START", "Migrations must run as the separate deploy step (`npm run db:migrate`, the image's `migrate` role), not at start-up. Remove MIGRATE_ON_START=true.");
  }

  // Numeric settings: an invalid value must not silently become a default.
  for (const k of ["DATABASE_POOL_MAX", "WORKER_INTERVAL_MS", "WORKER_DRAIN_MS"] as const) {
    if (set(env[k]) && !/^[1-9]\d*$/.test(env[k]!.trim())) err(k, "Must be a positive whole number.");
  }
  if (set(env.EMAIL_PROVIDER) && norm(env.EMAIL_PROVIDER) !== "log") err("EMAIL_PROVIDER", "Unknown provider. Only `log` exists until an email provider is chosen.");
  else if (strict) warn("EMAIL_PROVIDER", "No email provider: emails can't be sent in this environment (sending fails loudly).");

  // Paired settings: an ID without its secret (or vice versa) is a misconfiguration.
  for (const [id, secret] of [
    ["META_APP_ID", "META_APP_SECRET"],
    ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"],
    ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    ["PINTEREST_CLIENT_ID", "PINTEREST_CLIENT_SECRET"],
    ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"],
  ] as const) {
    if (set(env[id]) !== set(env[secret])) err(set(env[id]) ? secret : id, `${id} and ${secret} must be set together.`);
  }
  if (set(env.STRIPE_SECRET_KEY) && !set(env.STRIPE_WEBHOOK_SECRET)) err("STRIPE_WEBHOOK_SECRET", "Required when STRIPE_SECRET_KEY is set.");
  if (/^sk_test_/.test(env.STRIPE_SECRET_KEY ?? "") && isProd) {
    warn("STRIPE_SECRET_KEY", "A Stripe test key is configured in production.");
  }
  return out;
}

/** Non-secret summary for health checks and the admin view. */
export function configSummary(env: Env = process.env) {
  const problems = checkConfig(env);
  return {
    deployEnv: deployEnvLabel(env),
    strict: isStrict(env),
    database: set(env.DATABASE_URL) ? "postgres" : "pglite",
    storage: norm(env.STORAGE_DRIVER) || "local",
    migrateOnStart: migrateOnStart(env),
    aiMode: env.AI_PROVIDER === "mock" ? "demo" : "production",
    errors: problems.filter((p) => p.level === "error").length,
    warnings: problems.filter((p) => p.level === "warning").length,
  };
}

/**
 * Run at process start (web, worker, migrate). Logs every problem; in staging/production any
 * error stops the process.
 */
export function enforceConfig(where: string, env: Env = process.env, exit: (code: number) => never = process.exit) {
  const problems = checkConfig(env);
  for (const p of problems) {
    const line = JSON.stringify({ ts: new Date().toISOString(), level: p.level === "error" ? "error" : "warn", event: "config.problem", where, key: p.key, message: p.message });
    (p.level === "error" ? console.error : console.warn)(line);
  }
  const errors = problems.filter((p) => p.level === "error");
  if (errors.length && isStrict(env)) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", event: "config.refused", where, deployEnv: deployEnvLabel(env), errors: errors.map((e) => e.key) }));
    exit(1);
  }
  return problems;
}
