import "server-only";
import { clientIp } from "./client-ip";
import crypto from "node:crypto";
import { RateLimitError, enforce } from "./ratelimit";
import { log } from "./log";

/** Minimum length for CRON_SECRET; shorter secrets are treated as not configured. */
export const MIN_CRON_SECRET = 32;

// Compare fixed-length digests so neither the content nor the length of the secret leaks through timing.
const KEY = crypto.randomBytes(32);
const digest = (s: string) => crypto.createHmac("sha256", KEY).update(s).digest();

export type CronAuth = { ok: true } | { ok: false; status: 401 | 429 | 503; retryAfter?: number };

/**
 * Authenticate an external scheduler call: `Authorization: Bearer <CRON_SECRET>` only.
 * Fails closed when the secret is missing or too short. Failed attempts are rate-limited per
 * client IP in Postgres (shared across instances); hashed IPs only, never the presented token.
 */
export async function authenticateCron(req: Request, secret = process.env.CRON_SECRET): Promise<CronAuth> {
  const ip = clientIp(req.headers);
  const ipKey = crypto.createHash("sha256").update(`cron:${ip}`).digest("hex").slice(0, 32);
  if (!secret || secret.length < MIN_CRON_SECRET) {
    log.warn("cron.not_configured", { reason: secret ? "secret_too_short" : "secret_missing" });
    return { ok: false, status: 503 };
  }
  const header = req.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (presented && crypto.timingSafeEqual(digest(presented), digest(secret))) return { ok: true };
  try {
    await enforce("cron_auth", { key: ipKey });
  } catch (e) {
    if (e instanceof RateLimitError) return { ok: false, status: 429, retryAfter: e.retryAfter };
    throw e;
  }
  log.warn("cron.unauthorized", { ip: ipKey, scheme: header.split(" ")[0] || "none" });
  return { ok: false, status: 401 };
}
