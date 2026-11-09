import "server-only";
import { audit } from "./audit";
import Stripe from "stripe";
import { eq } from "drizzle-orm";
import { getDb, schema } from "./db/client";
import { appUrl } from "./social/service";
import type { PlanId } from "@/lib/plans";

/**
 * Stripe billing.
 *
 * Rules:
 * - The workspace plan is changed ONLY by verified webhooks (signature checked against
 *   STRIPE_WEBHOOK_SECRET). Checkout success redirects never grant a plan.
 * - Events are processed at most once (stripe_events table). Subscription events re-read
 *   the subscription from Stripe, so out-of-order delivery can't apply stale state.
 * - Paid plans map to prices via STRIPE_PRICE_GROWTH / STRIPE_PRICE_AGENCY.
 */

export class BillingError extends Error {}

let client: Stripe | null = null;
export function stripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new BillingError("Billing isn't configured. Set STRIPE_SECRET_KEY on the server.");
  client ??= new Stripe(key);
  return client;
}

export type PaidPlan = Exclude<PlanId, "starter">;

export function priceFor(plan: PaidPlan): string | undefined {
  return plan === "growth" ? process.env.STRIPE_PRICE_GROWTH : process.env.STRIPE_PRICE_AGENCY;
}

export function planForPrice(priceId: string | undefined | null): PaidPlan | null {
  if (!priceId) return null;
  if (priceId === process.env.STRIPE_PRICE_GROWTH) return "growth";
  if (priceId === process.env.STRIPE_PRICE_AGENCY) return "agency";
  return null;
}

export function billingStatus() {
  return {
    configured: Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET),
    prices: { growth: Boolean(process.env.STRIPE_PRICE_GROWTH), agency: Boolean(process.env.STRIPE_PRICE_AGENCY) },
  };
}

/** Statuses that keep paid features. past_due keeps access while Stripe retries the payment. */
const ENTITLED = new Set<Stripe.Subscription.Status>(["active", "trialing", "past_due"]);

async function workspace(workspaceId: string) {
  const db = await getDb();
  const [ws] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
  if (!ws) throw new BillingError("Workspace not found.");
  return ws;
}

async function ensureCustomer(workspaceId: string, email: string) {
  const ws = await workspace(workspaceId);
  if (ws.stripeCustomerId) return ws.stripeCustomerId;
  const customer = await stripe().customers.create(
    { email, name: ws.name, metadata: { workspaceId } },
    { idempotencyKey: `customer-${workspaceId}` },
  );
  const db = await getDb();
  await db.update(schema.workspaces).set({ stripeCustomerId: customer.id }).where(eq(schema.workspaces.id, workspaceId));
  return customer.id;
}

/** Hosted Checkout for a new subscription; existing subscribers are sent to the portal instead. */
export async function createCheckout(p: { workspaceId: string; plan: PaidPlan; email: string }) {
  const price = priceFor(p.plan);
  if (!price) throw new BillingError(`No Stripe price is configured for the ${p.plan} plan.`);
  const ws = await workspace(p.workspaceId);
  if (ws.stripeSubscriptionId && ws.subscriptionStatus && ENTITLED.has(ws.subscriptionStatus as Stripe.Subscription.Status)) {
    // Plan changes on an existing subscription go through the portal (handles proration).
    return { url: await createPortal(p.workspaceId), via: "portal" as const };
  }
  const customer = await ensureCustomer(p.workspaceId, p.email);
  const session = await stripe().checkout.sessions.create({
    mode: "subscription",
    customer,
    client_reference_id: p.workspaceId,
    line_items: [{ price, quantity: 1 }],
    subscription_data: { metadata: { workspaceId: p.workspaceId } },
    allow_promotion_codes: true,
    success_url: `${appUrl()}/settings?billing=success`,
    cancel_url: `${appUrl()}/settings?billing=cancelled`,
  });
  if (!session.url) throw new BillingError("Stripe didn't return a checkout URL.");
  return { url: session.url, via: "checkout" as const };
}

