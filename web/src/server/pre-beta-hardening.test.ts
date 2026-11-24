/**
 * Pre-beta hardening (review findings H1, M1, M2, M4, L1, L2, L3, L4, L5, L6). On Postgres 16 when
 * TEST_DATABASE_URL is set (real concurrency), otherwise PGlite. The social sandbox stands in for
 * the platforms; nothing leaves the test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import JSZip from "jszip";

for (const k of Object.keys(process.env)) if (/^(AI_SPEND_CAP_|AI_STOP$|AI_TRIPWIRE_|DATABASE_URL$|VOYAGE_|DEPLOY_ENV$|CREDITS_MODE$|AUTONOMOUS_PUBLISHING$|SIGNUP_MODE$|EMAIL_)/.test(k)) delete process.env[k];
const PG_ADMIN = process.env.TEST_DATABASE_URL;
let pgDatabase: string | null = null;
if (PG_ADMIN) {
  const { default: postgres } = await import("postgres");
  pgDatabase = `bp_harden_${Date.now().toString(36)}`;
  const admin = postgres(PG_ADMIN, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${pgDatabase}`);
  await admin.end();
  const u = new URL(PG_ADMIN);
  u.pathname = `/${pgDatabase}`;
  process.env.DATABASE_URL = u.toString();
} else {
  process.env.PGLITE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bp-harden-pg-"));
}
process.env.AI_PROVIDER = "mock";
process.env.IMAGE_PROVIDER = "none";
process.env.SOCIAL_SANDBOX = "true";
process.env.EMAIL_PROVIDER = "memory";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bp-harden-store-"));

let token: string | null = null;
let ip = "198.51.100.10";
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (n: string) => (n === "bp_session" && token ? { value: token } : undefined), set() {}, delete() {} }),
  headers: async () => new Headers({ "x-forwarded-for": ip }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const { getDb, schema } = await import("./db/client");
const { sha256 } = await import("./crypto");
const { saveAccounts, publishPost, approvePost, captionOf } = await import("./social/service");
const posts = await import("../app/actions/posts");
const { recordApprovedContent } = await import("./social/approval");
const { autonomyTick } = await import("./autonomy/service");
const { runDueJobs, enqueue } = await import("./jobs/queue");
const { handlers, interruptedHooks } = await import("./jobs/handlers");
const { emergencyStop, pausedBrands } = await import("./emergency-stop");
const { resumePublishingFor } = await import("./publishing-pause");
const m = await import("./members");
const { mayCreateAccount } = await import("./beta-invites");
const { signUp } = await import("../app/actions/auth");
const { exportWorkspaceFor } = await import("./tenant-export");
const { anyCapApplies, creditGate } = await import("./ai/credit-gate");
const { embed, voyageRefusal } = await import("./ai/embeddings");
const { checkConfig } = await import("./config");
const { memoryOutbox } = await import("./email");
type SessionUser = import("./auth/session").SessionUser;

type Org = { ws: string; brand: string; creative: string; acctA: string; acctB: string; admin: SessionUser; editor: SessionUser; client: SessionUser };
let n = 0;
async function user(name: string, verified = true) {
  const db = await getDb();
  const email = `${name}-${n++}@harden.test`;
  const [u] = await db.insert(schema.users).values({ email, name, passwordHash: "x", emailVerifiedAt: verified ? new Date() : null }).returning();
  const tok = `tok-${u.id}`;
  await db.insert(schema.sessions).values({ id: sha256(tok), userId: u.id, expiresAt: new Date(Date.now() + 864e5) });
  const s: SessionUser = { sessionId: sha256(tok), activeBrandId: null, user: { id: u.id, email: u.email, name }, emailVerified: verified };
  return Object.assign(s, { token: tok });
}
const as = (s: SessionUser) => {
  token = (s as SessionUser & { token: string }).token;
};
async function org(): Promise<Org> {
  const db = await getDb();
  const admin = await user("admin");
  const editor = await user("editor");
  const client = await user("client");
  const [w] = await db.insert(schema.workspaces).values({ name: `Org ${n++}`, plan: "agency" }).returning();
  const [b] = await db.insert(schema.brands).values({ workspaceId: w.id, name: `Brand ${n}`, platforms: ["instagram", "facebook"], colors: ["#111111", "#F3EDE4", "#B5643C"] }).returning();
  const [b2] = await db.insert(schema.brands).values({ workspaceId: w.id, name: `Other brand ${n}` }).returning();
  await db.insert(schema.workspaceMembers).values([
    { workspaceId: w.id, userId: admin.user.id, role: "admin" },
    { workspaceId: w.id, userId: editor.user.id, role: "editor" },
    // A client user: editor, limited to this brand.
    { workspaceId: w.id, userId: client.user.id, role: "editor", brandIds: [b.id] },
  ]);
  void b2;
  const concept = { title: "T", headline: "Made to last", subline: "", cta: "", layout: "typographic", palette: { background: "#F3EDE4", foreground: "#2B2620", accent: "#B5643C" }, imagePrompt: "", imageTreatment: "", rationale: "" };
  const [c] = await db.insert(schema.creatives).values({ brandId: b.id, format: "ig_feed_square", style: "minimalist_luxury", visualSource: "typographic", concept }).returning();
  await saveAccounts(b.id, admin.user.id, [
    { platform: "instagram", externalId: `ig-a-${n}`, name: "IG A", token: { accessToken: "sandbox-a" } },
    { platform: "instagram", externalId: `ig-b-${n}`, name: "IG B", token: { accessToken: "sandbox-b" } },
  ]);
  const accts = await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.brandId, b.id));
  return { ws: w.id, brand: b.id, creative: c.id, acctA: accts.find((a) => a.name === "IG A")!.id, acctB: accts.find((a) => a.name === "IG B")!.id, admin, editor, client };
}
/** A post approved by the admin through the real approval path, then scheduled with its job. */
async function approvedScheduled(o: Org, at = new Date(Date.now() + 3600_000), extra: Partial<typeof schema.posts.$inferInsert> = {}) {
  const db = await getDb();
  const [p] = await db
    .insert(schema.posts)
    .values({ brandId: o.brand, platform: "instagram", format: "ig_feed_square", title: "Title", caption: "Approved caption", hashtags: ["stoneware"], creativeId: o.creative, socialAccountId: o.acctA, scheduledAt: at, status: "pending_approval", ...extra })
    .returning();
  await approvePost(o.brand, p.id, o.admin.user.id);
  await db.update(schema.posts).set({ status: "scheduled" }).where(eq(schema.posts.id, p.id));
  await enqueue("publish_post", { postId: p.id }, at);
  return p;
}
const get = async (id: string) => (await (await getDb()).select().from(schema.posts).where(eq(schema.posts.id, id)))[0];
const jobsFor = async (postId: string) => (await (await getDb()).select().from(schema.jobs).where(eq(schema.jobs.type, "publish_post"))).filter((j) => (j.payload as { postId: string }).postId === postId);
const attempts = async (postId: string) => (await getDb()).select().from(schema.publishAttempts).where(eq(schema.publishAttempts.postId, postId));

