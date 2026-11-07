import { afterEach, describe, expect, it } from "vitest";
import { GET } from "./.well-known/assetlinks.json/route";

const FP = Array(32).fill("ab").join(":");

afterEach(() => {
  delete process.env.ANDROID_PACKAGE_NAME;
  delete process.env.ANDROID_CERT_SHA256;
});

describe("/.well-known/assetlinks.json", () => {
  it("is 404 until configured", () => {
    expect(GET().status).toBe(404);
  });
  it("serves the package and upper-cased fingerprints", async () => {
    process.env.ANDROID_PACKAGE_NAME = "com.example.brandpilot";
    process.env.ANDROID_CERT_SHA256 = `${FP}, ${FP.replace(/ab/g, "CD")}`;
    const res = GET();
    expect(res.status).toBe(200);
    const [stmt] = await res.json();
    expect(stmt.relation).toEqual(["delegate_permission/common.handle_all_urls"]);
    expect(stmt.target.package_name).toBe("com.example.brandpilot");
    expect(stmt.target.sha256_cert_fingerprints).toEqual([FP.toUpperCase(), FP.replace(/ab/g, "CD")]);
  });
  it("rejects malformed fingerprints instead of publishing them", () => {
    process.env.ANDROID_PACKAGE_NAME = "com.example.brandpilot";
    process.env.ANDROID_CERT_SHA256 = "not-a-fingerprint";
    expect(GET().status).toBe(500);
  });
});
