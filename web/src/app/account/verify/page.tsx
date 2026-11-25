import { requireUser } from "@/server/auth/guard";
import { VerifyForm } from "@/components/account/verify-form";

export default async function Page({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  await requireUser();
  const { next } = await searchParams;
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas p-6">
      <VerifyForm next={next ?? "/dashboard"} />
    </div>
  );
}
