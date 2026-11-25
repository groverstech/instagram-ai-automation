// Q1 / R-P0-4: the whole lifecycle in one journey, with the social sandbox (simulated platform),
// demo AI and the file email outbox. Sign-up → email verification → organisation → brand → profile →
// strategy → calendar → content → visual → submit → approve → schedule → publish (via the cron
// scheduler) → publish history → metrics → analytics → autonomy settings → organisation export →
// invite a teammate → they sign up, verify and join with their role.
const { chromium } = require("playwright");
const { execSync } = require("child_process");
//
// Run: npm run e2e:lifecycle (see e2e/lifecycle.sh), after `npm run build`. Needs Postgres
// (E2E_DATABASE_URL), the server started by the runner with SOCIAL_SANDBOX=true and AI_PROVIDER=mock,
// and Playwright with Chromium. Everything here is simulated; it is never evidence of a real platform.
const path = require("path");
const S = process.argv[2] || require("fs").mkdtempSync(path.join(require("os").tmpdir(), "bp-lifecycle-"));
const F = path.join(__dirname, "fixtures");
const B = process.env.E2E_BASE_URL || "http://localhost:3100";
const CRON = process.env.CRON_SECRET;
const DB = process.env.E2E_DATABASE_URL;
if (!CRON || !DB) throw new Error("Set CRON_SECRET and E2E_DATABASE_URL (the runner does).");
const log = (...a) => console.log("✓", ...a);
const fail = (m) => { throw new Error(m); };
const sql = (q) => execSync(`psql "${DB}" -tAc "${q}"`).toString().trim();
const fs = require("fs");
const OUTBOX = process.env.E2E_OUTBOX;
if (!OUTBOX) throw new Error("Set E2E_OUTBOX (the runner does).");
/** The newest email to `to` in the file outbox, and the first link in it to `path`. */
const mailLink = async (to, pathPart) => {
  for (let i = 0; i < 40; i++) {
    const msgs = (fs.existsSync(OUTBOX) ? fs.readdirSync(OUTBOX) : []).sort().map((f) => JSON.parse(fs.readFileSync(path.join(OUTBOX, f), "utf8"))).filter((m) => m.to === to);
    const m = msgs.at(-1);
    const link = m && (m.text.match(new RegExp(`https?://\\S+/${pathPart}\\?token=\\S+`)) || [])[0];
    if (link) return { subject: m.subject, link };
    await new Promise((r) => setTimeout(r, 250));
  }
  fail(`no email to ${to} with a ${pathPart} link`);
};
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  global.__page = p;
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  p.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errs.push("console: " + m.text()));
  p.on("dialog", (d) => d.accept());
  const shot = async (n, full = true) => { await p.waitForTimeout(500); await p.screenshot({ path: `${S}/${n}.png`, fullPage: full }); };
  const tab = (name) => p.getByRole("tab", { name, exact: true }).click();
  const panel = () => p.locator('[role=tabpanel]:not(.hidden)');

  // --- Sign up + onboarding + approve brand profile
  await p.goto(B + "/signup");
  await p.fill("input[name=name]", "Asha Rao"); await p.fill("input[name=email]", "life@kora.test");
  await p.fill("input[name=password]", "supersecret1"); await p.fill("input[name=workspace]", "Kora Studio");
  await p.click('button:has-text("Create account")'); await p.waitForURL("**/verify-email");
  // Unverified: the app is closed until the address is confirmed.
  await p.goto(B + "/dashboard"); await p.waitForURL("**/verify-email");
  await p.getByText("Check your inbox").waitFor();
  const v = await mailLink("life@kora.test", "verify-email");
  await p.goto(v.link);
  await p.getByRole("button", { name: "Confirm my email address" }).click();
  await p.waitForURL("**/onboarding");
  log(`signed up; email verified through the test outbox ("${v.subject}")`);
  await p.fill("input[name=name]", "Kora Ceramics");
  await p.fill("textarea[name=description]", "A two-person studio in Bengaluru making small-batch stoneware for everyday use.");
  await p.fill("input[name=industry]", "Home & lifestyle");
  await p.fill("textarea[name=products]", "Stoneware mugs, serving bowls, dinner sets, pottery workshops");
  await p.click('button:has-text("Continue")');
  await p.fill("textarea[name=targetAudience]", "Design-conscious hosts aged 28-45 who prefer fewer, better things");
  await p.fill("input[name=geography]", "India: Bengaluru, Mumbai, Delhi");
  await p.click('button:has-text("Continue")');
  await p.fill("textarea[name=positioning]", "The modern heirloom: handmade ceramics for everyday use");
  await p.click('button:has-text("Continue")'); await p.click('button:has-text("Continue")');
  await p.fill("textarea[name=competitors]", "Claymen\nThe Pottery Barn");
  await p.click('button:has-text("Continue")');
  await p.locator('form input[type=file]').nth(0).setInputFiles(`${F}/logo.png`);
  await p.click('button:has-text("Continue")');
  await p.click('button:has-text("Analyse my brand")');
  await p.waitForURL("**/brand**", { timeout: 60000 });

  log("account, organisation and brand created; brand analysed (demo AI)");

  await p.goto(B + "/brand");
  await p.getByRole("button", { name: /Approve v1/ }).click();
  await p.locator("text=Approved").first().waitFor();
  log("brand profile approved");

  // --- Wizard (steps 1-4) and generation
  await p.goto(B + "/strategist");
  await p.getByRole("button", { name: "Build a strategy" }).click();
  await p.waitForSelector("text=New marketing strategy");
  await p.selectOption('select[aria-label="Account type"]', "business");
  await shot("02-wizard-brand", false);
  await p.getByRole("button", { name: /Continue/ }).click();
  await p.waitForSelector("text=approved Brand Intelligence Profile (v1)");
  await p.getByRole("button", { name: /Continue/ }).click();
  await p.locator('textarea[placeholder^="Grow online sales"]').fill("Grow online sales\nFill weekend pottery workshops");
  await p.locator('textarea[placeholder^="e.g. 300 newsletter"]').fill("40 workshop bookings per month by March");
  await p.getByRole("button", { name: "Pinterest", exact: true }).click().catch(() => {});
  await shot("03-wizard-objectives", false);
  await p.getByRole("button", { name: /Continue/ }).click();
  // Missing info: answer one, let the AI assume the rest.
  const boxes = p.locator('input[type=checkbox]');
  for (let i = 0; i < (await boxes.count()); i++) await boxes.nth(i).check();
  await p.locator('textarea[placeholder^="e.g. Winter glaze"]').fill("Diwali gifting season; studio open day on the 18th");
  await shot("04-wizard-missing-info", false);
  await p.getByRole("button", { name: /Continue/ }).click();
  await p.waitForSelector("text=Seven specialist agents");
  await shot("05-wizard-review", false);
  await p.getByRole("button", { name: "Generate strategy" }).click();
  await p.waitForURL("**/strategist?v=**");
  await p.waitForSelector("text=/strategist team is working|Strategy updated|Positioning/", { timeout: 20000 });
  await shot("06-progress", false);
  await p.waitForFunction(() => !document.body.innerText.includes("strategist team is working"), null, { timeout: 90000 });
  await p.waitForTimeout(1500);
  await p.reload();
  await p.waitForSelector("text=Planned posts");
  const tiles = await p.locator("text=Planned posts").locator("..").innerText();
  log("strategy generated; overview tile:", tiles.replace(/\s+/g, " "));

  // Approve the strategy and put its calendar on the content calendar.
  await p.getByRole("button", { name: "Submit for review" }).click();
  await p.waitForSelector('button:has-text("Request revisions")');
  await p.getByRole("button", { name: "Approve", exact: true }).first().click();
  await p.waitForSelector("text=approved strategy is locked");
  await tab("30-day calendar");
  await panel().getByRole("button", { name: "Add to content calendar" }).click();
  await p.waitForSelector("text=/draft posts on the content calendar/");
  const drafts = sql("select count(*) from posts where status='draft'");
  log(`strategy approved; ${drafts} draft posts on the content calendar`);

  // Connect a (simulated) Instagram account through the real OAuth start and callback.
  await p.goto(B + "/accounts");
  await p.getByRole("status", { name: "Social sandbox" }).waitFor();
  await p.locator('a[href*="/api/oauth/instagram/start"]').click();
  await p.waitForURL("**/accounts?connected=*");
  await p.getByText("Sandbox Instagram account").first().waitFor();
  await shot("01-accounts-connected");
  log("Instagram (simulated) connected through the OAuth start and callback (the Meta login also brings the Facebook Page, as in production); the sandbox banner is shown");

  // Open an Instagram draft, generate its creative and caption.
  const postId = sql("select id from posts where platform='instagram' and status='draft' order by scheduled_at limit 1");
  if (!postId) fail("no Instagram draft post");
  await p.goto(`${B}/calendar?post=${postId}`);
  await p.getByTitle("Generate creative + caption").click();
  for (let i = 0; i < 60 && !sql(`select creative_id from posts where id='${postId}'`); i++) await p.waitForTimeout(1000);
  if (!sql(`select creative_id from posts where id='${postId}'`)) fail("no creative attached");
  await p.reload();
  log("content and visual generated for the post (demo AI: labelled placeholder copy and type-led creative)");

  // Choose the account and a time two minutes ahead; save; submit; approve; schedule.
  const acct = sql("select id from social_accounts where platform='instagram'");
  const when = new Date(Date.now() + 2 * 60_000);
  const local = new Date(when.getTime() - when.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  await p.locator("select").filter({ has: p.locator(`option[value="${acct}"]`) }).selectOption(acct);
  await p.locator('input[type="datetime-local"]').fill(local);
  await p.getByRole("button", { name: "Save changes" }).click();
  await p.waitForFunction(() => !document.body.innerText.includes("Save changes"), null, { timeout: 15000 });
  await p.getByRole("button", { name: /Submit for approval/ }).click();
  await p.getByRole("button", { name: /^Approve/ }).first().click();
  await p.getByRole("button", { name: /^Schedule/ }).first().click();
  await p.getByText(/Scheduled\. It will publish/).first().waitFor();
  if (sql(`select status from posts where id='${postId}'`) !== "scheduled") fail("not scheduled");
  await shot("02-scheduled", false);
  log("post saved with the account and time, submitted, approved and scheduled");

  // The scheduler publishes it when due: the external cron endpoint runs the job.
  while (Date.now() < when.getTime() + 2000) await p.waitForTimeout(2000);
  const tick = execSync(`curl -s -H "authorization: Bearer ${CRON}" ${B}/api/cron/tick`).toString();
  const st = sql(`select status || '|' || coalesce(external_id,'') from posts where id='${postId}'`);
  if (!/^published\|sandbox-post-/.test(st)) fail(`not published: ${st}; tick: ${tick.slice(0, 200)}`);
  await p.reload();
  await p.getByText(/Published/).first().waitFor();
  await shot("03-published", false);
  log(`the scheduled job published it through the cron scheduler (simulated platform id ${st.split("|")[1]})`);

  // Publish history (the ledger) on the post.
  const attempts = sql(`select string_agg(status, ',' order by attempt) from publish_attempts where post_id='${postId}'`);
  if (attempts !== "succeeded") fail(`publish attempts: ${attempts}`);
  await p.getByText(/Publishing history \(1\)/).first().waitFor();
  log("publish attempt recorded (succeeded) and shown in the post's publishing history");

  // Metrics and results.
  await p.goto(B + "/analytics");
  await p.getByRole("button", { name: /Sync metrics/ }).click();
  await p.getByText(/Synced 1 posts and \d+ accounts/).first().waitFor({ timeout: 20000 });
  const reach = sql(`select reach from post_metrics where post_id='${postId}' order by captured_at desc limit 1`);
  if (!(Number(reach) > 0)) fail("no post metrics");
  await p.reload();
  await shot("04-analytics");
  log(`metrics synced (simulated): reach ${reach} for the post, follower counts for the connected accounts; Analytics shows them`);

  // Insights: the analysis panel is on the Analytics page.
  await p.getByText(/Published posts|Reach/).first().waitFor();

  // Autonomy: Assisted by default; Autonomous unavailable during the private beta.
  await p.goto(B + "/settings");
  const auto = p.getByRole("region", { name: "Autonomy" }).or(p.locator('[aria-label="Autonomy"]')).first();
  await auto.getByText("In effect: Assisted", { exact: true }).waitFor();
  await auto.getByText(/Not available during the private beta/).waitFor();
  if (!(await auto.locator('input[value="autonomous"]').isDisabled())) fail("Autonomous should be unavailable");
  await auto.scrollIntoViewIfNeeded();
  await auto.screenshot({ path: `${S}/05-autonomy.png` });
  await p.setViewportSize({ width: 390, height: 844 });
  await p.waitForTimeout(300);
  if (await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) fail("Settings scrolls sideways at phone width");
  await auto.screenshot({ path: `${S}/05-autonomy-mobile.png` });
  await p.setViewportSize({ width: 1440, height: 1000 });
  log("autonomy: Assisted in effect; Autonomous unavailable (platform switch off); no sideways scroll at phone width");

  // Organisation export includes the post and its publish history, and no secrets.
  const exp = await p.request.get(B + `/api/workspace/export?workspace=${sql("select id from workspaces where name='Kora Studio'")}`);
  if (exp.status() !== 200) fail(`export: HTTP ${exp.status()} ${(await exp.text()).slice(0, 200)}`);
  const JSZip = require(path.join(__dirname, "..", "node_modules", "jszip"));
  const zip = await JSZip.loadAsync(await exp.body());
  const data = JSON.parse(await zip.file("data.json").async("string"));
  if (!data.publishAttempts?.some((a) => a.postId === postId && a.status === "succeeded")) fail("export lacks the publish attempt");
  const all = await zip.file("data.json").async("string");
  if (/accessTokenEnc|passwordHash|idempotencyKey|sandbox-token-/.test(all)) fail("export contains a secret");
  log(`organisation export: ${data.posts.length} posts, ${data.publishAttempts.length} publish attempts, no tokens or password hashes`);

  // Invite a teammate; they sign up with that address, verify it and join as an editor.
  await p.goto(B + "/settings");
  await p.fill('input[placeholder="teammate@company.com"]', "mira@kora.test");
  await p.getByRole("button", { name: "Invite", exact: true }).click();
  await p.getByText("invitation pending").first().waitFor();
  const inv = await mailLink("mira@kora.test", "invite");
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const q = await ctx2.newPage();
  q.on("pageerror", (e) => errs.push("teammate: " + e.message));
  await q.goto(inv.link);
  await q.getByRole("heading", { name: "Join Kora Studio" }).waitFor();
  await q.screenshot({ path: `${S}/06-invite.png` });
  await q.getByRole("link", { name: /Create an account with mira@kora.test/ }).click();
  await q.fill("input[name=name]", "Mira K"); await q.fill("input[name=email]", "mira@kora.test");
  await q.fill("input[name=password]", "supersecret2"); await q.fill("input[name=workspace]", "unused");
  await q.click('button:has-text("Create account")'); await q.waitForURL("**/verify-email");
  if (sql("select count(*) from workspace_members m join users u on u.id=m.user_id where u.email='mira@kora.test'") !== "0") fail("joined before verifying");
  const v2 = await mailLink("mira@kora.test", "verify-email");
  await q.goto(v2.link);
  await q.getByRole("button", { name: "Confirm my email address" }).click();
  await q.waitForURL("**/dashboard");
  const role = sql("select m.role || '|' || m.status from workspace_members m join users u on u.id=m.user_id join workspaces w on w.id=m.workspace_id where u.email='mira@kora.test' and w.name='Kora Studio'");
  if (role !== "editor|active") fail(`teammate membership: ${role}`);
  await q.getByText("Kora Ceramics").first().waitFor();
  log(`invitation emailed ("${inv.subject}"); the teammate signed up, verified and joined as editor (not before verifying)`);
  await ctx2.close();

  if (errs.length) { console.log("ERRORS:", errs); process.exitCode = 1; } else log("no page errors");
  await browser.close();
})().catch(async (e) => {
  console.error("FAILED:", e.message);
  // Leave a screenshot of where it stopped, for the CI artefacts.
  try { if (global.__page) await global.__page.screenshot({ path: `${S}/failure.png`, fullPage: true }); } catch { /* ignore */ }
  process.exit(1);
});
