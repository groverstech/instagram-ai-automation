import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { createElement, Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const html = (n: ReactNode) => renderToStaticMarkup(createElement(Fragment, null, n));
import { afterEach, beforeAll, describe, expect, it } from "vitest";

process.env.AI_PROVIDER = "mock";
process.env.PGLITE_DIR = "memory://";
process.env.IMAGE_PROVIDER = "none";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bp-platform-"));
process.env.APP_URL = "https://app.example.com";
const SECRET = "meta-app-secret-for-tests";
process.env.META_APP_SECRET = SECRET;
process.env.META_APP_ID = "1234";

const { getDb, schema } = await import("./db/client");
const { encrypt, sign } = await import("./crypto");
const { parseSignedRequest, handleDataDeletion, handleDeauthorize, deletionStatus } = await import("./platforms/meta-callbacks");
const { metaDataDeletion, metaDeauthorize } = await import("./platforms/meta-routes");
const { publishPost, publicMediaUrl, saveAccounts } = await import("./social/service");
const { instagram, facebook } = await import("./social/providers/meta");
const { loadLegalDoc, renderMarkdown, LEGAL_SLUGS } = await import("./legal");
const { GET: mediaGET } = await import("@/app/api/public/media/[token]/route");

/** A signed_request exactly as Meta builds it: base64url(HMAC-SHA256(payload, secret)).base64url(payload). */
function signedRequest(payload: Record<string, unknown>, secret = SECRET) {
  const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const s = crypto.createHmac("sha256", secret).update(p).digest("base64url");
  return `${s}.${p}`;
}
const now = () => Math.floor(Date.now() / 1000);
const form = (sr: string) => new Request("https://app.example.com/api/platforms/meta/x", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ signed_request: sr }) });

const CONCEPT = { title: "Blue hour", headline: "Made to last", subline: "Winter glaze, small batches", cta: "Shop now", layout: "hero_overlay", palette: { background: "#F3EDE4", foreground: "#2B2620", accent: "#B5643C" }, imagePrompt: "", imageTreatment: "", rationale: "r" };

let wsId = "";
let brandId = "";
let otherBrandId = "";
let userId = "";
let creativeId = "";

beforeAll(async () => {
  const db = await getDb();
  const [u] = await db.insert(schema.users).values({ email: "owner@x.test", name: "Owner", passwordHash: "x" }).returning();
  userId = u.id;
  const [w] = await db.insert(schema.workspaces).values({ name: "Kora", plan: "agency" }).returning();
  wsId = w.id;
  const [b] = await db.insert(schema.brands).values({ workspaceId: w.id, name: "Kora Ceramics", colors: ["#2B2620", "#F3EDE4", "#B5643C"] }).returning();
  brandId = b.id;
  const [w2] = await db.insert(schema.workspaces).values({ name: "Other", plan: "agency" }).returning();
  const [b2] = await db.insert(schema.brands).values({ workspaceId: w2.id, name: "Rival" }).returning();
  otherBrandId = b2.id;
  const [c] = await db.insert(schema.creatives).values({ brandId, format: "instagram_post", style: "minimalist_luxury", concept: CONCEPT, visualSource: "typographic" }).returning();
  creativeId = c.id;
});
afterEach(() => {
  process.env.META_APP_SECRET = SECRET;
});

async function account(brand: string, platform: string, externalId: string, platformUserId: string | null) {
  const db = await getDb();
  const [a] = await db
    .insert(schema.socialAccounts)
    .values({ brandId: brand, platform, externalId, name: `${platform} ${externalId}`, accessTokenEnc: encrypt(`token-${externalId}`), platformUserId })
    .returning();
  return a;
}

