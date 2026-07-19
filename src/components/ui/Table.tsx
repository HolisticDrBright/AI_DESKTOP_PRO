import type { ReactNode, ThHTMLAttributes, TdHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

/**
 * Clear dense tables. Wide content scrolls inside the wrapper — the page
 * never scrolls horizontally.
 */
export function TableWrap({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("overflow-x-auto rounded-lg border border-line bg-card", className)}>
      <table className="w-full border-collapse text-[12.5px]">{children}</table>
    </div>
  );
}

export function TH({
  className,
  children,
  ...props
}: ThHTMLAttributes<HTMLTableCellElement> & { children?: ReactNode }) {
  return (
    <th
      className={cn(
        "border-b border-line bg-sunken px-3 py-[8px] text-left text-[11px] font-bold tracking-[0.04em] text-subtle uppercase",
        className,
      )}
      {...props}
    >
      {children}
    </th>
  );
}

export function TD({
  className,
  children,
  ...props
}: TdHTMLAttributes<HTMLTableCellElement> & { children?: ReactNode }) {
  return (
    <td
      className={cn("border-b border-hairline px-3 py-[9px] align-middle text-body", className)}
      {...props}
    >
      {children}
    </td>
  );
}
