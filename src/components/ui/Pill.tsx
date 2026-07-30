import type { ReactNode } from "react";
import type { Tone } from "@/adapters/types";
import { toneText, toneTint } from "@/lib/tones";
import { cn } from "@/lib/cn";

/** Tinted status chip. Text label always accompanies the color. */
export function Pill({
  tone = "slate",
  children,
  className,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-[8px] py-[2px] text-[11px] font-semibold whitespace-nowrap",
        className,
      )}
      style={{ background: toneTint[tone], color: toneText[tone] }}
    >
      {children}
    </span>
  );
}

/** Small neutral keyboard-style tag (channel names, versions). */
export function Tag({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border border-line bg-sunken px-[6px] py-px text-[10.5px] font-semibold text-muted",
        className,
      )}
    >
      {children}
    </span>
  );
}
