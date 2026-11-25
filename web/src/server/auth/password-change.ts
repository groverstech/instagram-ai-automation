import "server-only";
import { and, eq, ne } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import { audit } from "../audit";
import { sha256 } from "../crypto";
import { enforce } from "../ratelimit";
import { hashPassword, verifyPassword } from "./password";
import { notifyAccountChange } from "./notify";
import type { SessionUser } from "./session";

/** A refusal whose message is safe to show. */
export class PasswordChangeError extends Error {}

/**
 * Change the password while signed in (ASVS 2.1.5): the current password is required, attempts
 * are rate-limited per account like sign-in, every other session is signed out, the change is
 * audited, and the account holder is told by email. The new password follows the sign-up rules.
 */
export async function changePassword(session: Pick<SessionUser, "sessionId" | "user">, current: string, next: string, ip: string | null = null) {
  await enforce("login", { key: sha256(`password-change:${session.user.id}`) });
  if (next.length < 8) throw new PasswordChangeError("Use at least 8 characters for the new password.");
  if (next.length > 256) throw new PasswordChangeError("Use at most 256 characters for the new password.");
  if (next === current) throw new PasswordChangeError("The new password must be different from the current one.");
  const db = await getDb();
  const [u] = await db.select({ hash: schema.users.passwordHash }).from(schema.users).where(eq(schema.users.id, session.user.id));
  if (!u || !(await verifyPassword(current, u.hash))) {
    await audit({ action: "auth.password_change_failed", actorUserId: session.user.id, targetType: "user", targetId: session.user.id, ip, outcome: "failure" });
    throw new PasswordChangeError("The current password is incorrect.");
  }
  await db.update(schema.users).set({ passwordHash: await hashPassword(next) }).where(eq(schema.users.id, session.user.id));
  const ended = await db.delete(schema.sessions).where(and(eq(schema.sessions.userId, session.user.id), ne(schema.sessions.id, session.sessionId))).returning({ id: schema.sessions.id });
  await audit({ action: "auth.password_changed", actorUserId: session.user.id, targetType: "user", targetId: session.user.id, ip, details: { otherSessionsEnded: ended.length } });
  await notifyAccountChange(session.user.id, "password_changed");
  return { otherSessionsEnded: ended.length };
}
