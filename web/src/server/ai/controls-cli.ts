// `npm run ai:controls -- <command>`: operator tool for the AI kill switch (F12; ai/controls.ts).
// Platform-level, never exposed in the web app. Every change is audited (ai.stop, ai.resume).
//
//   status                                  active stops (database and AI_STOP), tripwire settings
//   stop <scope> --reason <text> --by <name>
//   resume <scope> --by <name>              also clears a tripwire stop, after you've looked
//
// Scopes: all | anthropic | openai | model:<id>. A stop applies to the next attempt in every process.
import { envStops, listStops, resumeAi, stopAi, tripwireConfig } from "./controls";

function flags(args: string[]) {
  const f: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) f[args[i].slice(2)] = args[++i] ?? "";
    else rest.push(args[i]);
  }
  return { f, rest };
}

async function status() {
  const rows = await listStops();
  const env = envStops();
  if (!rows.length && !env.length) console.log("AI requests: running (no stops).");
  for (const r of rows) console.log(`STOPPED ${r.scope.padEnd(28)} ${r.source.padEnd(9)} by ${r.setBy} at ${r.setAt.toISOString()}: ${r.reason}`);
  for (const s of env) console.log(`STOPPED ${s.padEnd(28)} env       AI_STOP (remove it from the environment to resume)`);
  const t = tripwireConfig();
  console.log(t ? `Tripwire: more than $${t.usd} per provider in ${t.windowMin} minutes stops that provider.` : "Tripwire: off (AI_TRIPWIRE_USD unset).");
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const { f, rest } = flags(args);
  if (cmd === "status") return status();
  if (cmd === "stop") {
    if (!rest[0]) throw new Error("Which scope? all, anthropic, openai or model:<id>.");
    const s = await stopAi(rest[0], f.reason ?? "", f.by ?? "");
    console.log(`Stopped ${s}. In-flight requests finish; no new ones are sent.`);
    return status();
  }
  if (cmd === "resume") {
    if (!rest[0]) throw new Error("Which scope?");
    console.log((await resumeAi(rest[0], f.by ?? "")) ? `Resumed ${rest[0]}.` : `${rest[0]} wasn't stopped in the database.`);
    return status();
  }
  console.log("Usage: npm run ai:controls -- status | stop <scope> --reason <text> --by <name> | resume <scope> --by <name>");
  process.exitCode = 2;
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
