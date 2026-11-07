import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import { embed } from "../ai/embeddings";
import type { MemoryKind } from "../db/schema";

export async function remember(
  brandId: string,
  items: { kind: MemoryKind; content: string; source: string; weight?: number }[],
) {
  const clean = items.filter((i) => i.content.trim());
  if (!clean.length) return;
  const vectors = await embed(clean.map((i) => i.content));
  const db = await getDb();
  await db.insert(schema.brandMemories).values(
    clean.map((i, idx) => ({
      brandId,
      kind: i.kind,
      content: i.content.trim().slice(0, 2000),
      source: i.source,
      weight: i.weight ?? 1,
      embedding: vectors[idx],
    })),
  );
}

/** Top-k memories for a task, by cosine similarity scaled by weight; recent feedback breaks ties. */
export async function recall(brandId: string, query: string, k = 12) {
  const db = await getDb();
  const [q] = await embed([query], "query");
  const vec = `[${q.join(",")}]`;
  const distance = sql<number>`(${schema.brandMemories.embedding} <=> ${vec}::vector)`;
  return db
    .select({
      id: schema.brandMemories.id,
      kind: schema.brandMemories.kind,
      content: schema.brandMemories.content,
      source: schema.brandMemories.source,
      createdAt: schema.brandMemories.createdAt,
      distance,
    })
    .from(schema.brandMemories)
    .where(eq(schema.brandMemories.brandId, brandId))
    .orderBy(sql`${distance} / greatest(${schema.brandMemories.weight}, 0.1)`, desc(schema.brandMemories.createdAt))
    .limit(k);
}

export async function listMemories(brandId: string, kind?: MemoryKind, limit = 50) {
  const db = await getDb();
  return db
    .select({
      id: schema.brandMemories.id,
      kind: schema.brandMemories.kind,
      content: schema.brandMemories.content,
      source: schema.brandMemories.source,
      createdAt: schema.brandMemories.createdAt,
    })
    .from(schema.brandMemories)
    .where(kind ? and(eq(schema.brandMemories.brandId, brandId), eq(schema.brandMemories.kind, kind)) : eq(schema.brandMemories.brandId, brandId))
    .orderBy(desc(schema.brandMemories.createdAt))
    .limit(limit);
}
