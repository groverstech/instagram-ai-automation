import "server-only";
import crypto from "node:crypto";

let devSecretWarned = false;

function secret(): Buffer {
  const s = process.env.APP_SECRET;
  if (s && s.length >= 32) return crypto.createHash("sha256").update(s).digest();
  if (process.env.NODE_ENV === "production") {
    throw new Error("APP_SECRET must be set (32+ chars) in production.");
  }
  if (!devSecretWarned) {
    console.warn("[security] APP_SECRET not set — using an insecure development key.");
    devSecretWarned = true;
  }
  return crypto.createHash("sha256").update("brandpilot-dev-secret-do-not-use").digest();
}

/** AES-256-GCM. Output: base64(iv | tag | ciphertext). Used for OAuth tokens at rest. */
export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", secret(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

export function decrypt(enc: string): string {
  const buf = Buffer.from(enc, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", secret(), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
}

/** Compact signed token: base64url(payload).base64url(hmac). */
export function sign(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verify<T = Record<string, unknown>>(token: string): T | null {
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const expected = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T & { exp?: number };
    if (data.exp && Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}

export function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

/**
 * Keyed hash (HMAC-SHA256 with the app secret), truncated. For identifiers we must match later
 * but must not store in readable form, e.g. client IPs in the audit log. Unlike a plain hash, it
 * can't be reversed by hashing every IPv4 address.
 */
export function keyedHash(s: string, len = 32): string {
  return crypto.createHmac("sha256", secret()).update(s).digest("hex").slice(0, len);
}
