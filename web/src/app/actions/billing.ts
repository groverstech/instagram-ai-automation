"use server";
import { requireWorkspaceRole } from "@/server/auth/guard";
import { safe } from "@/server/action";
import { createCheckout, createPortal, type PaidPlan } from "@/server/billing";

/** Only owners manage billing. Returns a Stripe-hosted URL; the plan changes when Stripe confirms via webhook. */
export async function startCheckout(workspaceId: string, plan: PaidPlan) {
  return safe(async () => {
    if (plan !== "growth" && plan !== "agency") throw new Error("Unknown plan.");
    const { session } = await requireWorkspaceRole(workspaceId, "owner");
    return createCheckout({ workspaceId, plan, email: session.user.email });
  });
}

export async function openBillingPortal(workspaceId: string) {
  return safe(async () => {
    await requireWorkspaceRole(workspaceId, "owner");
    return { url: await createPortal(workspaceId) };
  });
}
