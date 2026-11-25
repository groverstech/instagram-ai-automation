// `npm run beta:invite -- <command>`: the private-beta invitation list (src/server/beta-invites.ts).
// Operator tool, run with the server's database configuration; never exposed in the web app.
//
//   list
//   add <email> --by <name> [--note <text>]
//   revoke <email> --by <name>             (only an unused invitation)
//
// Tell the invited person yourself: no email is sent until an email provider is configured.
import { addBetaInvite, listBetaInvites, revokeBetaInvite, signupMode } from "./beta-invites";

function flags(args: string[]) {
  const f: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) f[args[i].slice(2)] = args[++i] ?? "";
    else rest.push(args[i]);
  }
  return { f, rest };
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const { f, rest } = flags(args);
  console.log(`Sign-up mode here: ${signupMode()} (SIGNUP_MODE).`);
  if (cmd === "list") {
    const rows = await listBetaInvites();
    if (!rows.length) console.log("No invitations.");
    for (const r of rows) console.log(`${r.usedAt ? "used   " : "pending"} ${r.email.padEnd(40)} by ${r.invitedBy} ${r.createdAt.toISOString().slice(0, 10)}${r.note ? `  (${r.note})` : ""}`);
    return;
  }
  if (cmd === "add") {
    if (!rest[0]) throw new Error("Which email?");
    console.log(`Invited ${await addBetaInvite(rest[0], f.by ?? "", f.note)}. They can now sign up with that address.`);
    return;
  }
  if (cmd === "revoke") {
    if (!rest[0]) throw new Error("Which email?");
    console.log((await revokeBetaInvite(rest[0], f.by ?? "")) ? `Revoked ${rest[0]}.` : `${rest[0]} has no unused invitation.`);
    return;
  }
  console.log("Usage: npm run beta:invite -- list | add <email> --by <name> [--note <text>] | revoke <email> --by <name>");
  process.exitCode = 2;
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
