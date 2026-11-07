/**
 * Digital Asset Links for the Android Trusted Web Activity. It proves the app and this site
 * belong together, so the app opens full-screen without a browser address bar.
 *
 * ANDROID_PACKAGE_NAME      e.g. com.yourco.brandpilot (the Bubblewrap package id)
 * ANDROID_CERT_SHA256       comma-separated SHA-256 signing-cert fingerprints: your upload key
 *                           and, with Play App Signing, Play's app-signing key.
 */
export const dynamic = "force-dynamic";

const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

export function GET() {
  const pkg = process.env.ANDROID_PACKAGE_NAME?.trim();
  const prints = (process.env.ANDROID_CERT_SHA256 ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  if (!pkg || !prints.length) return new Response("Android app links are not configured", { status: 404 });
  const bad = prints.filter((p) => !FINGERPRINT.test(p));
  if (bad.length) {
    console.error(`[assetlinks] invalid ANDROID_CERT_SHA256 value(s): ${bad.join(", ")}`);
    return new Response("Invalid ANDROID_CERT_SHA256 configuration", { status: 500 });
  }
  return Response.json(
    [
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: { namespace: "android_app", package_name: pkg, sha256_cert_fingerprints: prints },
      },
    ],
    { headers: { "cache-control": "public, max-age=3600" } },
  );
}
