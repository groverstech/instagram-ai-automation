import "server-only";
import { and, eq, ne } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import { audit } from "../audit";
import { enforce } from "../ratelimit";
import type { SessionUser } from "./session";
import { checkSecondFactor, MfaEnrolmentRequired, MfaError, mfaRequiredFor } from "./mfa";

/**
 * Step-up verification (FOLLOW_UPS F3b): for people with two-step verification on, sensitive
 * actions (member invitations, role and brand-access changes, removing members, billing, connecting
 * or disconnecting social accounts) need a second factor verified in this session within the last
 * 15 minutes. The sign-in verification counts, so they rarely see an extra prompt right after
 * signing in. People without MFA aren't asked, unless MFA is required for them (owners and admins in
 * staging and production) and they haven't set it up: then the action is refused, so a password
 * alone can never carry out a sensitive action for an account that must have a second factor.
 */
export const STEP_UP_WINDOW_MS = 15 * 60 * 1000;

export class StepUpRequired extends Error {
  constructor() {
    super("Confirm it's you: enter a code from your authenticator app to continue.");
  }
}

export async function requireRecentSecondFactor(session: Pick<SessionUser, "sessionId" | "user">, now = Date.now()) {
  const db = await getDb();
  const [u] = await db.select({ on: schema.users.mfaEnabledAt }).from(schema.users).where(eq(schema.users.id, session.user.id));
  if (!u?.on) {
    if (await mfaRequiredFor(session.user.id)) throw new MfaEnrolmentRequired();
    return;
  }
  const [s] = await db.select({ at: schema.sessions.mfaVerifiedAt }).from(schema.sessions).where(and(eq(schema.sessions.id, session.sessionId), eq(schema.sessions.userId, session.user.id)));
  if (!s?.at || now - s.at.getTime() > STEP_UP_WINDOW_MS) throw new StepUpRequired();
}

/** Verify a code (app or recovery) for this session, so step-up checks pass for the next 15 minutes. */
export async function confirmStepUp(session: Pick<SessionUser, "sessionId" | "user">, code: string, now = Date.now()) {
  await enforce("login", { key: `mfa:${session.user.id}` });
  const how = await checkSecondFactor(session.user.id, code, now);
  if (!how) {
    await audit({ action: "auth.mfa_failed", outcome: "denied", actorUserId: session.user.id, targetType: "user", targetId: session.user.id, details: { during: "step_up" } });
    throw new MfaError("That code isn't right.");
  }
  const db = await getDb();
  await db.update(schema.sessions).set({ mfaVerifiedAt: new Date(now) }).where(and(eq(schema.sessions.id, session.sessionId), eq(schema.sessions.userId, session.user.id)));
  await audit({ action: "mfa.step_up", actorUserId: session.user.id, targetType: "user", targetId: session.user.id, details: { factor: how } });
  return how;
}

/** End every other session of this user (lost device, shared computer). Returns how many ended. */
export async function signOutOtherSessions(session: Pick<SessionUser, "sessionId" | "user">) {
  await requireRecentSecondFactor(session);
  const db = await getDb();
  const ended = await db.delete(schema.sessions).where(and(eq(schema.sessions.userId, session.user.id), ne(schema.sessions.id, session.sessionId))).returning({ id: schema.sessions.id });
  await audit({ action: "auth.logout_all", actorUserId: session.user.id, targetType: "user", targetId: session.user.id, details: { ended: ended.length } });
  return ended.length;
}

/** Where /account/verify may continue to: same-site paths only, never an absolute or protocol-relative URL. */
export function safeNext(next: string) {
  return /^\/(?![/\\])[\w\-./?=&%]*$/.test(next) ? next : "/dashboard";
}
