"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Small accessible popover menu for header controls that don't yet have a full
 * screen. Closes on Escape, outside click, and (optionally) on item activation.
 * The trigger is a render-prop so callers own the button styling + aria.
 */
export function Popover({
  trigger,
  children,
  align = "right",
  side = "bottom",
  panelClassName,
  label,
}: {
  trigger: (o: { open: boolean; toggle: () => void }) => ReactNode;
  children: (o: { close: () => void }) => ReactNode;
  align?: "left" | "right";
  /** Which side of the trigger the panel opens on (top for footer controls). */
  side?: "bottom" | "top";
  panelClassName?: string;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open && (
        <div
          role="menu"
          aria-label={label}
          className={cn(
            "glass-overlay animate-fade-up absolute z-[120] w-[260px] overflow-hidden rounded-[14px] border border-[rgba(255,255,255,0.7)] bg-[rgba(255,255,255,0.97)] shadow-[0_18px_48px_rgba(24,42,61,0.2)] outline-1 outline-[rgba(203,214,224,0.6)]",
            side === "bottom" ? "top-[calc(100%+8px)]" : "bottom-[calc(100%+8px)]",
            align === "right" ? "right-0" : "left-0",
            panelClassName,
          )}
        >
          {children({ close: () => setOpen(false) })}
        </div>
      )}
    </div>
  );
}

/** A menu section heading + optional trailing note. */
export function PopoverHeader({ title, note }: { title: string; note?: string }) {
  return (
    <div className="flex items-center justify-between border-b border-hairline px-[13px] py-[9px]">
      <span className="text-[12.5px] font-bold text-ink">{title}</span>
      {note && <span className="text-[10px] font-semibold text-faint">{note}</span>}
    </div>
  );
}

/** Footer note used to state the demo boundary honestly. */
export function PopoverDemoNote({ children }: { children: ReactNode }) {
  return (
    <div className="border-t border-hairline bg-[rgba(247,250,252,0.7)] px-[13px] py-[7px] text-[10.5px] leading-[1.4] text-faint">
      {children}
    </div>
  );
}
