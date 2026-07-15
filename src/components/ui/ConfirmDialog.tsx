"use client";

import { useEffect, useRef } from "react";
import { TriangleAlert } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Confirmation dialog for destructive / patient-facing actions. Modal, focus is
 * moved to the confirm button, Escape cancels, backdrop click cancels, and the
 * confirm button reflects the action's tone (coral for destructive).
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      onClick={onCancel}
      className="fixed inset-0 z-[150] flex items-center justify-center bg-[rgba(24,42,61,0.32)] px-4 backdrop-blur-[3px]"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-body"
        className="glass-overlay animate-fade-up w-[420px] max-w-full overflow-hidden rounded-2xl border border-[rgba(255,255,255,0.7)] bg-[rgba(255,255,255,0.96)] shadow-[0_24px_64px_rgba(24,42,61,0.22)] outline-1 outline-[rgba(203,214,224,0.6)]"
      >
        <div className="flex items-start gap-3 px-5 pt-5">
          <span
            className={cn(
              "flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
              destructive ? "bg-critical-tint" : "bg-action-tint",
            )}
          >
            <TriangleAlert
              size={17}
              strokeWidth={2}
              className={destructive ? "text-critical" : "text-action"}
              aria-hidden
            />
          </span>
          <div>
            <h2 id="confirm-title" className="m-0 text-[15px] font-bold text-ink">
              {title}
            </h2>
            <p id="confirm-body" className="mt-1 mb-0 text-[12.5px] leading-normal text-body">
              {body}
            </p>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2 border-t border-hairline bg-[rgba(247,250,252,0.6)] px-5 py-3">
          <button
            onClick={onCancel}
            className="h-8 cursor-pointer rounded-lg border border-line bg-card px-3 text-[12.5px] font-semibold text-body hover:border-line-hover focus-visible:outline-2 focus-visible:outline-action"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            onClick={onConfirm}
            className={cn(
              "h-8 cursor-pointer rounded-lg border-none px-3 text-[12.5px] font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink",
              destructive ? "bg-critical hover:brightness-95" : "bg-action hover:bg-action-deep",
            )}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
