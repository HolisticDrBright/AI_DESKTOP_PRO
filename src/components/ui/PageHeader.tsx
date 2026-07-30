import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Dense screen header: breadcrumb line, 19px title, optional sub-line and
 * right-aligned actions. Calm by design — no hero sizing, no marketing copy.
 */
export function PageHeader({
  crumb,
  title,
  sub,
  actions,
  className,
}: {
  crumb: string;
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-4 flex flex-wrap items-end justify-between gap-3", className)}>
      <div className="min-w-0">
        <div className="text-[11.5px] font-semibold text-faint">{crumb}</div>
        <h1 className="m-0 mt-[2px] text-[19px] font-bold tracking-[-0.015em]">{title}</h1>
        {sub && <p className="mt-[3px] mb-0 text-[12.5px] leading-[1.5] text-subtle">{sub}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
