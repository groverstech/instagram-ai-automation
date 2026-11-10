import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { requireBrand } from "@/server/auth/guard";
import { provider } from "@/server/social/registry";
import { appUrl, saveAccounts } from "@/server/social/service";
import { verify } from "@/server/crypto";
import { audit } from "@/server/audit";

export async function GET(req: Request, { params }: { params: Promise<{ platform: string }> }) {
  const { platform } = await params;
  const url = new URL(req.url);
  const back = (q: string) => NextResponse.redirect(`${appUrl()}/accounts?${q}`);
  if (url.searchParams.get("error")) return back(`error=${encodeURIComponent(url.searchParams.get("error_description") ?? url.searchParams.get("error")!)}`);
  const state = verify<{ b: string; p: string; u: string; n: string; v: string }>(url.searchParams.get("state") ?? "");
  const nonce = (await cookies()).get("bp_oauth")?.value;
  if (!state || state.p !== platform || !nonce || nonce !== state.n) return back("error=This%20connection%20link%20expired.%20Please%20try%20again.");
  try {
    const { session, brand } = await requireBrand(state.b, "admin");
    if (session.user.id !== state.u) throw new Error("Signed-in user changed during connection.");
    const p = provider(platform);
    const token = await p.exchangeCode({ code: url.searchParams.get("code") ?? "", redirectUri: `${appUrl()}/api/oauth/${platform}/callback`, codeVerifier: state.v });
    // Meta login returns both Facebook Pages and Instagram accounts; save both.
    const family = Object.values((await import("@/server/social/registry")).PROVIDERS).filter((x) => x.oauthFamily === p.oauthFamily);
    const discovered = (await Promise.all(family.map((x) => x.discoverAccounts(token).catch(() => [])))).flat();
    if (!discovered.length) {
      return back(`error=${encodeURIComponent(platform === "instagram" ? "No Instagram Business or Creator account was found. Link one to a Facebook Page you manage, then reconnect." : `No ${p.label} accounts were returned.`)}`);
    }
    await saveAccounts(state.b, session.user.id, discovered);
    await audit({ action: "social.connect", workspaceId: brand.workspaceId, brandId: state.b, actorUserId: session.user.id, targetType: "platform", targetId: platform, details: { accounts: discovered.map((d) => ({ platform: d.platform, externalId: d.externalId })) } });
    const res = back(`connected=${discovered.length}`);
    res.cookies.delete({ name: "bp_oauth", path: "/api/oauth" });
    return res;
  } catch (e) {
    return back(`error=${encodeURIComponent((e as Error).message.slice(0, 300))}`);
  }
}
