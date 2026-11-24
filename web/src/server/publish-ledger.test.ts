/**
 * Publish-attempt ledger, reconciliation and token health (PR 4.4a). The real Instagram and Facebook
 * providers run against a fake Graph API (fetch is replaced; nothing leaves the test), so the tests
 * see every request the app would send and can prove a post is never sent twice.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { desc, eq } from "drizzle-orm";

process.env.PGLITE_DIR = "memory://";
process.env.AI_PROVIDER = "mock";
process.env.IMAGE_PROVIDER = "none";
process.env.APP_URL = "https://app.example.com";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bp-ledger-"));

type Call = { method: string; path: string; body: URLSearchParams | null };
let calls: Call[] = [];
/** Per-test behaviour of the fake Graph API: return a value to answer, throw to fail. */
let graph: (c: Call) => unknown = () => ({});
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname !== "graph.facebook.com") return realFetch(input, init);
  const c: Call = { method: init?.method ?? "GET", path: url.pathname.replace(/^\/v[\d.]+/, ""), body: init?.body instanceof URLSearchParams ? init.body : null };
  calls.push(c);
  const r = graph(c); // may throw: a network failure
  if (r instanceof Response) return r;
  return new Response(JSON.stringify(r), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;
const graphError = (status: number, code?: number, message = "error") => new Response(JSON.stringify({ error: { message, code } }), { status, headers: { "content-type": "application/json" } });
const timeout = () => {
  throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
};

const { getDb, schema } = await import("./db/client");
const { saveAccounts, publishPost, syncMetrics, captionOf } = await import("./social/service");
const { reconcilePost, checksNeeded, settleManually, RECONCILE_DELAY_MS } = await import("./social/publish-ledger");
const { sameText } = await import("./social/providers/meta");
const { runDueJobs } = await import("./jobs/queue");
const { handlers, interruptedHooks } = await import("./jobs/handlers");
const { PROVIDERS } = await import("./social/registry");

let brandId = "";
let userId = "";
let creativeId = "";
const acct: Record<string, string> = {};

beforeAll(async () => {
  const db = await getDb();
  const [u] = await db.insert(schema.users).values({ email: "ledger@x.test", name: "L", passwordHash: "x" }).returning();
  const [w] = await db.insert(schema.workspaces).values({ name: "Ledger" }).returning();
  const [b] = await db.insert(schema.brands).values({ workspaceId: w.id, name: "Kora", platforms: ["instagram", "facebook", "linkedin"] }).returning();
  const [c] = await db
    .insert(schema.creatives)
    .values({ brandId: b.id, format: "ig_feed_square", style: "minimalist_luxury", visualSource: "typographic", concept: { title: "T", headline: "Made to last", subline: "", cta: "", layout: "typographic", palette: { background: "#F3EDE4", foreground: "#2B2620", accent: "#B5643C" }, imagePrompt: "", imageTreatment: "", rationale: "" } })
    .returning();
  await saveAccounts(b.id, u.id, [
    { platform: "instagram", externalId: "ig-1", name: "Kora IG", token: { accessToken: "ig-token" } },
    { platform: "facebook", externalId: "page-1", name: "Kora Page", token: { accessToken: "fb-token" } },
    { platform: "linkedin", externalId: "urn:li:person:1", name: "Kora LI", token: { accessToken: "li-token" } },
  ]);
  for (const a of await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.brandId, b.id))) acct[a.platform] = a.id;
  brandId = b.id;
  userId = u.id;
  creativeId = c.id;
});
beforeEach(() => {
  calls = [];
  graph = () => ({});
});
afterEach(() => vi.restoreAllMocks());

let n = 0;
async function post(platform: "instagram" | "facebook" | "linkedin", status = "approved") {
  const db = await getDb();
  const [p] = await db
    .insert(schema.posts)
    .values({ brandId, platform, format: "ig_feed_square", status: status as "approved", approvedAt: new Date(), approvedBy: userId, creativeId, socialAccountId: acct[platform], caption: `Post ${n++}: made to last`, hashtags: ["stoneware"] })
    .returning();
  // An approval is for this exact content (social/approval.ts).
  await (await import("./social/approval")).recordApprovedContent(db, p.id);
  return p;
}
const attempts = async (postId: string) => (await getDb()).select().from(schema.publishAttempts).where(eq(schema.publishAttempts.postId, postId)).orderBy(desc(schema.publishAttempts.attempt));
const postRow = async (id: string) => (await (await getDb()).select().from(schema.posts).where(eq(schema.posts.id, id)))[0];
const count = (method: string, suffix: string) => calls.filter((c) => c.method === method && c.path.endsWith(suffix)).length;

