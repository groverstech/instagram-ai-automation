"use server";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { safe } from "@/server/action";
import { getPendingMfaSession, getSession } from "@/server/auth/session";
import { AccessError } from "@/server/auth/guard";
import { clientIp } from "@/server/client-ip";
import { completeMfaChallenge, confirmEnrolment, disableMfa, MfaError, regenerateRecoveryCodes, startEnrolment } from "@/server/auth/mfa";
import { RateLimitError } from "@/server/ratelimit";

export type MfaFormState = { error?: string };

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
