// Load test (PR 4.9 remainder; docs/LOAD_TEST.md): one signed-in session, fixed concurrency per page.
// EMAIL=… PASSWORD=… [B=http://localhost:3100] [DUR=20] [CONC=10,25] [OUT=results.json] node e2e/load.cjs
const { chromium } = require("playwright");
const B = process.env.B || "http://localhost:3100";
const DUR = Number(process.env.DUR || 30) * 1000;
const CONC = (process.env.CONC || "10,25").split(",").map(Number);
const pct = (a, p) => a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto(B + "/login");
  await p.fill("input[name=email]", process.env.EMAIL); await p.fill("input[name=password]", process.env.PASSWORD);
  await p.click('button:has-text("Sign in")'); await p.waitForURL(/dashboard|onboarding/);
  const cookie = (await ctx.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  await browser.close();
  const paths = ["/dashboard", "/calendar", "/analytics", "/settings", "/campaigns", "/api/health/ready"];
  const results = [];
  for (const conc of CONC) {
    for (const path of paths) {
      const lat = []; let errors = 0; const end = Date.now() + DUR;
      await Promise.all(Array.from({ length: conc }, async () => {
        while (Date.now() < end) {
          const t = performance.now();
          try { const r = await fetch(B + path, { headers: { cookie }, redirect: "manual" }); await r.arrayBuffer(); if (r.status !== 200) errors++; } catch { errors++; }
          lat.push(performance.now() - t);
        }
      }));
      lat.sort((a, b) => a - b);
      const row = { conc, path, requests: lat.length, rps: +(lat.length / (DUR / 1000)).toFixed(1), p50: +pct(lat, 50).toFixed(0), p95: +pct(lat, 95).toFixed(0), p99: +pct(lat, 99).toFixed(0), errors };
      results.push(row); console.log(JSON.stringify(row));
    }
  }
  require("fs").writeFileSync(process.env.OUT || "results.json", JSON.stringify(results, null, 2));
})().catch((e) => { console.error("FAILED", e.message); process.exit(1); });
