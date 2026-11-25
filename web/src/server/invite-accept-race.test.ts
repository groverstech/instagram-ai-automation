/**
 * Concurrent acceptance of one invitation (pre-beta hardening, both halves of the fix in
 * members.ts acceptInviteFor), made deterministic: the second acceptance is run at exactly the
 * point that used to go wrong, between the first acceptance's reads.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

process.env.AI_PROVIDER = "mock";
process.env.PGLITE_DIR = "memory://";
process.env.EMAIL_PROVIDER = "memory";

/** When set, the next getDb() returns a database whose reads call this hook after each one resolves. */
let interceptNext: ((nthRead: number) => Promise<void>) | null = null;
function interceptReads<T extends object>(db: T, hook: (n: number) => Promise<void>): T {
  let n = 0;
  const chain = (obj: object): object =>
    new Proxy(obj, {
      get(t, k) {
        const v = Reflect.get(t, k, t);
        if (k === "then" && typeof v === "function") {
          return (res: (x: unknown) => void, rej: (e: unknown) => void) =>
            (v as (a: unknown, b: unknown) => unknown).call(t, async (val: unknown) => {
              await hook(++n);
              res(val);
            }, rej);
        }
        if (typeof v === "function") {
          return (...a: unknown[]) => {
            const out = (v as (...b: unknown[]) => unknown).apply(t, a);
            return out && typeof out === "object" ? chain(out) : out;
          };
        }
        return v;
      },
    });
  return new Proxy(db, {
    get(t, k) {
      const v = Reflect.get(t, k, t);
      if (k === "select") return (...a: unknown[]) => chain((v as (...b: unknown[]) => object).apply(t, a));
      return typeof v === "function" ? (v as (...b: unknown[]) => unknown).bind(t) : v;
    },
  });
}
vi.mock("./db/client", async (importOriginal) => {
  const real = await importOriginal<typeof import("./db/client")>();
  return {
    ...real,
    getDb: async () => {
      const db = await real.getDb();
      if (!interceptNext) return db;
      const hook = interceptNext;
      interceptNext = null;
      return interceptReads(db, hook);
    },
  };
});

const { getDb, schema } = await import("./db/client");
const { sha256 } = await import("./crypto");
const m = await import("./members");
type SessionUser = import("./auth/session").SessionUser;

let ws = "";
let n = 0;
async function invitee() {
  const db = await getDb();
  const email = `invitee-${n++}@race.test`;
  const [u] = await db.insert(schema.users).values({ email, name: "Invitee", passwordHash: "x", emailVerifiedAt: new Date() }).returning();
  const s: SessionUser = { sessionId: `s-${u.id}`, activeBrandId: null, user: { id: u.id, email, name: "Invitee" }, emailVerified: true };
  const token = `invite-token-${u.id}`;
  const [inv] = await db.insert(schema.workspaceMembers).values({ workspaceId: ws, invitedEmail: email, role: "editor", status: "invited", inviteTokenHash: sha256(token), inviteExpiresAt: new Date(Date.now() + 864e5) }).returning();
  return { s, token, inviteId: inv.id };
}
const rowsFor = async (userId: string) => (await getDb()).select().from(schema.workspaceMembers).where(and(eq(schema.workspaceMembers.workspaceId, ws), eq(schema.workspaceMembers.userId, userId)));

beforeAll(async () => {
  const db = await getDb();
  const [w] = await db.insert(schema.workspaces).values({ name: "Race Org", plan: "agency" }).returning();
  ws = w.id;
});

describe("concurrent acceptance of one invitation", () => {
  it("a second acceptance that read the invitation before the first one accepted it is refused; the membership the first created stays", async () => {
    const { s, token, inviteId } = await invitee();
    let first: unknown = null;
    // B reads the pending invitation; right then, A accepts it; then B continues.
    interceptNext = async (nth) => {
      if (nth === 1) first = await m.acceptInviteFor(s, token);
    };
    const second = await m.acceptInviteFor(s, token).then(
      (r) => ({ ok: r }),
      (e) => ({ err: e as Error }),
    );
    expect(first).toMatchObject({ alreadyMember: false });
    // B must not treat A's fresh membership as "already a member through another row" (the
    // check excludes the invitation's own row): the invitation is spent, so B is refused.
    expect(second).toMatchObject({ err: expect.any(m.MemberError) });
    const rows = await rowsFor(s.user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: inviteId, status: "active" });
  });

  it("withdrawing the invitation of someone who's already a member deletes it only while it's still pending, never a membership it has just become", async () => {
    const db = await getDb();
    const { s, token, inviteId } = await invitee();
    // Already a member through another row.
    await db.insert(schema.workspaceMembers).values({ workspaceId: ws, userId: s.user.id, role: "viewer", status: "active" });
    // Right after B reads the invitation, it becomes a membership by another path.
    interceptNext = async (nth) => {
      if (nth === 1) await db.update(schema.workspaceMembers).set({ userId: s.user.id, status: "active", inviteTokenHash: null }).where(eq(schema.workspaceMembers.id, inviteId));
    };
    expect(await m.acceptInviteFor(s, token)).toMatchObject({ alreadyMember: true });
    const rows = await rowsFor(s.user.id);
    expect(rows.map((r) => r.id)).toContain(inviteId);
  });

  it("without interference, an already-member's spare invitation is withdrawn", async () => {
    const db = await getDb();
    const { s, token, inviteId } = await invitee();
    await db.insert(schema.workspaceMembers).values({ workspaceId: ws, userId: s.user.id, role: "viewer", status: "active" });
    expect(await m.acceptInviteFor(s, token)).toMatchObject({ alreadyMember: true });
    expect(await db.$count(schema.workspaceMembers, eq(schema.workspaceMembers.id, inviteId))).toBe(0);
  });
});
