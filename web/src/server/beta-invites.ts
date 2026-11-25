import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { getDb, schema } from "./db/client";
import { audit } from "./audit";
import { isStrict } from "./config";

/**
 * Invitation-only sign-up (private beta). SIGNUP_MODE:
 *   invite_only  an account can be created only for an email that has a pending organisation
 *                invitation (Settings → Members) or is on the beta list (`npm run beta:invite`).
 *                The default in staging and production.
 *   open         anyone can sign up. The default in development, demo and tests.
 * An unrecognised value is a configuration error (config.ts) and is treated as invite_only.
 *
 * The check runs before sign-up looks the email up, and refuses every uninvited email with the same
 * message, so it can't be used to learn whether an address has an account.
 */
type Env = Record<string, string | undefined>;
export type SignupMode = "invite_only" | "open";

export function signupMode(env: Env = process.env): SignupMode {
  const v = (env.SIGNUP_MODE ?? "").trim().toLowerCase();
  if (v === "open") return "open";
  if (v === "invite_only") return "invite_only";
  if (v) return "invite_only"; // unrecognised: fail closed
  return isStrict(env) ? "invite_only" : "open";
}

export const NOT_INVITED = "BrandPilot is in private beta, and sign-up is by invitation. If you were invited, use the email address the invitation was sent to.";

const norm = (email: string) => email.trim().toLowerCase();

/** May this email create an account? Always true in open mode. */
export async function mayCreateAccount(email: string, env: Env = process.env): Promise<boolean> {
  if (signupMode(env) === "open") return true;
  const e = norm(email);
  const db = await getDb();
  const [beta] = await db.select({ email: schema.betaInvites.email }).from(schema.betaInvites).where(and(eq(schema.betaInvites.email, e), isNull(schema.betaInvites.usedAt)));
  if (beta) return true;
  const [member] = await db
    .select({ id: schema.workspaceMembers.id })
    .from(schema.workspaceMembers)
    .where(and(eq(schema.workspaceMembers.invitedEmail, e), isNull(schema.workspaceMembers.userId), eq(schema.workspaceMembers.status, "invited")))
    .limit(1);
  return Boolean(member);
}

/** After a successful sign-up: the beta invitation (if any) is used. */
export async function markInviteUsed(email: string) {
  const db = await getDb();
  await db.update(schema.betaInvites).set({ usedAt: new Date() }).where(and(eq(schema.betaInvites.email, norm(email)), isNull(schema.betaInvites.usedAt)));
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class BetaInviteError extends Error {}

/** Operators only (CLI). Re-inviting an email that used its invitation is refused: it has an account. */
export async function addBetaInvite(email: string, by: string, note?: string) {
  const e = norm(email);
  if (!EMAIL.test(e) || e.length > 320) throw new BetaInviteError(`"${email}" isn't an email address.`);
  if (!by.trim()) throw new BetaInviteError("--by is required.");
  const db = await getDb();
  const [existing] = await db.select().from(schema.betaInvites).where(eq(schema.betaInvites.email, e));
  if (existing?.usedAt) throw new BetaInviteError(`${e} already used an invitation.`);
  await db
    .insert(schema.betaInvites)
    .values({ email: e, invitedBy: by.trim(), note: note?.trim().slice(0, 300) || null })
    .onConflictDoUpdate({ target: schema.betaInvites.email, set: { invitedBy: by.trim(), note: note?.trim().slice(0, 300) || null, createdAt: new Date() } });
  // The email itself isn't put in the Security log; the list is the record.
  await audit({ action: "beta.invite_add", actorType: "system", targetType: "beta_invite", details: { by: by.trim() } });
  return e;
}

export async function revokeBetaInvite(email: string, by: string) {
  if (!by.trim()) throw new BetaInviteError("--by is required.");
  const db = await getDb();
  const gone = await db.delete(schema.betaInvites).where(and(eq(schema.betaInvites.email, norm(email)), isNull(schema.betaInvites.usedAt))).returning();
  if (gone.length) await audit({ action: "beta.invite_revoke", actorType: "system", targetType: "beta_invite", details: { by: by.trim() } });
  return gone.length > 0;
}

export async function listBetaInvites() {
  const db = await getDb();
  return db.select().from(schema.betaInvites).orderBy(schema.betaInvites.createdAt);
}