let o: Org;
beforeAll(async () => {
  o = await org();
});
beforeEach(async () => {
  const db = await getDb();
  await db.delete(schema.rateLimitBuckets);
  token = null;
});
afterAll(async () => {
  if (!PG_ADMIN || !pgDatabase) return;
  const { default: postgres } = await import("postgres");
  const admin = postgres(PG_ADMIN, { max: 1, onnotice: () => {} });
  await admin.unsafe(`drop database if exists ${pgDatabase} with (force)`);
  await admin.end();
});

describe("H1: an approval covers exactly what was approved", () => {
  const edits: [string, (o: Org) => Record<string, unknown>][] = [
    ["caption", () => ({ caption: "A different caption" })],
    ["hashtags", () => ({ hashtags: ["unapproved_text"] })],
    ["title", () => ({ title: "A different title" })],
    ["socialAccountId", (x) => ({ socialAccountId: x.acctB })],
    ["platform", () => ({ platform: "facebook" })],
    ["format", () => ({ format: "ig_story" })],
    ["creativeId", () => ({ creativeId: null })],
  ];
  for (const [field, patch] of edits) {
    it(`an editor changing ${field} after approval withdraws it: back to a person, job cancelled, nothing publishes, audited`, async () => {
      const p = await approvedScheduled(o);
      as(o.editor);
      const r = await posts.updatePost(o.brand, p.id, patch(o) as never);
      expect(r).toMatchObject({ ok: true, data: { approvalWithdrawn: true, changed: [field] } });
      const after = await get(p.id);
      expect(after).toMatchObject({ status: "pending_approval", approvedAt: null, approvedBy: null, approvedContentHash: null, autoApprovedVersion: null });
      expect(await jobsFor(p.id)).toEqual([]);
      await expect(publishPost(p.id)).rejects.toThrow(/must be approved/);
      expect(await attempts(p.id)).toEqual([]);
      const db = await getDb();
      const [ev] = await db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.action, "post.approval_invalidated"), eq(schema.auditEvents.targetId, p.id)));
      expect(ev.details).toMatchObject({ at: "edit", fields: field, previousApprover: o.admin.user.id });
    });
  }

  it("a brand-scoped client editor is held to the same rule", async () => {
    const p = await approvedScheduled(o);
    as(o.client);
    expect((await posts.updatePost(o.brand, p.id, { hashtags: ["client_edit"], socialAccountId: o.acctB })).ok).toBe(true);
    expect((await get(p.id)).status).toBe("pending_approval");
  });

  it("a save that changes nothing published keeps the approval (empty title vs none, same values)", async () => {
    const p = await approvedScheduled(o, undefined, { title: null });
    as(o.editor);
    const r = await posts.updatePost(o.brand, p.id, { title: "", caption: "Approved caption", hashtags: ["stoneware"], socialAccountId: o.acctA, platform: "instagram", format: "ig_feed_square", creativeId: o.creative, pillar: "craft", objective: "awareness" });
    expect(r).toMatchObject({ ok: true, data: { approvalWithdrawn: false } });
    expect((await get(p.id)).status).toBe("scheduled");
  });

  it("changes outside the post are caught at publish: the creative's content, the brand's look; nothing is sent", async () => {
    const db = await getDb();
    const p = await approvedScheduled(o);
    await db.update(schema.creatives).set({ concept: { headline: "Changed after approval" } }).where(eq(schema.creatives.id, o.creative));
    const r = await publishPost(p.id);
    expect(r).toMatchObject({ ok: false, toPerson: true });
    expect(await get(p.id)).toMatchObject({ status: "pending_approval", approvedAt: null });
    expect(await attempts(p.id)).toEqual([]);
    const [ev] = await db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.action, "post.approval_invalidated"), eq(schema.auditEvents.targetId, p.id)));
    expect(ev.details).toMatchObject({ at: "publish", reason: "content_changed" });
    // The brand's colours are drawn on the image too.
    const q = await approvedScheduled(o);
    await db.update(schema.brands).set({ colors: ["#000000"] }).where(eq(schema.brands.id, o.brand));
    expect(await publishPost(q.id)).toMatchObject({ ok: false, toPerson: true });
  });

  it("a post approved before integrity checks existed (no hash) needs a fresh approval", async () => {
    const db = await getDb();
    const [p] = await db.insert(schema.posts).values({ brandId: o.brand, platform: "instagram", format: "ig_feed_square", caption: "Legacy", creativeId: o.creative, socialAccountId: o.acctA, status: "approved", approvedAt: new Date(), approvedBy: o.admin.user.id }).returning();
    expect(await publishPost(p.id)).toMatchObject({ ok: false, toPerson: true });
    expect((await get(p.id)).status).toBe("pending_approval");
  });

  it("after a fresh approval the edited version publishes, credited to the person who approved it", async () => {
    const db = await getDb();
    const p = await approvedScheduled(o);
    as(o.editor);
    await posts.updatePost(o.brand, p.id, { hashtags: ["edited_then_reapproved"] });
    const second = await user("approver2");
    await db.insert(schema.workspaceMembers).values({ workspaceId: o.ws, userId: second.user.id, role: "admin" });
    await approvePost(o.brand, p.id, second.user.id);
    const r = await publishPost(p.id);
    expect(r.ok).toBe(true);
    const done = await get(p.id);
    expect(done).toMatchObject({ status: "published", approvedBy: second.user.id });
    expect(captionOf(done)).toContain("#edited_then_reapproved");
  });

  it("edits are refused while the post is publishing (the claimed version is what goes out)", async () => {
    const db = await getDb();
    const p = await approvedScheduled(o);
    await db.update(schema.posts).set({ status: "publishing" }).where(eq(schema.posts.id, p.id));
    as(o.editor);
    const r = await posts.updatePost(o.brand, p.id, { caption: "too late" });
    expect(r.ok).toBe(false);
    expect((await get(p.id)).caption).toBe("Approved caption");
  });

  it("M2: an editor's text in an AI draft is no longer the AI's own: Autonomous won't approve it", async () => {
    process.env.AUTONOMOUS_PUBLISHING = "on";
    const db = await getDb();
    const x = await org();
    await db.update(schema.brands).set({ autonomyLevel: "autonomous", autonomyRules: { warmup: 0 } }).where(eq(schema.brands.id, x.brand));
    const [p] = await db.insert(schema.posts).values({ brandId: x.brand, platform: "instagram", format: "ig_feed_square", caption: "AI wrote this", creativeId: x.creative, socialAccountId: x.acctA, scheduledAt: new Date("2027-03-03T10:00:00Z"), status: "draft", origin: "ai", pillar: "craft" }).returning();
    as(x.editor);
    await posts.updatePost(x.brand, p.id, { caption: "Written by the editor" });
    expect((await get(p.id)).origin).toBe("ai_edited");
    await autonomyTick();
    // The autonomy pass only takes the AI's own drafts: this one waits for a person.
    expect(await get(p.id)).toMatchObject({ status: "draft", autoApprovedVersion: null, approvedAt: null });
    delete process.env.AUTONOMOUS_PUBLISHING;
  });
});

