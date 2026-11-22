import { LoginForm } from "@/components/auth/forms";

export default async function Page({ searchParams }: { searchParams: Promise<{ deleted?: string }> }) {
  const { deleted } = await searchParams;
  return <LoginForm notice={deleted === "1" ? "Your account was deleted." : undefined} />;
}
