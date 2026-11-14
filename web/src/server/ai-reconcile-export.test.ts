import { describe, expect, it } from "vitest";

// Synthetic exports shaped like the providers' documented usage and cost data (no real data).
process.env.PGLITE_DIR = "memory://";
const { parseCsv, readExport, compare, modelFromText } = await import("./ai/reconcile-export");
type LedgerAttempt = import("./ai/reconcile-export").LedgerAttempt;

const day = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 14, h, m));
const period = { start: day(10), end: day(12) };
const opus = (o: Partial<LedgerAttempt>): LedgerAttempt => ({ at: day(10, 30), provider: "anthropic", model: "claude-opus-5-5", outcome: "success", requestId: null, units: {}, costUsd: 0, priceSource: "anthropic-list-2026-11-10", ...o });

describe("reconciling the usage ledger with provider console exports", () => {
  it("parses CSV with quotes, embedded commas and newlines, and a byte-order mark", () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi""\nthere"\n\n1,2\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"\nthere'],
      ["1", "2"],
    ]);
  });

  it("recognises catalogued models in free text", () => {
    expect(modelFromText("Claude Opus 5.5 Usage - Output Tokens")).toBe("claude-opus-5-5");
    expect(modelFromText("gpt-image-2.6-sunburst, image output")).toBe("gpt-image-2.6-sunburst");
    expect(modelFromText("Web search")).toBe("");
  });

  it("Anthropic daily usage export (no request IDs): aggregate per model over the same whole UTC days, never request-level", () => {
    const csv = [
      "starting_at,model,uncached_input_tokens,cache_read_input_tokens,cache_creation.ephemeral_5m_input_tokens,cache_creation.ephemeral_1h_input_tokens,output_tokens,web_search_requests",
      "2026-11-14,claude-opus-5-5,30000,4000,1000,0,9000,2",
      "2026-11-13,claude-opus-5-5,999999,0,0,0,999999,0", // another day: outside the period
    ].join("\n");
    const ledger = [
      opus({ requestId: "req_a", units: { inputTokens: 20000, cacheReadTokens: 4000, cacheWriteTokens: 1000, outputTokens: 6000, webSearches: 2 }, costUsd: (20000 * 4 + 4000 * 0.2 + 1000 * 5 + 6000 * 20) / 1e6 + 0.02 }),
      opus({ requestId: "req_b", units: { inputTokens: 10000, outputTokens: 3000 }, costUsd: (10000 * 4 + 3000 * 20) / 1e6 }),
      opus({ requestId: "req_c", outcome: "unknown", costUsd: null, priceSource: "unknown" }),
    ];
    const r = compare("anthropic", readExport(csv), ledger, period);
    expect(r.level).toBe("aggregate");
    expect(r.requests).toEqual([]);
    expect(r.period).toMatchObject({ start: "2026-11-14T00:00:00.000Z", end: "2026-11-15T00:00:00.000Z" });
    const m = r.models.find((x) => x.model === "claude-opus-5-5")!;
    expect(m.tokens.find((t) => t.field === "inputTokens")).toMatchObject({ ledger: 30000, export: 30000, difference: 0 });
    expect(m.tokens.find((t) => t.field === "cacheWriteTokens")).toMatchObject({ ledger: 1000, export: 1000 });
    expect(m.tokens.find((t) => t.field === "outputTokens")).toMatchObject({ ledger: 9000, export: 9000 });
    expect(m.exportUsdSource).toBe("export tokens at the same rates");
    expect(m.costDifference).toBeCloseTo(0, 9);
    expect(r.excluded.unknownOutcome).toBe(1);
    expect(r.limitations.join(" ")).toMatch(/no request IDs.*No request-level accuracy is claimed/);
    expect(r.limitations.join(" ")).toMatch(/checks token metering, not the provider's prices/);
    expect(r.limitations.join(" ")).toMatch(/Daily granularity/);
  });

  it("Anthropic cost export in cents with the model only in the description: compared with the export's amounts", () => {
    const csv = [
      "date,description,token_type,amount,currency",
      "2026-11-14,Claude Opus 5.5 Usage - Input Tokens,uncached_input_tokens,12.0000,USD",
      "2026-11-14,Claude Opus 5.5 Usage - Output Tokens,output_tokens,18.3000,USD",
    ].join("\n");
    const ledger = [opus({ costUsd: 0.3 }), opus({ costUsd: 0.0016 })];
    const r = compare("anthropic", readExport(csv, {}, { amountUnit: "cents" }), ledger, period);
    const m = r.models[0];
    expect(m).toMatchObject({ model: "claude-opus-5-5", exportUsdSource: "export amount", withinTarget: true });
    expect(m.exportUsd).toBeCloseTo(0.303, 9);
    expect(m.costDifference).toBeCloseTo((0.3016 - 0.303) / 0.303, 9);
    expect(r.totals.withinTarget).toBe(true);
  });

  it("OpenAI images: usage export has image counts only (no tokens); cost export by line item is compared in USD", () => {
    const ledger: LedgerAttempt[] = [
      { at: day(11), provider: "openai", model: "gpt-image-2.6-flare", outcome: "success", requestId: "req_1", units: { images: 1, inputTokens: 60, textInputTokens: 60, outputTokens: 5000 }, costUsd: (60 * 5 + 5000 * 30) / 1e6, priceSource: "openai-list-2026-11-11" },
      { at: day(11, 5), provider: "openai", model: "gpt-image-2.6-sunburst", outcome: "success", requestId: "req_2", units: { images: 1, inputTokens: 1100, textInputTokens: 100, imageInputTokens: 1000, outputTokens: 6000 }, costUsd: (100 * 5 + 1000 * 8 + 6000 * 30) / 1e6, priceSource: "openai-list-2026-11-11" },
    ];
    const usage = readExport(["start_time,model,images,num_model_requests", `${day(0).getTime() / 1000},gpt-image-2.6-flare,1,1`, `${day(0).getTime() / 1000},gpt-image-2.6-sunburst,1,1`].join("\n"), { time: "start_time" });
    const u = compare("openai", usage, ledger, { start: day(0), end: day(23) });
    expect(u.models.find((m) => m.model === "gpt-image-2.6-flare")!.tokens.find((t) => t.field === "images")).toMatchObject({ ledger: 1, export: 1, difference: 0 });
    expect(u.models[0].tokens.find((t) => t.field === "outputTokens")).toMatchObject({ export: null }); // tokens aren't in the export
    const cost = readExport(["date,line_item,amount.value,amount.currency", "2026-11-14,\"gpt-image-2.6-flare, output\",0.1503,usd", "2026-11-14,\"gpt-image-2.6-sunburst, output\",0.1885,usd"].join("\n"));
    const c = compare("openai", cost, ledger, period);
    expect(c.models.map((m) => [m.model, m.withinTarget])).toEqual([
      ["gpt-image-2.6-flare", true],
      ["gpt-image-2.6-sunburst", true],
    ]);
  });

  it("request-level when an export has request IDs: matched one by one, with unmatched requests listed on both sides", () => {
    const csv = ["request_id,model,input_tokens,output_tokens,cost_usd", "req_a,claude-opus-5-5,1000,500,0.014", "req_x,claude-opus-5-5,10,10,0.0002"].join("\n");
    const ledger = [opus({ requestId: "req_a", units: { inputTokens: 1000, outputTokens: 500 }, costUsd: 0.014 }), opus({ requestId: "req_b", costUsd: 0.01 })];
    const r = compare("anthropic", readExport(csv), ledger, period);
    expect(r.level).toBe("request");
    expect(r.requests).toEqual([expect.objectContaining({ requestId: "req_a", ledgerUsd: 0.014, exportUsd: 0.014, costDifference: 0 })]);
    expect(r.unmatchedLedger).toEqual(["req_b"]);
    expect(r.unmatchedExport).toEqual(["req_x"]);
  });

  it("refuses non-USD amounts and exports without a usable column", () => {
    expect(() => readExport("date,model,amount,currency\n2026-11-14,claude-opus-5-5,1,EUR")).toThrow(/non-USD/);
    expect(() => readExport("foo,bar\n1,2")).toThrow(/Couldn't find a model, line item or request ID column/);
    expect(() => readExport("date,model\n2026-11-14,x", { costUsd: "Total" })).toThrow(/Column "Total"/);
  });
});
