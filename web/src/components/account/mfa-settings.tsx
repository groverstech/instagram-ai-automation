"use client";
import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { confirmMfaEnrolment, disableMfaAction, regenerateRecoveryCodesAction, startMfaEnrolment } from "@/app/actions/mfa";
import { Badge, Button, Card, CardBody, CardHeader, Field, Input, Notice } from "@/components/ui";
import { useRun } from "@/components/hooks";

type Status = { enabled: boolean; recoveryCodesLeft: number; required: boolean };

/** Account → Security: turn two-step verification on or off, and manage recovery codes. */
export function MfaSettings({ status, requiredNotice }: { status: Status; requiredNotice: boolean }) {
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const { run, busy } = useRun();

  if (codes) {
    return (
      <Card aria-label="Recovery codes">
        <CardHeader title="Save your recovery codes" description="Each works once if you lose your authenticator. They won't be shown again." />
        <CardBody className="space-y-4">
          <ol className="grid grid-cols-2 gap-2 font-mono text-[14px]" aria-label="Your recovery codes">
            {codes.map((c) => (
              <li key={c} className="rounded-lg bg-sunken px-3 py-1.5 text-center">
                {c}
              </li>
            ))}
          </ol>
          <Notice tone="warn">Store them somewhere safe, such as a password manager. Anyone with your password and one of these codes can sign in.</Notice>
          <Button onClick={() => window.location.assign("/dashboard")}>I&apos;ve saved them</Button>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card aria-label="Two-step verification">
      <CardHeader
        title="Two-step verification"
        description="A code from an authenticator app (Google Authenticator, 1Password, Authy, Microsoft Authenticator…) in addition to your password."
        action={status.enabled ? <Badge tone="success"><ShieldCheck /> On</Badge> : <Badge tone="warn">Off</Badge>}
      />
      <CardBody className="space-y-4 text-[13px]">
        {requiredNotice && !status.enabled ? <Notice tone="warn">Your organisation requires two-step verification for owners and admins. Turn it on to continue.</Notice> : null}
        {!status.enabled && !setup ? (
          <Button loading={busy("start")} onClick={() => run(() => startMfaEnrolment(), { key: "start", refresh: false, onOk: (d) => setSetup(d) })}>
            Turn on two-step verification
          </Button>
        ) : null}
        {setup ? (
          <div className="space-y-4">
            <p>1. Scan this code with your authenticator app, or enter the key by hand.</p>
            <div className="flex flex-wrap items-center gap-4">
              {/* eslint-disable-next-line @next/next/no-img-element -- a generated data: SVG */}
              <img src={setup.qr} alt="QR code for your authenticator app" width={176} height={176} className="rounded-lg border border-line bg-white p-2" />
              <code className="break-all rounded-lg bg-sunken px-3 py-2 font-mono text-[13px]" aria-label="Setup key">
                {setup.secret.replace(/(.{4})/g, "$1 ").trim()}
              </code>
            </div>
            <p>2. Enter the 6-digit code the app shows.</p>
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Code" className="w-40">
                <Input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={7} aria-label="Code from your authenticator app" />
              </Field>
              <Button loading={busy("confirm")} disabled={code.replace(/\s/g, "").length !== 6} onClick={() => run(() => confirmMfaEnrolment(code), { key: "confirm", success: "Two-step verification is on", refresh: false, onOk: (d) => setCodes(d.recoveryCodes) })}>
                Turn on
              </Button>
            </div>
          </div>
        ) : null}
        {status.enabled ? (
          <div className="space-y-3">
            <p className="text-muted">{status.recoveryCodesLeft} recovery code{status.recoveryCodesLeft === 1 ? "" : "s"} left.</p>
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Current code (app or recovery)" className="w-56">
                <Input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" maxLength={12} aria-label="Current code" />
              </Field>
              <Button variant="secondary" disabled={!code} loading={busy("regen")} onClick={() => run(() => regenerateRecoveryCodesAction(code), { key: "regen", success: "New recovery codes", refresh: false, onOk: (d) => setCodes(d.recoveryCodes) })}>
                New recovery codes
              </Button>
              {!status.required ? (
                <Button variant="danger" disabled={!code} loading={busy("off")} onClick={() => run(() => disableMfaAction(code), { key: "off", success: "Two-step verification is off", onOk: () => setCode("") })}>
                  Turn off
                </Button>
              ) : null}
            </div>
            {status.required ? <p className="text-[12px] text-faint">Required for organisation owners and admins, so it can&apos;t be turned off.</p> : null}
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
