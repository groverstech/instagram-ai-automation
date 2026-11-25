import { redirect } from "next/navigation";
import { MfaChallengeForm } from "@/components/auth/mfa-form";
import { getPendingMfaSession } from "@/server/auth/session";

export default async function Page() {
  const pending = await getPendingMfaSession();
  if (!pending) redirect("/login");
  return <MfaChallengeForm email={pending.email} />;
}
