import "server-only";
import { and, gte, lt, eq } from "drizzle-orm";
import { getDb, schema } from "../db/client";
import { IMAGE_MODEL_INFO, TEXT_MODELS } from "./catalog";
import { imageCost, textCost } from "./pricing";

/**
 * Reconcile the usage ledger with a usage or cost report EXPORTED from a provider console
 * (docs/AI_PROVIDERS.md, "Reconciling with provider exports"). No admin API keys are used.
 *
 * - **Request level** when the export has request IDs: each ledger attempt is matched to its
 *   provider row by request ID, and tokens and cost are compared per request.
 * - **Aggregate** otherwise: ledger and export are compared per model over the same period. When
 *   the export's time buckets are whole days, the ledger is summed over the same whole UTC days.
 *   Request-level accuracy is never claimed from aggregate data.
 *
 * Token totals are compared exactly (metering). Costs are compared when the export has an amount;
 * without one, the export's tokens are priced at the same rates, which checks metering only.
 */

export type Provider = "anthropic" | "openai";
export type Field =
  | "time"
  | "requestId"
  | "model"
  | "inputTokens"
  | "cacheReadTokens"
  | "cacheWriteTokens"
  | "cacheWrite5mTokens"
  | "cacheWrite1hTokens"
  | "outputTokens"
  | "webSearches"
  | "textInputTokens"
  | "imageInputTokens"
  | "imageOutputTokens"
  | "images"
  | "requests"
  | "costUsd"
  | "currency"
  | "lineItem";

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Column names seen in provider exports and APIs, normalised (lowercase, letters and digits only). */
const ALIASES: Record<Field, string[]> = {
  time: ["timestamp", "date", "day", "time", "starttime", "startingat", "bucketstart", "usagedateutc", "dateutc", "period", "start"],
  requestId: ["requestid", "xrequestid", "providerrequestid"],
  model: ["model", "modelname", "modelid", "modelversion"],
  inputTokens: ["uncachedinputtokens", "inputtokens", "inputtokensuncached", "usageinputtokensnocache", "promptokens", "prompttokens", "inputtokensnocache"],
  cacheReadTokens: ["cachereadinputtokens", "cachereadtokens", "inputcachedtokens", "cachedinputtokens", "usageinputtokenscacheread", "cachedtokens"],
  cacheWriteTokens: ["cachecreationinputtokens", "cachewritetokens", "cachecreationtokens"],
  cacheWrite5mTokens: ["cachecreationephemeral5minputtokens", "ephemeral5minputtokens", "usageinputtokenscachewrite5m", "cachewrite5mtokens"],
  cacheWrite1hTokens: ["cachecreationephemeral1hinputtokens", "ephemeral1hinputtokens", "usageinputtokenscachewrite1h", "cachewrite1htokens"],
  outputTokens: ["outputtokens", "usageoutputtokens", "completiontokens"],
  webSearches: ["webSearchrequests", "websearchrequests", "servertoolusewebsearchrequests", "websearches"].map(norm),
  textInputTokens: ["inputtexttokens", "textinputtokens", "inputtokensdetailstexttokens"],
  imageInputTokens: ["inputimagetokens", "imageinputtokens", "inputtokensdetailsimagetokens"],
  imageOutputTokens: ["outputimagetokens", "imageoutputtokens", "outputtokensdetailsimagetokens"],
  images: ["images", "numimages", "imagecount"],
  requests: ["nummodelrequests", "requests", "requestcount", "numrequests"],
  costUsd: ["costusd", "amountusd", "cost", "amount", "amountvalue", "totalcost", "costinusd"],
  currency: ["currency", "amountcurrency"],
  // Cost exports often name the model only inside a line item or description, e.g. "gpt-image-2.6-flare, output".
  lineItem: ["lineitem", "description", "item", "product"],
};

