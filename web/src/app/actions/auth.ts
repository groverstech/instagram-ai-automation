"use server";
import { redirect } from "next/navigation";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/server/db/client";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import { createSession, destroySession } from "@/server/auth/session";

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
