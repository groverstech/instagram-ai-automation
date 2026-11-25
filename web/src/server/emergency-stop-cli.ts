// `npm run publishing:stop -- <command>`: operator emergency stop (reviews M4, M-3). Platform-level,
// never in the web app. Every stop and every clear is recorded in each covered organisation's
// Security log.
//
//   stop   --by <name> --reason <text> [--org <organisation id>]   stop publishing everywhere (or for one organisation)
//   resume --by <name> --reason <text> [--org <organisation id>]   lift that stop (the same scope)
//   status                                                        stops in force, and brands paused by their own admins
//
// Brand admins can't lift an operator stop: "Resume publishing" in the app only clears a brand's own
// pause. Never lift a stop by editing the database: scheduled posts would be left without jobs.
import { clearStop, emergencyStop, stopStatus } from "./emergency-stop";

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
    console.log(`Stopped publishing (${r.scope}): ${r.brands} brand(s) in ${r.organisations} organisation(s); cancelled ${r.cancelledJobs} queued publish job(s).`);
    console.log(`Lift it with: npm run publishing:stop -- resume --by <name> --reason <text>${f.org ? ` --org ${f.org}` : ""}`);
    return;
  }
  if (cmd === "resume") {
    const r = await clearStop({ by: f.by ?? "", reason: f.reason ?? "", workspaceId: f.org || null });
    console.log(`Lifted the stop (${r.scope}) for ${r.organisations} organisation(s): re-queued ${r.requeued} scheduled post(s); ${r.unscheduled} missed post(s) returned to "approved".`);
    return;
  }
  if (cmd === "status") {
    const { stops, paused } = await stopStatus();
    if (!stops.length) console.log("No operator stop is in force.");
    for (const s of stops) console.log(`STOP ${s.scope}: since ${s.setAt.toISOString()} by ${s.setBy} (${s.reason})`);
    if (!paused.length) console.log("No brand is paused by its own admins.");
    for (const r of paused) console.log(`${r.workspace} / ${r.name}: paused ${r.at?.toISOString()} (${r.reason ?? "no reason"})`);
    return;
  }
  console.log("Usage: npm run publishing:stop -- stop|resume --by <name> --reason <text> [--org <id>] | status");
  process.exitCode = 2;
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
