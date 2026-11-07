"use server";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/server/db/client";
import { setActiveBrand } from "@/server/auth/session";
import { AccessError, requireBrand, requireWorkspaceRole } from "@/server/auth/guard";
import { storage } from "@/server/storage";
import { extFor, validateUpload, MAX_FILES_PER_UPLOAD, MAX_TOTAL_UPLOAD_BYTES, UploadError } from "@/server/assets";
import { safe } from "@/server/action";
import { analyzeAssets, generateBrandProfile, saveProfileEdits, approveProfile, setSectionStatus, syncProfileMemory } from "@/server/agents/brand";
import { askBrand, clearBrandChat } from "@/server/agents/brand-qa";
import { SECTIONS, type SectionId } from "@/lib/brand-profile";
import { log } from "@/server/log";
import { BrandProfile } from "@/server/agents/schemas";
import { remember } from "@/server/memory";
import { assertAiQuota, assertCanAdd } from "@/server/quota";
import { splitList } from "@/lib/utils";
import type { AssetKind } from "@/server/db/schema";

const ASSET_KINDS: AssetKind[] = ["logo", "guideline", "product", "creative", "reference", "post", "presentation", "document"];

const BrandInput = z.object({
  name: z.string({ error: "Brand name is required" }).trim().min(1, "Brand name is required"),
  website: z.string().trim().optional(),
  description: z.string().trim().max(4000).optional(),
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
  for (const k of ["name", "website", "description", "industry", "category", "products", "targetAudience", "geography", "positioning", "personality", "tone", "marketingGoals", "headingFont", "bodyFont"]) {
    const v = String(fd.get(k) ?? "").trim();
    raw[k] = v || undefined;
  }
  raw.objectives = fd.getAll("objectives").map(String);
  raw.platforms = fd.getAll("platforms").map(String);
  raw.competitors = splitList(String(fd.get("competitors") ?? ""));
  raw.colors = splitList(String(fd.get("colors") ?? "")).filter((c) => /^#?[0-9a-f]{3,8}$/i.test(c)).map((c) => (c.startsWith("#") ? c : `#${c}`));
  return BrandInput.parse(raw);
}

type CheckedUpload = { kind: AssetKind; name: string; buf: Buffer; mime: string };

/** Validate every file by content. Nothing is written until all files pass. */
async function checkUploads(fd: FormData): Promise<CheckedUpload[]> {
  const files: { kind: AssetKind; file: File }[] = [];
  for (const kind of ASSET_KINDS) for (const f of fd.getAll(`asset_${kind}`)) if (f instanceof File && f.size) files.push({ kind, file: f });
  if (files.length > MAX_FILES_PER_UPLOAD) throw new UploadError(`Upload up to ${MAX_FILES_PER_UPLOAD} files at a time.`);
  if (files.reduce((n, f) => n + f.file.size, 0) > MAX_TOTAL_UPLOAD_BYTES) throw new UploadError("Uploads are limited to 50 MB at a time. Add the rest afterwards from My Brand → Assets.");
  const checked: CheckedUpload[] = [];
  for (const { kind, file } of files) {
    const buf = Buffer.from(await file.arrayBuffer());
    const mime = await validateUpload(file.name, buf);
    checked.push({ kind, name: file.name.replace(/[\u0000-\u001f]/g, "").slice(0, 200), buf, mime });
  }
  return checked;
}

async function storeUploads(brandId: string, checked: CheckedUpload[]) {
  const db = await getDb();
  for (const c of checked) {
    const id = crypto.randomUUID();
    const key = `brands/${brandId}/assets/${id}.${extFor(c.mime)}`;
    await storage.put(key, c.buf, c.mime);
    await db.insert(schema.brandAssets).values({ id, brandId, kind: c.kind, name: c.name, path: key, mime: c.mime, size: c.buf.length });
  }
  if (checked.length) log.info("brand.assets_uploaded", { brandId, count: checked.length, kinds: [...new Set(checked.map((c) => c.kind))] });
  return checked.length;
}

export async function createBrand(fd: FormData) {
  return safe(async () => {
    // The target organisation is explicit and verified, never "the user's first membership":
    // agency users belong to several organisations.
    const workspaceId = String(fd.get("workspaceId") ?? "");
    if (!workspaceId) throw new AccessError("Choose the organisation this brand belongs to.");
    const { session } = await requireWorkspaceRole(workspaceId, "admin");
    const db = await getDb();
    await assertCanAdd(workspaceId, "brands");
    const input = parseBrandForm(fd);
    // Validate files before creating anything, so a rejected upload leaves no partial brand behind.
    const uploads = await checkUploads(fd);
    const { headingFont, bodyFont, ...rest } = input;
    const [brand] = await db
      .insert(schema.brands)
      .values({ ...rest, workspaceId, fonts: { heading: headingFont || undefined, body: bodyFont || undefined } })
      .returning();
    await storeUploads(brand.id, uploads);
    await setActiveBrand(session.sessionId, brand.id);
    return { brandId: brand.id };
  });
}

export async function updateBrand(brandId: string, fd: FormData) {
  return safe(async () => {
    await requireBrand(brandId, "editor");
    const { headingFont, bodyFont, ...rest } = parseBrandForm(fd);
    const db = await getDb();
    const nulls = Object.fromEntries(["website", "description", "industry", "category", "products", "targetAudience", "geography", "positioning", "personality", "tone", "marketingGoals"].map((k) => [k, (rest as Record<string, unknown>)[k] ?? null]));
    await db.update(schema.brands).set({ ...rest, ...nulls, fonts: { heading: headingFont || undefined, body: bodyFont || undefined } }).where(eq(schema.brands.id, brandId));
    revalidatePath("/brand");
  });
}

export async function uploadAssets(brandId: string, fd: FormData) {
  return safe(async () => {
    await requireBrand(brandId, "editor");
    const n = await storeUploads(brandId, await checkUploads(fd));
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
    const r = await generateBrandProfile({ brandId, userId: session.user.id }, brand);
    revalidatePath("/brand");
    revalidatePath("/dashboard");
    return { profileId: r.profile.id, assetsAnalyzed: r.assets.analyzed, assetsFailed: r.assets.failed };
  });
}

export async function saveProfile(brandId: string, profileId: string, data: unknown) {
  return safe(async () => {
    await requireBrand(brandId, "editor");
    if (JSON.stringify(data ?? null).length > 200_000) throw new Error("This profile is too large to save. Shorten some sections.");
    await saveProfileEdits(brandId, profileId, BrandProfile.parse(data));
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
    const text = note.trim().slice(0, 1000);
    if (!text) throw new Error("Write an instruction first.");
    await remember(brandId, [{ kind: "instruction", content: text, source: "user:instruction", weight: 2 }]);
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


export async function setSectionStatusAction(brandId: string, profileId: string, section: SectionId, status: "confirmed" | "needs_review") {
  return safe(async () => {
    await requireBrand(brandId, "editor");
    if (!SECTIONS.some((x) => x.id === section)) throw new Error("Unknown section.");
    const r = await setSectionStatus(brandId, profileId, section, status);
    revalidatePath("/brand");
    return r;
  });
}

export async function setAssetStatus(brandId: string, assetId: string, status: "approved" | "rejected" | "pending") {
  return safe(async () => {
    await requireBrand(brandId, "editor");
    const db = await getDb();
    const [a] = await db
      .update(schema.brandAssets)
      .set({ status })
      .where(and(eq(schema.brandAssets.id, assetId), eq(schema.brandAssets.brandId, brandId)))
      .returning();
    if (!a) throw new Error("Asset not found.");
    if (status !== "pending") {
      await remember(brandId, [
        { kind: status === "approved" ? "approval" : "feedback", content: `${status === "approved" ? "Approved" : "Rejected"} brand asset: ${a.kind} "${a.name}"${a.analysis ? ` (${String((a.analysis as { aesthetic?: string }).aesthetic ?? "")})` : ""}`, source: `asset:${status}`, weight: 1.1 },
      ]);
    }
    revalidatePath("/brand");
  });
}

export async function analyzeAssetsAction(brandId: string) {
  return safe(async () => {
    const { brand, session } = await requireBrand(brandId, "editor");
    await assertAiQuota(brandId);
    const r = await analyzeAssets({ brandId, userId: session.user.id }, brand, { retryFailed: true });
    revalidatePath("/brand");
    return r;
  });
}

export async function askBrandAction(brandId: string, question: string) {
  return safe(async () => {
    const { brand, session } = await requireBrand(brandId, "viewer");
    const q = question.trim().slice(0, 2000);
    if (!q) throw new Error("Ask a question first.");
    await assertAiQuota(brandId);
    return askBrand({ brandId, userId: session.user.id }, brand, q);
  });
}

export async function clearBrandChatAction(brandId: string) {
  return safe(async () => {
    await requireBrand(brandId, "editor");
    await clearBrandChat(brandId);
    revalidatePath("/brand");
  });
}

export async function resyncBrandMemory(brandId: string) {
  return safe(async () => {
    await requireBrand(brandId, "editor");
    return syncProfileMemory(brandId);
  });
}
