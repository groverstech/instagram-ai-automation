import Link from "next/link";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/server/auth/session";
import { logOut } from "@/app/actions/auth";
import { ConfirmEmailForm, ResendVerification } from "@/components/auth/link-forms";
import { Button, Notice } from "@/components/ui";

export const metadata: Metadata = { title: "Confirm your email · BrandPilot", referrer: "no-referrer" };

export default async function Page({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  if (token) {
    return (
      <div className="w-full max-w-sm space-y-4">
        <h1 className="font-display text-[34px] leading-tight">Confirm your email</h1>
        <p className="text-muted">One click to confirm this address for your BrandPilot account.</p>
        <ConfirmEmailForm token={token.slice(0, 200)} />
      </div>
    );
  }
  const s = await getSession();
  if (!s) redirect("/login");
  if (s.emailVerified) redirect("/dashboard");
  return (
    <div className="w-full max-w-sm space-y-4">
      <h1 className="font-display text-[34px] leading-tight">Check your inbox</h1>
      <p className="text-muted">
        We sent a link to <strong className="font-medium text-ink">{s.user.email}</strong>. Open it to confirm your address and continue. It works for 24 hours.
      </p>
      <Notice tone="info">Invitations to join an organisation are accepted as soon as your address is confirmed.</Notice>
      <ResendVerification />
      <form action={logOut}>
        <Button variant="ghost" className="w-full">Wrong address? Sign out</Button>
      </form>
      <p className="text-center text-[12px] text-faint">
        <Link href="/privacy" className="underline-offset-4 hover:underline">Privacy</Link>
      </p>
    </div>
  );
}
