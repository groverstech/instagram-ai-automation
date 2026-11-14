// `npm run ai:billing -- <command>`: operator tool for AI costs (platform-level, never exposed in the web app).
//   import <file.json>       JSON array of { provider, model?, periodStart, periodEnd, usd, source, reference? }
//                            taken from the providers' cost reports or invoices.
//   report <YYYY-MM>         estimated (usage ledger) vs confirmed cost per provider and model.
//   log --since <ISO> [--until <ISO>] [--budget <USD>] [--json <file>]
//                            every real provider request: status, request ID, tokens, estimated cost,
//                            running total and remaining budget.
//   reconcile <anthropic|openai> <export.csv> --since <ISO> --until <ISO> [--amount-unit usd|cents]
//                            [--map field="Column name" ...] [--json <file>]
//                            compare a usage or cost report exported from the provider console with the ledger.
// Runs with the server's database configuration. Output contains no keys or prompt content.
import fs from "node:fs";
import os from "node:os";
import { importConfirmedBilling, reconcile, requestLog } from "./billing";

const usd = (n: number | null | undefined, digits = 4) => (n === null || n === undefined ? "—" : `$${n.toFixed(digits)}`);
const pct = (n: number | null) => (n === null ? "—" : `${n >= 0 ? "+" : ""}${(n * 100).toFixed(2)}%`);

function flags(args: string[]) {
  const out: Record<string, string[]> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const k = args[i].slice(2);
      (out[k] ??= []).push(args[i + 1] ?? "");
      i++;
    } else rest.push(args[i]);
  }
  return { flags: out, rest };
}

