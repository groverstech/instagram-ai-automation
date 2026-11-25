import "server-only";
import { captureError } from "../monitoring";
import { handleDataDeletion, handleDeauthorize, MetaCallbackNotConfigured } from "./meta-callbacks";

/** Meta posts `signed_request` as form data; accept JSON too (useful for manual checks). */
async function signedRequestOf(req: Request): Promise<string | null> {
  const type = req.headers.get("content-type") ?? "";
  try {
    if (type.includes("application/json")) {
      const j = (await req.json()) as { signed_request?: unknown };
      return typeof j.signed_request === "string" ? j.signed_request : null;
    }
    const f = await req.formData();
    const v = f.get("signed_request");
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

async function guarded(fn: () => Promise<Response>, where: string): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof MetaCallbackNotConfigured) return json({ error: "Meta callbacks aren't configured on this server." }, 503);
    const ref = captureError(e, { where });
    return json({ error: "Internal error", ref }, 500);
  }
}

/** POST /api/platforms/meta/data-deletion → { url, confirmation_code } as Meta requires. */
export async function metaDataDeletion(req: Request): Promise<Response> {
  return guarded(async () => {
    const out = await handleDataDeletion(await signedRequestOf(req));
    if (!out) return json({ error: "Invalid signed_request." }, 400);
    return json({ url: out.url, confirmation_code: out.confirmationCode });
  }, "meta.data_deletion");
}

/** POST /api/platforms/meta/deauthorize → 200 once the person's accounts are revoked. */
export async function metaDeauthorize(req: Request): Promise<Response> {
  return guarded(async () => {
    const out = await handleDeauthorize(await signedRequestOf(req));
    if (!out) return json({ error: "Invalid signed_request." }, 400);
    return json({ ok: true });
  }, "meta.deauthorize");
}