describe("Meta signed_request verification", () => {
  const good = { algorithm: "HMAC-SHA256", user_id: "10101", issued_at: now() };

  it("accepts a correctly signed, current request", () => {
    expect(parseSignedRequest(signedRequest(good), SECRET)).toEqual({ userId: "10101", issuedAt: good.issued_at });
    expect(parseSignedRequest(signedRequest({ ...good, user_id: 10101 }), SECRET)?.userId).toBe("10101");
  });

  it("rejects tampering, another key, another algorithm, expiry, future dates and malformed input", () => {
    const sr = signedRequest(good);
    const [sig, payload] = sr.split(".");
    const forged = Buffer.from(JSON.stringify({ ...good, user_id: "999" })).toString("base64url");
    expect(parseSignedRequest(`${sig}.${forged}`, SECRET)).toBeNull(); // payload changed
    expect(parseSignedRequest(`${sig.slice(0, -2)}xx.${payload}`, SECRET)).toBeNull(); // signature changed
    expect(parseSignedRequest(signedRequest(good, "another-secret"), SECRET)).toBeNull();
    expect(parseSignedRequest(signedRequest({ ...good, algorithm: "HMAC-SHA1" }), SECRET)).toBeNull();
    expect(parseSignedRequest(signedRequest({ ...good, issued_at: now() - 2 * 24 * 3600 }), SECRET)).toBeNull(); // expired
    expect(parseSignedRequest(signedRequest({ ...good, issued_at: now() + 3600 }), SECRET)).toBeNull(); // from the future
    expect(parseSignedRequest(signedRequest({ algorithm: "HMAC-SHA256" }), SECRET)).toBeNull(); // no user
    expect(parseSignedRequest(signedRequest({ ...good, user_id: "1 OR 1=1" }), SECRET)).toBeNull();
    for (const bad of ["", "nodot", ".x", "x.", "a.b.c", "!!!.???", null, undefined]) expect(parseSignedRequest(bad, SECRET)).toBeNull();
  });
});

describe("Meta data-deletion callback", () => {
  it("deletes exactly that person's Meta data, keeps the brand's own posts, and gives a code with a status page", async () => {
    const db = await getDb();
    const ig = await account(brandId, "instagram", "ig-1", "555");
    const fb = await account(brandId, "facebook", "fb-1", "555");
    const otherPerson = await account(brandId, "instagram", "ig-2", "777");
    const legacy = await account(brandId, "facebook", "fb-legacy", null);
    const otherOrg = await account(otherBrandId, "facebook", "fb-9", "555-other");
    const linkedin = await account(brandId, "linkedin", "urn:li:person:1", "555"); // same digits, different platform
    const [post] = await db.insert(schema.posts).values({ brandId, platform: "instagram", status: "published", socialAccountId: ig.id, externalId: "ig-post-1", externalUrl: "https://instagram.com/p/1", creativeId, caption: "Hello" }).returning();
    const [keep] = await db.insert(schema.posts).values({ brandId, platform: "instagram", status: "published", socialAccountId: otherPerson.id, externalId: "ig-post-2", caption: "Other" }).returning();
    await db.insert(schema.postMetrics).values([
      { postId: post.id, likes: 10, source: "platform" },
      { postId: keep.id, likes: 3, source: "platform" },
    ]);
    await db.insert(schema.accountMetrics).values({ socialAccountId: fb.id, date: "2026-11-20", followers: 100 });

    const res = await metaDataDeletion(form(signedRequest({ algorithm: "HMAC-SHA256", user_id: "555", issued_at: now() })));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; confirmation_code: string };
    expect(body.confirmation_code).toMatch(/^[A-Z2-9]{12}$/);
    expect(body.url).toBe(`https://app.example.com/data-deletion/status?code=${body.confirmation_code}`);

    const remaining = (await db.select().from(schema.socialAccounts)).map((a) => a.id);
    expect(remaining).not.toContain(ig.id);
    expect(remaining).not.toContain(fb.id);
    expect(remaining).toEqual(expect.arrayContaining([otherPerson.id, legacy.id, otherOrg.id, linkedin.id]));
    const [p] = await db.select().from(schema.posts).where(eq(schema.posts.id, post.id));
    expect(p).toMatchObject({ socialAccountId: null, externalId: null, externalUrl: null, caption: "Hello", creativeId }); // the brand's post stays
    expect(await db.select().from(schema.postMetrics).where(eq(schema.postMetrics.postId, post.id))).toEqual([]);
    expect(await db.select().from(schema.postMetrics).where(eq(schema.postMetrics.postId, keep.id))).toHaveLength(1);
    expect(await db.select().from(schema.accountMetrics).where(eq(schema.accountMetrics.socialAccountId, fb.id))).toEqual([]);

    const [reqRow] = await db.select().from(schema.dataDeletionRequests).where(eq(schema.dataDeletionRequests.confirmationCode, body.confirmation_code));
    expect(reqRow).toMatchObject({ platform: "meta", externalUserId: "555", status: "completed", details: { accounts: 2, postsDetached: 1, postMetricsDeleted: 1 } });
    expect(reqRow.completedAt).toBeInstanceOf(Date);
    const st = await deletionStatus(body.confirmation_code);
    expect(st).toMatchObject({ status: "completed" });
    expect(Object.keys(st!)).toEqual(["status", "requestedAt", "completedAt"]); // nothing personal
    expect(await deletionStatus("NOTACODE")).toBeNull();
    expect(await deletionStatus("x' or 1=1")).toBeNull();

    const events = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, "social.data_deletion"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ workspaceId: wsId, brandId, actorType: "system" });
  });

  it("a person with nothing connected still gets a completed request", async () => {
    const out = await handleDataDeletion(signedRequest({ algorithm: "HMAC-SHA256", user_id: "424242", issued_at: now() }));
    expect(out).toMatchObject({ status: "completed" });
  });

  it("refuses invalid requests (400) and answers 503 when the app secret isn't configured", async () => {
    const db = await getDb();
    const before = await db.$count(schema.dataDeletionRequests);
    expect((await metaDataDeletion(form(signedRequest({ algorithm: "HMAC-SHA256", user_id: "555", issued_at: now() }, "wrong")))).status).toBe(400);
    expect((await metaDataDeletion(new Request("https://x/", { method: "POST", body: "garbage" }))).status).toBe(400);
    expect(await db.$count(schema.dataDeletionRequests)).toBe(before); // nothing recorded for invalid requests
    delete process.env.META_APP_SECRET;
    expect((await metaDataDeletion(form(signedRequest({ algorithm: "HMAC-SHA256", user_id: "555", issued_at: now() })))).status).toBe(503);
  });
});

