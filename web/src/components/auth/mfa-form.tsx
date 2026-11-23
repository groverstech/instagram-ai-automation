"use client";
import Link from "next/link";
import { useActionState, useState } from "react";
import { verifyMfaLogin, type MfaFormState } from "@/app/actions/mfa";
import { Button, Field, Input, Notice } from "@/components/ui";

/** Second step of sign-in: authenticator code, or a recovery code. */
export function MfaChallengeForm({ email, next }: { email: string; next?: string }) {
  const [state, action, pending] = useActionState(verifyMfaLogin, {} as MfaFormState);
  const [recovery, setRecovery] = useState(false);
  return (
    <form action={action} className="w-full max-w-sm space-y-4">
      <div className="mb-8">
        <h1 className="font-display text-[34px] leading-tight">Two-step verification</h1>
        <p className="mt-1 text-muted">
          {recovery ? "Enter one of your recovery codes." : "Enter the 6-digit code from your authenticator app."} Signing in as {email}.
        </p>
      </div>
      {state.error ? <Notice tone="danger">{state.error}</Notice> : null}
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <Field label={recovery ? "Recovery code" : "Code"}>
        {recovery ? (
          <Input key="recovery" name="code" autoComplete="off" placeholder="xxxx-xxxx" maxLength={12} required autoFocus />
        ) : (
          <Input key="totp" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} placeholder="123456" required autoFocus />
        )}
      </Field>
      <Button className="w-full" size="lg" loading={pending}>
        Verify
      </Button>
      <div className="flex justify-between text-[13px] text-muted">
        <button type="button" className="underline-offset-4 hover:underline" onClick={() => setRecovery(!recovery)}>
          {recovery ? "Use an authenticator code" : "Use a recovery code"}
        </button>
        <Link href="/login" className="underline-offset-4 hover:underline">
          Start over
        </Link>
      </div>
    </form>
  );
}
