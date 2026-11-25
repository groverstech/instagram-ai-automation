import Link from "next/link";
import type { Metadata } from "next";
import { getSession } from "@/server/auth/session";
import { inviteInfo } from "@/server/members";
import { logOut } from "@/app/actions/auth";
import { AcceptInviteForm } from "@/components/auth/link-forms";
import { Button, Notice } from "@/components/ui";

export const metadata: Metadata = { title: "Invitation · BrandPilot", referrer: "no-referrer" };

const article = (role: string) => (role === "admin" ? "an admin" : `a ${role}`);

export default async function Page({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token = "" } = await searchParams;
  const info = await inviteInfo(token.slice(0, 200));
  if (!info) {
    return (
      <div className="w-full max-w-sm space-y-4">
        <h1 className="font-display text-[34px] leading-tight">Invitation not found</h1>
        <Notice tone="warn">This invitation is invalid, has expired or was withdrawn. Ask the person who invited you to send a new one.</Notice>
        <Link href="/login" className="font-medium text-ink underline-offset-4 hover:underline">Go to sign in</Link>
      </div>
    );
  }
  const s = await getSession();
  const here = `/invite?token=${encodeURIComponent(token)}`;
  return (
    <div className="w-full max-w-sm space-y-4">
      <h1 className="font-display text-[34px] leading-tight">Join {info.workspace}</h1>
      <p className="text-muted">
        You&apos;re invited to join <strong className="font-medium text-ink">{info.workspace}</strong> on BrandPilot as {article(info.role)}. The invitation is for <strong className="font-medium text-ink">{info.email}</strong>.
      </p>
      {!s ? (
        <div className="space-y-2">
          <Link href={`/login?next=${encodeURIComponent(here)}`} className="flex h-11 w-full items-center justify-center rounded-xl bg-ink text-[14px] font-medium text-white">Sign in to accept</Link>
          <Link href="/signup" className="flex h-11 w-full items-center justify-center rounded-xl border border-line text-[14px] font-medium">Create an account with {info.email}</Link>
          <p className="text-[12px] text-faint">New accounts join as soon as the email address is confirmed.</p>
        </div>
      ) : s.user.email.toLowerCase() === (info.email ?? "").toLowerCase() ? (
        <AcceptInviteForm token={token.slice(0, 200)} />
      ) : (
        <div className="space-y-3">
          <Notice tone="warn">You&apos;re signed in as {s.user.email}. Sign in with {info.email} to accept this invitation.</Notice>
          <form action={logOut}>
            <Button variant="secondary" className="w-full">Sign out</Button>
          </form>
        </div>
      )}
    </div>
  );
}