const dateArg = (v: string | undefined, name: string) => {
  if (!v || Number.isNaN(Date.parse(v))) throw new Error(`--${name} needs a date and time, e.g. 2026-11-14T00:00:00Z`);
  return new Date(v);
};

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const { flags: f, rest } = flags(args);
  if (cmd === "import" && rest[0]) {
    const data = JSON.parse(fs.readFileSync(rest[0], "utf8"));
    if (!Array.isArray(data)) throw new Error("The file must contain a JSON array of billing lines.");
    const n = await importConfirmedBilling(data, `cli:${os.userInfo().username}`);
    console.log(`Imported ${n} confirmed billing line(s).`);
    return;
  }
  if (cmd === "report" && rest[0] && /^\d{4}-\d{2}$/.test(rest[0])) {
    const start = new Date(`${rest[0]}-01T00:00:00Z`);
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    const rows = await reconcile(start, end);
    console.log(`AI costs ${rest[0]} (UTC): estimated from the usage ledger vs confirmed by the provider\n`);
    for (const r of rows) {
      const diff = r.difference === null ? "" : `  (${(r.difference * 100).toFixed(1)}% vs confirmed)`;
      console.log(`${r.provider.padEnd(10)} ${(r.model || "(all models)").padEnd(26)} estimated ${usd(r.estimatedUsd).padEnd(12)} confirmed ${r.confirmedUsd === null ? "not confirmed" : usd(r.confirmedUsd)}${diff}`);
      if (r.unpricedAttempts || r.unknownOutcomeAttempts) console.log(`${"".padEnd(37)}${r.unpricedAttempts} unpriced, ${r.unknownOutcomeAttempts} with unknown outcome (may be billed)`);
    }
    if (!rows.length) console.log("No AI usage recorded in this period.");
    return;
  }
  if (cmd === "log") {
    const since = dateArg(f.since?.[0], "since");
    const until = f.until?.[0] ? dateArg(f.until[0], "until") : null;
    const budget = f.budget?.[0] ? Number(f.budget[0]) : null;
    const rows = await requestLog(since, until, budget !== null && Number.isFinite(budget) ? budget : null);
    if (f.json?.[0]) fs.writeFileSync(f.json[0], JSON.stringify({ since: since.toISOString(), until: until?.toISOString() ?? null, budgetUsd: budget, rows }, null, 2));
    console.log(`Real provider requests since ${since.toISOString()}${until ? ` until ${until.toISOString()}` : ""}${budget !== null ? `, budget ${usd(budget, 2)}` : ""}\n`);
    console.log(["time (UTC)", "provider", "route", "model", "try", "outcome", "HTTP", "request ID", "units", "estimated", "total", "remaining"].join(" | "));
    for (const r of rows) {
      const units = Object.entries(r.units)
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
      console.log([r.at.slice(11, 19), r.provider, r.route, r.model, r.attempt, r.outcome + (r.errorKind ? `(${r.errorKind})` : ""), r.httpStatus ?? (r.outcome === "success" ? 200 : "—"), r.requestId ?? "—", units || "—", usd(r.estimatedUsd), usd(r.cumulativeUsd), usd(r.remainingUsd)].join(" | "));
    }
    const last = rows.at(-1);
    console.log(`\n${rows.length} request(s); estimated total ${usd(last?.cumulativeUsd ?? 0)}${budget !== null ? `; remaining ${usd(budget - (last?.cumulativeUsd ?? 0))} of ${usd(budget, 2)}` : ""}.`);
    const unpriced = rows.filter((r) => r.estimatedUsd === null && r.outcome !== "blocked").length;
    if (unpriced) console.log(`${unpriced} request(s) have no estimate (unpriced or outcome unknown): the spending cap counts each at its reserve.`);
    return;
  }
  if (cmd === "reconcile" && (rest[0] === "anthropic" || rest[0] === "openai") && rest[1]) {
    const { readExport, compare, ledgerAttempts } = await import("./reconcile-export");
    const start = dateArg(f.since?.[0], "since");
    const end = dateArg(f.until?.[0], "until");
    const map = Object.fromEntries((f.map ?? []).map((m) => m.split("=")).map(([k, ...v]) => [k, v.join("=").replace(/^"|"$/g, "")]));
    const unit = f["amount-unit"]?.[0] === "cents" ? "cents" : "usd";
    const exp = readExport(fs.readFileSync(rest[1], "utf8"), map, { amountUnit: unit });
    const r = compare(rest[0], exp, await ledgerAttempts(rest[0], start, end), { start, end });
    if (f.json?.[0]) fs.writeFileSync(f.json[0], JSON.stringify(r, null, 2));
    console.log(`${rest[0]} export vs usage ledger · ${r.level === "request" ? "request-level" : "aggregate (per model)"} · ${r.period.start} → ${r.period.end}`);
    console.log(r.period.note);
    console.log(`Columns used: ${Object.entries(r.columns).map(([k, v]) => `${k}="${v}"`).join(", ")}${unit === "cents" ? " · amounts read as cents" : ""}\n`);
    for (const m of r.models) {
      console.log(`${m.model}: ledger ${m.ledgerAttempts} metered request(s)${m.exportRequests !== null ? `, export ${m.exportRequests}` : ""}`);
      for (const t of m.tokens) if (t.ledger || t.export) console.log(`   ${t.field.padEnd(18)} ledger ${String(t.ledger).padStart(10)}  export ${String(t.export ?? "—").padStart(10)}  ${pct(t.difference)}`);
      console.log(`   cost               ledger ${usd(m.ledgerUsd).padStart(10)}  export ${usd(m.exportUsd).padStart(10)}  ${pct(m.costDifference)}  (${m.exportUsdSource})${m.withinTarget === null ? "" : m.withinTarget ? "  within 5%" : "  OUTSIDE 5%"}`);
    }
    if (r.level === "request") {
      console.log(`\nRequests matched by ID: ${r.requests.length}; only in ledger: ${r.unmatchedLedger.length}; only in export: ${r.unmatchedExport.length}`);
      for (const q of r.requests) console.log(`   ${q.requestId}  ledger ${usd(q.ledgerUsd)}  export ${usd(q.exportUsd)}  ${pct(q.costDifference)}`);
    }
    console.log(`\nTotal: ledger ${usd(r.totals.ledgerUsd)} · export ${usd(r.totals.exportUsd)} · ${pct(r.totals.difference)}${r.totals.withinTarget === null ? "" : r.totals.withinTarget ? " (within 5%)" : " (OUTSIDE 5%)"}`);
    console.log(`Excluded from the comparison: ${r.excluded.unknownOutcome} unknown outcome, ${r.excluded.unpriced} unpriced, ${r.excluded.blocked} blocked (never sent).`);
    if (r.limitations.length) console.log(`\nLimitations:\n${r.limitations.map((l) => ` - ${l}`).join("\n")}`);
    return;
  }
  console.error(
    [
      "Usage: npm run ai:billing -- <command>",
      "  import <file.json>",
      "  report <YYYY-MM>",
      "  log --since <ISO> [--until <ISO>] [--budget <USD>] [--json <file>]",
      "  reconcile <anthropic|openai> <export.csv> --since <ISO> --until <ISO> [--amount-unit usd|cents] [--map field=\"Column\"] [--json <file>]",
    ].join("\n"),
  );
  process.exitCode = 2;
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  },
);