export async function createPortal(workspaceId: string) {
  const ws = await workspace(workspaceId);
  if (!ws.stripeCustomerId) throw new BillingError("This workspace has no billing account yet. Choose a plan first.");
  const session = await stripe().billingPortal.sessions.create({ customer: ws.stripeCustomerId, return_url: `${appUrl()}/settings` });
  return session.url;
}

/** Sync a subscription's state onto its workspace. Exported for tests. */
export async function applySubscription(sub: Stripe.Subscription) {
  const db = await getDb();
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  let [ws] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.stripeCustomerId, customerId));
  if (!ws && sub.metadata?.workspaceId) {
    [ws] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, sub.metadata.workspaceId));
  }
  if (!ws) return { applied: false as const, reason: "no workspace for customer" };

  // A different, still-current subscription is already on file: an old one ending must not downgrade it.
  if (ws.stripeSubscriptionId && ws.stripeSubscriptionId !== sub.id && !ENTITLED.has(sub.status)) {
    return { applied: false as const, reason: "stale subscription" };
  }

  const item = sub.items.data[0];
  const entitled = ENTITLED.has(sub.status);
  const paid = entitled ? planForPrice(item?.price.id) : null;
  if (entitled && !paid) {
    // Unknown price: keep the current plan rather than silently downgrading a paying customer.
    console.warn(`[billing] subscription ${sub.id} uses an unmapped price ${item?.price.id}`);
  }
  const plan: PlanId = entitled ? (paid ?? ws.plan) : "starter";
  await db
    .update(schema.workspaces)
    .set({
      plan,
      stripeCustomerId: customerId,
      stripeSubscriptionId: sub.id,
      subscriptionStatus: sub.status,
      currentPeriodEnd: item?.current_period_end ? new Date(item.current_period_end * 1000) : null,
      cancelAtPeriodEnd: sub.cancel_at_period_end,
    })
    .where(eq(schema.workspaces.id, ws.id));
  if (plan !== ws.plan || sub.status !== ws.subscriptionStatus) {
    await audit({ action: "billing.plan_changed", workspaceId: ws.id, actorType: "system", targetType: "subscription", targetId: sub.id, details: { from: ws.plan, to: plan, status: sub.status } });
  }
  return { applied: true as const, workspaceId: ws.id, plan, status: sub.status };
}

type Deps = { retrieveSubscription: (id: string) => Promise<Stripe.Subscription> };

/**
 * Verify, de-duplicate and process a webhook. Throws on an invalid signature (→ 400).
 * If processing fails, the event mark is removed so Stripe's retry processes it again.
 */
export async function handleWebhook(rawBody: string, signature: string | null, deps?: Partial<Deps>) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new BillingError("STRIPE_WEBHOOK_SECRET is not set.");
  if (!signature) throw new BillingError("Missing Stripe-Signature header.");
  const s = client ?? new Stripe(process.env.STRIPE_SECRET_KEY ?? "sk_unused_for_verification");
  const event = s.webhooks.constructEvent(rawBody, signature, secret);

  const db = await getDb();
  const fresh = await db.insert(schema.stripeEvents).values({ id: event.id, type: event.type }).onConflictDoNothing().returning();
  if (!fresh.length) return { event: event.id, type: event.type, duplicate: true };

  const retrieve = deps?.retrieveSubscription ?? ((id: string) => stripe().subscriptions.retrieve(id));
  try {
    let result: unknown = { ignored: true };
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        if (session.mode === "subscription" && session.subscription) {
          const subId = typeof session.subscription === "string" ? session.subscription : session.subscription.id;
          result = await applySubscription(await retrieve(subId));
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.paused":
      case "customer.subscription.resumed":
        result = await applySubscription(await retrieve(event.data.object.id));
        break;
      case "customer.subscription.deleted":
        // Terminal state; the payload is authoritative.
        result = await applySubscription(event.data.object);
        break;
    }
    return { event: event.id, type: event.type, duplicate: false, result };
  } catch (e) {
    await db.delete(schema.stripeEvents).where(eq(schema.stripeEvents.id, event.id));
    throw e;
  }
}
