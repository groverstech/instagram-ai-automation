// `npm run reviewer:setup -- --email reviewer@<domain> [--reset]`: create the platform app-review
// account (docs/submissions/META.md §4). Prints the password once: hand it to the platform only in
// the review form's secure test-credentials field. Runs with the server's database configuration.
import { setupReviewer, ReviewerSetupError, REVIEW_BRAND } from "./reviewer";

async function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf("--email");
  const email = at >= 0 ? args[at + 1] : undefined;
  if (!email) {
    console.error("Usage: npm run reviewer:setup -- --email reviewer@<your-domain> [--reset]");
    return 2;
  }
  try {
    const r = await setupReviewer({ email, reset: args.includes("--reset") });
    const appUrl = (process.env.APP_URL ?? "").replace(/\/$/, "") || "<APP_URL>";
    console.log(`Reviewer account ready.

  Email:     ${r.email}
  Password:  ${r.password}
  Two-step verification is on (required for owners in production). To sign in, use the password,
  then "Use a recovery code" with one of these (each works once; ${r.recoveryCodes.length} in total):
    ${r.recoveryCodes.join("  ")}
  Setup key for an authenticator app instead: ${r.totpSecret.replace(/(.{4})/g, "$1 ").trim()}
  Brand:     ${REVIEW_BRAND}, with an approved post for Instagram and one for Facebook
${r.posts.map((p) => `  ${p.platform === "instagram" ? "Instagram" : "Facebook"} post: ${appUrl}/calendar?post=${p.id}`).join("\n")}

The password, recovery codes and setup key are shown only now. Give the password and two or three
recovery codes to the platform only in the review form's secure test-credentials field, with the
note: "Sign in, then choose 'Use a recovery code' and enter one code". Delete the organisation "App review" (Settings → Delete data) after the review.`);
    return 0;
  } catch (e) {
    if (e instanceof ReviewerSetupError) {
      console.error(e.message);
      return 1;
    }
    throw e;
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  },
);
