// Runs before every unit test file (vitest.config.ts). Unit tests are hermetic: they never see a real
// Anthropic credential from the shell or the host environment, only the placeholders a test sets.
// Without this, a real BRANDPILOT_ANTHROPIC_API_KEY would take precedence over a test's placeholder
// ANTHROPIC_API_KEY (anthropic-key.ts), and a failing header assertion could print the real key.
for (const name of ["BRANDPILOT_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) delete process.env[name];