describe("Meta deauthorise callback", () => {
  it("revokes that person's accounts, destroys their tokens, and publishing to them stops", async () => {
    const db = await getDb();
    const ig = await account(brandId, "instagram", "ig-de-1", "888");
    const other = await account(brandId, "instagram", "ig-de-2", "999");
    const [post] = await db.insert(schema.posts).values({ brandId, platform: "instagram", status: "approved", approvedAt: new Date(), approvedBy: userId, socialAccountId: ig.id, creativeId, caption: "Hi" }).returning();

    const res = await metaDeauthorize(form(signedRequest({ algorithm: "HMAC-SHA256", user_id: "888", issued_at: now() })));
    expect(res.status).toBe(200);
    const [a] = await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.id, ig.id));
    expect(a.status).toBe("revoked");
    expect(a.deauthorizedAt).toBeInstanceOf(Date);
    expect(a.refreshTokenEnc).toBeNull();
    expect(a.accessTokenEnc).not.toBe(ig.accessTokenEnc);
    const [o] = await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.id, other.id));
    expect(o.status).toBe("active");

    const out = await publishPost(post.id);
    expect(out).toMatchObject({ ok: false, error: expect.stringMatching(/disconnected/) });
    const events = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, "social.deauthorized"));
    expect(events[0]).toMatchObject({ workspaceId: wsId, brandId, targetId: ig.id });
    expect(await handleDeauthorize("bad.request")).toBeNull();
  });
});

