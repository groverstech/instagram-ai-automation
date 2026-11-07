import Stripe from "stripe";
import { BillingError, handleWebhook } from "@/server/billing";

export const runtime = "nodejs";

/** Stripe webhook endpoint. Register `{APP_URL}/api/billing/webhook` in the Stripe dashboard. */
export async function POST(req: Request) {
  const body = await req.text(); // raw body is required for signature verification
  try {
    const r = await handleWebhook(body, req.headers.get("stripe-signature"));
    return Response.json({ received: true, duplicate: r.duplicate });
  } catch (e) {
    if (e instanceof Stripe.errors.StripeSignatureVerificationError || e instanceof BillingError) {
      return new Response(`Webhook rejected: ${e.message}`, { status: 400 });
    }
    console.error("[billing] webhook processing failed", e);
    return new Response("Webhook processing failed", { status: 500 }); // Stripe will retry
  }
}
