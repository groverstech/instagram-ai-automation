/**
 * Which environment variable holds the Anthropic API key. The single place every caller resolves it:
 * authentication (llm.ts), provider configuration (config.ts, overview.ts), readiness checks
 * (aiStatus) and the connectivity CLI (anthropic-check-cli.ts).
 *
 * BRANDPILOT_ANTHROPIC_API_KEY is preferred. Some hosts reserve ANTHROPIC_API_KEY for their own use
 * and don't pass it to the processes they run (Claude Code cloud sessions, for example), so the app
 * reads a name of its own first. ANTHROPIC_API_KEY stays as the fallback, so existing local and
 * production configurations keep working unchanged. A variable that is set but blank counts as unset.
 *
 * Only variable names leave this module; callers must never log, return or display the value.
 * Pure (no server-only import) so config validation and operator CLIs can use it too.
 */
export const ANTHROPIC_KEY_ENV = ["BRANDPILOT_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"] as const;
export type AnthropicKeyEnv = (typeof ANTHROPIC_KEY_ENV)[number];

/** Name to show in help text and setup messages. */
export const ANTHROPIC_KEY_HINT = "BRANDPILOT_ANTHROPIC_API_KEY (or ANTHROPIC_API_KEY)";

type Env = Record<string, string | undefined>;

/** The API key and the name of the variable it came from, or null when neither is set. */
export function resolveAnthropicApiKey(env: Env = process.env): { key: string; source: AnthropicKeyEnv } | null {
  for (const name of ANTHROPIC_KEY_ENV) {
    const key = env[name]?.trim();
    if (key) return { key, source: name };
  }
  return null;
}

/** Name of the variable the key would be read from, without the value. */
export function anthropicApiKeySource(env: Env = process.env): AnthropicKeyEnv | null {
  return resolveAnthropicApiKey(env)?.source ?? null;
}

/** True when Anthropic can be called: an API key, or ANTHROPIC_AUTH_TOKEN for bearer-token gateways. */
export function anthropicConfigured(env: Env = process.env): boolean {
  return resolveAnthropicApiKey(env) !== null || Boolean(env.ANTHROPIC_AUTH_TOKEN?.trim());
}
