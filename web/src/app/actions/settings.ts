"use server";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db/client";
import { AccessError, requireWorkspaceRole } from "@/server/auth/guard";
import { destroySession, getSession } from "@/server/auth/session";
import { deleteAccountFor, deleteBrandFor, deleteWorkspaceFor } from "@/server/deletion";
import { changeRoleFor, inviteMemberFor, removeMemberFor, setMemberBrandsFor } from "@/server/members";
import { safe } from "@/server/action";
import { audit } from "@/server/audit";
import type { Role } from "@/lib/roles";

export async function updateWorkspace(workspaceId: string, input: { name: string; type: "creator" | "business" | "agency" }) {
  return safe(async () => {
    const { session } = await requireWorkspaceRole(workspaceId, "admin");
    const db = await getDb();
    await db.update(schema.workspaces).set({ name: input.name.trim() || "Workspace", type: input.type }).where(eq(schema.workspaces.id, workspaceId));
    await audit({ action: "workspace.update", workspaceId, actorUserId: session.user.id, targetType: "workspace", targetId: workspaceId, details: { type: input.type } });
    revalidatePath("/settings");
  });
}

/** Delete a brand and everything in it. Owners and admins with access to every brand; the brand's name confirms. */
export async function deleteBrand(brandId: string, confirmName: string) {
  return safe(async () => {
    await deleteBrandFor(await me(), brandId, confirmName);
    revalidatePath("/", "layout");
  });
}

/** Delete an organisation with all its brands. Owners only; their password confirms. */
export async function deleteWorkspace(workspaceId: string, password: string) {
  return safe(async () => {
    await deleteWorkspaceFor(await me(), workspaceId, password);
    revalidatePath("/", "layout");
  });
}

/** Delete your own account (and organisations only you belong to). Your password confirms; you're signed out. */
export async function deleteAccount(password: string) {
  return safe(async () => {
    await deleteAccountFor(await me(), password);
    await destroySession();
  });
}

async function me() {
  const session = await getSession();
  if (!session) throw new AccessError("Not signed in.");
  return session;
}

export async function inviteMember(workspaceId: string, email: string, role: Role, brandIds?: string[] | null) {
  return safe(async () => {
    await inviteMemberFor(await me(), workspaceId, email, role, brandIds);
    revalidatePath("/settings");
  });
}

export async function changeRole(workspaceId: string, memberId: string, role: Role) {
  return safe(async () => {
    await changeRoleFor(await me(), workspaceId, memberId, role);
    revalidatePath("/settings");
  });
}

/** Limit a member to specific brands (client access), or pass null for every brand. */
export async function setMemberBrands(workspaceId: string, memberId: string, brandIds: string[] | null) {
  return safe(async () => {
    await setMemberBrandsFor(await me(), workspaceId, memberId, brandIds);
    revalidatePath("/settings");
  });
}

export async function removeMember(workspaceId: string, memberId: string) {
  return safe(async () => {
    await removeMemberFor(await me(), workspaceId, memberId);
    revalidatePath("/settings");
  });
}

/** Security log export: checks access and step-up first, then the client downloads /api/audit/export. */
export async function prepareAuditExport(workspaceId: string) {
  return safe(async () => {
    const { auditExportReadyFor } = await import("@/server/audit");
    await auditExportReadyFor(await me(), workspaceId);
  });
}

/** Organisation data export: owner and step-up checks first, then the client downloads /api/workspace/export. */
export async function prepareWorkspaceExport(workspaceId: string) {
  return safe(async () => {
    const { exportReadyFor } = await import("@/server/tenant-export");
    await exportReadyFor(await me(), workspaceId);
  });
}