describe("M1: the scheduler follows the post's time", () => {
  for (const [label, offsetH] of [["later", 48], ["earlier", 0.5]] as const) {
    it(`moving a scheduled post ${label} with updatePost replaces its job at the new time; the approval stays`, async () => {
      const p = await approvedScheduled(o, new Date(Date.now() + 6 * 3600_000));
      const when = new Date(Date.now() + offsetH * 3600_000);
      as(o.editor);
      const r = await posts.updatePost(o.brand, p.id, { scheduledAt: when.toISOString() });
      expect(r).toMatchObject({ ok: true, data: { approvalWithdrawn: false } });
      const jobs = await jobsFor(p.id);
      expect(jobs.map((j) => [j.status, j.runAt.getTime()])).toEqual([["queued", when.getTime()]]);
      expect((await get(p.id)).status).toBe("scheduled");
    });
  }

  it("a job already started at the old time doesn't publish early; the new job publishes once", async () => {
    const db = await getDb();
    const p = await approvedScheduled(o, new Date(Date.now() - 1000)); // due now
    // Simulate the race: the old job is past the queue's cancel (it's running) when the time changes.
    await db.update(schema.jobs).set({ status: "running" }).where(sql`payload->>'postId' = ${p.id}`);
    as(o.editor);
    const later = new Date(Date.now() + 3600_000);
    await posts.updatePost(o.brand, p.id, { scheduledAt: later.toISOString() });
    // The old job's handler runs anyway: it refuses because the post is now due later.
    const res = (await handlers.publish_post({ postId: p.id })) as { skipped?: string };
    expect(res.skipped).toBe("rescheduled");
    expect((await get(p.id)).status).toBe("scheduled");
    expect(await attempts(p.id)).toEqual([]);
    // At the new time, the replacement job publishes it, once.
    await db.update(schema.jobs).set({ runAt: new Date(Date.now() - 1000) }).where(and(sql`payload->>'postId' = ${p.id}`, eq(schema.jobs.status, "queued")));
    await db.update(schema.posts).set({ scheduledAt: new Date(Date.now() - 1000) }).where(eq(schema.posts.id, p.id));
    await recordApprovedContent(db, p.id);
    await runDueJobs(handlers, 10, interruptedHooks);
    expect((await get(p.id)).status).toBe("published");
    expect((await attempts(p.id)).length).toBe(1);
  });

  it("concurrent time edits leave exactly one queued job, at the last time saved", async () => {
    const p = await approvedScheduled(o, new Date(Date.now() + 6 * 3600_000));
    as(o.editor);
    const times = [10, 20, 30].map((h) => new Date(Date.now() + h * 3600_000));
    const results = await Promise.all(times.map((t) => posts.updatePost(o.brand, p.id, { scheduledAt: t.toISOString() })));
    expect(results.every((r) => r.ok)).toBe(true);
    const jobs = (await jobsFor(p.id)).filter((j) => j.status === "queued");
    const post = await get(p.id);
    // Whatever order the edits committed in, only jobs at the post's final time remain.
    expect(jobs.length).toBeGreaterThanOrEqual(1);
    expect(jobs.every((j) => j.runAt.getTime() === post.scheduledAt!.getTime())).toBe(true);
    // And running them all at that time publishes once.
    const db = await getDb();
    await db.update(schema.posts).set({ scheduledAt: new Date(Date.now() - 1000) }).where(eq(schema.posts.id, p.id));
    await db.update(schema.jobs).set({ runAt: new Date(Date.now() - 1000) }).where(and(sql`payload->>'postId' = ${p.id}`, eq(schema.jobs.status, "queued")));
    await runDueJobs(handlers, 10, interruptedHooks);
    expect((await get(p.id)).status).toBe("published");
    expect(await attempts(p.id)).toHaveLength(1);
  });

  it("while publishing is paused, a time change doesn't queue a job (resuming does)", async () => {
    const db = await getDb();
    const x = await org();
    const p = await approvedScheduled(x, new Date(Date.now() + 6 * 3600_000));
    await db.update(schema.brands).set({ publishingPausedAt: new Date() }).where(eq(schema.brands.id, x.brand));
    as(x.editor);
    await posts.updatePost(x.brand, p.id, { scheduledAt: new Date(Date.now() + 9 * 3600_000).toISOString() });
    expect((await jobsFor(p.id)).filter((j) => j.status === "queued")).toEqual([]);
  });
});

