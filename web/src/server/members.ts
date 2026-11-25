import "server-only";
import { requireRecentSecondFactor } from "./auth/step-up";
import { and, count, eq, gt, inArray, isNull, ne, or } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "./db/client";
import { AccessError, inBrandScope, requireBrandForUser, requireWorkspaceRoleForUser } from "./auth/guard";
import { setActiveBrand, type SessionUser } from "./auth/session";
import { assertCanAdd } from "./quota";
import { audit } from "./audit";
import { getPlan, listPlans } from "./credits";
import type { Role } from "@/lib/roles";
import { randomToken, sha256 } from "./crypto";
import { appUrl, sendEmail } from "./email";
import { enforce } from "./ratelimit";
import { log } from "./log";

/**
 * Workspace members, brand-scoped (client) access and brand switching. Every function takes the
 * signed-in session explicitly and authorises it here, so server actions stay thin and the rules
 * are testable without cookies.
 */

export class MemberError extends Error {}

const BrandIds = z.array(z.string().min(1).max(64)).max(200).nullable();

/** Validate a client-user brand scope: brands must belong to this workspace; scoped users can't be admins. */
export async function checkScope(workspaceId: string, role: Role, brandIds: string[] | null | undefined) {
  if (brandIds == null) return null;
  const ids = [...new Set(BrandIds.parse(brandIds) ?? [])];
  if (!ids.length) throw new MemberError("Choose at least one brand, or give access to all brands.");
  if (role === "owner" || role === "admin") throw new MemberError("Admins and owners always have access to every brand. Use the editor or viewer role for client access.");
  const db = await getDb();
  const rows = await db.select({ id: schema.brands.id }).from(schema.brands).where(and(eq(schema.brands.workspaceId, workspaceId), inArray(schema.brands.id, ids)));
  if (rows.length !== ids.length) throw new MemberError("One of those brands isn't in this workspace.");
  return ids;
}

async function memberOf(workspaceId: string, memberId: string) {
  const db = await getDb();
  const [m] = await db.select().from(schema.workspaceMembers).where(and(eq(schema.workspaceMembers.id, memberId), eq(schema.workspaceMembers.workspaceId, workspaceId)));
  if (!m) throw new MemberError("Member not found.");
  return m;
}

export const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
const INVITE_INVALID = "This invitation is invalid, has expired or was withdrawn. Ask the person who invited you to send a new one.";

/** A fresh single-use link for an invitation row (only the hash is stored), and its email. */
async function issueInvite(memberId: string, by: { id: string; name: string }) {
  const db = await getDb();
  const token = randomToken(32);
  const [m] = await db
    .update(schema.workspaceMembers)
    .set({ inviteTokenHash: sha256(token), inviteExpiresAt: new Date(Date.now() + INVITE_TTL_MS), invitedBy: by.id })
    .where(and(eq(schema.workspaceMembers.id, memberId), eq(schema.workspaceMembers.status, "invited")))
    .returning();
  if (!m?.invitedEmail) throw new MemberError("That invitation no longer exists.");
  const [ws] = await db.select({ name: schema.workspaces.name }).from(schema.workspaces).where(eq(schema.workspaces.id, m.workspaceId));
  const link = `${appUrl()}/invite?token=${encodeURIComponent(token)}`;
  let delivered = false;
  try {
    delivered = (
      await sendEmail({
        to: m.invitedEmail,
        subject: `${by.name || "A teammate"} invited you to ${ws?.name ?? "an organisation"} on BrandPilot`,
        text: `${by.name || "A teammate"} invited you to join ${ws?.name ?? "their organisation"} on BrandPilot as ${m.role === "admin" ? "an admin" : `a ${m.role}`}.\n\nAccept within 7 days:\n\n${link}\n\nSign in or create an account with this email address (${m.invitedEmail}) to accept. If you weren't expecting this, ignore it.`,
        tag: "member.invite",
      })
    ).delivered;
  } catch (e) {
    log.warn("member.invite_email_failed", { workspaceId: m.workspaceId, error: e instanceof Error ? e.message : String(e) });
  }
  return { member: m, delivered };
}

/**
 * Invite someone by email (admins, with a recent second factor). Always a pending invitation, even
 * for someone who already has an account: nobody is added to an organisation without accepting.
 * Accepted by opening the link while signed in with that address, or by verifying that address.
 */
