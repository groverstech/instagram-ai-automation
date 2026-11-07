import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { NextRequest } from "next/server";

process.env.PGLITE_DIR = "memory://";

const { getDb, schema } = await import("./db/client");
const web = await import("./web");
const { enforce, withAiSlot, RateLimitError, RULES, CONCURRENCY } = await import("./ratelimit");
const { checkUploadForm, MAX_FILES_PER_UPLOAD } = await import("./assets");
const { redact } = await import("./log");
const { safe } = await import("./action");
const { middleware, config: mwConfig } = await import("../middleware");

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const pub = (address = "93.184.215.14") => async () => [{ address, family: 4 as const }];

// ---------------------------------------------------------------------------
// SSRF
// ---------------------------------------------------------------------------

describe("SSRF: address classification", () => {
  it("blocks loopback, private, link-local/metadata, CGNAT, reserved, multicast and special IPv6 ranges", () => {
    const blocked = [
      "127.0.0.1", "127.255.255.254", "0.0.0.0", "10.0.0.1", "172.16.5.4", "172.31.255.255", "192.168.0.10",
      "169.254.169.254", "100.64.0.1", "100.127.255.254", "192.0.0.8", "192.0.2.1", "198.18.0.1", "198.51.100.7",
      "203.0.113.9", "224.0.0.251", "239.255.255.250", "240.0.0.1", "255.255.255.255",
      "::", "::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254", "::ffff:8.8.8.8", "64:ff9b::a9fe:a9fe", "100::1",
      "2001:db8::1", "2001::1", "2002:a9fe:a9fe::1", "fc00::1", "fd12:3456::1", "fe80::1", "fec0::1", "ff02::1", "not-an-ip",
    ];
    for (const ip of blocked) expect(web.isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["93.184.215.14", "8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "2a00:1450:4001::200e"]) {
      expect(web.isPrivateAddress(ip), ip).toBe(false);
    }
  });
});

describe("SSRF: URL policy", () => {
  it("rejects dangerous schemes, credentials, non-standard ports and internal hostnames", () => {
    const bad = [
      "file:///etc/passwd", "ftp://example.com/", "gopher://example.com/", "data:text/html,hi", "javascript:alert(1)",
      "https://user:pw@example.com/", "https://example.com:8080/", "http://example.com:6379/", "http://example.com:22/",
      "http://localhost/", "http://LOCALHOST./", "http://api.localhost/", "http://db.internal/", "http://printer.local/",
      "http://metadata.google.internal/computeMetadata/v1/", "http://intranet/", "http://metadata/",
      "http://[::1]/", "http://[::ffff:169.254.169.254]/", "http://169.254.169.254/latest/meta-data/",
      // Obfuscated IPv4 forms are normalised by the URL parser, then blocked.
      "http://2130706433/", "http://0x7f000001/", "http://0177.0.0.1/", "http://127.1/", "http://0/",
    ];
    for (const u of bad) expect(() => web.checkUrlPolicy(new URL(u)), u).toThrow(web.UnsafeUrlError);
    expect(web.checkUrlPolicy(new URL("https://www.Example.com./about"))).toBe("www.example.com");
    expect(web.checkUrlPolicy(new URL("http://93.184.215.14/"))).toBe("93.184.215.14");
  });
});

describe("SSRF: DNS resolution", () => {
  it("requires every resolved address to be public and resolves exactly once", async () => {
    let calls = 0;
    const r = await web.resolvePublic("brand.example", async () => (calls++, [{ address: "93.184.215.14", family: 4 }]));
    expect(r).toEqual({ address: "93.184.215.14", family: 4 });
    expect(calls).toBe(1);
  });

  it("rejects mixed public/private answers, private-only, mapped, empty and failing lookups", async () => {
    const cases: [string, () => Promise<{ address: string; family: 4 | 6 }[]>][] = [
      ["mixed", async () => [{ address: "93.184.215.14", family: 4 }, { address: "10.0.0.5", family: 4 }]],
      ["aaaa loopback", async () => [{ address: "::1", family: 6 }]],
      ["metadata", async () => [{ address: "169.254.169.254", family: 4 }]],
      ["mapped", async () => [{ address: "::ffff:10.0.0.1", family: 6 }]],
      ["empty", async () => []],
      ["nxdomain", async () => Promise.reject(new Error("ENOTFOUND"))],
    ];
    for (const [name, resolver] of cases) await expect(web.resolvePublic("brand.example", resolver), name).rejects.toThrow(web.UnsafeUrlError);
  });
});

describe("SSRF: redirects and DNS rebinding", () => {
  const ok = { status: 200, location: null, contentType: "text/html", body: "<title>Kora</title><p>Handmade ceramics</p>" };
  const redirect = (location: string) => ({ status: 302, location, contentType: "", body: "" });

  it("re-validates every redirect destination", async () => {
    for (const target of ["http://169.254.169.254/latest/meta-data/", "http://127.0.0.1/", "http://localhost/", "file:///etc/passwd", "https://example.com:8443/", "http://[::1]/", "http://db.internal/"]) {
      let n = 0;
      const text = await web.fetchPublicText("https://brand.example/", 100, { resolver: pub(), requester: async () => (n++, redirect(target)) });
      expect(text, target).toBeNull();
      expect(n, target).toBe(1);
    }
  });

  it("blocks a redirect to a hostname that resolves to a private address", async () => {
    const resolver = async (h: string) => [{ address: h === "evil.example" ? "10.0.0.7" : "93.184.215.14", family: 4 as const }];
    let n = 0;
    const text = await web.fetchPublicText("https://brand.example/", 100, { resolver, requester: async () => (n++, redirect("https://evil.example/")) });
    expect(text).toBeNull();
    expect(n).toBe(1);
  });

  it("pins the connection to the validated address (DNS rebinding)", async () => {
    // A rebinding resolver answers public first, private afterwards.
    let lookups = 0;
    const rebinding = async () => [{ address: lookups++ === 0 ? "93.184.215.14" : "127.0.0.1", family: 4 as const }];
    const pinnedTo: string[] = [];
    const text = await web.fetchPublicText("https://brand.example/", 100, { resolver: rebinding, requester: async (_u, pinned) => (pinnedTo.push(pinned.address), ok) });
    expect(text).toContain("Handmade ceramics");
    expect(lookups).toBe(1); // resolved once by us; the requester connects to the pinned IP only
    expect(pinnedTo).toEqual(["93.184.215.14"]);

    // If a redirect sends us back to the same host, it is re-resolved and now blocked.
    lookups = 0;
    let n = 0;
    const blocked = await web.fetchPublicText("https://brand.example/", 100, { resolver: rebinding, requester: async () => (n++ === 0 ? redirect("/again") : ok) });
    expect(blocked).toBeNull();
    expect(n).toBe(1);
  });

  it("follows relative public redirects, but at most 4", async () => {
    const seen: string[] = [];
    const text = await web.fetchPublicText("https://brand.example/a", 100, { resolver: pub(), requester: async (u) => (seen.push(u.pathname), seen.length < 3 ? redirect(`/r${seen.length}`) : ok) });
    expect(seen).toEqual(["/a", "/r1", "/r2"]);
    expect(text).toContain("Kora");
    let loops = 0;
    expect(await web.fetchPublicText("https://brand.example/", 100, { resolver: pub(), requester: async () => (loops++, redirect("/loop")) })).toBeNull();
    expect(loops).toBe(web.LIMITS.maxRedirects + 1);
  });

  it("returns nothing for errors, non-text responses and empty bodies", async () => {
    for (const res of [{ status: 500, location: null, contentType: "text/html", body: "" }, { status: 200, location: null, contentType: "application/octet-stream", body: "" }]) {
      expect(await web.fetchPublicText("https://brand.example/", 100, { resolver: pub(), requester: async () => res })).toBeNull();
    }
  });
});

describe("SSRF: pinned HTTP client on real sockets", () => {
  let server: http.Server;
  let port = 0;
  const seenHosts: string[] = [];
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seenHosts.push(String(req.headers.host));
      if (req.url === "/big") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("x".repeat(2_000_000));
      } else if (req.url === "/slow") {
        // never responds
      } else if (req.url === "/redirect") {
        res.writeHead(302, { location: "http://169.254.169.254/" });
        res.end();
      } else if (req.url === "/binary") {
        res.writeHead(200, { "content-type": "application/zip" });
        res.end("PK");
      } else {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<title>Pinned</title><p>ok</p>");
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => server.close());

  const pinned = { address: "127.0.0.1", family: 4 as const };
  const at = (path: string) => new URL(`http://unresolvable-host.invalid:${port}${path}`);

  it("connects to the pinned IP without resolving the hostname, and sends the original Host header", async () => {
    const r = await web.requestPinned(at("/"), pinned, AbortSignal.timeout(3000));
    expect(r.status).toBe(200);
    expect(r.body).toContain("Pinned");
    expect(seenHosts.at(-1)).toBe(`unresolvable-host.invalid:${port}`);
  });

  it("caps the response size", async () => {
    const r = await web.requestPinned(at("/big"), pinned, AbortSignal.timeout(3000));
    expect(r.body.length).toBe(web.LIMITS.maxBytes);
  });

  it("does not follow redirects or read non-text bodies", async () => {
    const r = await web.requestPinned(at("/redirect"), pinned, AbortSignal.timeout(3000));
    expect(r).toMatchObject({ status: 302, location: "http://169.254.169.254/", body: "" });
    expect((await web.requestPinned(at("/binary"), pinned, AbortSignal.timeout(3000))).body).toBe("");
  });

  it("times out slow servers", async () => {
    const started = Date.now();
    await expect(web.requestPinned(at("/slow"), pinned, AbortSignal.timeout(300))).rejects.toThrow();
    const text = await web.fetchPublicText("https://brand.example/", 100, {
      resolver: pub(),
      timeoutMs: 300,
      requester: (_u, _p, signal) => web.requestPinned(at("/slow"), pinned, signal),
    });
    expect(text).toBeNull();
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe("rate limiting", () => {
  let ws1 = "";
  let ws2 = "";
  beforeAll(async () => {
    const db = await getDb();
    [{ id: ws1 }, { id: ws2 }] = await db.insert(schema.workspaces).values([{ name: "RL1" }, { name: "RL2", plan: "growth" }]).returning({ id: schema.workspaces.id });
  });

  it("enforces per-user limits with a 429 and retry hint, independently per user", async () => {
    const now = new Date("2026-11-07T10:00:05Z");
    const max = RULES.ai[0].limit;
    for (let i = 0; i < max; i++) await enforce("ai", { userId: "u-a", workspaceId: ws1 }, now);
    const err = await enforce("ai", { userId: "u-a", workspaceId: ws1 }, now).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.status).toBe(429);
    expect(err.retryAfter).toBe(55);
    await expect(enforce("ai", { userId: "u-b", workspaceId: ws1 }, now)).resolves.toBeUndefined();
    // Next window: allowed again.
    await expect(enforce("ai", { userId: "u-a", workspaceId: ws1 }, new Date("2026-11-07T10:01:01Z"))).resolves.toBeUndefined();
  });

  it("enforces per-organisation limits across users, without affecting other organisations", async () => {
    const now = new Date("2026-11-07T11:00:00Z");
    const [perUser, perOrg] = [RULES.ai_heavy[0].limit, RULES.ai_heavy[1].limit];
    let allowed = 0;
    for (let u = 0; allowed < perOrg; u++) {
      for (let i = 0; i < perUser && allowed < perOrg; i++, allowed++) await enforce("ai_heavy", { userId: `org-user-${u}`, workspaceId: ws1 }, now);
    }
    await expect(enforce("ai_heavy", { userId: "fresh-user", workspaceId: ws1 }, now)).rejects.toThrow(/Too many/);
    await expect(enforce("ai_heavy", { userId: "fresh-user", workspaceId: ws2 }, now)).resolves.toBeUndefined();
  });

  it("limits uploads and login attempts", async () => {
    const now = new Date("2026-11-07T12:00:00Z");
    for (let i = 0; i < RULES.upload[0].limit; i++) await enforce("upload", { userId: "uploader", workspaceId: ws2 }, now);
    await expect(enforce("upload", { userId: "uploader", workspaceId: ws2 }, now)).rejects.toThrow(/uploads/);
    for (let i = 0; i < RULES.login[0].limit; i++) await enforce("login", { key: "hash-of-email" }, now);
    await expect(enforce("login", { key: "hash-of-email" }, now)).rejects.toThrow(/sign-in/);
    await expect(enforce("login", { key: "other-email" }, now)).resolves.toBeUndefined();
  });

  it("caps concurrent AI tasks per user and per organisation, and always releases leases", async () => {
    const gate: (() => void)[] = [];
    const hold = () => new Promise<void>((r) => gate.push(r));
    const subj = { userId: "conc-user", workspaceId: ws2, plan: "growth" as const };
    const running = [withAiSlot(subj, "ai", hold), withAiSlot(subj, "ai", hold)];
    await new Promise((r) => setTimeout(r, 50));
    await expect(withAiSlot(subj, "ai", async () => 1)).rejects.toThrow(/already have AI tasks running/);
    // Organisation cap (growth = 4) across users.
    const others = [withAiSlot({ ...subj, userId: "o1" }, "ai", hold), withAiSlot({ ...subj, userId: "o2" }, "ai", hold)];
    await new Promise((r) => setTimeout(r, 50));
    await expect(withAiSlot({ ...subj, userId: "o3" }, "ai", async () => 1)).rejects.toThrow(/organisation already has/);
    gate.forEach((g) => g());
    await Promise.all([...running, ...others]);
    // Leases are released after success and after failure.
    await expect(withAiSlot(subj, "ai", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(withAiSlot(subj, "ai", async () => "free")).resolves.toBe("free");
    const db = await getDb();
    expect(await db.$count(schema.aiTaskLeases)).toBe(0);
    expect(CONCURRENCY.perUser).toBe(2);
  });

  it("ignores expired leases (e.g. after a crash)", async () => {
    const db = await getDb();
    await db.insert(schema.aiTaskLeases).values([
      { workspaceId: ws1, userId: "crashed", kind: "ai", expiresAt: new Date(Date.now() - 1000) },
      { workspaceId: ws1, userId: "crashed", kind: "ai", expiresAt: new Date(Date.now() - 1000) },
    ]);
    await expect(withAiSlot({ userId: "crashed", workspaceId: ws1, plan: "starter" }, "ai", async () => "ok")).resolves.toBe("ok");
  });

  it("maps rate-limit errors to a structured 429 result for server actions", async () => {
    const r = await safe(async () => {
      throw new RateLimitError("Slow down.", 42);
    });
    expect(r).toEqual({ ok: false, error: "Slow down.", status: 429, retryAfter: 42 });
  });
});

describe("edge middleware", () => {
  const req = (path: string, method = "POST", ip = "203.0.113.50") => new NextRequest(`http://localhost${path}`, { method, headers: { "x-forwarded-for": ip } });

  it("answers HTTP 429 with Retry-After when one IP floods mutating requests", async () => {
    let last: Response | undefined;
    for (let i = 0; i < 121; i++) last = middleware(req("/brand"));
    expect(last!.status).toBe(429);
    expect(Number(last!.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await last!.json()).error).toMatch(/Too many requests/);
    expect(middleware(req("/brand", "POST", "198.51.100.9")).status).not.toBe(429);
    expect(middleware(req("/brand", "GET")).status).not.toBe(429);
    expect(middleware(req("/api/billing/webhook")).status).not.toBe(429);
  });

  it("never runs on static, icon, manifest or asset-link paths (PWA/TWA)", () => {
    const re = new RegExp(`^${mwConfig.matcher[0]}$`);
    for (const p of ["/_next/static/chunks/a.js", "/icons/icon-512.png", "/manifest.webmanifest", "/.well-known/assetlinks.json", "/icon", "/apple-icon"]) expect(re.test(p), p).toBe(false);
    for (const p of ["/brand", "/api/assets/x", "/onboarding"]) expect(re.test(p), p).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Uploads & secrets
// ---------------------------------------------------------------------------

describe("upload form validation", () => {
  const form = (files: [string, Blob, string][]) => {
    const fd = new FormData();
    for (const [field, blob, name] of files) fd.append(field, blob, name);
    return fd;
  };
  const png = () => new Blob([PNG], { type: "image/png" });

  it("accepts valid files and sanitises names", async () => {
    const out = await checkUploadForm(form([["asset_logo", png(), "lo\u0007go.png"]]), ["logo", "product"] as const);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "logo", name: "logo.png", mime: "image/png" });
  });

  it("is all-or-nothing: one bad file rejects the whole upload", async () => {
    const fd = form([["asset_logo", png(), "a.png"], ["asset_product", new Blob(["#!/bin/sh\nrm -rf /"]), "photo.png"]]);
    await expect(checkUploadForm(fd, ["logo", "product"] as const)).rejects.toThrow(/photo.png: unsupported/);
  });

  it("rejects too many files and oversized batches before reading contents", async () => {
    const many = form(Array.from({ length: MAX_FILES_PER_UPLOAD + 1 }, (_, i) => ["asset_product", png(), `p${i}.png`] as [string, Blob, string]));
    await expect(checkUploadForm(many, ["product"] as const)).rejects.toThrow(/Upload up to 20 files/);
    const big = form(Array.from({ length: 4 }, (_, i) => ["asset_product", new Blob([new Uint8Array(14 * 1024 * 1024)]), `b${i}.png`] as [string, Blob, string]));
    await expect(checkUploadForm(big, ["product"] as const)).rejects.toThrow(/50 MB/);
  });

  it("ignores fields for unknown asset kinds", async () => {
    expect(await checkUploadForm(form([["asset_executable", png(), "x.png"]]), ["logo"] as const)).toEqual([]);
  });
});

describe("secret redaction in logs", () => {
  it("redacts secret-looking fields and key-like values", () => {
    const out = redact({
      apiKey: "abc",
      authorization: "Bearer x",
      nested: { refresh_token: "r", note: "using sk-ant-api03-ABCDEFGHIJKLMNOP and whsec_ABCDEFGHIJKLMNOPQR" },
      list: ["sk_live_ABCDEFGHIJKLMNOP"],
      ok: "brand.profile_generated",
    }) as Record<string, unknown>;
    expect(out.apiKey).toBe("[REDACTED]");
    expect(out.authorization).toBe("[REDACTED]");
    expect(JSON.stringify(out)).not.toMatch(/sk-ant-|whsec_|sk_live_/);
    expect(out.ok).toBe("brand.profile_generated");
  });
});
