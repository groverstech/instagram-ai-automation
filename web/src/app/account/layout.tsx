import { StepUpDialog } from "@/components/account/step-up-dialog";
import { Toaster } from "@/components/ui/toast";

/** Account pages sit outside the app layout (see security/page.tsx) but still need toasts and step-up. */
export default function AccountLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <Toaster />
      <StepUpDialog />
    </>
  );
}
