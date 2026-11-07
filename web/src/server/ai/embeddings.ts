import "server-only";
import { EMBEDDING_DIMS } from "../db/schema";

/**
 * Embeddings for brand memory. Voyage AI when VOYAGE_API_KEY is set; otherwise a
 * deterministic feature-hashing embedder (word unigrams + bigrams, signed hashing,
 * L2-normalised). The local embedder captures lexical overlap only, which is enough
 * for small per-brand memory sets and keeps development fully offline.
 */
export async function embed(texts: string[], kind: "document" | "query" = "document"): Promise<number[][]> {
  if (!texts.length) return [];
  if (process.env.VOYAGE_API_KEY) {
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.VOYAGE_API_KEY}` },
      body: JSON.stringify({
        model: "voyage-3.5-lite",
        input: texts,
        input_type: kind,
        output_dimension: EMBEDDING_DIMS,
      }),
    });
    if (!res.ok) throw new Error(`Embedding request failed (${res.status})`);
    const json = (await res.json()) as { data: { embedding: number[] }[] };
    return json.data.map((d) => d.embedding);
  }
  return texts.map(hashEmbed);
}

const STOP = new Set("a an the and or of to in on for with at by from is are be this that it as our your we you".split(" "));

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function hashEmbed(text: string): number[] {
  const v = new Array<number>(EMBEDDING_DIMS).fill(0);
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w));
  const feats = [...words, ...words.slice(1).map((w, i) => `${words[i]}_${w}`)];
  for (const f of feats) {
    const h = fnv1a(f);
    v[h % EMBEDDING_DIMS] += h & 0x80000000 ? -1 : 1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}
