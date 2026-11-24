// `npm run publishing:stop -- <command>`: operator emergency stop (review M4). Platform-level, never
// in the web app. Every stop is recorded in each affected organisation's Security log.
//
//   stop --by <name> --reason <text> [--org <organisation id>]   pause every brand (or one organisation's)
//   status                                                      list paused brands
//
// There's no bulk resume on purpose: each brand is resumed in the app by one of its admins
// (Content Calendar → Resume publishing). Never resume by editing the database.
import { emergencyStop, pausedBrands } from "./emergency-stop";

function flags(args: string[]) {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) if (args[i].startsWith("--")) out[args[i].slice(2)] = args[++i] ?? "";
  return out;
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const f = flags(args);
  if (cmd === "stop") {
    const r = await emergencyStop({ by: f.by ?? "", reason: f.reason ?? "", workspaceId: f.org || null });
    console.log(`Paused ${r.brands} brand(s) in ${r.organisations} organisation(s); cancelled ${r.cancelledJobs} queued publish job(s).`);
    console.log("Resume each brand in the app (Content Calendar → Resume publishing). Don't resume in the database.");
    return;
  }
  if (cmd === "status") {
    const rows = await pausedBrands();
    if (!rows.length) console.log("No brand is paused.");
    for (const r of rows) console.log(`${r.workspace} / ${r.name}: paused ${r.at?.toISOString()} (${r.reason ?? "no reason"})`);
    return;
  }
  console.log("Usage: npm run publishing:stop -- stop --by <name> --reason <text> [--org <id>] | status");
  process.exitCode = 2;
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
