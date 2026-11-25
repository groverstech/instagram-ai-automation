import Link from "next/link";
import type { Metadata } from "next";
import { ArrowLeft } from "lucide-react";
import { requireUser } from "@/server/auth/guard";
import { mfaStatus } from "@/server/auth/mfa";
import { MfaSettings } from "@/components/account/mfa-settings";
import { ChangePassword } from "@/components/account/change-password";
import { logOut } from "@/app/actions/auth";

export const metadata: Metadata = { title: "Account security · BrandPilot" };

/**
 * Account → Security. Outside the app layout on purpose: owners and admins who must turn on
 * two-step verification are sent here, and must be able to reach it before anything else.
 */
export default async function Page({ searchParams }: { searchParams: Promise<{ required?: string }> }) {
  const session = await requireUser();
  const status = await mfaStatus(session.user.id);
  const { required } = await searchParams;
  return (
    <div className="min-h-screen bg-canvas">
      <main className="mx-auto max-w-2xl space-y-6 px-5 py-10">
        {status.enabled || !status.required ? (
          <Link href="/settings" className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink">
            <ArrowLeft className="size-4" /> Back to Settings
          </Link>
        ) : null}
        <div>
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Account</p>
          <h1 className="font-display text-[34px] leading-[1.1]">Security</h1>
          <p className="mt-2 text-[14px] text-muted">Signed in as {session.user.email}.</p>
        </div>
        <form action={logOut} className="text-right">
          <button className="text-[13px] text-muted underline-offset-4 hover:text-ink hover:underline">Sign out</button>
        </form>
        <MfaSettings status={{ enabled: status.enabled, recoveryCodesLeft: status.recoveryCodesLeft, required: status.required }} requiredNotice={required === "1" || status.required} />
        <ChangePassword />
      </main>
    </div>
  );
}
