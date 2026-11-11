// `npm run ai:billing -- <command>`: operator tool for provider-confirmed AI billing (platform-level).
//   import <file.json>      JSON array of { provider, model?, periodStart, periodEnd, usd, source, reference? }
//                           taken from the providers' cost reports or invoices.
//   report <YYYY-MM>        estimated (usage ledger) vs confirmed cost per provider and model.
// Runs with the server's database configuration. Never exposed in the web app.
import fs from "node:fs";
import os from "node:os";
import { importConfirmedBilling, reconcile } from "./billing";

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "import" && arg) {
    const data = JSON.parse(fs.readFileSync(arg, "utf8"));
    if (!Array.isArray(data)) throw new Error("The file must contain a JSON array of billing lines.");
    const n = await importConfirmedBilling(data, `cli:${os.userInfo().username}`);
    console.log(`Imported ${n} confirmed billing line(s).`);
    return;
  }
  if (cmd === "report" && arg && /^\d{4}-\d{2}$/.test(arg)) {
    const start = new Date(`${arg}-01T00:00:00Z`);
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    const rows = await reconcile(start, end);
    const usd = (n: number | null) => (n === null ? "not confirmed" : `$${n.toFixed(4)}`);
    console.log(`AI costs ${arg} (UTC): estimated from the usage ledger vs confirmed by the provider\n`);
    for (const r of rows) {
      const diff = r.difference === null ? "" : `  (${(r.difference * 100).toFixed(1)}% vs confirmed)`;
      console.log(`${r.provider.padEnd(10)} ${(r.model || "(all models)").padEnd(26)} estimated ${usd(r.estimatedUsd).padEnd(12)} confirmed ${usd(r.confirmedUsd)}${diff}`);
      if (r.unpricedAttempts || r.unknownOutcomeAttempts) console.log(`${"".padEnd(37)}${r.unpricedAttempts} unpriced, ${r.unknownOutcomeAttempts} with unknown outcome (may be billed)`);
    }
    if (!rows.length) console.log("No AI usage recorded in this period.");
    return;
  }
  console.error("Usage: npm run ai:billing -- import <file.json> | report <YYYY-MM>");
  process.exitCode = 2;
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  },
);
