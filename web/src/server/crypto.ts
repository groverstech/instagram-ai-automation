import "server-only";
import crypto from "node:crypto";

let devSecretWarned = false;

/**
 * Keys derived from APP_SECRET (current) and APP_SECRET_PREVIOUS (comma-separated, during a
 * rotation). New ciphertext, signatures and keyed hashes always use the current key; reading
 * accepts the previous ones too, so rotating the secret doesn't sign anyone out of their social
 * accounts or two-step verification. `npm run secrets:rotate` re-encrypts stored values under the
 * current key; then the previous secret can be removed (docs/DEPLOYMENT.md, "Rotating APP_SECRET").
 */
export type Key = { id: string; key: Buffer; current: boolean };
const derive = (s: string) => crypto.createHash("sha256").update(s).digest();
const keyId = (k: Buffer) => crypto.createHash("sha256").update(Buffer.concat([Buffer.from("bp-kid:"), k])).digest("hex").slice(0, 8);

export function keys(env: Record<string, string | undefined> = process.env): Key[] {
  const cur = currentKey(env);
  const prev = (env.APP_SECRET_PREVIOUS ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.length >= 32 && x !== env.APP_SECRET)
    .map(derive);
  const out: Key[] = [{ id: keyId(cur), key: cur, current: true }];
  for (const k of prev) if (!out.some((o) => o.key.equals(k))) out.push({ id: keyId(k), key: k, current: false });
  return out;
}

function currentKey(env: Record<string, string | undefined> = process.env): Buffer {
  const s = env.APP_SECRET;
  if (s && s.length >= 32) return derive(s);
  if (env.NODE_ENV === "production") {
    throw new Error("APP_SECRET must be set (32+ chars) in production.");
  }
  if (!devSecretWarned) {
    console.warn("[security] APP_SECRET not set — using an insecure development key.");
    devSecretWarned = true;
  }
  return derive("brandpilot-dev-secret-do-not-use");
}

function secret(): Buffer {
  return currentKey();
}

/**
 * AES-256-GCM. Output: `v1.<key id>.<base64(iv | tag | ciphertext)>`. Used for OAuth tokens and
 * two-step secrets at rest. Values written before key ids existed (plain base64) still decrypt.
 */
export function encrypt(plain: string): string {
  const k = keys()[0];
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", k.key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1.${k.id}.${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64")}`;
}

function decryptWith(key: Buffer, b64: string) {
  const buf = Buffer.from(b64, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
}

export class DecryptError extends Error {}

export function decrypt(enc: string): string {
  const all = keys();
  const m = /^v1\.([0-9a-f]{8})\.(.*)$/s.exec(enc);
  if (m) {
    const k = all.find((x) => x.id === m[1]);
    if (!k) throw new DecryptError(`Encrypted with a key that isn't configured (key id ${m[1]}). Add its secret to APP_SECRET_PREVIOUS.`);
    return decryptWith(k.key, m[2]);
  }
  // Legacy format (no key id): the authentication tag tells which key fits.
  for (const k of all) {
    try {
      return decryptWith(k.key, enc);
    } catch {
      /* next key */
    }
  }
  throw new DecryptError("Couldn't decrypt a stored value with any configured key (APP_SECRET, APP_SECRET_PREVIOUS).");
}

/** The key id a stored value was encrypted with; "legacy" for values from before key ids. */
export function keyIdOf(enc: string): string {
  return /^v1\.([0-9a-f]{8})\./.exec(enc)?.[1] ?? "legacy";
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
  const a = Buffer.from(mac);
  // Tokens signed before a rotation stay valid until they expire.
  const ok = keys().some((k) => {
    const b = Buffer.from(crypto.createHmac("sha256", k.key).update(body).digest("base64url"));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
  if (!ok) return null;
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

/** The keyed hash under every configured key (current first), for matching values stored before a rotation. */
export function keyedHashes(s: string, len = 32): { keyId: string; hash: string }[] {
  return keys().map((k) => ({ keyId: k.id, hash: crypto.createHmac("sha256", k.key).update(s).digest("hex").slice(0, len) }));
}
