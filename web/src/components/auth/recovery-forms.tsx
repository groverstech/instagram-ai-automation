"use client";
import Link from "next/link";
import { useActionState } from "react";
import { requestPasswordResetAction, resetPasswordAction, type RecoveryFormState } from "@/app/actions/auth";
import { Button, Field, Input, Notice } from "@/components/ui";

export function ForgotPasswordForm() {
  const [state, action, pending] = useActionState(requestPasswordResetAction, {} as RecoveryFormState);
  return (
    <form action={action} className="w-full max-w-sm space-y-4">
      <div className="mb-8">
        <h1 className="font-display text-[34px] leading-tight">Reset your password</h1>
        <p className="mt-1 text-muted">Enter the email you sign in with. We&apos;ll send a link to set a new password.</p>
      </div>
      {state.sent ? (
        <Notice tone="success">
          If an account uses {state.email}, a reset link is on its way. It works for 30 minutes. No email? Check spam, or ask your workspace owner or BrandPilot support.
        </Notice>
      ) : null}
      {state.error ? <Notice tone="danger">{state.error}</Notice> : null}
      <Field label="Email">
        <Input name="email" type="email" autoComplete="email" defaultValue={state.email} required />
      </Field>
      <Button className="w-full" size="lg" loading={pending}>
        Send reset link
      </Button>
      <p className="text-center text-[13px] text-muted">
        <Link href="/login" className="font-medium text-ink underline-offset-4 hover:underline">
          Back to sign in
        </Link>
      </p>
    </form>
  );
}

export function ResetPasswordForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState(resetPasswordAction, {} as RecoveryFormState);
  return (
    <form action={action} className="w-full max-w-sm space-y-4">
      <input type="hidden" name="token" value={token} />
      <div className="mb-8">
        <h1 className="font-display text-[34px] leading-tight">Choose a new password</h1>
        <p className="mt-1 text-muted">You&apos;ll be signed out everywhere and asked to sign in again. Two-step verification stays on.</p>
      </div>
      {state.error ? <Notice tone="danger">{state.error}</Notice> : null}
      <Field label="New password">
        <Input name="password" type="password" autoComplete="new-password" minLength={8} required />
      </Field>
      <Field label="Repeat it">
        <Input name="confirm" type="password" autoComplete="new-password" minLength={8} required />
      </Field>
      <Button className="w-full" size="lg" loading={pending}>
        Set new password
      </Button>
    </form>
  );
}
