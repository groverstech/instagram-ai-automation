import crypto from "node:crypto";
import type { SocialProvider } from "./types";

/**
 * Social sandbox (launch-readiness Q1): SOCIAL_SANDBOX=true replaces every platform's network calls
 * with a simulation, so the whole lifecycle (connect → publish → metrics) can run end to end in
 * development, demos and CI through the **real** OAuth callback, publish path, job queue and
 * metrics sync, without a developer app, a test account or any request to a platform.
 *
 * - Labels say "(simulated)" everywhere a platform name is shown.
 * - Refused in staging and production: sandboxOn() is false there, and config validation reports
 *   SOCIAL_SANDBOX=true as an error. Nothing it produces is evidence of a real integration.
 * - Capabilities stay the real provider's, so honest-capability checks still apply (a platform
 *   that can't publish images through its API still can't in the sandbox).
 */
export function sandboxOn(env: Record<string, string | undefined> = process.env) {
  if ((env.SOCIAL_SANDBOX ?? "").trim().toLowerCase() !== "true") return false;
  const deploy = (env.DEPLOY_ENV ?? "").trim().toLowerCase();
  // Strict environments (staging, production, or an unrecognised value) never run the sandbox.
  return deploy === "" || deploy === "development" || deploy === "demo" || deploy === "test";
}

/**
 * What the sandbox "published", per account, so the publish ledger's read-back (findRecentPost,
 * PR 4.4a) can be exercised like on Instagram and Facebook. In-process only: a restart forgets it,
 * which reads as "not found".
 */
const published = new Map<string, { externalId: string; caption: string; at: number }[]>();

const n = (seed: string, mod: number, min = 0) => min + (parseInt(crypto.createHash("sha256").update(seed).digest("hex").slice(0, 8), 16) % mod);

export function sandboxed(real: SocialProvider): SocialProvider {
  const canPublish = real.publish && real.capabilities.publishImage !== "unsupported";
  return {
    id: real.id,
    label: `${real.label} (simulated)`,
    oauthFamily: real.oauthFamily,
    capabilities: { ...real.capabilities, notes: `Sandbox: simulated, no requests reach ${real.label}. ${real.capabilities.notes}` },
    envKeys: [],
    configured: () => true,
    // Straight back to our own callback: the real OAuth state and browser-bound nonce are still checked.
    authorizeUrl: ({ state, redirectUri }) => `${redirectUri}?code=sandbox-${crypto.randomBytes(6).toString("hex")}&state=${encodeURIComponent(state)}`,
    async exchangeCode({ code }) {
      if (!code.startsWith("sandbox-")) throw new Error("Not a sandbox authorisation code.");
      return { accessToken: `sandbox-token-${crypto.randomBytes(12).toString("hex")}`, scopes: "sandbox", platformUserId: "sandbox-user" };
    },
    async discoverAccounts(token) {
      return [
        {
          platform: real.id,
          externalId: `sandbox-${real.id}-account`,
          name: `Sandbox ${real.label} account`,
          handle: `sandbox_${real.id}`,
          token,
          meta: { sandbox: true },
        },
      ];
    },
    publish: canPublish
      ? async (account, input, ctx) => {
          if (!input.caption && !input.title) throw new Error("Sandbox: a post needs a caption or a title.");
          // Render the image as the real publishers do, so a broken render fails here too.
          const png = await input.image();
          if (png.length < 100) throw new Error("Sandbox: the rendered image is empty.");
          ctx?.finalSend(); // like the real publishers: everything before this can't have published
          const id = `sandbox-post-${crypto.randomBytes(8).toString("hex")}`;
          const list = published.get(account.id) ?? [];
          list.push({ externalId: id, caption: input.caption, at: Date.now() });
          published.set(account.id, list.slice(-200));
          return { externalId: id };
        }
      : undefined,
    findRecentPost: canPublish
      ? async (account, { caption, since }) => {
          const hit = (published.get(account.id) ?? []).find((p) => p.at >= since.getTime() && p.caption.trim() === caption.trim());
          return hit ? { externalId: hit.externalId } : null;
        }
      : undefined,
    postMetrics: real.postMetrics
      ? async (_a, externalId) => {
          const reach = n(`${externalId}:reach`, 4000, 500);
          return { reach, impressions: reach + n(`${externalId}:imp`, 2000), likes: n(`${externalId}:likes`, 300, 10), comments: n(`${externalId}:comments`, 40), shares: n(`${externalId}:shares`, 30), saves: n(`${externalId}:saves`, 60) };
        }
      : undefined,
    accountMetrics: real.accountMetrics ? async (a) => ({ followers: n(`${a.externalId}:followers`, 5000, 1200), profileVisits: n(`${a.externalId}:visits`, 400, 20), reach: n(`${a.externalId}:areach`, 9000, 900), impressions: null }) : undefined,
  };
}