/** Known model IDs and display names, longest first so "gpt-image-2.6-sunburst" wins over shorter matches. */
const MODEL_NAMES: [string, string][] = [
  ...Object.entries(TEXT_MODELS).flatMap(([id, m]) => [[id, id], [m.label, id]] as [string, string][]),
  ...Object.entries(IMAGE_MODEL_INFO).flatMap(([id, m]) => [[id, id], [m.label, id]] as [string, string][]),
].sort((a, b) => b[0].length - a[0].length);

/** The catalogued model a free-text cell names, if any ("Claude Opus 5.5 - output tokens" → claude-opus-5-5). */
export function modelFromText(text: string): string {
  const t = text.toLowerCase();
  for (const [name, id] of MODEL_NAMES) if (t.includes(name.toLowerCase())) return id;
  return "";
}

/** RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let q = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((v) => v.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v.trim() !== "")) rows.push(row);
  return rows;
}

/** Which column holds which field. Explicit `overrides` (field → header as written) win. */
export function detectColumns(headers: string[], overrides: Partial<Record<Field, string>> = {}): Partial<Record<Field, number>> {
  const out: Partial<Record<Field, number>> = {};
  const normalised = headers.map(norm);
  for (const f of Object.keys(ALIASES) as Field[]) {
    const want = overrides[f];
    if (want !== undefined) {
      const i = headers.findIndex((h) => h === want || norm(h) === norm(want));
      if (i < 0) throw new Error(`Column "${want}" (for ${f}) isn't in the export. Columns: ${headers.join(", ")}`);
      out[f] = i;
      continue;
    }
    for (const alias of ALIASES[f]) {
      const i = normalised.indexOf(alias);
      if (i >= 0 && !Object.values(out).includes(i)) {
        out[f] = i;
        break;
      }
    }
  }
  return out;
}

export type ExportRow = { time: Date | null; dayOnly: boolean; requestId: string | null; model: string; units: Partial<Record<Field, number>>; costUsd: number | null };

const NUMERIC: Field[] = ["inputTokens", "cacheReadTokens", "cacheWriteTokens", "cacheWrite5mTokens", "cacheWrite1hTokens", "outputTokens", "webSearches", "textInputTokens", "imageInputTokens", "imageOutputTokens", "images", "requests"];

function parseTime(v: string): { time: Date | null; dayOnly: boolean } {
  const t = v.trim();
  if (!t) return { time: null, dayOnly: false };
  if (/^\d{10}(\.\d+)?$/.test(t)) return { time: new Date(Number(t) * 1000), dayOnly: false }; // Unix seconds
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return { time: new Date(`${t}T00:00:00Z`), dayOnly: true };
  const ms = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(t) ? t : `${t.replace(" ", "T")}Z`);
  return { time: Number.isNaN(ms) ? null : new Date(ms), dayOnly: false };
}

const numberOf = (v: string | undefined) => {
  if (v === undefined) return undefined;
  const t = v.replace(/[$,\s]/g, "");
  if (t === "") return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
};