export async function inviteMemberFor(session: SessionUser, workspaceId: string, email: string, role: Role, brandIds?: string[] | null) {
  await requireWorkspaceRoleForUser(session, workspaceId, "admin");
  await requireRecentSecondFactor(session);
  if (role === "owner") throw new MemberError("Invite as admin, then transfer ownership.");
  const scope = await checkScope(workspaceId, role, brandIds);
  const e = z.string().trim().toLowerCase().email("Enter a valid email").max(320).parse(email);
  await assertCanAdd(workspaceId, "seats");
  await enforce("invite", { workspaceId, userId: session.user.id });
  const db = await getDb();
  const [user] = await db.select().from(schema.users).where(eq(schema.users.email, e));
  const existing = await db
    .select({ id: schema.workspaceMembers.id, status: schema.workspaceMembers.status, userId: schema.workspaceMembers.userId, expires: schema.workspaceMembers.inviteExpiresAt })
    .from(schema.workspaceMembers)
    .where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), user ? or(eq(schema.workspaceMembers.userId, user.id), eq(schema.workspaceMembers.invitedEmail, e)) : eq(schema.workspaceMembers.invitedEmail, e)));
  // An expired invitation doesn't block inviting the person again (review L4): it's replaced.
  const expired = existing.filter((x) => x.status === "invited" && !x.userId && x.expires && x.expires <= new Date());
  if (existing.length > expired.length) throw new MemberError("That person is already a member or has a pending invitation. You can send the invitation again from the list.");
  if (expired.length) await db.delete(schema.workspaceMembers).where(inArray(schema.workspaceMembers.id, expired.map((x) => x.id)));
  let row: typeof schema.workspaceMembers.$inferSelect;
  try {
    [row] = await db.insert(schema.workspaceMembers).values({ workspaceId, invitedEmail: e, role, status: "invited", brandIds: scope, invitedBy: session.user.id }).returning();
  } catch (err) {
    // Two invitations at once: the unique index on pending invitations lets only one through.
    if (/wm_pending_invite_uq|unique/i.test(String((err as { cause?: Error }).cause?.message ?? (err as Error).message))) {
      throw new MemberError("That person is already a member or has a pending invitation. You can send the invitation again from the list.");
    }
    throw err;
  }
  const { member, delivered } = await issueInvite(row.id, { id: session.user.id, name: session.user.name });
  await audit({ action: "member.invite", workspaceId, actorUserId: session.user.id, targetType: "member", targetId: row.id, details: { role, scopedBrands: scope?.length ?? null, existingUser: Boolean(user), emailed: delivered } });
  return { ...member, delivered };
}

/** Send a pending invitation again: a new link (the old one stops working) and a new 7-day expiry. */
export async function resendInviteFor(session: SessionUser, workspaceId: string, memberId: string) {
  await requireWorkspaceRoleForUser(session, workspaceId, "admin");
  await requireRecentSecondFactor(session);
  const m = await memberOf(workspaceId, memberId);
  if (m.status !== "invited") throw new MemberError("This person has already joined.");
  await enforce("invite", { workspaceId, userId: session.user.id });
  const { delivered } = await issueInvite(m.id, { id: session.user.id, name: session.user.name });
  await audit({ action: "member.invite_resend", workspaceId, actorUserId: session.user.id, targetType: "member", targetId: m.id, details: { emailed: delivered } });
  return { delivered };
}

const pendingFor = (now: Date) => and(eq(schema.workspaceMembers.status, "invited"), isNull(schema.workspaceMembers.userId), or(isNull(schema.workspaceMembers.inviteExpiresAt), gt(schema.workspaceMembers.inviteExpiresAt, now)));

/** For the invitation page: what the link is for, without revealing more than the inviter would. */
export async function inviteInfo(token: string) {
  if (!token || token.length > 200) return null;
  const db = await getDb();
  const [r] = await db
    .select({ id: schema.workspaceMembers.id, email: schema.workspaceMembers.invitedEmail, role: schema.workspaceMembers.role, workspace: schema.workspaces.name })
    .from(schema.workspaceMembers)
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.workspaceMembers.workspaceId))
    .where(and(eq(schema.workspaceMembers.inviteTokenHash, sha256(token)), pendingFor(new Date())));
  return r ?? null;
}

/**
 * Accept with the link. The signed-in account's address must be the invited one; opening the link
 * proves access to that inbox, so the address also counts as verified.
 */
