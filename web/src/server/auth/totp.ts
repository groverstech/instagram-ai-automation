import "server-only";
import crypto from "node:crypto";
import { keyedHash } from "../crypto";

/**
 * Time-based one-time passwords (RFC 6238 over RFC 4226): HMAC-SHA1, 30-second steps, 6 digits,
 * which every authenticator app supports. Verification accepts the previous, current and next step
 * (clock drift) and returns the step used, so the caller can refuse a code that was already used.
 */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const STEP_SEC = 30;
export const DIGITS = 6;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error("Invalid base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new 160-bit secret, base32-encoded (the form authenticator apps take). */
export function newTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

export function hotp(secret: Buffer, counter: number, digits = DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac("sha1", secret).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export const stepAt = (ms: number) => Math.floor(ms / 1000 / STEP_SEC);

export function totpAt(secretB32: string, ms: number): string {
  return hotp(base32Decode(secretB32), stepAt(ms));
}

/**
 * The step a 6-digit code matches (previous, current or next), or null. A step at or before
 * `lastUsedStep` is refused, so a code can't be replayed.
 */
export function verifyTotp(secretB32: string, code: string, ms = Date.now(), lastUsedStep: number | null = null): number | null {
  const c = (code ?? "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(c)) return null;
  const secret = base32Decode(secretB32);
  const now = stepAt(ms);
  for (const step of [now - 1, now, now + 1]) {
    if (lastUsedStep !== null && step <= lastUsedStep) continue;
    const expected = hotp(secret, step);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return step;
  }
  return null;
}

/** The otpauth:// URI authenticator apps scan. */
export function otpauthUri(secretB32: string, account: string, issuer = "BrandPilot") {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SEC}`;
}

/** Ten one-time recovery codes like "k7m2-9qxp" (about 41 bits each), and their hashes for storage. */
export function newRecoveryCodes(n = 10): { codes: string[]; hashes: string[] } {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const codes = Array.from({ length: n }, () => {
    const b = crypto.randomBytes(8);
    const s = Array.from(b, (x) => alphabet[x % alphabet.length]).join("");
    return `${s.slice(0, 4)}-${s.slice(4, 8)}`;
  });
  return { codes, hashes: codes.map(hashRecoveryCode) };
}

/** Keyed with the app secret (HMAC-SHA256), so a leaked database alone can't be brute-forced for the codes. */
export function hashRecoveryCode(code: string) {
  return keyedHash(`bp-recovery:${code.trim().toLowerCase().replace(/[^a-z0-9]/g, "")}`, 64);
}
