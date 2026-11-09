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
 * Only variable *names* are reported, never their values.
 */

export const DEPLOY_ENVS = ["development", "test", "demo", "staging", "production"] as const;
export type DeployEnv = (typeof DEPLOY_ENVS)[number];

export type ConfigProblem = { level: "error" | "warning"; key: string; message: string };

type Env = Record<string, string | undefined>;

export function deployEnv(env: Env = process.env): DeployEnv {
  const v = (env.DEPLOY_ENV ?? "").toLowerCase();
  return (DEPLOY_ENVS as readonly string[]).includes(v) ? (v as DeployEnv) : "development";
}

/** True where configuration errors must stop the process. */
export function isStrict(env: Env = process.env) {
  const d = deployEnv(env);
  return d === "staging" || d === "production";
}

const set = (v: string | undefined) => Boolean(v && v.trim());

/** Validate the environment. Pure (takes the env as input) so it's easy to test. */
export function checkConfig(env: Env = process.env): ConfigProblem[] {
  const out: ConfigProblem[] = [];
  const err = (key: string, message: string) => out.push({ level: "error", key, message });
  const warn = (key: string, message: string) => out.push({ level: "warning", key, message });
  const strict = isStrict(env);
  const prod = strict || env.NODE_ENV === "production";

  if (env.DEPLOY_ENV && !(DEPLOY_ENVS as readonly string[]).includes(env.DEPLOY_ENV.toLowerCase())) {
    err("DEPLOY_ENV", `Unknown value. Use one of: ${DEPLOY_ENVS.join(", ")}.`);
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
  const driver = (env.STORAGE_DRIVER ?? "local").toLowerCase();
  if (!["local", "s3"].includes(driver)) err("STORAGE_DRIVER", "Use `local` or `s3`.");
  if (driver === "s3") {
    err("STORAGE_DRIVER", "The S3/R2 storage adapter arrives in PR 4.2. Until then only `local` is available.");
  } else if (strict && env.ALLOW_LOCAL_STORAGE_IN_PRODUCTION !== "true") {
    err(
      "STORAGE_DRIVER",
      "Local-disk storage can't be used in staging/production: files would live on one server and be lost on redeploy. Configure object storage (Cloudflare R2, PR 4.2), or set ALLOW_LOCAL_STORAGE_IN_PRODUCTION=true only for a single-instance pilot with a persistent, backed-up volume.",
    );
  } else if (prod && driver === "local") {
    warn("STORAGE_DRIVER", "Local-disk storage: back up STORAGE_DIR and run a single instance (or a shared volume).");
  }

  // AI mode: demo output must never reach real users (see src/server/ai/mode.ts).
  if (env.AI_PROVIDER === "mock") {
    if (strict && env.DEPLOY_ENV?.toLowerCase() === "production") err("AI_PROVIDER", "Demo mode (mock) can't run in production. Remove AI_PROVIDER=mock.");
    else if (prod && env.AI_ALLOW_MOCK_IN_PRODUCTION !== "true") warn("AI_PROVIDER", "AI_PROVIDER=mock is ignored with NODE_ENV=production unless AI_ALLOW_MOCK_IN_PRODUCTION=true.");
  } else if (!set(env.ANTHROPIC_API_KEY) && !set(env.ANTHROPIC_AUTH_TOKEN)) {
    (strict ? err : warn)("ANTHROPIC_API_KEY", "No Anthropic credentials: AI features are unavailable. Real-provider validation stays pending until it's configured.");
  }
  if (env.AI_ALLOW_MOCK_IN_PRODUCTION === "true" && env.DEPLOY_ENV?.toLowerCase() === "production") {
    err("AI_ALLOW_MOCK_IN_PRODUCTION", "Must not be set in production.");
  }
  if ((env.IMAGE_PROVIDER ?? "openai").toLowerCase() === "openai" && !set(env.OPENAI_API_KEY)) {
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

  // Migrations: in staging/production they should run as a separate step (ADR-003).
  if (strict && env.MIGRATE_ON_START !== "false") {
    warn("MIGRATE_ON_START", "Migrations run at start-up. Recommended: run `npm run db:migrate` as a deploy step and set MIGRATE_ON_START=false.");
  }

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
  if (strict && /^sk_test_/.test(env.STRIPE_SECRET_KEY ?? "") && env.DEPLOY_ENV?.toLowerCase() === "production") {
    warn("STRIPE_SECRET_KEY", "A Stripe test key is configured in production.");
  }
  return out;
}

/** Non-secret summary for health checks and the admin view. */
export function configSummary(env: Env = process.env) {
  const problems = checkConfig(env);
  return {
    deployEnv: deployEnv(env),
    strict: isStrict(env),
    database: set(env.DATABASE_URL) ? "postgres" : "pglite",
    storage: (env.STORAGE_DRIVER ?? "local").toLowerCase(),
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
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", event: "config.refused", where, deployEnv: deployEnv(env), errors: errors.map((e) => e.key) }));
    exit(1);
  }
  return problems;
}
