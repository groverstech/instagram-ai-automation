import { describe, expect, it } from "vitest";

process.env.PGLITE_DIR = "memory://";
const { PROVIDERS } = await import("./social/registry");

// Plan defect D2: the capability matrix must never promise more than the providers implement.
describe("social capabilities match what BrandPilot implements", () => {
  const implemented = (v: string) => v === "supported" || v === "requires_app_review";

  for (const p of Object.values(PROVIDERS)) {
    it(`${p.label}: every available capability has an implementation`, () => {
      const c = p.capabilities;
      // Image publishing needs a publish method.
      if (implemented(c.publishImage)) expect(p.publish, "publishImage claimed without publish()").toBeTypeOf("function");
      // The publisher interface takes one image: carousels, video and native scheduling aren't implemented anywhere yet.
      for (const k of ["publishCarousel", "publishVideo", "scheduleNative"] as const) {
        expect(implemented(c[k]), `${k} is "${c[k]}" but no provider implements it`).toBe(false);
      }
      // Analytics claims need the matching metrics method, and vice versa.
      expect(implemented(c.postAnalytics)).toBe(typeof p.postMetrics === "function");
      expect(implemented(c.accountAnalytics)).toBe(typeof p.accountMetrics === "function");
      expect(c.notes.length).toBeGreaterThan(20);
    });
  }

  it("Instagram and Facebook publish single images only, and say so", () => {
    for (const id of ["instagram", "facebook"]) {
      const c = PROVIDERS[id].capabilities;
      expect(c).toMatchObject({ publishImage: "supported", publishCarousel: "not_built", publishVideo: "not_built" });
      expect(c.notes).toMatch(/single-image/);
    }
  });

  it("LinkedIn organisation features and YouTube are marked as coming soon", () => {
    expect(PROVIDERS.linkedin.capabilities.notes).toMatch(/coming soon/i);
    expect(PROVIDERS.youtube.capabilities.notes).toMatch(/coming soon/i);
  });
});
