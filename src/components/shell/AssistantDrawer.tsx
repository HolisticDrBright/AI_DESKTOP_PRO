"use client";

import { Sparkles, X } from "lucide-react";
import { useShellUi } from "@/lib/providers";
import { ClinicalEmpty } from "@/components/ui/ClinicalStates";

/**
 * Clinical assistant drawer — CLINICAL.
 *
 * The assistant has no live backend: no governed model configuration, no
 * grounding pipeline, no provenance chain. The drawer stays (the surface is
 * part of the designed shell) and says exactly that — it never renders a
 * synthetic transcript about a synthetic patient.
 */
export function AssistantDrawer() {
  const { aiOpen, closeAi } = useShellUi();
  if (!aiOpen) return null;

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
          <div className="text-[11px] text-subtle">Not configured</div>
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
        <ClinicalEmpty
          title="The assistant isn't configured yet"
          message="AI assistance requires a governed model configuration with grounded, provenance-linked patient context. Until that exists, this panel stays empty rather than fabricating an answer."
        />
      </div>
    </aside>
  );
}
