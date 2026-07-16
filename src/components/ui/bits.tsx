import Link from "next/link";
import { Info } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** White content card (border #E4EAF1, radius 14). */
export function Card({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("rounded-[14px] border border-line bg-card", className)}>
      {children}
    </div>
  );
}

/** 13/700 card header row; optional trailing info hint. */
export function CardTitle({
  children,
  info,
  className,
}: {
  children: ReactNode;
  info?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-[5px] text-[13px] font-bold", className)}>
      {children}
      {info && <Info size={12} strokeWidth={2} className="text-ghost" aria-hidden />}
    </div>
  );
}

/** "View All …" card footer link. */
export function CardLink({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "text-[12px] font-semibold text-action hover:text-action-deep focus-visible:outline-2 focus-visible:outline-action",
        className,
      )}
    >
      {children}
    </Link>
  );
}

/** Full-width outline button (32px, #DCE5EE border, action-blue label).
 *  Renders as a Link when `href` is provided so it navigates rather than no-ops. */
export function OutlineButton({
  children,
  href,
}: {
  children: ReactNode;
  href?: string;
}) {
  const className =
    "mt-3 flex h-8 w-full cursor-pointer items-center justify-center rounded-[9px] border border-line-btn bg-card text-[12px] font-semibold text-action hover:border-line-hover-2 hover:bg-[#F7FAFD] focus-visible:outline-2 focus-visible:outline-action";
  if (href) {
    return (
      <Link href={href} className={className}>
        {children}
      </Link>
    );
  }
  return <button className={className}>{children}</button>;
}

/** Initials avatar — solid color or [from, to] gradient. */
export function InitialsAvatar({
  initials,
  size,
  color,
  gradient,
  fontSize,
  className,
}: {
  initials: string;
  size: number;
  color?: string;
  gradient?: [string, string];
  fontSize: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full font-bold text-white",
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize,
        background: gradient
          ? `linear-gradient(135deg,${gradient[0]},${gradient[1]})`
          : color,
      }}
    >
      {initials}
    </span>
  );
}

/** 5px progress bar on an #EDF2F6 track. */
export function ProgressBar({
  pct,
  color,
  className,
  label,
}: {
  pct: number;
  color: string;
  className?: string;
  label?: string;
}) {
  return (
    <div
      className={cn("h-[5px] overflow-hidden rounded-full bg-track", className)}
      role={label ? "img" : undefined}
      aria-label={label}
    >
      <div
        className="h-full rounded-full"
        style={{ width: `${pct}%`, background: color }}
      />
    </div>
  );
}
