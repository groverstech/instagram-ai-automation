"use server";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/server/db/client";
import { getSession, setActiveBrand } from "@/server/auth/session";
import { AccessError, requireBrand, listAccessibleBrands } from "@/server/auth/guard";
import { roleAtLeast } from "@/lib/roles";
import { storage, extFor } from "@/server/storage";
import { safe } from "@/server/action";
import { generateBrandProfile, saveProfileEdits, approveProfile } from "@/server/agents/brand";
import { BrandProfile } from "@/server/agents/schemas";
import { remember } from "@/server/memory";
import { assertAiQuota, assertCanAdd } from "@/server/quota";
import { splitList } from "@/lib/utils";
import type { AssetKind } from "@/server/db/schema";

const ASSET_KINDS: AssetKind[] = ["logo", "guideline", "product", "creative", "reference", "post"];
const ALLOWED = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml", "application/pdf"]);

const BrandInput = z.object({
  name: z.string({ error: "Brand name is required" }).trim().min(1, "Brand name is required"),
  website: z.string().trim().optional(),
  industry: z.string().trim().optional(),
  category: z.string().trim().optional(),
  products: z.string().trim().optional(),
  targetAudience: z.string().trim().optional(),
  geography: z.string().trim().optional(),
  positioning: z.string().trim().optional(),
  personality: z.string().trim().optional(),
  tone: z.string().trim().optional(),
  marketingGoals: z.string().trim().optional(),
  objectives: z.array(z.string()).default([]),
  platforms: z.array(z.string()).default([]),
  competitors: z.array(z.string()).default([]),
  colors: z.array(z.string()).default([]),
  headingFont: z.string().trim().optional(),
  bodyFont: z.string().trim().optional(),
});

