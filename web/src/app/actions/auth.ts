"use server";
import { redirect } from "next/navigation";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/server/db/client";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import { createSession, destroySession } from "@/server/auth/session";
import { headers } from "next/headers";
import { enforce, RateLimitError } from "@/server/ratelimit";
import { sha256 } from "@/server/crypto";

/** Client IP from the platform's proxy headers (first hop). */
async function clientIp() {
  const h = await headers();
  return (h.get("x-forwarded-for")?.split(",")[0] ?? h.get("x-real-ip") ?? "unknown").trim();
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
  password: z.string().min(8, "Use at least 8 characters"),
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
  if (!invites.length) {
    const [ws] = await db.insert(schema.workspaces).values({ name: workspace, type }).returning();
    await db.insert(schema.workspaceMembers).values({ workspaceId: ws.id, userId: user.id, role: "owner" });
  }
  await createSession(user.id);
  redirect(invites.length ? "/dashboard" : "/onboarding");
}

export async function logIn(_: unknown, fd: FormData): Promise<{ error?: string }> {
  const email = String(fd.get("email") ?? "").trim().toLowerCase();
  const password = String(fd.get("password") ?? "");
  const blocked = await limited("login", `email:${email}`, `ip:${await clientIp()}`);
  if (blocked) return { error: blocked };
  const db = await getDb();
  const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email));
  if (!user || !(await verifyPassword(password, user.passwordHash))) return { error: "Email or password is incorrect." };
  await createSession(user.id);
  redirect("/dashboard");
}

export async function logOut() {
  await destroySession();
  redirect("/login");
}