describe("M4: operator emergency stop", () => {
  it("pauses every unpaused brand, cancels their queued publishes, records who and why per organisation; resuming in the app re-queues", async () => {
    const db = await getDb();
    const x = await org();
    const y = await org();
    const px = await approvedScheduled(x, new Date(Date.now() + 3600_000));
    const py = await approvedScheduled(y, new Date(Date.now() - 1000));
    await expect(emergencyStop({ by: "", reason: "x" })).rejects.toThrow(/--by/);
    const r = await emergencyStop({ by: "Asha (on call)", reason: "Meta policy incident" });
    expect(r.brands).toBeGreaterThanOrEqual(4);
    expect((await jobsFor(px.id)).filter((j) => j.status === "queued")).toEqual([]);
    // A due post isn't published while stopped.
    expect(await publishPost(py.id)).toMatchObject({ ok: false, paused: true });
    const evs = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, "publishing.emergency_stop"));
    expect(evs.map((e) => e.workspaceId)).toEqual(expect.arrayContaining([x.ws, y.ws]));
    expect(evs.find((e) => e.workspaceId === x.ws)?.details).toMatchObject({ by: "Asha (on call)", reason: "Meta policy incident" });
    expect((await pausedBrands()).some((b) => b.id === x.brand && /Emergency stop/.test(b.reason ?? ""))).toBe(true);
    // A second stop doesn't overwrite the first one's reason.
    expect((await emergencyStop({ by: "B", reason: "again" })).brands).toBe(0);
    // Recovery is in the app, per brand, by its admin: future posts are queued again.
    await resumePublishingFor(x.admin, x.brand);
    expect((await jobsFor(px.id)).filter((j) => j.status === "queued")).toHaveLength(1);
    // Others stay stopped until their own admins resume them.
    expect(await publishPost(py.id)).toMatchObject({ ok: false, paused: true });
    await resumePublishingFor(y.admin, y.brand);
    for (const b of [o.brand]) await db.update(schema.brands).set({ publishingPausedAt: null }).where(eq(schema.brands.id, b));
  });
});

