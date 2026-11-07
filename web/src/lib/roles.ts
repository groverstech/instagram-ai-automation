export type Role = "owner" | "admin" | "editor" | "viewer";

const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

export function roleAtLeast(role: Role, min: Role): boolean {
  return RANK[role] >= RANK[min];
}

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  owner: "Full control, including billing and members",
  admin: "Approve & publish content, connect accounts, manage brands",
  editor: "Create and edit drafts, run AI agents",
  viewer: "Read-only access",
};
