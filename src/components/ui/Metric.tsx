import Link from "next/link";
import type { ReactNode } from "react";
import type { Tone } from "@/adapters/types";
import { toneText } from "@/lib/tones";
import { cn } from "@/lib/cn";

/**
 * Dense stat tile for dashboard rows. Optional href makes the whole tile a
 * link (every number opens its source).
 */
export function Metric({
  label,
  value,
  sub,
  subTone,
  href,
  className,
}: {
  label: string;
  value: ReactNode;
  sub?: string;
  subTone?: Tone;
  href?: string;
  className?: string;
}) {
  const body = (
    <>
      <div className="text-[11.5px] font-semibold text-subtle">{label}</div>
      <div className="mt-[3px] text-[20px] leading-none font-bold tracking-[-0.01em] text-ink">
        {value}
      </div>
      {sub && (
        <div
          className="mt-[5px] text-[11.5px] font-medium text-muted"
          style={subTone ? { color: toneText[subTone] } : undefined}
        >
          {sub}
        </div>
      )}
    </>
  );
  const base = "rounded-lg border border-line bg-card px-[14px] py-[12px]";
  if (href) {
    return (
      <Link
        href={href}
        className={cn(
          base,
          "block hover:border-line-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-action",
          className,
        )}
      >
        {body}
      </Link>
    );
  }
  return <div className={cn(base, className)}>{body}</div>;
}