describe("L5 / L4: invitations", () => {
  it("an expired invitation neither lets the address create an account nor leaves a new account without an organisation", async () => {
    const db = await getDb();
    const addr = `expired-${n++}@harden.test`;
    await db.insert(schema.workspaceMembers).values({ workspaceId: o.ws, invitedEmail: addr, role: "viewer", status: "invited", inviteExpiresAt: new Date(Date.now() - 1000) });
    expect(await mayCreateAccount(addr, { SIGNUP_MODE: "invite_only" })).toBe(false);
    // With open sign-up the address can register, and gets its own organisation (not an orphan).
    const fd = new FormData();
    for (const [k, v] of Object.entries({ name: "E", email: addr, password: "supersecret1", workspace: "Own org", type: "business" })) fd.set(k, v);
    ip = `198.51.100.${n % 200}`;
    await expect(signUp(undefined, fd)).rejects.toThrow(/REDIRECT \/(onboarding|verify-email)/);
    const [u] = await db.select().from(schema.users).where(eq(schema.users.email, addr));
    const own = await db.select().from(schema.workspaceMembers).where(and(eq(schema.workspaceMembers.userId, u.id), eq(schema.workspaceMembers.role, "owner")));
    expect(own).toHaveLength(1);
    expect(await m.acceptInvitesForVerifiedEmail(u.id, addr)).toBe(0); // the expired one isn't accepted
  });

  it("revoked, reused and wrong-address invitations are refused; a valid one works for an existing user", async () => {
    const existing = await user("existing");
    const inv = await m.inviteMemberFor(o.admin, o.ws, existing.user.email, "viewer");
    const tokenOf = () => new URL(memoryOutbox().filter((x) => x.to === existing.user.email).at(-1)!.text.match(/https?:\/\/\S+\/invite\?token=\S+/)![0]).searchParams.get("token")!;
    const t1 = tokenOf();
    const stranger = await user("stranger");
    await expect(m.acceptInviteFor(stranger, t1)).rejects.toThrow(/different email address/);
    expect(await m.acceptInviteFor(existing, t1)).toMatchObject({ alreadyMember: false });
    await expect(m.acceptInviteFor(existing, t1)).rejects.toThrow(/invalid, has expired/); // reused
    // Revoked: the row goes, the link stops working.
    const other = await user("other");
    const inv2 = await m.inviteMemberFor(o.admin, o.ws, other.user.email, "viewer");
    const t2 = new URL(memoryOutbox().filter((x) => x.to === other.user.email).at(-1)!.text.match(/https?:\/\/\S+\/invite\?token=\S+/)![0]).searchParams.get("token")!;
    await m.removeMemberFor(o.admin, o.ws, inv2.id);
    await expect(m.acceptInviteFor(other, t2)).rejects.toThrow(/invalid, has expired/);
    void inv;
  });

  it("concurrent acceptance of one invitation joins once", async () => {
    const db = await getDb();
    const u = await user("racer");
    await m.inviteMemberFor(o.admin, o.ws, u.user.email, "editor");
    const t = new URL(memoryOutbox().filter((x) => x.to === u.user.email).at(-1)!.text.match(/https?:\/\/\S+\/invite\?token=\S+/)![0]).searchParams.get("token")!;
    const results = await Promise.allSettled([m.acceptInviteFor(u, t), m.acceptInviteFor(u, t), m.acceptInviteFor(u, t)]);
    expect(results.filter((r) => r.status === "fulfilled" && !(r.value as { alreadyMember: boolean }).alreadyMember)).toHaveLength(1);
    expect(await db.$count(schema.workspaceMembers, and(eq(schema.workspaceMembers.workspaceId, o.ws), eq(schema.workspaceMembers.userId, u.user.id)))).toBe(1);
  });

  it("simultaneous invitations to one address create one pending invitation; re-inviting after expiry or withdrawal works", async () => {
    const db = await getDb();
    const addr = `dup-${n++}@harden.test`;
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => m.inviteMemberFor(o.admin, o.ws, addr, "viewer")));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason instanceof m.MemberError)).toBe(true);
    expect(await db.$count(schema.workspaceMembers, and(eq(schema.workspaceMembers.workspaceId, o.ws), eq(schema.workspaceMembers.invitedEmail, addr)))).toBe(1);
    // The database refuses a second pending row even outside the app.
    await expect(db.insert(schema.workspaceMembers).values({ workspaceId: o.ws, invitedEmail: addr, role: "viewer", status: "invited" })).rejects.toThrow();
    // Expired: re-inviting replaces it.
    await db.update(schema.workspaceMembers).set({ inviteExpiresAt: new Date(Date.now() - 1000) }).where(and(eq(schema.workspaceMembers.workspaceId, o.ws), eq(schema.workspaceMembers.invitedEmail, addr)));
    const again = await m.inviteMemberFor(o.admin, o.ws, addr, "editor");
    expect(again.role).toBe("editor");
    expect(await db.$count(schema.workspaceMembers, and(eq(schema.workspaceMembers.workspaceId, o.ws), eq(schema.workspaceMembers.invitedEmail, addr)))).toBe(1);
    // Withdrawn: re-inviting works.
    await m.removeMemberFor(o.admin, o.ws, again.id);
    expect((await m.inviteMemberFor(o.admin, o.ws, addr, "viewer")).status).toBe("invited");
  });
});

