// Staging rehearsal (run by e2e/staging-rehearsal.sh). Checks a strict staging deployment the way an
// operator would before beta invitations:
//   readiness · invite-only sign-up · no account enumeration · required two-step verification ·
//   onboarding and the Brand page under RLS as an ordinary role · operator emergency stop drill
//   (stop, a brand admin can't lift it, operator resume, audited) · Meta reviewer account sign-in.
//
// Environment: STAGING_BASE_URL; SERVER_DATABASE_URL (the server's own database settings: the
// operator commands run with them, as an operator does from the server's environment);
// CHECK_DATABASE_URL (a privileged role, for this script's own checks only); APP_ROLE (checked to be
// ordinary); STAGING_ENV_LINE (the server's settings, so the operator commands pass the same checks).
//
// Without an email provider (a fresh staging), the rehearsal marks the address confirmed in the
// database in place of the link; with a provider, use the link from the email instead.
const { chromium } = require("playwright");
const { execFileSync } = require("child_process");
const crypto = require("crypto");
const path = require("path");

const B = process.env.STAGING_BASE_URL;
const DB = process.env.CHECK_DATABASE_URL;
const ROLE = process.env.APP_ROLE;
if (!B || !DB || !process.env.SERVER_DATABASE_URL) throw new Error("Set STAGING_BASE_URL, CHECK_DATABASE_URL and SERVER_DATABASE_URL (the runner does).");
const opEnv = { ...process.env };
for (const kv of (process.env.STAGING_ENV_LINE ?? "").split(" ").filter(Boolean)) {
  const i = kv.indexOf("=");
  opEnv[kv.slice(0, i)] = kv.slice(i + 1);
}
opEnv.DATABASE_URL = process.env.SERVER_DATABASE_URL;
const sql = (q) => execFileSync("psql", [DB, "-tAc", q], { encoding: "utf8" }).trim();
const npm = (script, args) => execFileSync("npm", ["run", "-s", script, "--", ...args], { encoding: "utf8", env: opEnv, cwd: path.join(__dirname, "..") });
const log = (m) => console.log("✓", m);
const fail = (m) => {
  throw new Error(m);
};
function totp(secret, t = Date.now()) {
  const alph = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of secret.toUpperCase().replace(/=+$/, "")) bits += alph.indexOf(ch).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const ctr = Buffer.alloc(8);
  ctr.writeBigUInt64BE(BigInt(Math.floor(t / 30000)));
  const h = crypto.createHmac("sha1", key).update(ctr).digest();
  const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, "0");
}

