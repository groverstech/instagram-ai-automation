import { redirect } from "next/navigation";
import { MfaChallengeForm } from "@/components/auth/mfa-form";
import { getPendingMfaSession } from "@/server/auth/session";
import { safeNext } from "@/server/auth/step-up";

export default async function Page({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const pending = await getPendingMfaSession();
  if (!pending) redirect("/login");
  const { next } = await searchParams;
  return <MfaChallengeForm email={pending.email} next={next ? safeNext(next) : undefined} />;
}
