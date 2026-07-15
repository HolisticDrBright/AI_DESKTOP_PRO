"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";

/**
 * Small segmented control (track #F1F5F9, active white chip with soft shadow).
 * Uncontrolled by default; pass `value`/`onChange` to control it.
 */
export function SegmentedControl({
  options,
  value,
  defaultValue,
  onChange,
  ariaLabel,
}: {
  options: string[];
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  ariaLabel: string;
}) {
  const [inner, setInner] = useState(defaultValue ?? options[0]);
  const active = value ?? inner;

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="flex rounded-lg bg-sunken-2 p-[2px]"
    >
      {options.map((opt) => {
        const selected = opt === active;
        return (
          <button
            key={opt}
            role="tab"
            aria-selected={selected}
            onClick={() => {
              setInner(opt);
              onChange?.(opt);
            }}
            className={cn(
              "cursor-pointer rounded-md border-none px-[9px] py-[3px] text-[11px] font-semibold whitespace-nowrap focus-visible:outline-2 focus-visible:outline-action",
              selected
                ? "bg-card text-ink shadow-[0_1px_2px_rgba(24,42,61,0.08)]"
                : "bg-transparent text-subtle",
            )}
          >
            {opt}
          </button>
        );
      })}
    </div>
  );
}
