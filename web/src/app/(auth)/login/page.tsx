import { LoginForm } from "@/components/auth/forms";
import { safeNext } from "@/server/auth/step-up";

export default async function Page({ searchParams }: { searchParams: Promise<{ deleted?: string; reset?: string; next?: string; verified?: string }> }) {
  const { deleted, reset, next, verified } = await searchParams;
  const notice = deleted === "1" ? "Your account was deleted." : reset === "1" ? "Your password was changed. Sign in with the new one." : verified === "1" ? "Your email address is confirmed. Sign in to continue." : next?.startsWith("/invite") ? "Sign in to accept the invitation." : undefined;
  return <LoginForm notice={notice} next={next ? safeNext(next) : undefined} />;
}