export async function acceptInviteFor(session: SessionUser, token: string) {
  if (!token || token.length > 200) throw new MemberError(INVITE_INVALID);
  const db = await getDb();
  const now = new Date();
  const [m] = await db.select().from(schema.workspaceMembers).where(and(eq(schema.workspaceMembers.inviteTokenHash, sha256(token)), pendingFor(now)));
  if (!m) throw new MemberError(INVITE_INVALID);
  if ((m.invitedEmail ?? "").toLowerCase() !== session.user.email.toLowerCase()) throw new MemberError(`This invitation is for a different email address. Sign in with that address to accept it.`);
  // Already a member through another row: the invitation is withdrawn. The check excludes this
  // invitation's own row, and the delete only removes it while still pending: a concurrent
  // acceptance that just turned it into the membership must not be deleted (found by the
  // concurrent-acceptance test).
  const [already] = await db
    .select({ id: schema.workspaceMembers.id })
    .from(schema.workspaceMembers)
    .where(and(eq(schema.workspaceMembers.workspaceId, m.workspaceId), eq(schema.workspaceMembers.userId, session.user.id), ne(schema.workspaceMembers.id, m.id)));
  if (already) {
    await db.delete(schema.workspaceMembers).where(and(eq(schema.workspaceMembers.id, m.id), eq(schema.workspaceMembers.status, "invited"), isNull(schema.workspaceMembers.userId)));
    return { workspaceId: m.workspaceId, alreadyMember: true };
  }
  const [ok] = await db
    .update(schema.workspaceMembers)
    .set({ userId: session.user.id, status: "active", inviteTokenHash: null, inviteExpiresAt: null })
    .where(and(eq(schema.workspaceMembers.id, m.id), eq(schema.workspaceMembers.status, "invited"), isNull(schema.workspaceMembers.userId)))
    .returning();
  if (!ok) throw new MemberError(INVITE_INVALID);
  await db.update(schema.users).set({ emailVerifiedAt: now }).where(and(eq(schema.users.id, session.user.id), isNull(schema.users.emailVerifiedAt)));
  await audit({ action: "member.invite_accept", workspaceId: m.workspaceId, actorUserId: session.user.id, targetType: "member", targetId: m.id, details: { role: m.role, via: "link" } });
  return { workspaceId: m.workspaceId, alreadyMember: false };
}

/** After an address is verified: accept every unexpired invitation waiting for it. */
export async function acceptInvitesForVerifiedEmail(userId: string, email: string) {
  const db = await getDb();
  const e = email.trim().toLowerCase();
  const pending = await db.select().from(schema.workspaceMembers).where(and(eq(schema.workspaceMembers.invitedEmail, e), pendingFor(new Date())));
  let n = 0;
  for (const m of pending) {
    const [already] = await db.select({ id: schema.workspaceMembers.id }).from(schema.workspaceMembers).where(and(eq(schema.workspaceMembers.workspaceId, m.workspaceId), eq(schema.workspaceMembers.userId, userId), ne(schema.workspaceMembers.id, m.id)));
    if (already) continue;
    const [ok] = await db
      .update(schema.workspaceMembers)
      .set({ userId, status: "active", inviteTokenHash: null, inviteExpiresAt: null })
      .where(and(eq(schema.workspaceMembers.id, m.id), isNull(schema.workspaceMembers.userId)))
      .returning({ id: schema.workspaceMembers.id });
    if (!ok) continue;
    n++;
    await audit({ action: "member.invite_accept", workspaceId: m.workspaceId, actorUserId: userId, targetType: "member", targetId: m.id, details: { role: m.role, via: "verified_email" } });
  }
  return n;
}

export async function changeRoleFor(session: SessionUser, workspaceId: string, memberId: string, role: Role) {
  const { role: mine } = await requireWorkspaceRoleForUser(session, workspaceId, "admin");
  await requireRecentSecondFactor(session);
  if (role === "owner" && mine !== "owner") throw new MemberError("Only the owner can grant ownership.");
  const m = await memberOf(workspaceId, memberId);
  if (Array.isArray(m.brandIds) && (role === "owner" || role === "admin")) throw new MemberError("This member only has access to specific brands. Give them access to all brands first.");
  const db = await getDb();
  if (m.role === "owner" && role !== "owner") {
    const [{ n }] = await db.select({ n: count() }).from(schema.workspaceMembers).where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), eq(schema.workspaceMembers.role, "owner")));
    if (n <= 1) throw new MemberError("A workspace needs at least one owner.");
  }
  await db.update(schema.workspaceMembers).set({ role }).where(eq(schema.workspaceMembers.id, memberId));
  await audit({ action: "member.role_change", workspaceId, actorUserId: session.user.id, targetType: "member", targetId: memberId, details: { from: m.role, to: role } });
}