export function readExport(text: string, overrides: Partial<Record<Field, string>> = {}, opts: { amountUnit?: "usd" | "cents" } = {}) {
  const [headers, ...body] = parseCsv(text);
  if (!headers) throw new Error("The export is empty.");
  const cols = detectColumns(headers, overrides);
  if (cols.model === undefined && cols.requestId === undefined && cols.lineItem === undefined) throw new Error(`Couldn't find a model, line item or request ID column. Columns: ${headers.join(", ")}. Map one with --map model="<column>".`);
  const divisor = opts.amountUnit === "cents" ? 100 : 1;
  const rows: ExportRow[] = [];
  const currencies = new Set<string>();
  for (const r of body) {
    const units: Partial<Record<Field, number>> = {};
    for (const f of NUMERIC) {
      const i = cols[f];
      const n = i === undefined ? undefined : numberOf(r[i]);
      if (n !== undefined) units[f] = n;
    }
    // The ledger keeps total cache writes; exports may list the 5-minute and 1-hour parts separately.
    if (units.cacheWriteTokens === undefined && (units.cacheWrite5mTokens !== undefined || units.cacheWrite1hTokens !== undefined)) {
      units.cacheWriteTokens = (units.cacheWrite5mTokens ?? 0) + (units.cacheWrite1hTokens ?? 0);
    }
    const { time, dayOnly } = cols.time === undefined ? { time: null, dayOnly: false } : parseTime(r[cols.time] ?? "");
    if (cols.currency !== undefined && r[cols.currency]?.trim()) currencies.add(r[cols.currency].trim().toUpperCase());
    rows.push({
      time,
      dayOnly,
      requestId: cols.requestId === undefined ? null : r[cols.requestId]?.trim() || null,
      model: ((m) => modelFromText(m) || m)(cols.model !== undefined && r[cols.model]?.trim() ? r[cols.model].trim() : cols.lineItem !== undefined ? modelFromText(r[cols.lineItem] ?? "") : ""),
      units,
      costUsd: cols.costUsd === undefined ? null : ((n) => (n === undefined ? null : n / divisor))(numberOf(r[cols.costUsd])),
    });
  }
  if ([...currencies].some((c) => c !== "USD")) throw new Error(`The export has non-USD amounts (${[...currencies].join(", ")}); convert or export in USD.`);
  return { headers, columns: Object.fromEntries(Object.entries(cols).map(([f, i]) => [f, headers[i as number]])) as Partial<Record<Field, string>>, rows };
}

export type LedgerAttempt = { at: Date; provider: string; model: string; outcome: string; requestId: string | null; units: Record<string, number>; costUsd: number | null; priceSource: string | null };

/** Comparable fields: ledger unit name → export field. */
const COMPARE: Record<Provider, [string, Field][]> = {
  anthropic: [
    ["inputTokens", "inputTokens"],
    ["cacheReadTokens", "cacheReadTokens"],
    ["cacheWriteTokens", "cacheWriteTokens"],
    ["outputTokens", "outputTokens"],
    ["webSearches", "webSearches"],
  ],
  openai: [
    ["inputTokens", "inputTokens"],
    ["textInputTokens", "textInputTokens"],
    ["imageInputTokens", "imageInputTokens"],
    ["outputTokens", "outputTokens"],
    ["imageOutputTokens", "imageOutputTokens"],
    ["images", "images"],
  ],
};

const pct = (a: number, b: number) => (b === 0 ? (a === 0 ? 0 : null) : (a - b) / b);
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

export type ModelComparison = {
  model: string;
  ledgerAttempts: number;
  exportRequests: number | null;
  tokens: { field: string; ledger: number; export: number | null; difference: number | null }[];
  ledgerUsd: number;
  exportUsd: number | null;
  exportUsdSource: "export amount" | "export tokens at the same rates" | "none";
  costDifference: number | null;
  withinTarget: boolean | null;
};

export type RequestComparison = { requestId: string; model: string; tokens: { field: string; ledger: number; export: number | null }[]; ledgerUsd: number | null; exportUsd: number | null; costDifference: number | null };

export type Reconciliation = {
  provider: Provider;
  level: "request" | "aggregate";
  period: { start: string; end: string; note: string };
  columns: Partial<Record<Field, string>>;
  models: ModelComparison[];
  requests: RequestComparison[];
  unmatchedLedger: string[];
  unmatchedExport: string[];
  excluded: { unpriced: number; unknownOutcome: number; blocked: number };
  totals: { ledgerUsd: number; exportUsd: number | null; difference: number | null; withinTarget: boolean | null };
  limitations: string[];
};

