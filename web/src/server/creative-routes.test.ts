import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";

process.env.AI_PROVIDER = "mock";
process.env.PGLITE_DIR = "memory://";
process.env.IMAGE_PROVIDER = "none";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bp-croutes-"));

// Requests carry a real session token; only the cookie jar is stubbed.
let token: string | null = null;
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => (n === "bp_session" && token ? { value: token } : undefined), set() {}, delete() {} }) }));

const { getDb, schema } = await import("./db/client");
const { sha256 } = await import("./crypto");
const { GET: image } = await import("../app/api/creatives/[id]/image/route");
const { GET: zip } = await import("../app/api/creatives/[id]/zip/route");

const users: Record<string, string> = {};
let carouselId = "", singleOther = "";

async function login(name: string) {
  token = `tok-${name}`;
}
const get = (route: typeof image, id: string, qs = "") => route(new Request(`http://localhost/api/creatives/${id}/x${qs}`), { params: Promise.resolve({ id }) });

beforeAll(async () => {
  const db = await getDb();
  for (const n of ["owner", "client", "outsider"]) {
    const [u] = await db.insert(schema.users).values({ email: `${n}@x.test`, name: n, passwordHash: "x" }).returning();
    users[n] = u.id;
    await db.insert(schema.sessions).values({ id: sha256(`tok-${n}`), userId: u.id, expiresAt: new Date(Date.now() + 864e5) });
  }
  const [w] = await db.insert(schema.workspaces).values({ name: "Agency", plan: "agency" }).returning();
  const [w2] = await db.insert(schema.workspaces).values({ name: "Other" }).returning();
  const [a, b] = await db.insert(schema.brands).values([{ workspaceId: w.id, name: "Kora" }, { workspaceId: w.id, name: "Northwind" }]).returning();
  const [o] = await db.insert(schema.brands).values({ workspaceId: w2.id, name: "Rival" }).returning();
  await db.insert(schema.workspaceMembers).values([
    { workspaceId: w.id, userId: users.owner, role: "owner" },
    { workspaceId: w.id, userId: users.client, role: "viewer", brandIds: [b.id] },
    { workspaceId: w2.id, userId: users.outsider, role: "owner" },
  ]);
  const concept = { title: "Made to last", headline: "Made to last", subline: "Small batches", cta: "Shop", layout: "typographic", palette: { background: "#F3EDE4", foreground: "#2B2620", accent: "#B5643C" }, imagePrompt: "", imageTreatment: "", rationale: "" };
  const [c] = await db
    .insert(schema.creatives)
    .values({ brandId: a.id, format: "instagram_post", style: "minimalist_luxury", kind: "carousel", visualSource: "typographic", concept, slides: [{ headline: "Two", body: "b" }, { headline: "Three", body: "b" }, { headline: "Four", body: "b" }], copy: { primary: "Forty hours for one bowl.", hashtags: ["slowmade", "stoneware"] } })
    .returning();
  carouselId = c.id;
  const [x] = await db.insert(schema.creatives).values({ brandId: o.id, format: "instagram_post", style: "minimalist_luxury", visualSource: "typographic", concept }).returning();
  singleOther = x.id;
});
beforeEach(async () => {
  const db = await getDb();
  await db.delete(schema.rateLimitBuckets);
  token = null;
});

describe("creative image route", () => {
  it("renders each slide and resize for a member, and validates parameters", async () => {
    await login("owner");
    for (const qs of ["", "?slide=1", "?slide=3", "?format=instagram_story&slide=2"]) {
      const r = await get(image, carouselId, qs);
      expect(r.status, qs).toBe(200);
      expect(r.headers.get("content-type")).toBe("image/png");
    }
    expect((await get(image, carouselId, "?slide=4")).status).toBe(400);
    expect((await get(image, carouselId, "?slide=-1")).status).toBe(400);
    expect((await get(image, carouselId, "?slide=1.5")).status).toBe(400);
    expect((await get(image, carouselId, "?format=billboard")).status).toBe(400);
    const dl = await get(image, carouselId, "?slide=2&download=1");
    expect(dl.headers.get("content-disposition")).toMatch(/attachment; filename="kora-made-to-last-slide-3-1080x1350\.png"/);
  });

  it("refuses anonymous users, other organisations and clients scoped to other brands", async () => {
    expect((await get(image, carouselId)).status).toBe(403);
    await login("outsider");
    expect((await get(image, carouselId)).status).toBe(403);
    await login("client"); // viewer limited to Northwind; the creative belongs to Kora
    expect((await get(image, carouselId)).status).toBe(403);
    await login("owner");
    expect((await get(image, singleOther)).status).toBe(403);
    expect((await get(image, "does-not-exist")).status).toBe(404);
  });
});

describe("creative ZIP route", () => {
  it("bundles every slide and the caption", async () => {
    await login("owner");
    const r = await get(zip, carouselId);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/zip");
    expect(r.headers.get("cache-control")).toContain("no-store");
    const z = await JSZip.loadAsync(Buffer.from(await r.arrayBuffer()));
    const names = Object.keys(z.files).sort();
    expect(names).toEqual(["caption.txt", "kora-made-to-last-1080x1350-01.png", "kora-made-to-last-1080x1350-02.png", "kora-made-to-last-1080x1350-03.png", "kora-made-to-last-1080x1350-04.png"]);
    expect(await z.file("caption.txt")!.async("string")).toBe("Forty hours for one bowl.\n\n#slowmade #stoneware\n");
    const png = await z.file(names[1])!.async("nodebuffer");
    expect(png.subarray(1, 4).toString()).toBe("PNG");
  });

  it("is protected like the image route", async () => {
    expect((await get(zip, carouselId)).status).toBe(403);
    await login("outsider");
    expect((await get(zip, carouselId)).status).toBe(403);
    await login("client");
    expect((await get(zip, carouselId)).status).toBe(403);
    await login("owner");
    expect((await get(zip, carouselId, "?format=nope")).status).toBe(400);
  });
});
