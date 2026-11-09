import { requireActiveBrand } from "@/server/auth/guard";
import { workspaceSettingsFor } from "@/server/members";
import { usage } from "@/server/quota";
import { aiStatus } from "@/server/ai/llm";
import { imageStatus } from "@/server/ai/image";
import { SettingsView } from "@/components/settings/view";
import { billingStatus } from "@/server/billing";
import { auditTrailFor } from "@/server/audit";
import { roleAtLeast } from "@/lib/roles";

export default async function Page({ searchParams }: { searchParams: Promise<{ billing?: string }> }) {
  const { billing } = await searchParams;
  const { brand, role, session } = await requireActiveBrand();
  const view = await workspaceSettingsFor(session, brand.workspaceId, brand.id);
  const ws = view.workspace;
  // Security log: owners and admins only. auditTrailFor re-checks the membership on the server and
  // limits the events to the viewer's brand scope.
  const auditLog = roleAtLeast(role, "admin") ? await auditTrailFor(session, ws.id) : null;
  return (
    <SettingsView
      role={role}
      me={session.user.id}
      scoped={view.scoped}
      brandLimit={view.brandLimit}
      canAddBrand={view.canAddBrand}
      workspace={{ id: ws.id, name: ws.name, type: ws.type, plan: ws.plan }}
      // Organisation-wide data (usage across all brands, billing, infrastructure) is never sent to
      // brand-scoped client users: it would reveal brands and activity outside their access.
      billing={view.scoped ? null : {
        ...billingStatus(),
        notice: billing === "success" || billing === "cancelled" ? billing : undefined,
        hasCustomer: Boolean(ws.stripeCustomerId),
        status: ws.subscriptionStatus,
        currentPeriodEnd: ws.currentPeriodEnd,
        cancelAtPeriodEnd: ws.cancelAtPeriodEnd,
      }}
      usage={view.scoped ? null : await usage(ws.id)}
      auditLog={auditLog}
      members={view.members}
      brands={view.brands}
      integrations={view.scoped ? null : { ai: aiStatus(), image: imageStatus(), embeddings: process.env.VOYAGE_API_KEY ? "Voyage AI (voyage-3.5-lite)" : "Local hashing (set VOYAGE_API_KEY for semantic embeddings)", database: process.env.DATABASE_URL ? "PostgreSQL" : "Embedded PGlite (development)" }}
    />
  );
}
