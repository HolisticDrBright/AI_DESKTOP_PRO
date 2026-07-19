"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Right-side detail drawer (appointment details, template versions, thread
 * context…). Modal: backdrop click + Escape close it, focus moves to the
 * close button on open and returns to the opener on close (browser default
 * via focus history is unreliable, so we restore explicitly).
 */
export function Drawer({
  open,
  onClose,
  title,
  sub,
  width = 420,
  children,
  footer,
  labelledBy,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  sub?: ReactNode;
  width?: number;
  children: ReactNode;
  footer?: ReactNode;
  labelledBy?: string;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = (document.activeElement as HTMLElement) ?? null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      restoreRef.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[140]" role="presentation">
      <div
        onClick={onClose}
        className="absolute inset-0 bg-[rgba(24,42,61,0.28)] backdrop-blur-[2px]"
        aria-hidden
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className="animate-fade-up absolute top-0 right-0 flex h-full max-w-[92vw] flex-col border-l border-line bg-card shadow-[-16px_0_48px_rgba(24,42,61,0.16)]"
        style={{ width }}
      >
        <header className="flex items-start gap-3 border-b border-hairline px-5 py-4">
          <div className="min-w-0 flex-1 leading-[1.35]">
            <div id={labelledBy} className="truncate text-[15px] font-bold text-ink">
              {title}
            </div>
            {sub && <div className="mt-[2px] text-[12px] text-subtle">{sub}</div>}
          </div>
          <button
            ref={closeRef}
            onClick={onClose}
            aria-label="Close panel"
            className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-line bg-card text-muted hover:border-line-hover focus-visible:outline-2 focus-visible:outline-action"
          >
            <X size={15} strokeWidth={2} aria-hidden />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer && (
          <footer className={cn("border-t border-hairline bg-sunken px-5 py-3")}>{footer}</footer>
        )}
      </aside>
    </div>
  );
}