/** Fake Instagram: container → FINISHED → publish; `publish` decides what media_publish does. */
function instagram(opts: { publish?: () => unknown; media?: () => { data: unknown[] } } = {}) {
  graph = (c) => {
    if (c.method === "POST" && c.path === "/ig-1/media") return { id: "container-1" };
    if (c.method === "GET" && c.path === "/container-1") return { status_code: "FINISHED" };
    if (c.method === "POST" && c.path === "/ig-1/media_publish") return opts.publish ? opts.publish() : { id: "ig-media-1" };
    if (c.method === "GET" && c.path === "/ig-1/media") return opts.media ? opts.media() : { data: [] };
    if (c.method === "GET" && c.path.startsWith("/ig-media")) return { permalink: "https://instagram.com/p/x" };
    return {};
  };
}

describe("the attempt ledger", () => {
  it("records each attempt before sending and settles it: a Facebook post", async () => {
    graph = (c) => (c.path === "/page-1/photos" ? { id: "photo-1", post_id: "page-1_post-1" } : {});
    const p = await post("facebook");
    expect(await publishPost(p.id)).toMatchObject({ ok: true, externalId: "page-1_post-1" });
    const [a] = await attempts(p.id);
    expect(a).toMatchObject({ attempt: 1, status: "succeeded", externalId: "page-1_post-1", idempotencyKey: `post:${p.id}:1`, platform: "facebook" });
    expect(JSON.stringify(a)).not.toContain("fb-token"); // no tokens in the ledger
    expect(await postRow(p.id)).toMatchObject({ status: "published", externalId: "page-1_post-1" });
  });

  it("concurrent publishes of one post send it once", async () => {
    graph = (c) => (c.path === "/page-1/photos" ? { id: "photo-2", post_id: "page-1_post-2" } : {});
    const p = await post("facebook");
    const results = await Promise.all([publishPost(p.id), publishPost(p.id), publishPost(p.id)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(count("POST", "/photos")).toBe(1);
    expect(await attempts(p.id)).toHaveLength(1);
  });

  it("a pause that arrives after the claim but before the final request stops it: nothing is sent, the post keeps its approval and waits for resume (review M4)", async () => {
    instagram();
    const p = await post("instagram", "scheduled");
    const db = await getDb();
    const wrapped = globalThis.fetch;
    // While Instagram is "processing the image" (after the claim, before media_publish), an admin pauses.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/container-1") && (init?.method ?? "GET") === "GET") await db.update(schema.brands).set({ publishingPausedAt: new Date() }).where(eq(schema.brands.id, brandId));
      return wrapped(input, init);
    }) as typeof fetch;
    try {
      expect(await publishPost(p.id)).toMatchObject({ ok: false, paused: true });
    } finally {
      globalThis.fetch = wrapped;
      await db.update(schema.brands).set({ publishingPausedAt: null }).where(eq(schema.brands.id, brandId));
    }
    expect(count("POST", "/media_publish")).toBe(0); // the request that makes it public was never sent
    expect((await attempts(p.id))[0]).toMatchObject({ status: "failed" });
    expect((await attempts(p.id))[0].error).toMatch(/emergency pause before sending/);
    const [after] = await db.select().from(schema.posts).where(eq(schema.posts.id, p.id));
    expect(after.status).toBe("scheduled"); // still approved and scheduled: resuming publishes it
    expect(after.approvedContentHash).not.toBeNull();
    expect(await checksNeeded([{ id: p.id, platform: "instagram" }])).toEqual({}); // definite: no check needed
  });

  it("a refusal before the final request is a definite failure: retrying is allowed straight away", async () => {
    graph = (c) => (c.path === "/ig-1/media" && c.method === "POST" ? graphError(500, 2, "temporary") : {});
    const p = await post("instagram");
    expect(await publishPost(p.id)).toMatchObject({ ok: false });
    expect((await attempts(p.id))[0]).toMatchObject({ status: "failed" });
    expect(await checksNeeded([{ id: p.id, platform: "instagram" }])).toEqual({});
    instagram();
    expect(await publishPost(p.id)).toMatchObject({ ok: true, externalId: "ig-media-1" });
    expect((await attempts(p.id)).map((a) => a.status)).toEqual(["succeeded", "failed"]);
  });

  it("a platform refusal of the final request (4xx) is a definite failure too", async () => {
    instagram({ publish: () => graphError(400, 9007, "Media ID is not available") });
    const p = await post("instagram");
    expect(await publishPost(p.id)).toMatchObject({ ok: false, error: expect.stringMatching(/Publishing failed/) });
    expect((await attempts(p.id))[0].status).toBe("failed");
  });
});

