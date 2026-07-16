"use client";

import { useEffect, useRef, useState } from "react";
import { TriangleAlert } from "lucide-react";

/**
 * Confirmation dialog for state changes that REQUIRE a recorded reason
 * (cancel, entered-in-error). Modal; Escape cancels; the reason is required
 * before confirm enables — these reasons land in the clinical record.
 */
export function ReasonDialog({
  open,
  title,
  body,
  confirmLabel,
  destructive = true,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    setReason("");
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(15,18,20,0.4)] p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-[400px] rounded-[14px] border border-line bg-card p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-[10px]">
          <TriangleAlert size={16} strokeWidth={2.2} className={destructive ? "mt-[2px] text-critical" : "mt-[2px] text-body"} aria-hidden />
          <div className="min-w-0">
            <h2 className="m-0 text-[14px] font-bold text-ink">{title}</h2>
            <p className="m-0 mt-[4px] text-[12.5px] leading-[1.5] text-body">{body}</p>
          </div>
        </div>
        <label htmlFor="reason-input" className="mt-3 mb-[5px] block text-[10px] font-bold tracking-[0.04em] text-faint uppercase">
          Reason (recorded)
        </label>
        <textarea
          id="reason-input"
          ref={inputRef}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
          className="w-full resize-y rounded-lg border border-line bg-card px-[10px] py-[8px] text-[13px] text-body outline-none focus-visible:outline-2 focus-visible:outline-action"
        />
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="h-9 cursor-pointer rounded-lg border border-line bg-card px-4 text-[12.5px] font-semibold text-body hover:border-line-hover focus-visible:outline-2 focus-visible:outline-action"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!reason.trim()}
            onClick={() => onConfirm(reason.trim())}
            className={`h-9 cursor-pointer rounded-lg border-none px-4 text-[12.5px] font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-50 ${destructive ? "bg-critical hover:opacity-90" : "bg-action hover:bg-action-deep"}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