function parseBrandForm(fd: FormData) {
  const raw: Record<string, unknown> = {};
  for (const k of ["name", "website", "industry", "category", "products", "targetAudience", "geography", "positioning", "personality", "tone", "marketingGoals", "headingFont", "bodyFont"]) {
    const v = String(fd.get(k) ?? "").trim();
    raw[k] = v || undefined;
  }
  raw.objectives = fd.getAll("objectives").map(String);
  raw.platforms = fd.getAll("platforms").map(String);
  raw.competitors = splitList(String(fd.get("competitors") ?? ""));
  raw.colors = splitList(String(fd.get("colors") ?? "")).filter((c) => /^#?[0-9a-f]{3,8}$/i.test(c)).map((c) => (c.startsWith("#") ? c : `#${c}`));
  return BrandInput.parse(raw);
}

async function saveUploads(brandId: string, fd: FormData) {
  const db = await getDb();
  let saved = 0;
  for (const kind of ASSET_KINDS) {
    for (const f of fd.getAll(`asset_${kind}`)) {
      if (!(f instanceof File) || !f.size) continue;
      if (!ALLOWED.has(f.type)) throw new Error(`${f.name}: unsupported file type (${f.type || "unknown"}).`);
      if (f.size > 15 * 1024 * 1024) throw new Error(`${f.name} is larger than 15 MB.`);
      const id = crypto.randomUUID();
      const key = `brands/${brandId}/assets/${id}.${extFor(f.type)}`;
      await storage.put(key, Buffer.from(await f.arrayBuffer()), f.type);
      await db.insert(schema.brandAssets).values({ id, brandId, kind, name: f.name.slice(0, 200), path: key, mime: f.type, size: f.size });
      saved++;
    }
  }
  return saved;
}

export async function createBrand(fd: FormData) {
  return safe(async () => {
    const session = await getSession();
    if (!session) throw new AccessError("Not signed in.");
    const db = await getDb();
    const [m] = await db.select().from(schema.workspaceMembers).where(and(eq(schema.workspaceMembers.userId, session.user.id), eq(schema.workspaceMembers.status, "active")));
    if (!m || !roleAtLeast(m.role, "admin")) throw new AccessError("You need admin access to add a brand.");
    await assertCanAdd(m.workspaceId, "brands");
    const input = parseBrandForm(fd);
    const { headingFont, bodyFont, ...rest } = input;
    const [brand] = await db
      .insert(schema.brands)
      .values({ ...rest, workspaceId: m.workspaceId, fonts: { heading: headingFont || undefined, body: bodyFont || undefined } })
      .returning();
    await saveUploads(brand.id, fd);
    await setActiveBrand(session.sessionId, brand.id);
    return { brandId: brand.id };
  });
}

export async function updateBrand(brandId: string, fd: FormData) {
  return safe(async () => {
    await requireBrand(brandId, "editor");
    const { headingFont, bodyFont, ...rest } = parseBrandForm(fd);
    const db = await getDb();
    const nulls = Object.fromEntries(["website", "industry", "category", "products", "targetAudience", "geography", "positioning", "personality", "tone", "marketingGoals"].map((k) => [k, (rest as Record<string, unknown>)[k] ?? null]));
    await db.update(schema.brands).set({ ...rest, ...nulls, fonts: { heading: headingFont || undefined, body: bodyFont || undefined } }).where(eq(schema.brands.id, brandId));
    revalidatePath("/brand");
  });
}

export async function uploadAssets(brandId: string, fd: FormData) {
  return safe(async () => {
    await requireBrand(brandId, "editor");
    const n = await saveUploads(brandId, fd);
    revalidatePath("/brand");
    return n;
  });
}

export async function deleteAsset(brandId: string, assetId: string) {
  return safe(async () => {
    await requireBrand(brandId, "editor");
    const db = await getDb();
    const [a] = await db.delete(schema.brandAssets).where(and(eq(schema.brandAssets.id, assetId), eq(schema.brandAssets.brandId, brandId))).returning();
    if (a) await storage.remove(a.path);
    revalidatePath("/brand");
  });
}

export async function switchBrand(brandId: string) {
  return safe(async () => {
    const { session } = await requireBrand(brandId, "viewer");
    await setActiveBrand(session.sessionId, brandId);
    revalidatePath("/", "layout");
  });
}

export async function runBrandIntelligence(brandId: string) {
  return safe(async () => {
    const { brand, session } = await requireBrand(brandId, "editor");
    await assertAiQuota(brandId);
    const p = await generateBrandProfile({ brandId, userId: session.user.id }, brand);
    revalidatePath("/brand");
    revalidatePath("/dashboard");
    return { profileId: p.id };
  });
}

export async function saveProfile(brandId: string, profileId: string, data: unknown) {
  return safe(async () => {
    await requireBrand(brandId, "editor");
    await saveProfileEdits(brandId, profileId, BrandProfile.parse(data));
    await remember(brandId, [{ kind: "feedback", content: "User edited the brand profile; the edited version reflects their intent.", source: "profile:edit", weight: 0.5 }]);
    revalidatePath("/brand");
  });
}

export async function approveBrandProfile(brandId: string, profileId: string) {
  return safe(async () => {
    const { session } = await requireBrand(brandId, "admin");
    await approveProfile(brandId, profileId, session.user.id);
    revalidatePath("/", "layout");
  });
}

export async function addBrandNote(brandId: string, note: string) {
  return safe(async () => {
    await requireBrand(brandId, "editor");
    await remember(brandId, [{ kind: "preference", content: note, source: "user:note", weight: 1.6 }]);
    revalidatePath("/brand");
  });
}

export async function deleteMemory(brandId: string, memoryId: string) {
  return safe(async () => {
    await requireBrand(brandId, "editor");
    const db = await getDb();
    await db.delete(schema.brandMemories).where(and(eq(schema.brandMemories.id, memoryId), eq(schema.brandMemories.brandId, brandId)));
    revalidatePath("/brand");
  });
}

export async function myBrands() {
  const s = await getSession();
  if (!s) return [];
  return (await listAccessibleBrands(s.user.id)).map((b) => ({ id: b.brand.id, name: b.brand.name, role: b.role }));
}
