"use client";
import { openAssistant } from "@/components/shell/assistant";
import { Button } from "@/components/ui";

export function AskButton({ prompt, children, variant = "ai" }: { prompt: string; children: React.ReactNode; variant?: "ai" | "link" }) {
  if (variant === "link") {
    return (
      <button onClick={() => openAssistant(prompt)} className="mt-2 inline-flex items-center gap-1 text-[12px] font-medium text-accent hover:text-accent-ink">
        {children}
      </button>
    );
  }
  return (
    <Button variant="ai" onClick={() => openAssistant(prompt)}>
      {children}
    </Button>
  );
}
