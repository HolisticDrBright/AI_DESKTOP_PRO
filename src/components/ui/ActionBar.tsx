"use client";

import { useState } from "react";
import {
  ACTIONS,
  ACTION_REVIEW_OUTCOME,
  COMPOSER_ACTIONS,
  executeAction,
  type ActionContext,
  type ActionKind,
} from "@/adapters/actions";
import { useReviewOutcome } from "@/adapters/session-store";
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
  onExecuted,
  size = "md",
  className,
}: {
  actions: ActionKind[];
  context: ActionContext;
  onAction?: (kind: ActionKind, context: ActionContext) => Promise<void> | void;
  /** Called after an action executes through the default path (audit recorded). */
  onExecuted?: (kind: ActionKind) => void;
  size?: "sm" | "md";
  className?: string;
}) {
  const { announce } = useFeedback();
  const composer = useComposerOptional();
  const [pending, setPending] = useState<ActionKind | null>(null);
  // When the subject is reviewable, a recorded outcome settles its actions.
  const outcome = useReviewOutcome(context.reviewKey ?? "");

  const run = async (kind: ActionKind) => {
    if (onAction) {
      await onAction(kind, context);
      onExecuted?.(kind);
      return;
    }
    const result = await executeAction(kind, context, new Date().toISOString());
    announce(result.message);
    onExecuted?.(kind);
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
        // A settling action (approve/reject/resolve/…) is disabled once the
        // subject's review has settled — it must not read as "nothing happened".
        const isSettling = kind in ACTION_REVIEW_OUTCOME;
        const disabled = Boolean(outcome) && isSettling;
        return (
          <button
            key={kind}
            onClick={() => !disabled && handleClick(kind)}
            disabled={disabled}
            aria-disabled={disabled || undefined}
            aria-label={`${d.label} — ${context.subjectType} ${context.subjectLabel}`}
            className={cn(
              "flex items-center gap-[5px] rounded-[7px] border font-semibold focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-action",
              disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer",
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
