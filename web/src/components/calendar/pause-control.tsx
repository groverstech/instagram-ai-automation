"use client";
import { useState } from "react";
import { PauseCircle, PlayCircle } from "lucide-react";
import { pausePublishing, resumePublishing } from "@/app/actions/posts";
import { Button, Field, Input, Modal } from "@/components/ui";
import { useRun } from "@/components/hooks";
import { roleAtLeast, type Role } from "@/lib/roles";

/** Emergency pause (Content Calendar): editors and above pause, admins and owners resume. */
export function PauseControl({ brandId, brandName, role, paused }: { brandId: string; brandName: string; role: Role; paused: boolean }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const { run, busy } = useRun();
  if (paused && !roleAtLeast(role, "admin")) return null;
  if (!paused && !roleAtLeast(role, "editor")) return null;
  return (
    <>
      {paused ? (
        <Button variant="secondary" onClick={() => setOpen(true)}>
          <PlayCircle /> Resume publishing
        </Button>
      ) : (
        <Button variant="danger" onClick={() => setOpen(true)}>
          <PauseCircle /> Pause publishing
        </Button>
      )}
      {open ? (
        <Modal open onClose={() => setOpen(false)} title={paused ? `Resume publishing for ${brandName}?` : `Pause all publishing for ${brandName}?`}>
          <div className="space-y-4 p-5 text-[13px]">
            {paused ? (
              <p>Scheduled posts still due in the future are queued again. Posts whose time passed during the pause go back to <strong className="font-medium">approved</strong>, so you can reschedule them; nothing goes out late on its own.</p>
            ) : (
              <>
                <p>Nothing is published or scheduled for this brand until an admin resumes. Scheduled posts keep their status and times. A post already being sent to a platform can&apos;t be recalled.</p>
                <Field label="Reason (optional, shown to your team)">
                  <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="e.g. Reviewing the campaign after a customer complaint" aria-label="Reason for pausing" />
                </Field>
              </>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              {paused ? (
                <Button loading={busy("resume")} onClick={() => run(() => resumePublishing(brandId), { key: "resume", success: (r) => `Publishing resumed · ${r.requeued} queued again${r.unscheduled ? ` · ${r.unscheduled} missed post${r.unscheduled === 1 ? "" : "s"} back to approved` : ""}`, onOk: () => setOpen(false) })}>
                  Resume publishing
                </Button>
              ) : (
                <Button variant="danger" loading={busy("pause")} onClick={() => run(() => pausePublishing(brandId, reason), { key: "pause", success: "Publishing paused", onOk: () => { setOpen(false); setReason(""); } })}>
                  Pause publishing
                </Button>
              )}
            </div>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
