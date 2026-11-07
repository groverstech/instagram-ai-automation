"use client";
import { useState } from "react";
import { format } from "date-fns";
import { Sparkles } from "lucide-react";
import { planCalendarAction } from "@/app/actions/ai";
import { Button, Field, Input, Modal } from "@/components/ui";
import { useRun } from "@/components/hooks";

export function PlanCalendarModal({ open, onClose, brandId, platforms }: { open: boolean; onClose: () => void; brandId: string; platforms: string[] }) {
  const [start, setStart] = useState(format(new Date(Date.now() + 864e5), "yyyy-MM-dd"));
  const [days, setDays] = useState(14);
  const [ppw, setPpw] = useState(5);
  const [note, setNote] = useState("");
  const { run, busy } = useRun();
  return (
    <Modal open={open} onClose={onClose} title="Populate the content calendar">
      <div className="space-y-4 p-5">
        <p className="text-[13px] text-muted">The Content Strategist turns your current strategy into dated draft posts for {platforms.join(", ") || "your platforms"}. Nothing is scheduled until you approve it.</p>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Start"><Input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
          <Field label="Days"><Input type="number" min={1} max={60} value={days} onChange={(e) => setDays(Number(e.target.value))} /></Field>
          <Field label="Posts / week"><Input type="number" min={1} max={21} value={ppw} onChange={(e) => setPpw(Number(e.target.value))} /></Field>
        </div>
        <Field label="Anything specific?"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="More reels, focus on workshops…" /></Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="accent" loading={busy()} onClick={() => run(() => planCalendarAction(brandId, { start, days, platforms, postsPerWeek: ppw, note }), { success: (d) => `${d.count} draft posts added to the calendar`, onOk: onClose })}>
            <Sparkles /> Plan calendar
          </Button>
        </div>
      </div>
    </Modal>
  );
}
