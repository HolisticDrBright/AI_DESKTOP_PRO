"use client";

import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

type Variant = "primary" | "outline" | "ghost" | "danger" | "ai";
type Size = "sm" | "md";

const VARIANTS: Record<Variant, string> = {
  primary: "border-transparent bg-action text-white hover:bg-action-deep",
  outline: "border-line-btn bg-card text-action hover:border-line-hover-2 hover:bg-[#F7FAFD]",
  ghost: "border-transparent bg-transparent text-body-2 hover:bg-[rgba(37,99,199,0.06)]",
  danger: "border-transparent bg-critical text-white hover:bg-[#c04a41]",
  ai: "border-[rgba(116,97,201,0.3)] bg-[rgba(116,97,201,0.07)] text-ai-deep hover:bg-[rgba(116,97,201,0.13)]",
};

const SIZES: Record<Size, string> = {
  sm: "h-7 px-[10px] text-[11.5px] gap-[5px] rounded-[7px]",
  md: "h-8 px-3 text-[12.5px] gap-[6px] rounded-lg",
};

export function btnClass(variant: Variant = "outline", size: Size = "md", extra?: string) {
  return cn(
    "inline-flex cursor-pointer items-center justify-center border font-semibold whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-action disabled:cursor-not-allowed disabled:opacity-45",
    VARIANTS[variant],
    SIZES[size],
    extra,
  );
}

export function Btn({
  variant = "outline",
  size = "md",
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  children: ReactNode;
}) {
  return (
    <button className={btnClass(variant, size, className)} {...props}>
      {children}
    </button>
  );
}

export function BtnLink({
  variant = "outline",
  size = "md",
  href,
  className,
  children,
}: {
  variant?: Variant;
  size?: Size;
  href: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link href={href} className={btnClass(variant, size, className)}>
      {children}
    </Link>
  );
}
