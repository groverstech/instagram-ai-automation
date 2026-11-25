"use client";
import { useActionState, useEffect } from "react";
import { verifyAndContinue, type MfaFormState } from "@/app/actions/mfa";
import { Button, Field, Input, Notice } from "@/components/ui";

/** Confirm a fresh second factor, then continue to `next` (used before connecting a social account). */
export function VerifyForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState(verifyAndContinue, {} as MfaFormState);
  useEffect(() => {
    if (state.next) window.location.assign(state.next);
  }, [state.next]);
  return (
    <form action={action} className="w-full max-w-sm space-y-4">
      <input type="hidden" name="next" value={next} />
      <h1 className="font-display text-[30px] leading-tight">Confirm it&apos;s you</h1>
      <p className="text-muted">Enter a code from your authenticator app (or a recovery code) to continue.</p>
      {state.error ? <Notice tone="danger">{state.error}</Notice> : null}
      <Field label="Code">
        <Input name="code" autoComplete="one-time-code" maxLength={12} required autoFocus aria-label="Verification code" />
      </Field>
      <Button className="w-full" size="lg" loading={pending || Boolean(state.next)}>
        Confirm and continue
      </Button>
    </form>
  );
}
