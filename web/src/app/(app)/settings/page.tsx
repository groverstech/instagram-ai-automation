import { eq } from "drizzle-orm";
import { requireActiveBrand } from "@/server/auth/guard";
import { getDb, schema } from "@/server/db/client";
import { usage } from "@/server/quota";
import { aiStatus } from "@/server/ai/llm";
import { imageStatus } from "@/server/ai/image";
import { SettingsView } from "@/components/settings/view";
import { billingStatus } from "@/server/billing";

export default async function Page({ searchParams }: { searchParams: Promise<{ billing?: string }> }) {
  const { billing } = await searchParams;
  const { brand, role, session } = await requireActiveBrand();
  const db = await getDb();
  const [ws] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, brand.workspaceId));
  const allMembers = await db
    .select({ id: schema.workspaceMembers.id, role: schema.workspaceMembers.role, brandIds: schema.workspaceMembers.brandIds, status: schema.workspaceMembers.status, invitedEmail: schema.workspaceMembers.invitedEmail, userId: schema.workspaceMembers.userId, name: schema.users.name, email: schema.users.email })
    .from(schema.workspaceMembers)
    .leftJoin(schema.users, eq(schema.users.id, schema.workspaceMembers.userId))
    .where(eq(schema.workspaceMembers.workspaceId, ws.id));
  const allBrands = await db.select({ id: schema.brands.id, name: schema.brands.name, createdAt: schema.brands.createdAt }).from(schema.brands).where(eq(schema.brands.workspaceId, ws.id));
  // Client users (brand-scoped) only see their own brands and their own membership.
  const myScope = allMembers.find((m) => m.userId === session.user.id)?.brandIds ?? null;
  const scoped = Array.isArray(myScope);
  const brands = scoped ? allBrands.filter((b) => myScope.includes(b.id)) : allBrands;
  const members = scoped ? allMembers.filter((m) => m.userId === session.user.id) : allMembers;
  return (
    <SettingsView
      role={role}
      me={session.user.id}
      scoped={scoped}
      workspace={{ id: ws.id, name: ws.name, type: ws.type, plan: ws.plan }}
      billing={{
        ...billingStatus(),
        notice: billing === "success" || billing === "cancelled" ? billing : undefined,
        hasCustomer: Boolean(ws.stripeCustomerId),
        status: ws.subscriptionStatus,
        currentPeriodEnd: ws.currentPeriodEnd,
        cancelAtPeriodEnd: ws.cancelAtPeriodEnd,
      }}
      usage={await usage(ws.id)}
      members={members}
      brands={brands}
      integrations={{ ai: aiStatus(), image: imageStatus(), embeddings: process.env.VOYAGE_API_KEY ? "Voyage AI (voyage-3.5-lite)" : "Local hashing (set VOYAGE_API_KEY for semantic embeddings)", database: process.env.DATABASE_URL ? "PostgreSQL" : "Embedded PGlite (development)" }}
    />
  );
}