describe("Meta login records the person's app-scoped ID on every connected account", () => {
  it("exchangeCode reads /me and discovery passes it to each Page and Instagram account", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const u = String(input);
      const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
      if (u.includes("/oauth/access_token") && u.includes("fb_exchange_token")) return ok({ access_token: "long", expires_in: 5000000 });
      if (u.includes("/oauth/access_token")) return ok({ access_token: "short" });
      if (u.includes("/me?")) return ok({ id: "31337" });
      if (u.includes("/me/accounts")) return ok({ data: [{ id: "page-1", name: "Kora Page", access_token: "page-token", instagram_business_account: { id: "ig-77", username: "kora" } }] });
      throw new Error(`unexpected ${u}`);
    }) as typeof fetch;
    try {
      const token = await facebook.exchangeCode({ code: "c", redirectUri: "https://app.example.com/cb", codeVerifier: "v" });
      expect(token.platformUserId).toBe("31337");
      const found = [...(await facebook.discoverAccounts(token)), ...(await instagram.discoverAccounts(token))];
      expect(found.map((f) => [f.platform, f.token.platformUserId])).toEqual([
        ["facebook", "31337"],
        ["instagram", "31337"],
      ]);
      await saveAccounts(brandId, userId, found);
      const db = await getDb();
      const saved = await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.externalId, "ig-77"));
      expect(saved[0].platformUserId).toBe("31337");
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe("publish media is JPEG (Instagram accepts JPEG only)", () => {
  const call = (token: string) => mediaGET(new Request(`https://app.example.com/api/public/media/${token}`), { params: Promise.resolve({ token }) });

  it("publish URLs end in .jpg and serve baseline sRGB JPEG at the format's size", async () => {
    const url = publicMediaUrl(creativeId, "instagram_post");
    expect(url).toMatch(/^https:\/\/app\.example\.com\/api\/public\/media\/[^/]+\.jpg$/);
    const res = await call(url.split("/").pop()!);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    const buf = Buffer.from(await res.arrayBuffer());
    expect([...buf.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    const { default: sharp } = await import("sharp");
    const m = await sharp(buf).metadata();
    expect(m).toMatchObject({ format: "jpeg", space: "srgb", width: 1080, height: 1350, hasAlpha: false });
    expect(m.icc).toBeTruthy();
  });

  it("links issued before the switch (.png) still serve PNG; bad or expired tokens are refused", async () => {
    const token = sign({ c: creativeId, f: null, exp: Date.now() + 60_000 });
    const png = await call(`${token}.png`);
    expect(png.headers.get("content-type")).toBe("image/png");
    expect((await call("not-a-token.jpg")).status).toBe(403);
    expect((await call(`${sign({ c: creativeId, f: null, exp: Date.now() - 1000 })}.jpg`)).status).toBe(403);
  });
});

describe("public legal pages", () => {
  it("every page loads, is marked draft until counsel's text is final, and fills placeholders from the environment", () => {
    for (const slug of LEGAL_SLUGS) {
      const doc = loadLegalDoc(slug, { LEGAL_ENTITY_NAME: "Kora Labs Ltd", LEGAL_CONTACT_EMAIL: "privacy@kora.test", APP_URL: "https://app.example.com" });
      expect(doc.status).toBe("draft");
      expect(doc.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const out = html(doc.body);
      expect(out).toContain("<h1");
      expect(out).not.toMatch(/\{\{\w+\}\}/);
    }
    const privacy = html(loadLegalDoc("privacy", { LEGAL_ENTITY_NAME: "Kora Labs Ltd", LEGAL_CONTACT_EMAIL: "privacy@kora.test", APP_URL: "https://app.example.com" }).body);
    expect(privacy).toContain("Kora Labs Ltd");
    expect(privacy).toContain("privacy@kora.test");
    const missing = html(loadLegalDoc("privacy", {}).body);
    expect(missing).toContain("[contact email to be confirmed]");
  });

  it("the markdown renderer never injects HTML or unsafe links", () => {
    const md = html(renderMarkdown("# T\n\n<script>alert(1)</script> **bold** [x](javascript:alert(1)) [ok](https://example.com) [here](/data-deletion)\n\n- one\n- two\n\n1. a\n2. b"));
    expect(md).not.toContain("<script>");
    expect(md).toContain("&lt;script&gt;");
    expect(md).not.toContain('href="javascript');
    expect(md).toContain('<a href="https://example.com" class="underline underline-offset-2" rel="noopener noreferrer">ok</a>');
    expect(md).toContain('href="/data-deletion"');
    expect(md).toContain("<strong>bold</strong>");
    expect(md).toMatch(/<ul[^>]*><li>one<\/li><li>two<\/li><\/ul>/);
    expect(md).toMatch(/<ol[^>]*><li>a<\/li><li>b<\/li><\/ol>/);
  });
});
