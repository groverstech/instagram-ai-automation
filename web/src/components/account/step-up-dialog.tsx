"use client";
import { useEffect, useState } from "react";
import { confirmStepUpAction } from "@/app/actions/mfa";
import { Button, Field, Input, Modal, Notice } from "@/components/ui";
import { STEP_UP_EVENT, type StepUpDetail } from "@/components/hooks";

/**
 * Asks for a fresh second factor when a sensitive action needs one (auth/step-up.ts), then retries
 * that action. Mounted once in the app layout; actions raise it through useRun.
 */
export function StepUpDialog() {
  const [pending, setPending] = useState<StepUpDetail | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const on = (e: Event) => {
      setPending((e as CustomEvent<StepUpDetail>).detail);
      setCode("");
      setError(null);
    };
    window.addEventListener(STEP_UP_EVENT, on);
    return () => window.removeEventListener(STEP_UP_EVENT, on);
  }, []);
  if (!pending) return null;
  const close = () => {
    pending.cancel();
    setPending(null);
  };
  async function confirm() {
    setBusy(true);
    setError(null);
    const r = await confirmStepUpAction(code).catch(() => ({ ok: false as const, error: "The server is busy or unreachable. Try again." }));
    setBusy(false);
    if (!r.ok) return setError(r.error);
    const retry = pending!.retry;
    setPending(null);
    retry();
  }
  return (
    <Modal open onClose={close} title="Confirm it's you">
      <form
        className="space-y-4 p-5 text-[13px]"
        onSubmit={(e) => {
          e.preventDefault();
          void confirm();
        }}
      >
        <p>This change needs a code from your authenticator app (or a recovery code). You won&apos;t be asked again for 15 minutes.</p>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <Field label="Code">
          <Input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" maxLength={12} autoFocus aria-label="Verification code" />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} disabled={!code.trim()}>
            Confirm and continue
          </Button>
        </div>
      </form>
    </Modal>
  );
}
