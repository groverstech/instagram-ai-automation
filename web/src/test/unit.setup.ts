// Runs before every unit test file (vitest.config.ts). Unit tests are hermetic: they never see a real
// Anthropic credential from the shell or the host environment, only the placeholders a test sets.
// Without this, a real BRANDPILOT_ANTHROPIC_API_KEY would take precedence over a test's placeholder
// ANTHROPIC_API_KEY (anthropic-key.ts), and a failing header assertion could print the real key.
for (const name of ["BRANDPILOT_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) delete process.env[name];
// Likewise for spending-cap settings: a cap set in the shell (an operator session) would change what
// requests are sent (server-side fallbacks are withheld under a cap) and what is reserved; tests that
// need a cap set one themselves.
for (const name of Object.keys(process.env)) if (/^AI_SPEND_CAP_|^AI_SPEND_LEDGER_SINGLE_SESSION$|^DEPLOY_ENV$/.test(name)) delete process.env[name];