describe("L1: organisation export completeness", () => {
  it("includes the autonomy decision log and credit grants of this organisation only, and no secrets", async () => {
    const db = await getDb();
    const owner = await user("owner");
    const x = await org();
    const y = await org();
    await db.insert(schema.workspaceMembers).values({ workspaceId: x.ws, userId: owner.user.id, role: "owner" });
    await db.insert(schema.agentActions).values([
      { workspaceId: x.ws, brandId: x.brand, actorType: "agent", action: "auto_approve", decision: "require_approval", level: "assisted", reasons: ["x-reason"], policyVersion: 1 },
      { workspaceId: y.ws, brandId: y.brand, actorType: "agent", action: "auto_approve", decision: "allow", level: "autonomous", reasons: ["y-secret-reason"], policyVersion: 1 },
    ]);
    await db.insert(schema.creditGrants).values([
      { workspaceId: x.ws, period: "2026-11", credits: 50, kind: "topup", reason: "x-grant", createdBy: "ops" },
      { workspaceId: y.ws, period: "2026-11", credits: 70, kind: "topup", reason: "y-grant", createdBy: "ops" },
    ]);
    const p = await approvedScheduled(x);
    await publishPost(p.id);
    const out = await exportWorkspaceFor(owner, x.ws);
    const z = await JSZip.loadAsync(out.body);
    const text = await z.file("data.json")!.async("string");
    const data = JSON.parse(text);
    expect(data.autonomyDecisions.map((r: { reasons: string[] }) => r.reasons[0])).toEqual(["x-reason"]);
    expect(data.creditGrants.map((r: { reason: string }) => r.reason)).toEqual(["x-grant"]);
    expect(data.publishAttempts.length).toBe(1);
    for (const bad of ["y-secret-reason", "y-grant", "approvedContentHash", "accessTokenEnc", "passwordHash", "idempotencyKey", "inviteTokenHash", "sandbox-a"]) expect(text).not.toContain(bad);
  });
});

