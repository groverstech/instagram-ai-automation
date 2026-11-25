"use server";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { safe } from "@/server/action";
import { getPendingMfaSession, getSession } from "@/server/auth/session";
import { AccessError } from "@/server/auth/guard";
import { clientIp } from "@/server/client-ip";
import { completeMfaChallenge, confirmEnrolment, disableMfa, MfaError, regenerateRecoveryCodes, startEnrolment } from "@/server/auth/mfa";
import { RateLimitError } from "@/server/ratelimit";
import { confirmStepUp, safeNext, signOutOtherSessions } from "@/server/auth/step-up";

export type MfaFormState = { error?: string; next?: string };

/** Second step of sign-in: a code from the authenticator app, or a recovery code. */
export async function verifyMfaLogin(_: unknown, fd: FormData): Promise<MfaFormState> {
  const pending = await getPendingMfaSession();
  if (!pending) redirect("/login");
  const code = String(fd.get("code") ?? "").slice(0, 32);
  try {
    await completeMfaChallenge(pending.sessionId, pending.userId, code, clientIp(await headers()));
  } catch (e) {
    if (e instanceof MfaError || e instanceof RateLimitError) return { error: e.message };
    throw e;
  }
  redirect("/dashboard");
}

async function me() {
  const s = await getSession();
  if (!s) throw new AccessError("Not signed in.");
  return s;
}

export async function startMfaEnrolment() {
  return safe(async () => {
    const s = await me();
    const r = await startEnrolment(s.user.id);
    return { secret: r.secret, qr: r.qrSvgDataUrl };
  });
}

export async function confirmMfaEnrolment(code: string) {
  return safe(async () => {
    const s = await me();
    return confirmEnrolment(s.user.id, s.sessionId, code);
  });
}

export async function disableMfaAction(code: string) {
  return safe(async () => {
    await disableMfa((await me()).user.id, code);
  });
}

export async function regenerateRecoveryCodesAction(code: string) {
  return safe(async () => regenerateRecoveryCodes((await me()).user.id, code));
}

/** Step-up: verify a code for this session so sensitive actions can continue (auth/step-up.ts). */
export async function confirmStepUpAction(code: string) {
  return safe(async () => {
    await confirmStepUp(await me(), code);
  });
}

/** End every other session of the signed-in user. */
export async function signOutOtherSessionsAction() {
  return safe(async () => ({ ended: await signOutOtherSessions(await me()) }));
}

/** /account/verify: confirm a code, then continue to a same-site path (e.g. connecting a social account). */
export async function verifyAndContinue(_: unknown, fd: FormData): Promise<MfaFormState> {
  const session = await getSession();
  if (!session) redirect("/login");
  const next = String(fd.get("next") ?? "/dashboard");
  try {
    await confirmStepUp(session, String(fd.get("code") ?? "").slice(0, 32));
  } catch (e) {
    if (e instanceof MfaError || e instanceof RateLimitError) return { error: e.message };
    throw e;
  }
  // The client navigates (a full page load): `next` is usually the OAuth start route, which
  // redirects on to the platform's own site, so a client-side router transition can't follow it.
  return { next: safeNext(next) };
}
