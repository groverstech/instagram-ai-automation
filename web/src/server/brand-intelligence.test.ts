import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, like } from "drizzle-orm";
import JSZip from "jszip";

process.env.AI_PROVIDER = "mock";
process.env.PGLITE_DIR = "memory://";
process.env.IMAGE_PROVIDER = "none";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bp-bi-"));

const { getDb, schema } = await import("./db/client");
const { detectMime, validateUpload, extractText, MIME, MAX_FILE_BYTES } = await import("./assets");
const { storage } = await import("./storage");
const brandAgent = await import("./agents/brand");
const { buildContext, renderContext, profileOf } = await import("./agents/context");
const { askBrand, brandChatHistory } = await import("./agents/brand-qa");
const { assistantHistory } = await import("./agents/assistant");
const { recall, remember } = await import("./memory");
const lib = await import("@/lib/brand-profile");

// 1×1 transparent PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

async function docx(paragraphs: string[]) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("word/document.xml", `<w:document><w:body>${paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join("")}</w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}
async function pptx(slides: string[]) {
  const zip = new JSZip();
  zip.file("ppt/presentation.xml", "<p:presentation/>");
  // Write slide 10 before slide 2 to check numeric ordering.
  slides.forEach((t, i) => zip.file(`ppt/slides/slide${i === 1 ? 10 : i + 1}.xml`, `<p:sld><a:t>${t}</a:t></p:sld>`));
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("upload validation & extraction", () => {
  it("detects types from content, not the file name", async () => {
    expect(await detectMime(PNG, "photo.pdf")).toBe(MIME.png);
    expect(await detectMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]), "a.jpg")).toBe(MIME.jpeg);
    expect(await detectMime(Buffer.from("%PDF-1.7\n..."), "a.pdf")).toBe(MIME.pdf);
    expect(await detectMime(Buffer.from('<?xml version="1.0"?><svg xmlns="x"></svg>'), "logo.svg")).toBe(MIME.svg);
    expect(await detectMime(await docx(["Hi"]), "a.docx")).toBe(MIME.docx);
    expect(await detectMime(await pptx(["Hi"]), "a.pptx")).toBe(MIME.pptx);
    expect(await detectMime(Buffer.from("Brand notes"), "notes.md")).toBe(MIME.text);
    // A text file pretending to be an image, and binary junk, are rejected.
    expect(await detectMime(Buffer.from("not really a png"), "fake.png")).toBeNull();
    expect(await detectMime(Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]), "app.exe")).toBeNull();
  });

  it("rejects empty, oversized, unknown and scripted SVG files", async () => {
    await expect(validateUpload("e.png", Buffer.alloc(0))).rejects.toThrow(/empty/);
    await expect(validateUpload("big.png", Buffer.concat([PNG, Buffer.alloc(MAX_FILE_BYTES)]))).rejects.toThrow(/15 MB/);
    await expect(validateUpload("x.bin", Buffer.from([0, 1, 2, 3]))).rejects.toThrow(/unsupported/);
    await expect(validateUpload("x.svg", Buffer.from('<svg onload="alert(1)"></svg>'))).rejects.toThrow(/scripts/);
    await expect(validateUpload("ok.png", PNG)).resolves.toBe(MIME.png);
  });

  it("extracts text from DOCX, PPTX (in slide order) and SVG colours", async () => {
    expect(await extractText(MIME.docx, await docx(["Our values: craft &amp; care", "Tone: warm"]))).toBe("Our values: craft & care\nTone: warm");
    const slides = await extractText(MIME.pptx, await pptx(["Mission", "Audience", "Colours"]));
    expect(slides!.split("\n")).toEqual(["Slide 1: Mission", "Slide 3: Colours", "Slide 10: Audience"]);
    const svg = await extractText(MIME.svg, Buffer.from('<svg><rect fill="#1f1d1a"/><text>KORA</text></svg>'));
    expect(svg).toContain("#1F1D1A");
    expect(svg).toContain("KORA");
    expect(await extractText(MIME.png, PNG)).toBeNull();
  });
});

describe("profile model", () => {
  const v1 = {
    summary: "Old summary",
    personality: { archetype: "Sage", traits: ["calm"] },
    positioning: { statement: "Modern heirloom", category: "Ceramics", differentiators: ["Handmade"] },
    usps: ["Small batch"],
    voice: { description: "Warm", do: ["Be brief"], dont: ["Hype"], vocabulary: ["crafted"], sampleLines: ["Made slowly."] },
    visualIdentity: { palette: [{ hex: "#111111", name: "Ink", usage: "Text" }], typography: { heading: "Playfair" }, imagery: "Natural light" },
    preferredStyles: ["minimalist_luxury", "not_a_style"],
    contentOpportunities: [{ title: "Process", why: "Proof" }],
  };

  it("upgrades v1 profiles and marks everything as unconfirmed", () => {
    const p = lib.readProfile(v1, 1);
    expect(p.identity.positioning.statement).toBe("Modern heirloom");
    expect(p.identity.positioning.source).toBe("inferred");
    expect(p.visual.preferredStyles).toEqual(["minimalist_luxury"]);
    expect(lib.SECTIONS.flatMap((s) => lib.sectionSources(p, s.id)).every((x) => x === "inferred")).toBe(true);
  });

  it("confirming a section turns its findings into provided facts", () => {
    const p = lib.confirmSection(lib.readProfile(v1, 1), "identity");
    expect(lib.sectionSources(p, "identity").every((s) => s === "provided")).toBe(true);
    expect(lib.sectionSources(p, "visual").every((s) => s === "inferred")).toBe(true);
  });

  it("edits keep provenance for unchanged lines and mark new lines as provided", () => {
    const prev = [{ text: "calm", source: "inferred" as const, evidence: "AI" }];
    const next = lib.linesToFindings(prev, "calm\nplayful");
    expect(next[0]).toEqual(prev[0]);
    expect(next[1]).toMatchObject({ text: "playful", source: "provided" });
  });

  it("renders unconfirmed suggestions with a marker for downstream agents", () => {
    const text = lib.renderProfileForPrompt(lib.readProfile(v1, 1), {});
    expect(text).toContain("Modern heirloom [unconfirmed AI suggestion]");
    expect(text).toContain("awaiting the brand's review");
  });

  it("scores completeness from 0 to 100", () => {
    const empty = lib.brandIntelligenceScore({ brand: { name: "X" }, assets: [], profile: null, sectionStatus: {}, approved: false, memories: 0 });
    expect(empty.score).toBeLessThan(10);
    expect(empty.parts.find((p) => p.id === "profile")?.tip).toBeTruthy();
    const full = lib.brandIntelligenceScore({
      brand: { name: "X", website: "x", description: "x", industry: "x", products: "x", targetAudience: "x", geography: "x", positioning: "x", personality: "x", tone: "x", objectives: ["a"], platforms: ["instagram"], competitors: ["c"], colors: ["#000"] },
      assets: ["logo", "guideline", "product"].map((kind) => ({ kind, status: "approved", analyzed: true })),
      profile: lib.readProfile(v1, 1),
      sectionStatus: Object.fromEntries(lib.SECTIONS.map((s) => [s.id, "confirmed"])),
      approved: true,
      memories: 40,
    });
    expect(full.score).toBe(100);
  });
});

describe("Brand Intelligence agent workflow", () => {
  let userId = "";
  let brandA = "";
  let brandB = "";

  beforeAll(async () => {
    const db = await getDb();
    const [u] = await db.insert(schema.users).values({ email: "bi@example.com", name: "BI", passwordHash: "x" }).returning();
    const [wsA] = await db.insert(schema.workspaces).values({ name: "A" }).returning();
    const [wsB] = await db.insert(schema.workspaces).values({ name: "B" }).returning();
    await db.insert(schema.workspaceMembers).values({ workspaceId: wsA.id, userId: u.id, role: "owner" });
    const [a] = await db
      .insert(schema.brands)
      .values({ workspaceId: wsA.id, name: "Kora Ceramics", description: "Small-batch stoneware studio", tone: "Warm, precise", positioning: "The modern heirloom", objectives: ["awareness"], platforms: ["instagram"], colors: ["#2B2620", "#F3EDE4"] })
      .returning();
    const [b] = await db.insert(schema.brands).values({ workspaceId: wsB.id, name: "Other Co", tone: "Loud" }).returning();
    userId = u.id;
    brandA = a.id;
    brandB = b.id;

    // Assets: an image, a readable document, and an unreadable (empty) document.
    const put = async (kind: "logo" | "document", name: string, buf: Buffer, mime: string) => {
      const key = `brands/${brandA}/assets/${name}`;
      await storage.put(key, buf, mime);
      await db.insert(schema.brandAssets).values({ brandId: brandA, kind, name, path: key, mime, size: buf.length });
    };
    await put("logo", "logo.png", PNG, MIME.png);
    await put("document", "guide.docx", await docx(["Brand colour #B5643C is our accent", "We never use discount language"]), MIME.docx);
    await put("document", "empty.docx", await docx([]), MIME.docx);
  });

  const brand = async (id: string) => {
    const db = await getDb();
    const [b] = await db.select().from(schema.brands).where(eq(schema.brands.id, id));
    return b;
  };

  it("analyses assets independently, generates a v2 profile and keeps going past a bad file", async () => {
    const { profile, assets } = await brandAgent.generateBrandProfile({ brandId: brandA, userId }, await brand(brandA));
    expect(assets).toEqual({ analyzed: 2, failed: 1 });
    expect(profile.schemaVersion).toBe(2);
    expect(Object.values(profile.sectionStatus).every((s) => s === "needs_review")).toBe(true);
    const p = profileOf(profile)!;
    expect(p.identity.positioning).toMatchObject({ statement: "The modern heirloom", source: "provided" });

    const db = await getDb();
    const rows = await db.select().from(schema.brandAssets).where(eq(schema.brandAssets.brandId, brandA));
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(byName["guide.docx"].extractedText).toContain("#B5643C");
    expect(byName["guide.docx"].analysis).toBeTruthy();
    expect(byName["empty.docx"].analysisError).toMatch(/No readable content/);
  });

  it("writes only confirmed sections to memory, idempotently", async () => {
    const db = await getDb();
    const [row] = await db.select().from(schema.brandProfiles).where(eq(schema.brandProfiles.brandId, brandA));
    await brandAgent.approveProfile(brandA, row.id, userId);
    const profileMem = () => db.select().from(schema.brandMemories).where(and(eq(schema.brandMemories.brandId, brandA), like(schema.brandMemories.source, "profile:%")));
    expect(await profileMem()).toHaveLength(0);

    await brandAgent.setSectionStatus(brandA, row.id, "communication", "confirmed");
    const once = await profileMem();
    expect(once.length).toBeGreaterThan(0);
    expect(once.every((m) => m.source === "profile:communication")).toBe(true);

    await brandAgent.approveProfile(brandA, row.id, userId);
    await brandAgent.setSectionStatus(brandA, row.id, "communication", "confirmed");
    expect(await profileMem()).toHaveLength(once.length);

    const [after] = await db.select().from(schema.brandProfiles).where(eq(schema.brandProfiles.id, row.id));
    expect(profileOf(after)!.communication.tone.source).toBe("provided");

    await brandAgent.setSectionStatus(brandA, row.id, "communication", "needs_review");
    expect(await profileMem()).toHaveLength(0);
  });

  it("rejects malformed profile edits and saves valid ones", async () => {
    const db = await getDb();
    const [row] = await db.select().from(schema.brandProfiles).where(eq(schema.brandProfiles.brandId, brandA));
    await expect(brandAgent.saveProfileEdits(brandA, row.id, { summary: 1 })).rejects.toThrow();
    const p = profileOf(row)!;
    await brandAgent.saveProfileEdits(brandA, row.id, { ...p, summary: "Edited summary" });
    const [after] = await db.select().from(schema.brandProfiles).where(eq(schema.brandProfiles.id, row.id));
    expect(profileOf(after)!.summary).toBe("Edited summary");
    // A profile can't be edited through another brand.
    await expect(brandAgent.saveProfileEdits(brandB, row.id, p)).rejects.toThrow(/not found/);
  });

  it("retrieves brand knowledge before generation, always including instructions", async () => {
    await remember(brandA, [{ kind: "instruction", content: "Always mention free shipping over 2000", source: "user:instruction" }]);
    const ctx = await buildContext(await brand(brandA), "completely unrelated topic about tax law");
    expect(ctx.instructions).toContain("Always mention free shipping over 2000");
    expect(ctx.profile?.summary).toBe("Edited summary");
    const text = renderContext(ctx);
    expect(text).toContain("<brand_instructions");
    expect(text).toContain("Business description: Small-batch stoneware studio");
  });

  it("keeps brand knowledge isolated between brands", async () => {
    await remember(brandB, [{ kind: "instruction", content: "Other Co secret rule", source: "user:instruction" }]);
    const ctxA = await buildContext(await brand(brandA), "rules");
    const ctxB = await buildContext(await brand(brandB), "rules");
    expect(ctxA.instructions).not.toContain("Other Co secret rule");
    expect(ctxB.instructions).toEqual(["Other Co secret rule"]);
    expect(ctxB.profile).toBeNull();
    expect((await recall(brandB, "shipping")).every((m) => !m.content.includes("free shipping"))).toBe(true);
  });

  it("answers brand questions from saved knowledge and stores them apart from the workflow assistant", async () => {
    const r = await askBrand({ brandId: brandA, userId }, await brand(brandA), "Describe my brand identity.");
    expect(r.meta.basis).toBe("brand_knowledge");
    expect(r.answer).toContain("Edited summary");
    const hist = await brandChatHistory(brandA);
    expect(hist.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(await assistantHistory(brandA)).toHaveLength(0);
    expect(await brandChatHistory(brandB)).toHaveLength(0);

    // A brand with no profile, instructions or memory gets an explicitly ungrounded answer.
    const db = await getDb();
    const [ws] = await db.insert(schema.workspaces).values({ name: "C" }).returning();
    const [c] = await db.insert(schema.brands).values({ workspaceId: ws.id, name: "Empty Co" }).returning();
    const none = await askBrand({ brandId: c.id, userId }, c, "Who is my ideal customer?");
    expect(none.meta.basis).toBe("general_guidance");
    expect(none.meta.missingInfo).toContain("Brand Intelligence Profile");
  });
});
