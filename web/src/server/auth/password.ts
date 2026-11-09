import crypto from "node:crypto";

/**
 * Password hashing with scrypt.
 *
 * Current format: `scrypt2$N$r$p$salt$key`, with the parameters stored in the hash so they can
 * be raised later without breaking existing users. Parameters follow OWASP's scrypt guidance at
 * 16 MiB of memory (N=2^14, r=8, p=5).
 *
 * Legacy format `scrypt$salt$key` (Node defaults: N=2^14, r=8, p=1) still verifies. `needsRehash`
 * lets the login flow upgrade it transparently after a successful sign-in.
 */
const PARAMS = { N: 16384, r: 8, p: 5 } as const;
const KEY_LEN = 64;

function scrypt(pw: string, salt: Buffer, len: number, opts: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    crypto.scrypt(pw, salt, len, { ...opts, maxmem: 128 * opts.N * opts.r * 2 }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, KEY_LEN, PARAMS);
  return `scrypt2$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

function parse(stored: string): { opts: { N: number; r: number; p: number }; salt: Buffer; key: Buffer } | null {
  const parts = stored.split("$");
  if (parts[0] === "scrypt" && parts.length === 3) {
    return { opts: { N: 16384, r: 8, p: 1 }, salt: Buffer.from(parts[1], "base64"), key: Buffer.from(parts[2], "base64") };
  }
  if (parts[0] === "scrypt2" && parts.length === 6) {
    const [N, r, p] = parts.slice(1, 4).map(Number);
    // Refuse absurd parameters from a tampered row instead of burning CPU or memory.
    if (![N, r, p].every(Number.isInteger) || N < 1024 || N > 1 << 20 || r < 1 || r > 32 || p < 1 || p > 16) return null;
    return { opts: { N, r, p }, salt: Buffer.from(parts[4], "base64"), key: Buffer.from(parts[5], "base64") };
  }
  return null;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const h = parse(stored);
  if (!h || !h.key.length) return false;
  const key = await scrypt(pw, h.salt, h.key.length, h.opts);
  return crypto.timingSafeEqual(key, h.key);
}

/** True when a stored hash uses older or weaker parameters than today's. */
export function needsRehash(stored: string): boolean {
  const h = parse(stored);
  return !h || !stored.startsWith("scrypt2$") || h.opts.N < PARAMS.N || h.opts.r < PARAMS.r || h.opts.p < PARAMS.p;
}

/**
 * Burn the same work as a real verification. Used when the account doesn't exist, so response
 * time doesn't reveal which email addresses are registered.
 */
let dummy: Promise<string> | null = null;
export async function verifyDummy(pw: string): Promise<false> {
  dummy ??= hashPassword(crypto.randomBytes(16).toString("hex"));
  await verifyPassword(pw, await dummy);
  return false;
}
