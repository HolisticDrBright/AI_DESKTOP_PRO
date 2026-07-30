"use client";

import Link from "next/link";
import { Users } from "lucide-react";

/**
 * Patient switcher — CLINICAL. Links to the live, RLS-scoped directory. The
 * demo's inline fixture roster is gone; patient search happens against real
 * rows on /patients.
 */
export function PatientPicker() {
  return (
    <Link
      href="/patients"
      className="flex h-8 items-center gap-[6px] rounded-lg border border-line bg-card px-3 text-[12px] font-semibold text-body-2 hover:border-line-hover focus-visible:outline-2 focus-visible:outline-action"
    >
      <Users size={13} strokeWidth={1.75} aria-hidden />
      Directory
    </Link>
  );
}
