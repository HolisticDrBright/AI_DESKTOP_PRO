"use client";

import { useState } from "react";
import {
  ACTIONS,
  COMPOSER_ACTIONS,
  executeAction,
  type ActionContext,
  type ActionKind,
} from "@/adapters/actions";
import { actionIcons } from "@/components/icons";
import { cn } from "@/lib/cn";
import { useComposerOptional } from "@/lib/composer";
import { useFeedback } from "@/lib/feedback";
import { toneText, toneTint } from "@/lib/tones";
import { ConfirmDialog } from "./ConfirmDialog";

/**
 * Reusable review-to-action bar for clinical cards, alerts, queue items, lab
 * abnormalities, hypotheses, experiment conclusions and protocol approvals.
 *
 * - Confirm-required (destructive / patient-facing) actions open a ConfirmDialog.
 * - Outcomes are announced via the accessible feedback channel.
 * - Execution goes through the mock `executeAction` adapter (no real
 *   persistence); pass `onAction` to override with a real mutation later.
 */
export function ActionBar({
  actions,
  context,
  onAction,
  size = "md",
  className,
}: {
  actions: ActionKind[];
  context: ActionContext;
  onAction?: (kind: ActionKind, context: ActionContext) => Promise<void> | void;
  size?: "sm" | "md";
  className?: string;
}) {
  const { announce } = useFeedback();
  const composer = useComposerOptional();
  const [pending, setPending] = useState<ActionKind | null>(null);

  const run = async (kind: ActionKind) => {
    if (onAction) {
      await onAction(kind, context);
      return;
    }
    const result = await executeAction(kind, context, new Date().toISOString());
    announce(result.message);
  };

  const handleClick = (kind: ActionKind) => {
    // Composer actions open the note/report drawer directly — its own review /
    // approve step is the gate, so we skip the standalone confirmation here.
    const draftKind = COMPOSER_ACTIONS[kind];
    if (draftKind && composer && !onAction) {
      composer.openComposer(draftKind, {
        patientName: context.patientName ?? "the patient",
        subjectType: context.subjectType,
        subjectLabel: context.subjectLabel,
        seeds: context.seeds,
      });
      return;
    }
    if (ACTIONS[kind].confirm) setPending(kind);
    else void run(kind);
  };

  const pad = size === "sm" ? "h-6 px-[8px] text-[11px]" : "h-[26px] px-[10px] text-[11.5px]";

  return (
    <div className={cn("flex flex-wrap items-center gap-[6px]", className)} role="group" aria-label="Review actions">
      {actions.map((kind) => {
        const d = ACTIONS[kind];
        const Icon = actionIcons[d.icon];
        return (
          <button
            key={kind}
            onClick={() => handleClick(kind)}
            aria-label={`${d.label} — ${context.subjectType} ${context.subjectLabel}`}
            className={cn(
              "flex cursor-pointer items-center gap-[5px] rounded-[7px] border font-semibold focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-action",
              pad,
            )}
            style={{
              color: toneText[d.tone],
              background: toneTint[d.tone],
              borderColor: "transparent",
            }}
          >
            <Icon size={size === "sm" ? 11 : 12} strokeWidth={2} aria-hidden />
            {d.label}
          </button>
        );
      })}

      {pending && (
        <ConfirmDialog
          open
          title={`${ACTIONS[pending].label}?`}
          body={ACTIONS[pending].confirmText ?? "Please confirm this action."}
          confirmLabel={ACTIONS[pending].label}
          destructive={ACTIONS[pending].destructive}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const kind = pending;
            setPending(null);
            void run(kind);
          }}
        />
      )}
    </div>
  );
}
