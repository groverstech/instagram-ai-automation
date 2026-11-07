import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import Stripe from "stripe";
import type { Stripe as StripeNS } from "stripe";

process.env.PGLITE_DIR = "memory://";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_secret";
process.env.STRIPE_PRICE_GROWTH = "price_growth";
process.env.STRIPE_PRICE_AGENCY = "price_agency";

const { getDb, schema } = await import("./db/client");
const { handleWebhook } = await import("./billing");

const signer = new Stripe("sk_test_unused");
let wsId = "";
let n = 0;

function sub(over: { id?: string; status?: StripeNS.Subscription.Status; price?: string; cancel?: boolean; customer?: string } = {}) {
  return {
    id: over.id ?? "sub_1",
    object: "subscription",
    customer: over.customer ?? "cus_1",
    status: over.status ?? "active",
    cancel_at_period_end: over.cancel ?? false,
    metadata: { workspaceId: wsId },
    items: { object: "list", data: [{ id: "si_1", price: { id: over.price ?? "price_growth" }, current_period_end: 1_800_000_000 }] },
  } as unknown as StripeNS.Subscription;
}

function signed(type: string, object: unknown, id = `evt_${++n}`) {
  const payload = JSON.stringify({ id, object: "event", type, data: { object } });
  return { payload, header: signer.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET! }) };
}

async function ws() {
  const db = await getDb();
  const [w] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, wsId));
  return w;
}

beforeAll(async () => {
  const db = await getDb();
  const [w] = await db.insert(schema.workspaces).values({ name: "Billing WS", stripeCustomerId: "cus_1" }).returning();
  wsId = w.id;
});

describe("Stripe webhooks", () => {
  it("rejects a bad signature without changing anything", async () => {
    const { payload } = signed("customer.subscription.updated", sub());
    await expect(handleWebhook(payload, "t=1,v1=deadbeef")).rejects.toThrow();
    await expect(handleWebhook(payload, null)).rejects.toThrow(/Stripe-Signature/);
    expect((await ws()).plan).toBe("starter");
  });

  it("upgrades on checkout completion using the subscription re-read from Stripe", async () => {
    const e = signed("checkout.session.completed", { id: "cs_1", object: "checkout.session", mode: "subscription", subscription: "sub_1", client_reference_id: wsId });
    const r = await handleWebhook(e.payload, e.header, { retrieveSubscription: async () => sub() });
    expect(r.duplicate).toBe(false);
    const w = await ws();
    expect(w.plan).toBe("growth");
    expect(w.subscriptionStatus).toBe("active");
    expect(w.stripeSubscriptionId).toBe("sub_1");
    expect(w.currentPeriodEnd?.getTime()).toBe(1_800_000_000_000);
  });

  it("processes each event id once", async () => {
    const e = signed("customer.subscription.updated", { id: "sub_1" }, "evt_dup");
    let calls = 0;
    const retrieve = async () => (calls++, sub({ price: "price_agency" }));
    await handleWebhook(e.payload, e.header, { retrieveSubscription: retrieve });
    const again = await handleWebhook(e.payload, e.header, { retrieveSubscription: retrieve });
    expect(again.duplicate).toBe(true);
    expect(calls).toBe(1);
    expect((await ws()).plan).toBe("agency");
  });

  it("keeps the plan while past_due and records cancel-at-period-end", async () => {
    const e = signed("customer.subscription.updated", { id: "sub_1" });
    await handleWebhook(e.payload, e.header, { retrieveSubscription: async () => sub({ status: "past_due", price: "price_agency", cancel: true }) });
    const w = await ws();
    expect(w.plan).toBe("agency");
    expect(w.subscriptionStatus).toBe("past_due");
    expect(w.cancelAtPeriodEnd).toBe(true);
  });

  it("keeps the current plan when the price is not mapped", async () => {
    const e = signed("customer.subscription.updated", { id: "sub_1" });
    await handleWebhook(e.payload, e.header, { retrieveSubscription: async () => sub({ price: "price_unknown" }) });
    expect((await ws()).plan).toBe("agency");
  });

  it("ignores an old subscription ending while a newer one is current", async () => {
    const e = signed("customer.subscription.deleted", sub({ id: "sub_old", status: "canceled" }));
    const r = await handleWebhook(e.payload, e.header);
    expect((r.result as { applied: boolean }).applied).toBe(false);
    expect((await ws()).plan).toBe("agency");
  });

  it("allows Stripe to retry an event whose processing failed", async () => {
    const e = signed("customer.subscription.updated", { id: "sub_1" }, "evt_retry");
    await expect(handleWebhook(e.payload, e.header, { retrieveSubscription: async () => { throw new Error("Stripe down"); } })).rejects.toThrow("Stripe down");
    const r = await handleWebhook(e.payload, e.header, { retrieveSubscription: async () => sub({ price: "price_growth" }) });
    expect(r.duplicate).toBe(false);
    expect((await ws()).plan).toBe("growth");
  });

  it("downgrades to Starter when the subscription is deleted", async () => {
    const e = signed("customer.subscription.deleted", sub({ status: "canceled" }));
    await handleWebhook(e.payload, e.header);
    const w = await ws();
    expect(w.plan).toBe("starter");
    expect(w.subscriptionStatus).toBe("canceled");
  });
});
