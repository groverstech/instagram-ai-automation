import "server-only";
import { cookies } from "next/headers";
import { and, eq, gt } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import { randomToken, sha256 } from "../crypto";

const COOKIE = "bp_session";
const TTL_MS = 1000 * 60 * 60 * 24 * 30;

export async function createSession(userId: string) {
  const db = await getDb();
  const token = randomToken();
  const expiresAt = new Date(Date.now() + TTL_MS);
  await db.insert(schema.sessions).values({ id: sha256(token), userId, expiresAt });
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
};

export async function getSession(): Promise<SessionUser | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  const db = await getDb();
  const rows = await db
    .select({
      sessionId: schema.sessions.id,
      activeBrandId: schema.sessions.activeBrandId,
      id: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
    })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(and(eq(schema.sessions.id, sha256(token)), gt(schema.sessions.expiresAt, new Date())))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    sessionId: r.sessionId,
    activeBrandId: r.activeBrandId,
    user: { id: r.id, email: r.email, name: r.name },
  };
}

export async function setActiveBrand(sessionId: string, brandId: string) {
  const db = await getDb();
  await db.update(schema.sessions).set({ activeBrandId: brandId }).where(eq(schema.sessions.id, sessionId));
}
