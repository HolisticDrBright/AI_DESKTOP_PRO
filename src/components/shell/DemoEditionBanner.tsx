"use client";

import { useState } from "react";
import { FlaskConical, RotateCcw } from "lucide-react";
import { DEMO_BANNER_TEXT, IS_DEMO } from "@/lib/edition";
import { resetDemoState } from "@/adapters/demo-reset";

/**
 * The demo edition's standing disclosure, rendered by `AppShell` so it appears
 * on every primary screen rather than on whichever screens someone remembered
 * to annotate.
 *
 * It carries the Reset Demo control too: the honest statement and the way to
 * undo your changes belong in the same place, and a visitor who has clicked
 * through half the app should never have to hunt for how to start over.
 *
 * Renders nothing at all in the clinical edition.
 */
export function DemoEditionBanner() {
  const [resetting, setResetting] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  if (!IS_DEMO) return null;

  const onReset = () => {
    setResetting(true);
    try {
      const { clearedKeys } = resetDemoState();
      setNote(
        clearedKeys > 0
          ? "Demo reset — original synthetic data restored."
          : "Demo already at its original synthetic data.",
      );
    } finally {
      setResetting(false);
    }
    // The banner note is transient; screens re-render from fixtures immediately.
    window.setTimeout(() => setNote(null), 4000);
  };

  return (
    <div
      data-testid="demo-banner"
      role="region"
      aria-label="Demo edition notice"
      className="flex shrink-0 items-center gap-2 border-b border-[rgba(124,92,196,0.28)] bg-[rgba(124,92,196,0.09)] px-4 py-[7px]"
    >
      <FlaskConical size={13} strokeWidth={2.2} aria-hidden className="shrink-0 text-inference" />
      <span className="text-[11.5px] font-semibold text-inference">{DEMO_BANNER_TEXT}</span>
      <span className="text-[11px] text-subtle">
        No patient records, no backend, nothing you change is saved.
      </span>

      {note && (
        <span role="status" className="ml-auto text-[11px] font-semibold text-action">
          {note}
        </span>
      )}

      <button
        type="button"
        onClick={onReset}
        disabled={resetting}
        data-testid="demo-reset"
        className={`${note ? "ml-2" : "ml-auto"} inline-flex items-center gap-1.5 rounded-[7px] border border-line bg-surface px-2.5 py-[3px] text-[11px] font-semibold text-body transition-colors hover:border-action hover:text-action disabled:opacity-60`}
      >
        <RotateCcw size={11} strokeWidth={2.2} aria-hidden />
        {resetting ? "Resetting…" : "Reset demo"}
      </button>
    </div>
  );
}
