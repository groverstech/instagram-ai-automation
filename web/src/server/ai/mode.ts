import "server-only";

let mockWarned = false;

/**
 * Demo mode (AI_PROVIDER=mock): every agent returns deterministic stand-in output and no paid AI
 * API is called (text or images). In production it is only honoured with an explicit
 * AI_ALLOW_MOCK_IN_PRODUCTION=true, so a stray AI_PROVIDER=mock can't silently replace Claude
 * for real users.
 */
export function mockActive(): boolean {
  if (process.env.AI_PROVIDER !== "mock") return false;
  if (process.env.NODE_ENV === "production" && process.env.AI_ALLOW_MOCK_IN_PRODUCTION !== "true") {
    if (!mockWarned) {
      console.error("[ai] AI_PROVIDER=mock is ignored in production. Set AI_ALLOW_MOCK_IN_PRODUCTION=true only for demos/E2E.");
      mockWarned = true;
    }
    return false;
  }
  return true;
}
