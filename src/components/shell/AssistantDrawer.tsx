"use client";

import { CircleAlert, Send, Sparkles, X } from "lucide-react";
import { getAssistantSession } from "@/adapters/assistant.mock";
import type { Tone } from "@/adapters/types";
import { useShellUi } from "@/lib/providers";

/* Provenance badge colors — Measured / Patient-reported / AI inference. */
const FACT_STYLE: Partial<Record<Tone, { color: string; tint: string }>> = {
  navy: { color: "#3D5A80", tint: "#E8EEF5" },
  teal: { color: "#0E8388", tint: "rgba(14,131,136,0.12)" },
  ai: { color: "#5D4BB5", tint: "rgba(116,97,201,0.12)" },
};

export function AssistantDrawer() {
  const { aiOpen, closeAi } = useShellUi();
  if (!aiOpen) return null;

  const session = getAssistantSession();

  return (
    <aside
      role="dialog"
      aria-label="Clinical assistant panel"
      className="glass-overlay animate-fade-up fixed top-3 right-3 bottom-3 z-90 flex w-[392px] flex-col overflow-hidden rounded-[20px] border border-[rgba(255,255,255,0.7)] bg-[rgba(255,255,255,0.92)] shadow-[0_20px_56px_rgba(24,42,61,0.2),inset_0_1px_0_rgba(255,255,255,0.85)] outline-1 outline-[rgba(203,214,224,0.6)]"
    >
      <div className="h-[3px] shrink-0 bg-[linear-gradient(90deg,#7461C9,#9D8DE8)]" />

      <div className="flex items-center gap-[9px] border-b border-hairline px-4 pt-[14px] pb-3">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[rgba(116,97,201,0.12)]">
          <Sparkles size={14} strokeWidth={1.75} className="text-ai" aria-hidden />
        </span>
        <div className="flex-1">
          <div className="text-[14px] font-bold">Clinical Assistant</div>
          <div className="text-[11px] text-subtle">
            {session.patientName} · data through {session.dataThrough}
          </div>
        </div>
        <button
          onClick={closeAi}
          aria-label="Close assistant"
          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg border-none bg-transparent text-faint hover:bg-[rgba(90,107,126,0.1)] hover:text-ink focus-visible:outline-2 focus-visible:outline-ai"
        >
          <X size={14} strokeWidth={2} aria-hidden />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-[14px]">
        <div className="mb-[14px] flex flex-wrap gap-[6px]">
          {session.chips.map((chip) => (
            <button
              key={chip}
              className="cursor-pointer rounded-full border border-[rgba(116,97,201,0.3)] bg-[rgba(116,97,201,0.06)] px-[11px] py-[5px] text-[11.5px] font-semibold text-ai-deep hover:bg-[rgba(116,97,201,0.12)] focus-visible:outline-2 focus-visible:outline-ai"
            >
              {chip}
            </button>
          ))}
        </div>

        <div className="mb-2 text-[12px] font-bold text-ink">{session.question}</div>
        <div className="rounded-xl border border-[#ECE9F8] bg-[rgba(116,97,201,0.04)] p-3">
          <div className="flex flex-col gap-[9px]">
            {session.facts.map((fact) => {
              const style = FACT_STYLE[fact.tone];
              return (
                <div key={fact.text} className="flex items-baseline gap-2">
                  <span
                    aria-hidden
                    className="h-2 w-2 shrink-0 translate-y-px rounded-[3px]"
                    style={{ background: style?.color }}
                  />
                  <span className="flex-1 text-[12px] leading-[1.45] text-body">
                    {fact.text}{" "}
                    <span
                      className="ml-[3px] inline-block rounded-[4px] px-[5px] py-px align-[1px] text-[9.5px] font-bold"
                      style={{ color: style?.color, background: style?.tint }}
                    >
                      {fact.badge}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="mt-[14px]">
          <div className="mb-[7px] text-[10.5px] font-bold tracking-[0.06em] text-faint uppercase">
            Sources used
          </div>
          <div className="flex flex-wrap gap-[6px]">
            {session.sources.map((source) => (
              <span
                key={source}
                className="rounded-md bg-sunken-2 px-2 py-[3px] text-[11px] font-semibold text-muted"
              >
                {source}
              </span>
            ))}
          </div>
        </div>

        <div className="mt-[14px]">
          <div className="mb-[7px] text-[10.5px] font-bold tracking-[0.06em] text-faint uppercase">
            Missing information
          </div>
          <div className="text-[12px] leading-normal text-muted">{session.missingInfo}</div>
        </div>
      </div>

      <div className="border-t border-hairline bg-[rgba(247,250,252,0.7)] px-4 py-3">
        <div className="mb-[10px] flex items-center gap-[7px]">
          <CircleAlert size={12} strokeWidth={2} className="text-warning" aria-hidden />
          <span className="text-[11px] font-semibold text-warning-deep">
            {session.reviewNotice}
          </span>
        </div>
        <div className="mb-[10px] flex gap-2">
          <button className="h-[30px] flex-1 cursor-pointer rounded-lg border border-line bg-card text-[12px] font-semibold text-body hover:border-line-hover focus-visible:outline-2 focus-visible:outline-ai">
            Insert into note
          </button>
          <button className="h-[30px] flex-1 cursor-pointer rounded-lg border border-[rgba(116,97,201,0.35)] bg-[rgba(116,97,201,0.08)] text-[12px] font-semibold text-ai-deep hover:bg-[rgba(116,97,201,0.14)] focus-visible:outline-2 focus-visible:outline-ai">
            Explain reasoning
          </button>
        </div>
        <form
          onSubmit={(e) => e.preventDefault()}
          className="flex h-9 items-center gap-2 rounded-[10px] border border-line bg-card px-[10px]"
        >
          <input
            placeholder="Ask about this patient…"
            aria-label="Ask about this patient"
            className="flex-1 border-none bg-transparent text-[12.5px] outline-none placeholder:text-faint"
          />
          <button
            type="submit"
            aria-label="Send question"
            className="flex cursor-pointer items-center border-none bg-transparent p-0 focus-visible:outline-2 focus-visible:outline-ai"
          >
            <Send size={14} strokeWidth={2} className="text-ai" aria-hidden />
          </button>
        </form>
      </div>
    </aside>
  );
}
