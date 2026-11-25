import { SignupForm } from "@/components/auth/forms";
import { signupMode } from "@/server/beta-invites";

export const dynamic = "force-dynamic";

export default function Page() {
  return <SignupForm inviteOnly={signupMode() === "invite_only"} />;
}
