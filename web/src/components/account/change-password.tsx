"use client";
import { useState } from "react";
import { changePasswordAction } from "@/app/actions/mfa";
import { Button, Card, CardBody, CardHeader, Field, Input } from "@/components/ui";
import { useRun } from "@/components/hooks";

/** Account → Security: change the password. Other sessions are signed out; an email confirms it. */
export function ChangePassword() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const { run, busy } = useRun();
  const mismatch = again.length > 0 && next !== again;
  return (
    <Card>
      <CardHeader title="Password" description="Changing it signs you out everywhere else, and we email you to confirm." />
      <CardBody className="space-y-3 text-[13px]">
        <Field label="Current password">
          <Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} aria-label="Current password" />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="New password" hint="8+ characters">
            <Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} aria-label="New password" />
          </Field>
          <Field label="New password again">
            <Input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} aria-label="New password again" />
          </Field>
        </div>
        {mismatch ? <p className="text-[12px] text-danger">The new passwords don&apos;t match.</p> : null}
        <Button
          loading={busy("pw")}
          disabled={!current || next.length < 8 || next !== again}
          onClick={() =>
            run(() => changePasswordAction(current, next), {
              key: "pw",
              refresh: false,
              success: (d) => `Password changed${d.otherSessionsEnded ? ` · signed out of ${d.otherSessionsEnded} other session${d.otherSessionsEnded === 1 ? "" : "s"}` : ""}`,
              onOk: () => {
                setCurrent("");
                setNext("");
                setAgain("");
              },
            })
          }
        >
          Change password
        </Button>
      </CardBody>
    </Card>
  );
}
