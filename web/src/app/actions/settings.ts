"use server";
import { revalidatePath } from "next/cache";
import { and, count, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/server/db/client";
import { requireWorkspaceRole } from "@/server/auth/guard";
import { safe } from "@/server/action";
import { assertCanAdd } from "@/server/quota";
import type { Role } from "@/lib/roles";

export async function updateWorkspace(workspaceId: string, input: { name: string; type: "creator" | "business" | "agency" }) {
  return safe(async () => {
    await requireWorkspaceRole(workspaceId, "admin");
    const db = await getDb();
    await db.update(schema.workspaces).set({ name: input.name.trim() || "Workspace", type: input.type }).where(eq(schema.workspaces.id, workspaceId));
    revalidatePath("/settings");
  });
}

export async function inviteMember(workspaceId: string, email: string, role: Role) {
  return safe(async () => {
    await requireWorkspaceRole(workspaceId, "admin");
    if (role === "owner") throw new Error("Invite as admin, then transfer ownership.");
    const e = z.string().trim().toLowerCase().email("Enter a valid email").parse(email);
    await assertCanAdd(workspaceId, "seats");
    const db = await getDb();
    const [user] = await db.select().from(schema.users).where(eq(schema.users.email, e));
    if (user) {
      const [exists] = await db.select().from(schema.workspaceMembers).where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), eq(schema.workspaceMembers.userId, user.id)));
      if (exists) throw new Error("That person is already a member.");
      await db.insert(schema.workspaceMembers).values({ workspaceId, userId: user.id, role, status: "active", invitedEmail: e });
    } else {
      // Pending until they sign up with this email. (Email delivery is a Phase 8 integration.)
      await db.insert(schema.workspaceMembers).values({ workspaceId, invitedEmail: e, role, status: "invited" });
    }
    revalidatePath("/settings");
  });
}

export async function changeRole(workspaceId: string, memberId: string, role: Role) {
  return safe(async () => {
    const { role: mine } = await requireWorkspaceRole(workspaceId, "admin");
    if (role === "owner" && mine !== "owner") throw new Error("Only the owner can grant ownership.");
    const db = await getDb();
    const [m] = await db.select().from(schema.workspaceMembers).where(and(eq(schema.workspaceMembers.id, memberId), eq(schema.workspaceMembers.workspaceId, workspaceId)));
    if (!m) throw new Error("Member not found");
    if (m.role === "owner") {
      const [{ n }] = await db.select({ n: count() }).from(schema.workspaceMembers).where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), eq(schema.workspaceMembers.role, "owner")));
      if (n <= 1) throw new Error("A workspace needs at least one owner.");
    }
    await db.update(schema.workspaceMembers).set({ role }).where(eq(schema.workspaceMembers.id, memberId));
    revalidatePath("/settings");
  });
}

export async function removeMember(workspaceId: string, memberId: string) {
  return safe(async () => {
    const { session } = await requireWorkspaceRole(workspaceId, "admin");
    const db = await getDb();
    const [m] = await db.select().from(schema.workspaceMembers).where(and(eq(schema.workspaceMembers.id, memberId), eq(schema.workspaceMembers.workspaceId, workspaceId)));
    if (!m) return;
    if (m.role === "owner") throw new Error("Transfer ownership before removing the owner.");
    if (m.userId === session.user.id) throw new Error("You can't remove yourself.");
    await db.delete(schema.workspaceMembers).where(eq(schema.workspaceMembers.id, memberId));
    revalidatePath("/settings");
  });
}