describe("unknown outcomes and reconciliation", () => {
  it("no answer to the final request: unknown; publishing again is refused until a check", async () => {
    instagram({ publish: timeout });
    const p = await post("instagram");
    const r = await publishPost(p.id);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/may have gone out/) });
    expect((await attempts(p.id))[0]).toMatchObject({ status: "unknown", progress: { creationId: "container-1" } });
    expect(await checksNeeded([{ id: p.id, platform: "instagram" }])).toEqual({ [p.id]: "auto" });
    const sendsBefore = count("POST", "/media_publish");
    expect(await publishPost(p.id)).toMatchObject({ ok: false, needsCheck: true });
    expect(count("POST", "/media_publish")).toBe(sendsBefore); // nothing sent again
  });

  it("a check right away is too soon; later it finds the post: published, never sent twice", async () => {
    instagram({ publish: timeout });
    const p = await post("instagram");
    await publishPost(p.id);
    expect(await reconcilePost(p.id)).toMatchObject({ state: "too_soon" });
    const caption = captionOf(p);
    instagram({ media: () => ({ data: [{ id: "ig-found-1", caption, timestamp: new Date().toISOString(), permalink: "https://instagram.com/p/found" }] }) });
    expect(await reconcilePost(p.id, Date.now() + RECONCILE_DELAY_MS + 1000)).toEqual({ state: "published", externalId: "ig-found-1", url: "https://instagram.com/p/found" });
    expect(await postRow(p.id)).toMatchObject({ status: "published", externalId: "ig-found-1" });
    expect((await attempts(p.id))[0].status).toBe("reconciled");
    expect(count("POST", "/media_publish")).toBe(1);
  });

  it("not found: the attempt is settled as failed and the retry reuses the container", async () => {
    instagram({ publish: timeout });
    const p = await post("instagram");
    await publishPost(p.id);
    instagram({ media: () => ({ data: [{ id: "other", caption: "Something else", timestamp: new Date().toISOString() }] }) });
    expect(await reconcilePost(p.id, Date.now() + RECONCILE_DELAY_MS + 1000)).toEqual({ state: "not_published" });
    expect(await postRow(p.id)).toMatchObject({ status: "failed", publishError: expect.stringMatching(/isn't there/) });
    calls = [];
    instagram();
    expect(await publishPost(p.id)).toMatchObject({ ok: true });
    expect(count("POST", "/ig-1/media")).toBe(0); // the existing container was reused
    expect(count("POST", "/media_publish")).toBe(1);
  });

  it("a worker that died mid-publish: recovery checks the platform and settles the job", async () => {
    const db = await getDb();
    const caption = (p: { caption: string | null; hashtags: string[] }) => captionOf(p);
    for (const found of [true, false]) {
      const p = await post("instagram", "approved");
      // The dead worker had claimed the post and recorded attempt 1, then stopped.
      await db.update(schema.posts).set({ status: "publishing" }).where(eq(schema.posts.id, p.id));
      await db.insert(schema.publishAttempts).values({ postId: p.id, socialAccountId: acct.instagram, platform: "instagram", attempt: 1, idempotencyKey: `post:${p.id}:1`, status: "sending", startedAt: new Date(Date.now() - 12 * 60_000) });
      const [job] = await db.insert(schema.jobs).values({ type: "publish_post", payload: { postId: p.id }, status: "running", lockedAt: new Date(Date.now() - 11 * 60_000), attempts: 1, runAt: new Date(Date.now() - 12 * 60_000) }).returning();
      instagram({ media: () => ({ data: found ? [{ id: `ig-rec-${p.id}`, caption: caption(p), timestamp: new Date(Date.now() - 11 * 60_000).toISOString() }] : [] }) });
      await runDueJobs(handlers, 10, interruptedHooks);
      const [j] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, job.id));
      if (found) {
        expect(await postRow(p.id)).toMatchObject({ status: "published", externalId: `ig-rec-${p.id}` });
        expect(j.status).toBe("done");
      } else {
        expect(await postRow(p.id)).toMatchObject({ status: "failed", publishError: expect.stringMatching(/isn't there/) });
        expect(j.status).toBe("failed");
      }
      expect(count("POST", "/media_publish")).toBe(0); // recovery never re-sends
      calls = [];
    }
  });

  it("a worker that died after claiming but before recording an attempt: nothing was sent", async () => {
    const db = await getDb();
    const p = await post("instagram");
    // Attempt 1 failed earlier (settled); the next claim died before recording attempt 2.
    await db.insert(schema.publishAttempts).values({ postId: p.id, socialAccountId: acct.instagram, platform: "instagram", attempt: 1, idempotencyKey: `post:${p.id}:1`, status: "failed", error: "Publishing failed" });
    await db.update(schema.posts).set({ status: "publishing" }).where(eq(schema.posts.id, p.id));
    await db.insert(schema.jobs).values({ type: "publish_post", payload: { postId: p.id }, status: "running", lockedAt: new Date(Date.now() - 11 * 60_000), attempts: 1, runAt: new Date(Date.now() - 12 * 60_000) });
    await runDueJobs(handlers, 10, interruptedHooks);
    expect(await postRow(p.id)).toMatchObject({ status: "failed", publishError: expect.stringMatching(/before anything was sent/) });
    expect(calls).toHaveLength(0);
  });

  it("an interrupted post with no ledger rows (e.g. from before the ledger) stays flagged for a person", async () => {
    const db = await getDb();
    const p = await post("instagram");
    await db.update(schema.posts).set({ status: "publishing" }).where(eq(schema.posts.id, p.id));
    await db.insert(schema.jobs).values({ type: "publish_post", payload: { postId: p.id }, status: "running", lockedAt: new Date(Date.now() - 11 * 60_000), attempts: 1, runAt: new Date(Date.now() - 12 * 60_000) });
    await runDueJobs(handlers, 10, interruptedHooks);
    expect(await postRow(p.id)).toMatchObject({ status: "failed", publishError: expect.stringMatching(/interrupted.*Check the account/) });
    expect(calls).toHaveLength(0);
  });

  it("platforms without an automatic check: unknown outcomes are settled by a person", async () => {
    vi.spyOn(PROVIDERS.linkedin, "publish").mockRejectedValue(new TypeError("fetch failed"));
    const p = await post("linkedin");
    expect(await publishPost(p.id)).toMatchObject({ ok: false, error: expect.stringMatching(/may have gone out/) });
    expect(await checksNeeded([{ id: p.id, platform: "linkedin" }])).toEqual({ [p.id]: "manual" });
    expect(await reconcilePost(p.id, Date.now() + RECONCILE_DELAY_MS * 2)).toEqual({ state: "manual" });
    expect(await settleManually(p.id, false, "Owner")).toBe(true);
    expect(await checksNeeded([{ id: p.id, platform: "linkedin" }])).toEqual({});
    vi.spyOn(PROVIDERS.linkedin, "publish").mockResolvedValue({ externalId: "urn:li:share:9" });
    expect(await publishPost(p.id)).toMatchObject({ ok: true });
  });

  it("caption matching tolerates whitespace and line endings, not other differences", () => {
    expect(sameText("Hello  world\r\n\r\n#tag ", "Hello world\n\n#tag")).toBe(true);
    expect(sameText("Hello world", "Hello world!")).toBe(false);
    expect(sameText("", "")).toBe(false);
    expect(sameText(undefined, "x")).toBe(false);
  });
});

describe("token health", () => {
  it("a rejected token marks the account for reconnecting; publishing then fails fast; reconnecting clears it", async () => {
    graph = (c) => (c.path === "/page-1/photos" ? graphError(400, 190, "Error validating access token: Session has expired") : {});
    const p = await post("facebook");
    expect(await publishPost(p.id)).toMatchObject({ ok: false, error: expect.stringMatching(/Reconnect it/) });
    const db = await getDb();
    const [a] = await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.id, acct.facebook));
    expect(a).toMatchObject({ status: "expired", health: { status: "needs_reconnect" } });
    calls = [];
    const p2 = await post("facebook");
    expect(await publishPost(p2.id)).toMatchObject({ ok: false, error: expect.stringMatching(/Reconnect it/) });
    expect(calls).toHaveLength(0); // failed fast, nothing sent
    await saveAccounts(brandId, userId, [{ platform: "facebook", externalId: "page-1", name: "Kora Page", token: { accessToken: "fb-token-2" } }]);
    const [b] = await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.id, acct.facebook));
    expect(b).toMatchObject({ status: "active", health: {} });
  });

  it("an expired token fails before sending", async () => {
    const db = await getDb();
    await db.update(schema.socialAccounts).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.socialAccounts.id, acct.instagram));
    const p = await post("instagram");
    expect(await publishPost(p.id)).toMatchObject({ ok: false, error: expect.stringMatching(/Reconnect it/) });
    expect(calls).toHaveLength(0);
    await saveAccounts(brandId, userId, [{ platform: "instagram", externalId: "ig-1", name: "Kora IG", token: { accessToken: "ig-token" } }]);
  });

  it("a metrics sync that hits a rejected token marks the account", async () => {
    graph = (c) => (c.method === "GET" && c.path === "/ig-1" ? graphError(401, 190, "Invalid OAuth access token") : {});
    await syncMetrics(brandId);
    const db = await getDb();
    const [a] = await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.id, acct.instagram));
    expect(a.health).toMatchObject({ status: "needs_reconnect" });
    await saveAccounts(brandId, userId, [{ platform: "instagram", externalId: "ig-1", name: "Kora IG", token: { accessToken: "ig-token" } }]);
  });
});
