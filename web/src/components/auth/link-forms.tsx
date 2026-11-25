"use client";
import { useActionState, useState, useTransition } from "react";
import { acceptInviteAction, verifyEmailAction, type LinkState } from "@/app/actions/invites";
import { resendVerificationAction } from "@/app/actions/auth";
import { Button, Notice } from "@/components/ui";

export function ConfirmEmailForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState(verifyEmailAction, {} as LinkState);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="token" value={token} />
      {state.error ? <Notice tone="danger">{state.error}</Notice> : null}
      <Button className="w-full" size="lg" loading={pending}>
        Confirm my email address
      </Button>
    </form>
  );
}

export function AcceptInviteForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState(acceptInviteAction, {} as LinkState);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="token" value={token} />
      {state.error ? <Notice tone="danger">{state.error}</Notice> : null}
      <Button className="w-full" size="lg" loading={pending}>
        Accept the invitation
      </Button>
    </form>
  );
}

export function ResendVerification() {
  const [msg, setMsg] = useState<{ ok: boolean; message: string } | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="space-y-3">
      {msg ? <Notice tone={msg.ok ? "success" : "danger"}>{msg.message}</Notice> : null}
      <Button variant="secondary" className="w-full" loading={pending} onClick={() => start(async () => setMsg(await resendVerificationAction()))}>
        Send the link again
      </Button>
    </div>
  );
}
