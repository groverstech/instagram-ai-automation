import { NextResponse } from "next/server";
import { requireBrand } from "@/server/auth/guard";
import { provider } from "@/server/social/registry";
import { pkce } from "@/server/social/providers/others";
import { appUrl } from "@/server/social/service";
import { assertCanAdd } from "@/server/quota";
import { randomToken, sign } from "@/server/crypto";

export async function GET(req: Request, { params }: { params: Promise<{ platform: string }> }) {
  const { platform } = await params;
  const brandId = new URL(req.url).searchParams.get("brand") ?? "";
  const back = (q: string) => NextResponse.redirect(`${appUrl()}/accounts?${q}`);
  let access;
  try {
    access = await requireBrand(brandId, "admin");
    await assertCanAdd(access.brand.workspaceId, "socialAccounts");
  } catch (e) {
    return back(`error=${encodeURIComponent((e as Error).message)}`);
  }
  const p = provider(platform);
  if (!p.configured()) return back(`error=${encodeURIComponent(`${p.label} isn't configured. Add ${p.envKeys.join(" and ")} to the server environment.`)}`);
  const { verifier, challenge } = pkce();
  const nonce = randomToken(16);
  const state = sign({ b: brandId, p: platform, u: access.session.user.id, n: nonce, v: verifier, exp: Date.now() + 10 * 60 * 1000 });
  const redirectUri = `${appUrl()}/api/oauth/${platform}/callback`;
  const res = NextResponse.redirect(p.authorizeUrl({ state, redirectUri, codeChallenge: challenge }));
  // Bind the flow to this browser (CSRF protection on the callback).
  res.cookies.set("bp_oauth", nonce, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 600, path: "/api/oauth" });
  return res;
}
