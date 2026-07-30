"use client";

import { useRouter } from "next/navigation";
import { cn } from "@/lib/cn";

export interface SegTabOption {
  id: string;
  label: string;
  badge?: string | number;
}

/**
 * URL-synced section tabs (`?tab=` / `?view=`). The ACTIVE value comes from
 * the server page's `searchParams` (no useSearchParams → no client Suspense
 * requirement); selecting replaces the query so back/forward and deep links
 * behave. Underline style matches the patient tab bar.
 */
export function SegTabs({
  basePath,
  param = "tab",
  value,
  options,
  preserve,
  ariaLabel,
  className,
}: {
  basePath: string;
  param?: string;
  value: string;
  options: SegTabOption[];
  /** Extra query params to keep while switching. */
  preserve?: Record<string, string | undefined>;
  ariaLabel: string;
  className?: string;
}) {
  const router = useRouter();

  const hrefFor = (id: string) => {
    const q = new URLSearchParams();
    q.set(param, id);
    for (const [k, v] of Object.entries(preserve ?? {})) {
      if (v != null && v !== "") q.set(k, v);
    }
    return `${basePath}?${q.toString()}`;
  };

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn("mb-4 flex gap-[2px] overflow-x-auto border-b border-line", className)}
    >
      {options.map((opt) => {
        const selected = opt.id === value;
        return (
          <button
            key={opt.id}
            role="tab"
            aria-selected={selected}
            onClick={() => router.replace(hrefFor(opt.id), { scroll: false })}
            className={cn(
              "-mb-px flex cursor-pointer items-center gap-[6px] border-b-2 bg-transparent px-3 pt-[8px] pb-[9px] text-[13px] whitespace-nowrap focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-action",
              selected
                ? "border-action font-[650] text-action-deep"
                : "border-transparent font-medium text-muted hover:text-ink",
            )}
          >
            {opt.label}
            {opt.badge != null && opt.badge !== 0 && (
              <span className="rounded-full bg-[rgba(90,107,126,0.12)] px-[6px] py-px text-[10.5px] font-semibold text-muted">
                {opt.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
