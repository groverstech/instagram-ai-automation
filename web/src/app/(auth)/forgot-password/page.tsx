import type { Metadata } from "next";
import { ForgotPasswordForm } from "@/components/auth/recovery-forms";

export const metadata: Metadata = { title: "Reset your password · BrandPilot" };

export default function Page() {
  return <ForgotPasswordForm />;
}
