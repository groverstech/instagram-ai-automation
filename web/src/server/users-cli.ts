// `npm run users -- <command>`: operator account recovery (src/server/auth/recovery.ts; launch gate
// S11). Confirm the person's identity out of band first (for example, a call to the number on file
// or a message from their organisation's owner), and say how in --reason. Every use is audited.
//
//   reset-link --email <email> --by <your name> --reason "<how identity was confirmed>"
//       prints a password-reset link valid for 24 hours; give it to the person directly
//   reset-mfa  --email <email> --by <your name> --reason "<how identity was confirmed>"
//       turns off two-step verification (lost authenticator and recovery codes) and signs the
//       account out everywhere; owners and admins enrol again at their next sign-in where required
import { operatorResetLink, operatorResetMfa, RecoveryError } from "./auth/recovery";

function flag(args: string[], name: string) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? "") : "";
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const email = flag(args, "email");
  const by = flag(args, "by");
  const reason = flag(args, "reason");
  if (cmd === "reset-link") {
    const r = await operatorResetLink(email, by, reason);
    console.log(`Reset link for ${r.email} (valid 24 hours, single use; give it only to the person):\n\n  ${r.link}\n`);
    return;
  }
  if (cmd === "reset-mfa") {
    const r = await operatorResetMfa(email, by, reason);
    console.log(`Two-step verification turned off for ${r.email}; ${r.sessionsEnded} session(s) ended.`);
    return;
  }
  console.log('Usage: npm run users -- reset-link|reset-mfa --email <email> --by <your name> --reason "<how identity was confirmed>"');
  process.exitCode = 2;
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error(e instanceof RecoveryError || e?.name === "ZodError" ? (e instanceof RecoveryError ? e.message : "Enter a valid --email.") : String(e));
    process.exit(1);
  });
