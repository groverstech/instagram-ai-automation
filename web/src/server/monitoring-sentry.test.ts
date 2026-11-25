/** Error tracking through Sentry's envelope API (gate O2), without a vendor SDK. Nothing leaves the test. */
import { describe, expect, it } from "vitest";

const { parseSentryDsn, sentryReporter } = await import("./monitoring");
const { checkConfig } = await import("./config");

describe("Sentry reporter", () => {
  it("parses DSNs, including self-hosted ones under a path; refuses anything else", () => {
    expect(parseSentryDsn("https://abc123@o1.ingest.sentry.io/4507")).toEqual({ endpoint: "https://o1.ingest.sentry.io/api/4507/envelope/", key: "abc123" });
    expect(parseSentryDsn("https://k@sentry.example.com/errors/12")).toEqual({ endpoint: "https://sentry.example.com/errors/api/12/envelope/", key: "k" });
    for (const bad of ["", "not a url", "http://k@h/1", "https://h/1", "https://k@h/notanumber"]) expect(parseSentryDsn(bad)).toBeNull();
  });

  it("sends one envelope with the error, the reference and the redacted context; never a secret", async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    const send = (async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return new Response("{}");
    }) as unknown as typeof fetch;
    const report = sentryReporter("https://pubkey@o1.ingest.sentry.io/77", { DEPLOY_ENV: "staging", APP_VERSION: "abc1234" }, send)!;
    await report(new TypeError("boom"), { ref: "a1b2c3d4", where: "server_action", route: "/calendar", apiKey: "sk-live-secret-value-123456" });
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("https://o1.ingest.sentry.io/api/77/envelope/");
    expect((sent[0].init.headers as Record<string, string>)["x-sentry-auth"]).toContain("sentry_key=pubkey");
    const [header, item, event] = String(sent[0].init.body).trim().split("\n").map((l) => JSON.parse(l));
    expect(item).toEqual({ type: "event" });
    expect(header.event_id).toBe(event.event_id);
    expect(event).toMatchObject({ level: "error", environment: "staging", release: "abc1234", exception: { values: [{ type: "TypeError", value: "boom" }] }, tags: { ref: "a1b2c3d4", where: "server_action" } });
    expect(event.extra.route).toBe("/calendar");
    expect(String(sent[0].init.body)).not.toContain("sk-live-secret-value-123456");
  });

  it("a malformed DSN is a configuration error; no DSN is only a warning in staging", () => {
    expect(checkConfig({ SENTRY_DSN: "https://nokey.example.com/1" }).find((p) => p.key === "SENTRY_DSN")).toMatchObject({ level: "error" });
    expect(checkConfig({ SENTRY_DSN: "https://k@o1.ingest.sentry.io/1" }).find((p) => p.key === "SENTRY_DSN")).toBeUndefined();
    expect(checkConfig({ DEPLOY_ENV: "staging" }).find((p) => p.key === "SENTRY_DSN")).toMatchObject({ level: "warning" });
  });

  it("without SENTRY_DSN nothing is installed", async () => {
    const { installConfiguredReporters, captureError } = await import("./monitoring");
    const real = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("{}");
    }) as typeof fetch;
    try {
      installConfiguredReporters({});
      captureError(new Error("local only"));
      await new Promise((r) => setTimeout(r, 20));
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = real;
    }
  });
});
