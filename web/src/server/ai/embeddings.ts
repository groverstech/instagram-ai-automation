import "server-only";
import { EMBEDDING_DIMS } from "../db/schema";

/**
 * Embeddings for brand memory. Voyage AI when VOYAGE_API_KEY is set and permitted; otherwise a
 * deterministic feature-hashing embedder (word unigrams + bigrams, signed hashing, L2-normalised).
 * The local embedder captures lexical overlap only, which is enough for small per-brand memory sets
 * and keeps development fully offline.
 *
 * Voyage calls are NOT metered by the AI ledger (no spending cap, tripwire, credits or usage rows)
 * (review L3). So they're made only when no control depends on that metering. See voyageRefusal.
 * When refused, the local embedder is used instead: nothing is sent, and features keep working
 * (with weaker recall). Config validation reports the same conditions at start-up.
 */
type Env = Record<string, string | undefined>;

/** Why Voyage may not be called now, or null if it may. Static part (environment). */
export function voyageRefusal(env: Env = process.env): string | null {
  const v = (k: string) => (env[k] ?? "").trim().toLowerCase();
  if (!v("VOYAGE_API_KEY")) return "not configured";
  if (v("AI_SPEND_CAP_REQUIRED") === "true" || v("AI_SPEND_CAP_USD")) return "a hard spending cap is set, and Voyage isn't metered by it";
  if (v("AI_TRIPWIRE_USD")) return "the spending tripwire is set, and Voyage isn't metered by it";
  if (v("CREDITS_MODE") === "enforce") return "credits are enforced, and Voyage isn't metered by them";
  if (v("AI_STOP").split(",").map((x) => x.trim()).some((x) => x === "all" || x === "voyage")) return "AI is stopped (AI_STOP)";
  const deploy = v("DEPLOY_ENV");
  const strict = deploy === "staging" || deploy === "production" || (deploy !== "" && !["development", "demo", "test"].includes(deploy));
  if (strict && v("VOYAGE_UNMETERED_OK") !== "true") return "staging and production need VOYAGE_UNMETERED_OK=true to accept unmetered Voyage spend";
  return null;
}

let warned = "";
export async function embed(texts: string[], kind: "document" | "query" = "document", env: Env = process.env): Promise<number[][]> {
  if (!texts.length) return [];
  let refusal = voyageRefusal(env);
  if (!refusal) {
    // The kill switch's "all" scope stops Voyage too.
    const { globalAiStopped } = await import("../autonomy/service");
    if (await globalAiStopped(undefined, env).catch(() => true)) refusal = "AI is stopped (kill switch)";
  }
  if (refusal) {
    if (refusal !== "not configured" && warned !== refusal) {
      warned = refusal;
      const { log } = await import("../log");
      log.warn("embeddings.voyage_refused", { reason: refusal, using: "local" });
    }
    return texts.map(hashEmbed);
  }
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.VOYAGE_API_KEY}` },
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
