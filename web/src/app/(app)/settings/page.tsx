import { requireActiveBrand } from "@/server/auth/guard";
import { workspaceSettingsFor } from "@/server/members";
import { usage } from "@/server/quota";
import { aiStatus } from "@/server/ai/llm";
import { imageStatus } from "@/server/ai/image";
import { SettingsView } from "@/components/settings/view";
import { billingStatus } from "@/server/billing";

export default async function Page({ searchParams }: { searchParams: Promise<{ billing?: string }> }) {
  const { billing } = await searchParams;
  const { brand, role, session } = await requireActiveBrand();
  const view = await workspaceSettingsFor(session, brand.workspaceId, brand.id);
  const ws = view.workspace;
  return (
    <SettingsView
      role={role}
      me={session.user.id}
      scoped={view.scoped}
      brandLimit={view.brandLimit}
      canAddBrand={view.canAddBrand}
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
      members={view.members}
      brands={view.brands}
      integrations={{ ai: aiStatus(), image: imageStatus(), embeddings: process.env.VOYAGE_API_KEY ? "Voyage AI (voyage-3.5-lite)" : "Local hashing (set VOYAGE_API_KEY for semantic embeddings)", database: process.env.DATABASE_URL ? "PostgreSQL" : "Embedded PGlite (development)" }}
    />
  );
}
