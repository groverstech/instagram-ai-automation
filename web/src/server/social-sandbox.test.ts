/**
 * Social sandbox (social/sandbox.ts): only in development, demo and CI; never in staging or
 * production; labelled; honest capabilities; deterministic simulated metrics.
 */
import { describe, expect, it } from "vitest";

process.env.PGLITE_DIR = "memory://";

const { sandboxOn, sandboxed } = await import("./social/sandbox");
const { instagram } = await import("./social/providers/meta");
const { youtube } = await import("./social/providers/others");
const { checkConfig } = await import("./config");

describe("social sandbox", () => {
  it("runs only in development, demo and test; never in staging, production or an unknown environment", () => {
    for (const d of [undefined, "", "development", "demo", "test"]) expect(sandboxOn({ SOCIAL_SANDBOX: "true", DEPLOY_ENV: d })).toBe(true);
    for (const d of ["staging", "production", "prod", "live"]) expect(sandboxOn({ SOCIAL_SANDBOX: "true", DEPLOY_ENV: d })).toBe(false);
    expect(sandboxOn({})).toBe(false);
    expect(sandboxOn({ SOCIAL_SANDBOX: "yes" })).toBe(false);
    const err = (env: Record<string, string>) => checkConfig(env).some((p) => p.key === "SOCIAL_SANDBOX" && p.level === "error");
    expect(err({ SOCIAL_SANDBOX: "true", DEPLOY_ENV: "production" })).toBe(true);
    expect(err({ SOCIAL_SANDBOX: "true", DEPLOY_ENV: "staging" })).toBe(true);
    expect(err({ SOCIAL_SANDBOX: "true" })).toBe(false);
  });

  it("is labelled simulated, accepts only its own codes, and keeps the real capabilities", async () => {
    const ig = sandboxed(instagram);
    expect(ig.label).toBe("Instagram (simulated)");
    expect(ig.capabilities.publishImage).toBe(instagram.capabilities.publishImage);
    expect(ig.capabilities.notes).toMatch(/^Sandbox: simulated/);
    const url = new URL(ig.authorizeUrl({ state: "s1", redirectUri: "http://localhost:3100/api/oauth/instagram/callback", codeChallenge: "c" }));
    expect(url.origin + url.pathname).toBe("http://localhost:3100/api/oauth/instagram/callback"); // never leaves the app
    expect(url.searchParams.get("state")).toBe("s1");
    await expect(ig.exchangeCode({ code: "real-code", redirectUri: "x", codeVerifier: "v" })).rejects.toThrow(/Not a sandbox/);
    const token = await ig.exchangeCode({ code: url.searchParams.get("code")!, redirectUri: "x", codeVerifier: "v" });
    const [acct] = await ig.discoverAccounts(token);
    expect(acct).toMatchObject({ platform: "instagram", name: "Sandbox Instagram account", meta: { sandbox: true } });
    // A platform whose API can't publish images still can't in the sandbox.
    expect(youtube.capabilities.publishImage).toBe("unsupported");
    expect(sandboxed(youtube).publish).toBeUndefined();
  });

  it("publishing renders the image and returns a sandbox id; metrics are deterministic per post", async () => {
    const ig = sandboxed(instagram);
    let rendered = false;
    const res = await ig.publish!({ id: "a", platform: "instagram", externalId: "x", accessToken: "t", meta: {} }, { caption: "hello", imageUrl: "http://x", image: async () => ((rendered = true), Buffer.alloc(500, 1)) });
    expect(rendered).toBe(true);
    expect(res.externalId).toMatch(/^sandbox-post-[0-9a-f]{16}$/);
    await expect(ig.publish!({ id: "a", platform: "instagram", externalId: "x", accessToken: "t", meta: {} }, { caption: "x", imageUrl: "http://x", image: async () => Buffer.alloc(10) })).rejects.toThrow(/empty/);
    const m1 = await ig.postMetrics!({ id: "a", platform: "instagram", externalId: "x", accessToken: "t", meta: {} }, res.externalId);
    const m2 = await ig.postMetrics!({ id: "a", platform: "instagram", externalId: "x", accessToken: "t", meta: {} }, res.externalId);
    expect(m1).toEqual(m2);
    expect(m1.reach).toBeGreaterThanOrEqual(500);
  });
});