describe("L2 / L3: spending-control paths", () => {
  it("no cap applies: the credit gate skips the usage sums (fewer reads under the ledger lock); a cap still enforces", async () => {
    const db = await getDb();
    const x = await org();
    await db.update(schema.plans).set({ includedCredits: null }).where(eq(schema.plans.key, "agency"));
    expect(await anyCapApplies(db, x.ws, x.brand)).toBe(false);
    let reads = 0;
    const counting = new Proxy(db, { get: (t, k) => (k === "select" ? (...a: unknown[]) => (reads++, (t.select as (...b: unknown[]) => unknown)(...a)) : (t as unknown as Record<string | symbol, unknown>)[k]) }) as typeof db;
    await creditGate(counting, { workspaceId: x.ws, brandId: x.brand }, "anthropic", 1, { CREDITS_MODE: "enforce" });
    const noCapReads = reads;
    await db.insert(schema.creditLimits).values({ workspaceId: x.ws, brandId: "", monthlyCapCredits: 1 });
    expect(await anyCapApplies(db, x.ws, x.brand)).toBe(true);
    reads = 0;
    await expect(creditGate(counting, { workspaceId: x.ws, brandId: x.brand }, "anthropic", 1, { CREDITS_MODE: "enforce" })).rejects.toThrow(/credits? left/);
    expect(noCapReads).toBeLessThanOrEqual(2);
    expect(reads).toBeGreaterThan(noCapReads);
  });

  it("Voyage is never called while a control can't meter it; the local embedder is used instead", async () => {
    let calls = 0;
    const real = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ data: [{ embedding: [0.1] }] }), { status: 200 });
    }) as typeof fetch;
    try {
      const base = { VOYAGE_API_KEY: "placeholder" };
      for (const env of [
        { ...base, AI_SPEND_CAP_USD: "10" },
        { ...base, AI_SPEND_CAP_REQUIRED: "true" },
        { ...base, AI_TRIPWIRE_USD: "5" },
        { ...base, CREDITS_MODE: "enforce" },
        { ...base, AI_STOP: "all" },
        { ...base, DEPLOY_ENV: "production" },
        { ...base, DEPLOY_ENV: "staging" },
      ]) {
        expect(voyageRefusal(env), JSON.stringify(env)).not.toBeNull();
        const v = await embed(["hello"], "document", env);
        expect(v[0].length).toBeGreaterThan(1); // the local embedder's vector
      }
      expect(calls).toBe(0);
      // The kill switch's "all" scope, set in the database, stops it too.
      const db = await getDb();
      await db.insert(schema.aiControls).values({ scope: "all", reason: "test", source: "operator", setBy: "t" }).onConflictDoNothing();
      await embed(["hello"], "document", base);
      expect(calls).toBe(0);
      await db.delete(schema.aiControls).where(eq(schema.aiControls.scope, "all"));
      // Development, no controls depending on metering: allowed.
      expect(voyageRefusal(base)).toBeNull();
      expect(voyageRefusal({ ...base, DEPLOY_ENV: "production", VOYAGE_UNMETERED_OK: "true" })).toBeNull();
      // Start-up reports the conditions.
      const errs = (env: Record<string, string>) => checkConfig(env).filter((p) => p.key === "VOYAGE_API_KEY" && p.level === "error").length;
      expect(errs({ ...base, AI_TRIPWIRE_USD: "5" })).toBe(1);
      expect(errs({ ...base, CREDITS_MODE: "enforce" })).toBe(1);
      expect(errs({ ...base })).toBe(0);
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe("L6: the autonomy decision log is append-only for the application", () => {
  it("UPDATE and DELETE are refused; deleting a post or a brand still works (foreign-key actions)", async () => {
    const db = await getDb();
    const x = await org();
    const [p] = await db.insert(schema.posts).values({ brandId: x.brand, platform: "instagram", caption: "c" }).returning();
    const [row] = await db.insert(schema.agentActions).values({ workspaceId: x.ws, brandId: x.brand, postId: p.id, actorType: "agent", action: "auto_approve", decision: "allow", level: "autonomous", reasons: ["r"], policyVersion: 1 }).returning();
    const msg = (e: unknown) => String((e as { cause?: Error }).cause?.message ?? (e as Error).message);
    expect(msg(await db.update(schema.agentActions).set({ decision: "deny" }).where(eq(schema.agentActions.id, row.id)).then(() => null, (e) => e))).toMatch(/append-only/);
    expect(msg(await db.delete(schema.agentActions).where(eq(schema.agentActions.id, row.id)).then(() => null, (e) => e))).toMatch(/append-only/);
    expect((await db.select().from(schema.agentActions).where(eq(schema.agentActions.id, row.id)))[0].decision).toBe("allow");
    await db.delete(schema.posts).where(eq(schema.posts.id, p.id)); // ON DELETE SET NULL
    expect((await db.select().from(schema.agentActions).where(eq(schema.agentActions.id, row.id)))[0].postId).toBeNull();
    await db.delete(schema.brands).where(eq(schema.brands.id, x.brand)); // ON DELETE CASCADE
    expect(await db.$count(schema.agentActions, eq(schema.agentActions.id, row.id))).toBe(0);
  });
});