(async () => {
  // 1. Readiness, as an ordinary role.
  const ready = await (await fetch(`${B}/api/health/ready`)).json();
  if (ready.status !== "ready" || ready.deployEnv !== "staging") fail(`not ready: ${JSON.stringify(ready)}`);
  if (ROLE) {
    const r = sql(`select rolsuper::text || ',' || rolbypassrls::text from pg_roles where rolname = '${ROLE}'`);
    if (r !== "false,false") fail(`the app role isn't ordinary: ${r}`);
  }
  log(`ready in strict staging mode (${ready.checks.migrations.detail}); the app role is ordinary (no superuser, no BYPASSRLS)`);

  const browser = await chromium.launch();
  const errs = [];
  const watch = (p, who) => {
    p.on("pageerror", (e) => errs.push(`${who}: ${e.message}`));
    p.on("response", (r) => {
      const u = new URL(r.url());
      if (u.origin === new URL(B).origin && r.status() >= 500) errs.push(`${who}: ${r.status()} ${r.request().method()} ${u.pathname}`);
    });
  };
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  global.__page = p;
  watch(p, "owner");
  const signUp = async (email) => {
    await p.goto(`${B}/signup`);
    await p.fill("input[name=name]", "Rehearsal Owner");
    await p.fill("input[name=email]", email);
    await p.fill("input[name=password]", "rehearsal-pass-1");
    await p.fill("input[name=workspace]", "Rehearsal Studio");
    await p.click('button:has-text("Create account")');
  };

  // 2. Invitation-only sign-up, and no account enumeration: a registered address (its invitation
  //    now used) gets exactly the answer an uninvited address gets.
  const formText = async () => (await p.locator("form").first().innerText()).replace(/\s+/g, " ");
  await signUp("uninvited@rehearsal.test");
  await p.getByText(/sign-up is by invitation/i).first().waitFor();
  const uninvited = await formText();
  if (sql("select count(*) from users where email = 'uninvited@rehearsal.test'") !== "0") fail("an uninvited address got an account");
  npm("beta:invite", ["add", "owner@rehearsal.test", "--by", "Rehearsal"]);
  await signUp("owner@rehearsal.test");
  await p.waitForURL(/\/verify-email\?sent=1$/);
  if (sql("select count(*) from sessions s join users u on u.id = s.user_id where u.email = 'owner@rehearsal.test'") !== "0") fail("sign-up signed someone in");
  await signUp("owner@rehearsal.test");
  await p.getByText(/sign-up is by invitation/i).first().waitFor();
  if ((await formText()).replace("owner@rehearsal.test", "uninvited@rehearsal.test") !== uninvited) fail("a registered address was answered differently from an uninvited one");
  log("sign-up is invitation-only; the invited address gets \"check your inbox\" with nobody signed in; a registered address is answered exactly like an uninvited one");

  // 3. Confirm (no email provider on a fresh staging: stand in for the link), sign in, required MFA.
  sql("update users set email_verified_at = now() where email = 'owner@rehearsal.test'");
  await p.goto(`${B}/login`);
  await p.fill("input[name=email]", "owner@rehearsal.test");
  await p.fill("input[name=password]", "rehearsal-pass-1");
  await p.click('button:has-text("Sign in")');
  await p.waitForURL(/\/account\/security\?required=1/);
  await p.getByRole("button", { name: "Turn on two-step verification" }).click();
  const secret = (await p.getByLabel("Setup key").innerText()).replace(/\s/g, "");
  await p.getByLabel("Code from your authenticator app").fill(totp(secret));
  await p.getByRole("button", { name: "Turn on", exact: true }).click();
  await p.getByRole("button", { name: /I've saved them/ }).click();
  await p.waitForURL(/\/(dashboard|onboarding)/);
  log("owners must turn on two-step verification before anything else; enrolment works");

  // 4. Onboarding and the Brand page, under RLS as the ordinary role.
  if (!p.url().includes("/onboarding")) await p.goto(`${B}/onboarding`);
  await p.fill("input[name=name]", "Rehearsal Ceramics");
  await p.fill("textarea[name=description]", "A small studio making stoneware for everyday use.");
  await p.fill("input[name=industry]", "Home & lifestyle");
  await p.fill("textarea[name=products]", "Mugs, bowls, workshops");
  await p.click('button:has-text("Continue")');
  await p.fill("textarea[name=targetAudience]", "Design-conscious hosts");
  await p.fill("input[name=geography]", "India");
  await p.click('button:has-text("Continue")');
  await p.fill("textarea[name=positioning]", "Handmade ceramics for everyday use");
  await p.click('button:has-text("Continue")');
  await p.click('button:has-text("Continue")');
  await p.click('button:has-text("Continue")');
  await p.locator("form input[type=file]").nth(0).setInputFiles(path.join(__dirname, "fixtures", "logo.png"));
  await p.click('button:has-text("Continue")');
  await p.click('button:has-text("Analyse my brand")');
  await p.waitForURL("**/brand**", { timeout: 60000 });
  await p.getByRole("button", { name: /Approve v1/ }).click();
  await p.locator("text=Approved").first().waitFor();
  for (const page of ["/dashboard", "/calendar", "/settings"]) {
    await p.goto(B + page, { waitUntil: "networkidle" });
    if (/Application error|Something went wrong/i.test(await p.locator("body").innerText())) fail(`${page} failed under RLS`);
  }
  log("organisation and brand created, profile approved; Dashboard, Calendar and Settings load under RLS");

  // 5. Operator emergency-stop drill.
  npm("publishing:stop", ["stop", "--by", "Rehearsal operator", "--reason", "Staging rehearsal"]);
  await p.goto(`${B}/calendar`, { waitUntil: "networkidle" });
  if (!/Publishing stopped/i.test(await p.locator("body").innerText())) fail("no stop banner");
  // MFA step-up isn't needed to pause or resume; the brand admin tries to lift it.
  await p.getByRole("button", { name: /Pause publishing/ }).first().click();
  await p.getByRole("dialog").getByRole("button", { name: /Pause publishing/ }).click();
  await p.getByRole("button", { name: /Resume publishing/ }).first().waitFor();
  await p.getByRole("button", { name: /Resume publishing/ }).first().click();
  await p.getByRole("dialog").getByRole("button", { name: /Resume publishing/ }).click();
  await p.getByText(/stays stopped by the BrandPilot team/).first().waitFor();
  if (sql("select count(*) from publishing_stops") !== "1") fail("the brand admin lifted the operator stop");
  npm("publishing:stop", ["resume", "--by", "Rehearsal operator", "--reason", "Rehearsal over"]);
  await p.reload({ waitUntil: "networkidle" });
  if (/Publishing stopped/i.test(await p.locator("body").innerText())) fail("banner still shown after the operator resume");
  const actions = sql("select string_agg(action, ',' order by created_at) from audit_events where action like 'publishing.%'");
  if (actions !== "publishing.emergency_stop,publishing.pause,publishing.resume,publishing.emergency_resume") fail(`audit trail: ${actions}`);
  log("emergency-stop drill: stopped, a brand admin couldn't lift it, the operator lifted it; every step audited");
  await ctx.close();

  // 6. The Meta reviewer account: created by the operator command, signs in with a recovery code.
  const out = npm("reviewer:setup", ["--email", "reviewer@rehearsal.test"]);
  const pw = out.match(/Password:\s+(\S+)/)[1];
  const code = out.match(/recovery codes?[^\n]*\n\s+(\S+)/i)?.[1] ?? out.match(/([a-z0-9]{4,5}-[a-z0-9]{4,5})/i)[1];
  const r = await browser.newContext();
  const q = await r.newPage();
  watch(q, "reviewer");
  await q.goto(`${B}/login`);
  await q.fill("input[name=email]", "reviewer@rehearsal.test");
  await q.fill("input[name=password]", pw);
  await q.click('button:has-text("Sign in")');
  await q.waitForURL("**/login/mfa");
  await q.getByRole("button", { name: "Use a recovery code" }).click();
  await q.fill("input[name=code]", code);
  await q.getByRole("button", { name: "Verify" }).click();
  await q.waitForURL((u) => !u.pathname.startsWith("/login"));
  await q.goto(`${B}/calendar`, { waitUntil: "networkidle" });
  await q.getByText(/Made to last/).first().waitFor();
  log("the Meta reviewer account signs in (password + recovery code) and sees its approved review posts");
  await r.close();

  await browser.close();
  if (errs.length) fail(`page errors or 5xx: ${errs.join(" | ")}`);
  log("no page errors or 5xx responses");
})().catch(async (e) => {
  console.error("REHEARSAL FAILED:", e.message);
  try {
    if (global.__page) console.error(`at ${global.__page.url()}: ${(await global.__page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 600)}`);
  } catch {
    /* ignore */
  }
  process.exit(1);
});