/** Price a provider export row at the rates the ledger uses, when the export has no amount. */
function priceExportUnits(provider: Provider, model: string, u: Partial<Record<Field, number>>): number | null {
  if (provider === "anthropic") {
    const w = (u.cacheWriteTokens ?? 0) || (u.cacheWrite5mTokens ?? 0) + (u.cacheWrite1hTokens ?? 0);
    return textCost({ model, inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: u.cacheReadTokens, cacheWriteTokens: w, cacheWrite1hTokens: u.cacheWrite1hTokens, webSearches: u.webSearches }).usd;
  }
  return imageCost({ model, units: { images: u.images, inputTokens: u.inputTokens, textInputTokens: u.textInputTokens, imageInputTokens: u.imageInputTokens, outputTokens: u.outputTokens, imageOutputTokens: u.imageOutputTokens } }).usd;
}

export function compare(provider: Provider, exp: ReturnType<typeof readExport>, ledger: LedgerAttempt[], period: { start: Date; end: Date }, target = 0.05): Reconciliation {
  const limitations: string[] = [];
  const mine = ledger.filter((l) => l.provider === provider);
  // "Fully metered": the provider reported usage and we priced it.
  const metered = mine.filter((l) => l.costUsd !== null && l.outcome !== "blocked");
  const excluded = {
    unpriced: mine.filter((l) => l.priceSource === "unpriced").length,
    unknownOutcome: mine.filter((l) => l.outcome === "unknown").length,
    blocked: mine.filter((l) => l.outcome === "blocked").length,
  };
  if (excluded.unknownOutcome) limitations.push(`${excluded.unknownOutcome} attempt(s) timed out or lost their connection: the provider may have billed them, but the ledger has no usage for them, so they're listed separately and not in the comparison.`);
  if (excluded.unpriced) limitations.push(`${excluded.unpriced} attempt(s) had no price in the ledger and are excluded from the cost comparison.`);

  // Whole-day export buckets: compare over the same whole UTC days.
  const dayOnly = exp.rows.length > 0 && exp.rows.every((r) => r.dayOnly);
  let start = period.start;
  let end = period.end;
  let note = "Same period in the ledger and the export.";
  if (dayOnly) {
    start = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
    end = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate() + (end.getTime() % 86_400_000 === 0 ? 0 : 1)));
    note = "The export has whole-day (UTC) buckets, so both sides cover the same whole UTC days. Any other use of the same API key or workspace on those days is in the export but not in this run's ledger.";
    limitations.push("Daily granularity: other usage of the same key on the same days would appear as a difference. Use a dedicated validation key or workspace.");
  }
  const inPeriod = (t: Date | null) => t === null || (t >= start && t < end);
  const rows = exp.rows.filter((r) => inPeriod(r.time));
  if (exp.columns.time === undefined) limitations.push("The export has no time column: all of its rows are treated as being in the period.");
  const led = metered.filter((l) => l.at >= start && l.at < end);

  const level: "request" | "aggregate" = exp.columns.requestId !== undefined && rows.some((r) => r.requestId) ? "request" : "aggregate";
  const requests: RequestComparison[] = [];
  const unmatchedLedger: string[] = [];
  const unmatchedExport: string[] = [];
  if (level === "request") {
    const byId = new Map(rows.filter((r) => r.requestId).map((r) => [r.requestId!, r]));
    for (const l of led) {
      const x = l.requestId ? byId.get(l.requestId) : undefined;
      if (!x) {
        unmatchedLedger.push(l.requestId ?? `(no request ID, ${l.at.toISOString()})`);
        continue;
      }
      byId.delete(l.requestId!);
      const xu = x.units;
      const exportUsd = x.costUsd ?? priceExportUnits(provider, x.model || l.model, xu);
      requests.push({
        requestId: l.requestId!,
        model: l.model,
        tokens: COMPARE[provider].map(([lf, xf]) => ({ field: lf, ledger: l.units[lf] ?? 0, export: xu[xf] ?? null })),
        ledgerUsd: l.costUsd,
        exportUsd,
        costDifference: l.costUsd !== null && exportUsd !== null ? pct(l.costUsd, exportUsd) : null,
      });
    }
    unmatchedExport.push(...byId.keys());
  } else {
    limitations.push("The export has no request IDs, so requests can't be matched one by one: only per-model totals over the period are compared. No request-level accuracy is claimed.");
  }

  const models = [...new Set([...led.map((l) => l.model), ...rows.map((r) => r.model)])].filter(Boolean).sort();
  const modelRows: ModelComparison[] = models.map((model) => {
    const L = led.filter((l) => l.model === model);
    const X = rows.filter((r) => r.model === model);
    const xSum = (f: Field) => (X.some((r) => r.units[f] !== undefined) ? X.reduce((s, r) => s + (r.units[f] ?? 0), 0) : null);
    const hasAmount = X.some((r) => r.costUsd !== null);
    const priced = hasAmount ? X.reduce((s, r) => s + (r.costUsd ?? 0), 0) : X.length ? X.reduce<number | null>((s, r) => (s === null ? null : ((p) => (p === null ? null : s + p))(priceExportUnits(provider, model, r.units))), 0) : null;
    const ledgerUsd = r6(L.reduce((s, l) => s + (l.costUsd ?? 0), 0));
    const exportUsd = priced === null ? null : r6(priced);
    const diff = exportUsd === null ? null : pct(ledgerUsd, exportUsd);
    return {
      model,
      ledgerAttempts: L.length,
      exportRequests: xSum("requests"),
      tokens: COMPARE[provider].map(([lf, xf]) => {
        const ledgerN = L.reduce((s, l) => s + (l.units[lf] ?? 0), 0);
        const xn = xSum(xf);
        return { field: lf, ledger: ledgerN, export: xn, difference: xn === null ? null : pct(ledgerN, xn) };
      }),
      ledgerUsd,
      exportUsd,
      exportUsdSource: hasAmount ? "export amount" : exportUsd !== null ? "export tokens at the same rates" : "none",
      costDifference: diff,
      withinTarget: diff === null ? null : Math.abs(diff) <= target,
    };
  });
  if (modelRows.some((m) => m.exportUsdSource === "export tokens at the same rates")) {
    limitations.push("Where the export has no amounts, its tokens are priced at the same rates as the ledger: that checks token metering, not the provider's prices or invoice.");
  }
  const ledgerUsd = r6(modelRows.reduce((s, m) => s + m.ledgerUsd, 0));
  const exportUsd = modelRows.every((m) => m.exportUsd === null) ? null : r6(modelRows.reduce((s, m) => s + (m.exportUsd ?? 0), 0));
  const difference = exportUsd === null ? null : pct(ledgerUsd, exportUsd);
  return {
    provider,
    level,
    period: { start: start.toISOString(), end: end.toISOString(), note },
    columns: exp.columns,
    models: modelRows,
    requests,
    unmatchedLedger,
    unmatchedExport,
    excluded,
    totals: { ledgerUsd, exportUsd, difference, withinTarget: difference === null ? null : Math.abs(difference) <= target },
    limitations,
  };
}

/** Ledger attempts for a provider and period (real providers only), as the comparison needs them. */
export async function ledgerAttempts(provider: Provider, start: Date, end: Date): Promise<LedgerAttempt[]> {
  const db = await getDb();
  const e = schema.usageEvents;
  // Widen to whole UTC days on both sides: compare() narrows to the period it settles on.
  const s = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const t = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate() + 1));
  const rows = await db
    .select()
    .from(e)
    .where(and(eq(e.provider, provider), gte(e.createdAt, s), lt(e.createdAt, t)));
  return rows.map((r) => ({ at: r.createdAt, provider: r.provider, model: r.model ?? "", outcome: r.outcome, requestId: r.providerRequestId ?? null, units: r.units ?? {}, costUsd: r.costUsd ?? null, priceSource: r.priceSource ?? null }));
}
