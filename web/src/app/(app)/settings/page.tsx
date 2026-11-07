import { eq } from "drizzle-orm";
import { requireActiveBrand } from "@/server/auth/guard";
import { getDb, schema } from "@/server/db/client";
import { usage } from "@/server/quota";
import { aiStatus } from "@/server/ai/llm";
import { imageStatus } from "@/server/ai/image";
import { SettingsView } from "@/components/settings/view";

export default async function Page() {
  const { brand, role, session } = await requireActiveBrand();
  const db = await getDb();
  const [ws] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, brand.workspaceId));
  const members = await db
    .select({ id: schema.workspaceMembers.id, role: schema.workspaceMembers.role, status: schema.workspaceMembers.status, invitedEmail: schema.workspaceMembers.invitedEmail, userId: schema.workspaceMembers.userId, name: schema.users.name, email: schema.users.email })
    .from(schema.workspaceMembers)
    .leftJoin(schema.users, eq(schema.users.id, schema.workspaceMembers.userId))
    .where(eq(schema.workspaceMembers.workspaceId, ws.id));
  const brands = await db.select({ id: schema.brands.id, name: schema.brands.name, createdAt: schema.brands.createdAt }).from(schema.brands).where(eq(schema.brands.workspaceId, ws.id));
  return (
    <SettingsView
      role={role}
      me={session.user.id}
      workspace={{ id: ws.id, name: ws.name, type: ws.type, plan: ws.plan }}
      usage={await usage(ws.id)}
      members={members}
      brands={brands}
      integrations={{ ai: aiStatus(), image: imageStatus(), embeddings: process.env.VOYAGE_API_KEY ? "Voyage AI (voyage-3.5-lite)" : "Local hashing (set VOYAGE_API_KEY for semantic embeddings)", database: process.env.DATABASE_URL ? "PostgreSQL" : "Embedded PGlite (development)" }}
    />
  );
}
