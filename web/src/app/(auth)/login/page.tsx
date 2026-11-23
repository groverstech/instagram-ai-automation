import { LoginForm } from "@/components/auth/forms";

export default async function Page({ searchParams }: { searchParams: Promise<{ deleted?: string; reset?: string }> }) {
  const { deleted, reset } = await searchParams;
  return <LoginForm notice={deleted === "1" ? "Your account was deleted." : reset === "1" ? "Your password was changed. Sign in with the new one." : undefined} />;
}
