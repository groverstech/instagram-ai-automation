"use server";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getSession } from "@/server/auth/session";
import { clientIp } from "@/server/client-ip";
import { acceptInviteFor, MemberError } from "@/server/members";
import { verifyEmail } from "@/server/auth/verify-email";

export type LinkState = { error?: string };

/**
 * Confirming an email address is a button, not the page load: mail scanners that open links
 * would otherwise use up the single-use token.
 */
export async function verifyEmailAction(_: LinkState, fd: FormData): Promise<LinkState> {
  const r = await verifyEmail(String(fd.get("token") ?? "").slice(0, 200), clientIp(await headers()));
  if (!r.ok) return { error: r.error };
  const s = await getSession();
  redirect(s ? (r.acceptedInvites ? "/dashboard" : "/onboarding") : "/login?verified=1");
}

export async function acceptInviteAction(_: LinkState, fd: FormData): Promise<LinkState> {
  const s = await getSession();
  const token = String(fd.get("token") ?? "").slice(0, 200);
  if (!s) redirect(`/login?next=${encodeURIComponent(`/invite?token=${token}`)}`);
  try {
    await acceptInviteFor(s, token);
  } catch (e) {
    if (e instanceof MemberError) return { error: e.message };
    throw e;
  }
  redirect("/dashboard");
}
