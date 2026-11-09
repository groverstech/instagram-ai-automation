"use server";
import { redirect } from "next/navigation";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/server/db/client";
import { hashPassword, needsRehash, verifyDummy, verifyPassword } from "@/server/auth/password";
import { createSession, destroySession, getSession } from "@/server/auth/session";
import { audit } from "@/server/audit";
import { headers } from "next/headers";
import { enforce, RateLimitError } from "@/server/ratelimit";
import { keyedHash, sha256 } from "@/server/crypto";
import { clientIp as ipFrom } from "@/server/client-ip";

/** Client IP from the trusted proxy hop (see src/server/client-ip.ts). */
async function clientIp() {
  return ipFrom(await headers());
}

/** Brute-force protection; keys are hashed so emails/IPs never appear in the limiter table. */
async function limited(kind: "login" | "signup", ...parts: string[]): Promise<string | null> {
  try {
    for (const p of parts) await enforce("login", { key: sha256(`${kind}:${p}`) });
    return null;
  } catch (e) {
    if (e instanceof RateLimitError) return e.message;
    throw e;
  }
}

const SignUp = z.object({
  name: z.string().trim().min(1, "Enter your name"),
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  password: z.string().min(8, "Use at least 8 characters").max(256, "Use at most 256 characters"),
  workspace: z.string().trim().min(1, "Name your workspace"),
  type: z.enum(["creator", "business", "agency"]),
});

export async function signUp(_: unknown, fd: FormData): Promise<{ error?: string }> {
  const parsed = SignUp.safeParse(Object.fromEntries(fd));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const { name, email, password, workspace, type } = parsed.data;
  const ip = await clientIp();
  const blocked = await limited("signup", `ip:${ip}`);
  if (blocked) return { error: blocked };
  const db = await getDb();
  const [exists] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email));
  if (exists) return { error: "An account with this email already exists." };
  const [user] = await db.insert(schema.users).values({ name, email, passwordHash: await hashPassword(password) }).returning();

  // Accept pending invitations for this email, otherwise create the user's own workspace.
  const invites = await db
    .update(schema.workspaceMembers)
    .set({ userId: user.id, status: "active" })
    .where(and(eq(schema.workspaceMembers.invitedEmail, email), isNull(schema.workspaceMembers.userId)))
    .returning();
  let workspaceId = invites[0]?.workspaceId ?? null;
  if (!invites.length) {
    const [ws] = await db.insert(schema.workspaces).values({ name: workspace, type }).returning();
    await db.insert(schema.workspaceMembers).values({ workspaceId: ws.id, userId: user.id, role: "owner" });
    workspaceId = ws.id;
  }
  await audit({ action: "auth.signup", workspaceId, actorUserId: user.id, targetType: "user", targetId: user.id, ip, details: { acceptedInvites: invites.length } });
  await createSession(user.id);
  redirect(invites.length ? "/dashboard" : "/onboarding");
}

export async function logIn(_: unknown, fd: FormData): Promise<{ error?: string }> {
  const email = String(fd.get("email") ?? "").trim().toLowerCase();
  const password = String(fd.get("password") ?? "").slice(0, 256);
  const ip = await clientIp();
  const blocked = await limited("login", `email:${email}`, `ip:${ip}`);
  if (blocked) {
    await audit({ action: "auth.login_failed", outcome: "denied", ip, details: { reason: "rate_limited", emailHash: keyedHash(`email:${email}`) } });
    return { error: blocked };
  }
  const db = await getDb();
  const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email));
  // Same hashing work whether or not the account exists, so timing doesn't reveal registered emails.
  const ok = user ? await verifyPassword(password, user.passwordHash) : await verifyDummy(password);
  if (!user || !ok) {
    await audit({ action: "auth.login_failed", outcome: "denied", actorUserId: user?.id ?? null, ip, details: { reason: user ? "wrong_password" : "unknown_email", emailHash: keyedHash(`email:${email}`) } });
    return { error: "Email or password is incorrect." };
  }
  // Upgrade older password hashes transparently now that we know the password.
  if (needsRehash(user.passwordHash)) await db.update(schema.users).set({ passwordHash: await hashPassword(password) }).where(eq(schema.users.id, user.id));
  await audit({ action: "auth.login", actorUserId: user.id, targetType: "user", targetId: user.id, ip });
  await createSession(user.id);
  redirect("/dashboard");
}

export async function logOut() {
  const s = await getSession();
  if (s) await audit({ action: "auth.logout", actorUserId: s.user.id, targetType: "user", targetId: s.user.id });
  await destroySession();
  redirect("/login");
}
