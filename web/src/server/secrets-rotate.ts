import "server-only";
import { and, eq, isNotNull } from "drizzle-orm";
import { getDb, schema } from "./db/client";
import { decrypt, encrypt, keyIdOf, keys } from "./crypto";
import { audit } from "./audit";

/**
 * APP_SECRET rotation (launch gate S3; docs/DEPLOYMENT.md "Rotating APP_SECRET").
 *
 * 1. Set APP_SECRET to the new secret and APP_SECRET_PREVIOUS to the old one; deploy. Everything
 *    keeps working: reads accept both keys, writes use the new one.
 * 2. `npm run secrets:rotate -- reencrypt` re-encrypts stored secrets (social-account tokens,
 *    two-step secrets) under the new key. Each row is updated only if it still holds the value that
 *    was read (compare-and-set), so concurrent writes win.
 * 3. `status` shows what still depends on an old key: encrypted values, and recovery codes (which
 *    can't be re-hashed without the codes themselves: they move to the new key when the person
 *    makes new codes). When nothing does, or you accept that those recovery codes stop working,
 *    remove APP_SECRET_PREVIOUS.
 */

type Column = { table: "users" | "social_accounts"; column: string };
const COLUMNS = [
  { table: "users", column: "mfaSecretEnc" },
  { table: "users", column: "mfaPendingSecretEnc" },
  { table: "social_accounts", column: "accessTokenEnc" },
  { table: "social_accounts", column: "refreshTokenEnc" },
] as const satisfies readonly Column[];

function tableOf(c: Column) {
  return c.table === "users" ? schema.users : schema.socialAccounts;
}

async function rowsOf(c: (typeof COLUMNS)[number]) {
  const db = await getDb();
  const t = tableOf(c);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the column is one of COLUMNS
  const col = (t as any)[c.column];
  return { db, t, col, rows: (await db.select({ id: t.id, v: col }).from(t).where(isNotNull(col))) as { id: string; v: string }[] };
}

export type RotationStatus = {
  current: string;
  previous: string[];
  encrypted: { column: string; byKey: Record<string, number> }[];
  recoveryCodes: { users: number; byKey: Record<string, number> };
};

export async function rotationStatus(): Promise<RotationStatus> {
  const ks = keys();
  const encrypted = [];
  for (const c of COLUMNS) {
    const { rows } = await rowsOf(c);
    const byKey: Record<string, number> = {};
    for (const r of rows) byKey[keyIdOf(r.v)] = (byKey[keyIdOf(r.v)] ?? 0) + 1;
    encrypted.push({ column: `${c.table}.${c.column}`, byKey });
  }
  const db = await getDb();
  const users = await db.select({ h: schema.users.mfaRecoveryHashes }).from(schema.users).where(isNotNull(schema.users.mfaEnabledAt));
  const byKey: Record<string, number> = {};
  let withCodes = 0;
  for (const u of users) {
    if (!u.h.length) continue;
    withCodes++;
    const ids = new Set(u.h.map((x) => (x.includes(":") ? x.split(":")[0] : "legacy")));
    for (const id of ids) byKey[id] = (byKey[id] ?? 0) + 1;
  }
  return { current: ks[0].id, previous: ks.slice(1).map((k) => k.id), encrypted, recoveryCodes: { users: withCodes, byKey } };
}

/** Re-encrypt every stored secret not yet under the current key. Never throws for one bad row. */
export async function reencryptAll(opts: { dryRun?: boolean; by: string }) {
  const current = keys()[0].id;
  const result = { reencrypted: 0, alreadyCurrent: 0, failed: [] as string[], changedMeanwhile: 0 };
  for (const c of COLUMNS) {
    const { db, t, col, rows } = await rowsOf(c);
    for (const r of rows) {
      if (keyIdOf(r.v) === current) {
        result.alreadyCurrent++;
        continue;
      }
      let plain: string;
      try {
        plain = decrypt(r.v);
      } catch {
        result.failed.push(`${c.table}.${c.column} ${r.id}`);
        continue;
      }
      if (opts.dryRun) {
        result.reencrypted++;
        continue;
      }
      const done = await db.update(t).set({ [c.column]: encrypt(plain) }).where(and(eq(t.id, r.id), eq(col, r.v))).returning({ id: t.id });
      if (done.length) result.reencrypted++;
      else result.changedMeanwhile++;
    }
  }
  if (!opts.dryRun) await audit({ action: "config.secrets_reencrypt", actorType: "system", targetType: "app_secret", targetId: current, details: { by: opts.by, status: `${result.reencrypted} re-encrypted, ${result.failed.length} failed` } });
  return result;
}
