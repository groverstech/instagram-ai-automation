// BRANDPILOT_ANTHROPIC_API_KEY (preferred) and ANTHROPIC_API_KEY (fallback): one resolution for
// authentication, provider configuration, readiness and the connectivity CLI (ai/anthropic-key.ts).
// Hermetic: placeholder keys only, a stubbed fetch, no network.
import { afterEach, describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";

process.env.AI_PROVIDER = "";
process.env.STORAGE_DIR ??= "/tmp/bp-anthropic-key-store";
process.env.PGLITE_DIR = "memory://";

const { resolveAnthropicApiKey, anthropicApiKeySource, anthropicConfigured, ANTHROPIC_KEY_ENV, ANTHROPIC_KEY_HINT } = await import("./ai/anthropic-key");
const { anthropicAuth, aiStatus } = await import("./ai/llm");
const { checkConfig } = await import("./config");
const { friendlyAIError } = await import("./ai/errors");

const PREFERRED = "placeholder-preferred-key-0001";
const FALLBACK = "placeholder-fallback-key-0002";
const KEY_VARS = ["BRANDPILOT_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;

afterEach(() => {
  for (const k of KEY_VARS) delete process.env[k];
});

describe("Anthropic key resolution", () => {
  it("prefers BRANDPILOT_ANTHROPIC_API_KEY and falls back to ANTHROPIC_API_KEY", () => {
    expect(ANTHROPIC_KEY_ENV).toEqual(["BRANDPILOT_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"]);
    expect(resolveAnthropicApiKey({ BRANDPILOT_ANTHROPIC_API_KEY: PREFERRED, ANTHROPIC_API_KEY: FALLBACK })).toEqual({ key: PREFERRED, source: "BRANDPILOT_ANTHROPIC_API_KEY" });
    expect(resolveAnthropicApiKey({ ANTHROPIC_API_KEY: FALLBACK })).toEqual({ key: FALLBACK, source: "ANTHROPIC_API_KEY" });
    expect(resolveAnthropicApiKey({ BRANDPILOT_ANTHROPIC_API_KEY: PREFERRED })).toEqual({ key: PREFERRED, source: "BRANDPILOT_ANTHROPIC_API_KEY" });
    expect(resolveAnthropicApiKey({})).toBeNull();
  });

  it("trims values, and a blank preferred variable falls back instead of winning", () => {
    expect(resolveAnthropicApiKey({ BRANDPILOT_ANTHROPIC_API_KEY: `  ${PREFERRED}\n` })?.key).toBe(PREFERRED);
    expect(resolveAnthropicApiKey({ BRANDPILOT_ANTHROPIC_API_KEY: "   ", ANTHROPIC_API_KEY: FALLBACK })?.source).toBe("ANTHROPIC_API_KEY");
    expect(resolveAnthropicApiKey({ BRANDPILOT_ANTHROPIC_API_KEY: "", ANTHROPIC_API_KEY: " " })).toBeNull();
  });

  it("reports only the variable name as the source", () => {
    expect(anthropicApiKeySource({ BRANDPILOT_ANTHROPIC_API_KEY: PREFERRED })).toBe("BRANDPILOT_ANTHROPIC_API_KEY");
    expect(anthropicApiKeySource({ ANTHROPIC_API_KEY: FALLBACK })).toBe("ANTHROPIC_API_KEY");
    expect(anthropicApiKeySource({})).toBeNull();
  });

  it("configured with either key variable, or a gateway's ANTHROPIC_AUTH_TOKEN", () => {
    expect(anthropicConfigured({ BRANDPILOT_ANTHROPIC_API_KEY: PREFERRED })).toBe(true);
    expect(anthropicConfigured({ ANTHROPIC_API_KEY: FALLBACK })).toBe(true);
    expect(anthropicConfigured({ ANTHROPIC_AUTH_TOKEN: "gateway-token" })).toBe(true);
    expect(anthropicConfigured({ BRANDPILOT_ANTHROPIC_API_KEY: " ", ANTHROPIC_AUTH_TOKEN: "" })).toBe(false);
  });
});

describe("Anthropic authentication uses the resolved key in x-api-key", () => {
  it("anthropicAuth sends the preferred key as X-Api-Key and removes Authorization", () => {
    expect(anthropicAuth({ BRANDPILOT_ANTHROPIC_API_KEY: PREFERRED, ANTHROPIC_API_KEY: FALLBACK })).toEqual({ apiKey: PREFERRED, defaultHeaders: { "X-Api-Key": PREFERRED, Authorization: null } });
    expect(anthropicAuth({ ANTHROPIC_API_KEY: FALLBACK })).toEqual({ apiKey: FALLBACK, defaultHeaders: { "X-Api-Key": FALLBACK, Authorization: null } });
    expect(anthropicAuth({ ANTHROPIC_AUTH_TOKEN: "gateway-token" })).toEqual({});
  });

  for (const name of ["BRANDPILOT_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"] as const) {
    it(`the SDK sends ${name} as x-api-key with no Authorization header (stubbed fetch)`, async () => {
      const seen: { url: string; xApiKey: string | null; authorization: string | null }[] = [];
      const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const h = new Headers(init?.headers);
        // Compare inside the stub so a mismatch never prints a key value.
        seen.push({ url: String(input), xApiKey: h.get("x-api-key") === PREFERRED ? "preferred" : h.get("x-api-key") ? "other" : null, authorization: h.get("authorization") });
        return new Response(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: "m", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch;
      // An ANTHROPIC_AUTH_TOKEN in the environment must not add a bearer header alongside the key.
      process.env.ANTHROPIC_AUTH_TOKEN = "gateway-token-not-used";
      const client = new Anthropic({ baseURL: "https://api.anthropic.com", maxRetries: 0, fetch: stub, ...anthropicAuth({ [name]: PREFERRED }) });
      await client.messages.create({ model: "m", max_tokens: 1, messages: [{ role: "user", content: "hi" }] });
      expect(seen).toEqual([{ url: "https://api.anthropic.com/v1/messages", xApiKey: "preferred", authorization: null }]);
    });
  }
});

describe("readiness and configuration agree with authentication", () => {
  it("aiStatus is ready with either key variable and not ready with neither", () => {
    process.env.BRANDPILOT_ANTHROPIC_API_KEY = PREFERRED;
    expect(aiStatus().ready).toBe(true);
    delete process.env.BRANDPILOT_ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = FALLBACK;
    expect(aiStatus().ready).toBe(true);
    delete process.env.ANTHROPIC_API_KEY;
    expect(aiStatus().ready).toBe(false);
  });

  it("config validation and user-facing messages name the variables, never the value", () => {
    const problems = checkConfig({ DEPLOY_ENV: "staging", NODE_ENV: "production" });
    const missing = problems.find((p) => p.key === "BRANDPILOT_ANTHROPIC_API_KEY");
    expect(missing?.level).toBe("error");
    expect(missing?.message).toMatch(/BRANDPILOT_ANTHROPIC_API_KEY.*ANTHROPIC_API_KEY/);

    const withKey = checkConfig({ DEPLOY_ENV: "staging", NODE_ENV: "production", BRANDPILOT_ANTHROPIC_API_KEY: PREFERRED });
    expect(withKey.find((p) => p.key === "BRANDPILOT_ANTHROPIC_API_KEY")).toBeUndefined();
    expect(JSON.stringify(withKey)).not.toContain(PREFERRED);

    const auth = new Anthropic.AuthenticationError(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, "invalid x-api-key", new Headers());
    process.env.BRANDPILOT_ANTHROPIC_API_KEY = PREFERRED;
    const msg = friendlyAIError(auth) ?? "";
    expect(msg).toContain(ANTHROPIC_KEY_HINT);
    expect(msg).not.toContain(PREFERRED);
  });
});