/** Limit a member to specific brands (client access), or pass null for every brand. */
export async function setMemberBrandsFor(session: SessionUser, workspaceId: string, memberId: string, brandIds: string[] | null) {
  await requireWorkspaceRoleForUser(session, workspaceId, "admin");
  await requireRecentSecondFactor(session);
  const m = await memberOf(workspaceId, memberId);
  if (m.userId === session.user.id) throw new MemberError("You can't change your own brand access.");
  const scope = await checkScope(workspaceId, m.role, brandIds);
  const db = await getDb();
  await db.update(schema.workspaceMembers).set({ brandIds: scope }).where(eq(schema.workspaceMembers.id, memberId));
  await audit({ action: "member.brand_scope_change", workspaceId, actorUserId: session.user.id, targetType: "member", targetId: memberId, details: { from: m.brandIds, to: scope } });
  // Sessions whose active brand is no longer allowed fall back to an allowed brand on next load
  // (requireActiveBrand). Clear it now so no request keeps using a revoked brand.
  if (scope && m.userId) {
    const sessions = await db.select({ id: schema.sessions.id, active: schema.sessions.activeBrandId }).from(schema.sessions).where(eq(schema.sessions.userId, m.userId));
    for (const s of sessions) if (s.active && !scope.includes(s.active)) await db.update(schema.sessions).set({ activeBrandId: null }).where(eq(schema.sessions.id, s.id));
  }
  return scope;
}

export async function removeMemberFor(session: SessionUser, workspaceId: string, memberId: string) {
  await requireWorkspaceRoleForUser(session, workspaceId, "admin");
  await requireRecentSecondFactor(session);
  const m = await memberOf(workspaceId, memberId);
  if (m.role === "owner") throw new MemberError("Transfer ownership before removing the owner.");
  if (m.userId === session.user.id) throw new MemberError("You can't remove yourself.");
  const db = await getDb();
  await db.delete(schema.workspaceMembers).where(eq(schema.workspaceMembers.id, memberId));
  // Withdrawing a pending invitation: its link stops working with the row.
  await audit({ action: m.status === "invited" ? "member.invite_revoke" : "member.remove", workspaceId, actorUserId: session.user.id, targetType: "member", targetId: memberId, details: { role: m.role, userId: m.userId } });
}

/** Switch the session's active brand. Only brands the user may access (workspace + brand scope). */
export async function switchBrandFor(session: SessionUser, brandId: string) {
  const access = await requireBrandForUser(session, z.string().min(1).max(64).parse(brandId), "viewer");
  await setActiveBrand(session.sessionId, brandId);
  return access;
}

export type BrandRow = { id: string; name: string; createdAt: Date; active: boolean; colors: string[]; access: { all: number; scoped: number } };
export type MemberRow = { id: string; role: Role; brandIds: string[] | null; status: string; invitedEmail: string | null; userId: string | null; name: string | null; email: string | null; inviteExpiresAt: Date | null };

/**
 * Everything the Settings page shows for one workspace, already filtered for the viewer:
 * brand-scoped (client) members see only their brands and their own membership.
 */
export async function workspaceSettingsFor(session: SessionUser, workspaceId: string, activeBrandId: string) {
  const { role, brandIds: myScope } = await requireWorkspaceRoleForUser(session, workspaceId, "viewer");
  const db = await getDb();
  const [ws] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
  if (!ws) throw new AccessError();
  const allMembers: MemberRow[] = await db
    .select({ id: schema.workspaceMembers.id, role: schema.workspaceMembers.role, brandIds: schema.workspaceMembers.brandIds, status: schema.workspaceMembers.status, invitedEmail: schema.workspaceMembers.invitedEmail, userId: schema.workspaceMembers.userId, name: schema.users.name, email: schema.users.email, inviteExpiresAt: schema.workspaceMembers.inviteExpiresAt })
    .from(schema.workspaceMembers)
    .leftJoin(schema.users, eq(schema.users.id, schema.workspaceMembers.userId))
    .where(eq(schema.workspaceMembers.workspaceId, workspaceId));
  const allBrands = await db.select({ id: schema.brands.id, name: schema.brands.name, createdAt: schema.brands.createdAt, colors: schema.brands.colors }).from(schema.brands).where(eq(schema.brands.workspaceId, workspaceId));
  const scoped = Array.isArray(myScope);
  const brands: BrandRow[] = allBrands
    .filter((b) => inBrandScope(myScope, b.id))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((b) => ({
      ...b,
      active: b.id === activeBrandId,
      access: scoped ? { all: 0, scoped: 0 } : { all: allMembers.filter((m) => !m.brandIds).length, scoped: allMembers.filter((m) => m.brandIds?.includes(b.id)).length },
    }));
  const members = scoped ? allMembers.filter((m) => m.userId === session.user.id) : allMembers;
  const [plan, plans] = await Promise.all([getPlan(ws.plan), listPlans()]);
  return { workspace: ws, role, scoped, brands, members, plan, plans, brandLimit: plan.limits.brands, canAddBrand: !scoped && (role === "owner" || role === "admin") && allBrands.length < plan.limits.brands };
}
