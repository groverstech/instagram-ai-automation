import "server-only";
import crypto from "node:crypto";
import { log, redact } from "./log";

/**
 * Error reporting hook (ADR-007). Every unexpected error goes through `captureError`, which:
 *   1. assigns a short reference ID that can be shown to the user and searched in logs;
 *   2. writes a structured, redacted `error.captured` log line (stack trimmed);
 *   3. forwards to registered reporters.
 *
 * No vendor SDK is bundled. With `SENTRY_DSN` set, `installConfiguredReporters` (called at web and
 * worker start-up) adds a small dependency-free reporter that sends each captured error to Sentry's
 * envelope endpoint; without it, nothing leaves the process.
 */
export type ErrorContext = Record<string, unknown> & { where?: string };
type Reporter = (error: unknown, ctx: ErrorContext & { ref: string }) => void | Promise<void>;

const reporters: Reporter[] = [];
export function addErrorReporter(r: Reporter) {
  reporters.push(r);
}

export function captureError(error: unknown, ctx: ErrorContext = {}): string {
  const ref = crypto.randomBytes(4).toString("hex");
  const e = error instanceof Error ? error : new Error(String(error));
  log.error("error.captured", {
    ref,
    name: e.name,
    message: e.message,
    stack: e.stack?.split("\n").slice(0, 8).join("\n"),
    ...(redact(ctx) as Record<string, unknown>),
  });
  for (const r of reporters) {
    try {
      void Promise.resolve(r(error, { ...ctx, ref })).catch(() => {});
    } catch {
      // A broken reporter must never break the request.
    }
  }
  return ref;
}

/**
 * Errors whose message is internal (database, network, filesystem) and must never be shown to
 * users: postgres errors (SQLSTATE codes, severity) and Node system errors (ECONNREFUSED, ENOENT…).
 */
export function isInternalError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const o = e as { code?: unknown; severity?: unknown; errno?: unknown; syscall?: unknown; name?: string };
  if (typeof o.severity === "string") return true; // postgres-js PostgresError
  if (typeof o.code === "string" && (/^[0-9A-Z]{5}$/.test(o.code) || /^E[A-Z]{2,}$/.test(o.code))) return true;
  if (typeof o.errno === "number" || typeof o.syscall === "string") return true;
  return o.name === "PostgresError" || o.name === "DrizzleQueryError";
}

/** Parse a Sentry DSN (https://<public key>@<host>[/<path>]/<project id>), or null if it isn't one. */
export function parseSentryDsn(dsn: string): { endpoint: string; key: string } | null {
  try {
    const u = new URL(dsn.trim());
    const parts = u.pathname.split("/").filter(Boolean);
    const project = parts.pop();
    if (u.protocol !== "https:" || !u.username || !project || !/^\d+$/.test(project)) return null;
    const base = parts.length ? `/${parts.join("/")}` : "";
    return { endpoint: `https://${u.host}${base}/api/${project}/envelope/`, key: u.username };
  } catch {
    return null;
  }
}

/** A reporter for Sentry's envelope API: message, type, trimmed stack and the redacted context only. */
export function sentryReporter(dsn: string, env: Record<string, string | undefined> = process.env, send: typeof fetch = fetch): Reporter | null {
  const target = parseSentryDsn(dsn);
  if (!target) return null;
  return async (error, ctx) => {
    const e = error instanceof Error ? error : new Error(String(error));
    const eventId = crypto.randomBytes(16).toString("hex");
    const { ref, where, ...rest } = ctx;
    const event = {
      event_id: eventId,
      timestamp: Date.now() / 1000,
      platform: "node",
      level: "error",
      environment: env.DEPLOY_ENV || "development",
      release: env.APP_VERSION || undefined,
      exception: { values: [{ type: e.name, value: String(redact(e.message)) }] },
      tags: { ref, where: typeof where === "string" ? where : undefined },
      extra: { ...(redact(rest) as Record<string, unknown>), stack: e.stack?.split("\n").slice(0, 12).join("\n") },
    };
    const body = `${JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString() })}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify(event)}\n`;
    await send(target.endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-sentry-envelope", "x-sentry-auth": `Sentry sentry_version=7, sentry_key=${target.key}, sentry_client=brandpilot/1` },
      body,
      signal: AbortSignal.timeout(3000),
    });
  };
}

let installed = false;
/** Register the reporters the environment configures (today: Sentry via SENTRY_DSN). Idempotent. */
export function installConfiguredReporters(env: Record<string, string | undefined> = process.env) {
  if (installed) return;
  installed = true;
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) return;
  const r = sentryReporter(dsn, env);
  if (r) {
    addErrorReporter(r);
    log.info("monitoring.reporter_installed", { provider: "sentry" });
  }
}
