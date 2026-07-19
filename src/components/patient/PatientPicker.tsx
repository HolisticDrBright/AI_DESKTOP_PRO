"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown, Users } from "lucide-react";
import { listPatients } from "@/adapters/patients.mock";
import { USE_LIVE_API } from "@/adapters/mode";
import { parsePatientPath, patientPath } from "@/lib/routes";
import { cn } from "@/lib/cn";
import { InitialsAvatar } from "@/components/ui/bits";
import { Popover, PopoverDemoNote, PopoverHeader } from "@/components/ui/Popover";

/**
 * Collapsible in-chart patient picker: switch patients without leaving the
 * current tab. Demo roster only — live mode routes through the real
 * directory instead of listing patients client-side.
 */
export function PatientPicker({ currentId }: { currentId: string }) {
  const pathname = usePathname();
  const tab = parsePatientPath(pathname)?.tab ?? "overview";

  if (USE_LIVE_API) {
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

  return (
    <Popover
      label="Switch patient"
      align="left"
      panelClassName="w-[280px]"
      trigger={({ open, toggle }) => (
        <button
          onClick={toggle}
          aria-haspopup="menu"
          aria-expanded={open}
          className="flex h-8 cursor-pointer items-center gap-[6px] rounded-lg border border-line bg-card px-3 text-[12px] font-semibold text-body-2 hover:border-line-hover focus-visible:outline-2 focus-visible:outline-action"
        >
          <Users size={13} strokeWidth={1.75} aria-hidden />
          Switch patient
          <ChevronDown size={12} strokeWidth={2} className="text-faint" aria-hidden />
        </button>
      )}
    >
      {({ close }) => (
        <>
          <PopoverHeader title="Patients" note="Keeps your current tab" />
          <div className="max-h-[300px] overflow-y-auto">
            {listPatients().map((p) => (
              <Link
                key={p.id}
                href={patientPath(p.id, tab)}
                onClick={close}
                aria-current={p.id === currentId ? "true" : undefined}
                className={cn(
                  "flex items-center gap-[9px] px-[13px] py-[8px] text-[12.5px] font-medium hover:bg-[rgba(37,99,199,0.06)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-action",
                  p.id === currentId ? "bg-nav-active text-action-deep" : "text-body-2",
                )}
              >
                <InitialsAvatar initials={p.initials} size={24} fontSize={9} gradient={p.avatarGradient} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{p.name}</span>
                  <span className="block text-[10.5px] font-normal text-faint">{p.mrn}</span>
                </span>
              </Link>
            ))}
          </div>
          <PopoverDemoNote>Demo roster — live mode uses the real directory.</PopoverDemoNote>
        </>
      )}
    </Popover>
  );
}
