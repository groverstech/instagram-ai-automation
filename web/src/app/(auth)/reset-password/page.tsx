import Link from "next/link";
import type { Metadata } from "next";
import { ResetPasswordForm } from "@/components/auth/recovery-forms";
import { resetTokenValid } from "@/server/auth/recovery";
import { Notice } from "@/components/ui";

export const metadata: Metadata = { title: "Choose a new password · BrandPilot", referrer: "no-referrer" };

export default async function Page({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token = "" } = await searchParams;
  if (!(await resetTokenValid(token))) {
    return (
      <div className="w-full max-w-sm space-y-4">
        <h1 className="font-display text-[34px] leading-tight">This link has expired</h1>
        <Notice tone="warn">Reset links work once, for a limited time. Ask for a new one.</Notice>
        <Link href="/forgot-password" className="font-medium text-ink underline-offset-4 hover:underline">
          Send a new reset link
        </Link>
      </div>
    );
  }
  return <ResetPasswordForm token={token} />;
}
