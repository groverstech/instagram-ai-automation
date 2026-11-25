import "server-only";
import { cookies } from "next/headers";
import { and, eq, gt } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import { randomToken, sha256 } from "../crypto";

const COOKIE = "bp_session";
const TTL_MS = 1000 * 60 * 60 * 24 * 30;
/** A session waiting for its second factor lasts 10 minutes. */
const PENDING_MFA_TTL_MS = 1000 * 60 * 10;

/**
 * Start a session. `pendingMfa`: the password was right but the user has two-step verification on,
 * so the session can only complete sign-in (/login/mfa) until the second factor is verified.
 */
export async function createSession(userId: string, opts: { pendingMfa?: boolean } = {}) {
  const db = await getDb();
  const token = randomToken();
  const expiresAt = new Date(Date.now() + (opts.pendingMfa ? PENDING_MFA_TTL_MS : TTL_MS));
  await db.insert(schema.sessions).values({ id: sha256(token), userId, expiresAt, mfaVerifiedAt: opts.pendingMfa ? null : new Date() });
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
}

export async function destroySession() {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) {
    const db = await getDb();
    await db.delete(schema.sessions).where(eq(schema.sessions.id, sha256(token)));
  }
  jar.delete(COOKIE);
}

export type SessionUser = {
  sessionId: string;
  activeBrandId: string | null;
  user: { id: string; email: string; name: string };
  /** Two-step verification is on for this user. */
  mfaEnabled?: boolean;
  /** The user confirmed their email address (auth/verify-email.ts). */
  emailVerified?: boolean;
};

async function sessionRow() {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  const db = await getDb();
  const rows = await db
    .select({
      sessionId: schema.sessions.id,
      activeBrandId: schema.sessions.activeBrandId,
      mfaVerifiedAt: schema.sessions.mfaVerifiedAt,
      id: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
      mfaEnabledAt: schema.users.mfaEnabledAt,
      emailVerifiedAt: schema.users.emailVerifiedAt,
    })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(and(eq(schema.sessions.id, sha256(token)), gt(schema.sessions.expiresAt, new Date())))
    .limit(1);
  return rows[0] ?? null;
}

/** The session waiting for its second factor, if that's what the cookie holds (for /login/mfa only). */
export async function getPendingMfaSession(): Promise<{ sessionId: string; userId: string; email: string } | null> {
  const r = await sessionRow();
  if (!r || !r.mfaEnabledAt || r.mfaVerifiedAt) return null;
  return { sessionId: r.sessionId, userId: r.id, email: r.email };
}

/**
 * The signed-in user. A session still waiting for its second factor (MFA on, not yet verified)
 * counts as signed out everywhere except /login/mfa.
 */
export async function getSession(): Promise<SessionUser | null> {
  const r = await sessionRow();
  if (!r) return null;
  if (r.mfaEnabledAt && !r.mfaVerifiedAt) return null;
  return {
    sessionId: r.sessionId,
    activeBrandId: r.activeBrandId,
    user: { id: r.id, email: r.email, name: r.name },
    mfaEnabled: Boolean(r.mfaEnabledAt),
    emailVerified: Boolean(r.emailVerifiedAt),
  };
}

export async function setActiveBrand(sessionId: string, brandId: string) {
  const db = await getDb();
  await db.update(schema.sessions).set({ activeBrandId: brandId }).where(eq(schema.sessions.id, sessionId));
}
