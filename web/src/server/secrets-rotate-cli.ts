// `npm run secrets:rotate -- status | reencrypt --by <name> [--dry-run]`: APP_SECRET rotation
// (src/server/secrets-rotate.ts; docs/DEPLOYMENT.md "Rotating APP_SECRET"). Prints key ids and
// counts only, never a secret or a value.
import { reencryptAll, rotationStatus } from "./secrets-rotate";

async function status() {
  const s = await rotationStatus();
  console.log(`Current key: ${s.current}${s.previous.length ? `   previous: ${s.previous.join(", ")}` : "   (no APP_SECRET_PREVIOUS)"}`);
  for (const e of s.encrypted) {
    const parts = Object.entries(e.byKey).map(([k, n]) => `${k === s.current ? `${k} (current)` : k}: ${n}`);
    console.log(`  ${e.column.padEnd(34)} ${parts.length ? parts.join(", ") : "none"}`);
  }
  const rc = Object.entries(s.recoveryCodes.byKey).map(([k, n]) => `${k === s.current ? `${k} (current)` : k}: ${n}`);
  console.log(`  recovery codes (people)            ${rc.length ? rc.join(", ") : "none"}`);
  const old = s.encrypted.some((e) => Object.keys(e.byKey).some((k) => k !== s.current));
  const oldCodes = Object.keys(s.recoveryCodes.byKey).some((k) => k !== s.current);
  console.log(old ? "Some values still use an old key: run `reencrypt`." : "All encrypted values use the current key.");
  if (oldCodes) console.log("Some people's recovery codes use an old key: they keep working while that key is in APP_SECRET_PREVIOUS, until they make new codes.");
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "status") return status();
  if (cmd === "reencrypt") {
    const i = args.indexOf("--by");
    const by = i >= 0 ? (args[i + 1] ?? "").trim() : "";
    if (!by) throw new Error("--by <your name> is required: it's recorded with the change.");
    const r = await reencryptAll({ dryRun: args.includes("--dry-run"), by });
    console.log(`${args.includes("--dry-run") ? "Would re-encrypt" : "Re-encrypted"} ${r.reencrypted}; already current ${r.alreadyCurrent}; changed meanwhile ${r.changedMeanwhile}; failed ${r.failed.length}`);
    for (const f of r.failed) console.log(`  couldn't decrypt ${f} with any configured key`);
    if (r.failed.length) process.exitCode = 1;
    return status();
  }
  console.log("Usage: npm run secrets:rotate -- status | reencrypt --by <name> [--dry-run]");
  process.exitCode = 2;
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
