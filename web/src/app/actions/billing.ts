"use server";
import { requireWorkspaceRole } from "@/server/auth/guard";
import { safe } from "@/server/action";
import { requireRecentSecondFactor } from "@/server/auth/step-up";
import { audit } from "@/server/audit";
import { createCheckout, createPortal, type PaidPlan } from "@/server/billing";

/** Only owners manage billing. Returns a Stripe-hosted URL; the plan changes when Stripe confirms via webhook. */
export async function startCheckout(workspaceId: string, plan: PaidPlan) {
  return safe(async () => {
    if (plan !== "growth" && plan !== "agency") throw new Error("Unknown plan.");
    const { session } = await requireWorkspaceRole(workspaceId, "owner");
    await requireRecentSecondFactor(session);
    await audit({ action: "billing.checkout_started", workspaceId, actorUserId: session.user.id, targetType: "workspace", targetId: workspaceId, details: { plan } });
    return createCheckout({ workspaceId, plan, email: session.user.email });
  });
}

export async function openBillingPortal(workspaceId: string) {
  return safe(async () => {
    const { session } = await requireWorkspaceRole(workspaceId, "owner");
    await requireRecentSecondFactor(session);
    return { url: await createPortal(workspaceId) };
  });
}
