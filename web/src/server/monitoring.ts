import "server-only";
import crypto from "node:crypto";
import { log, redact } from "./log";

/**
 * Error reporting hook (ADR-007). Every unexpected error goes through `captureError`, which:
 *   1. assigns a short reference ID that can be shown to the user and searched in logs;
 *   2. writes a structured, redacted `error.captured` log line (stack trimmed);
 *   3. forwards to registered reporters.
 *
 * No vendor SDK is bundled yet: the error-tracking provider (e.g. Sentry) is a pending
 * infrastructure decision. Registering one later is a single `addErrorReporter` call at start-up;
 * no call sites change.
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
