"use client";

import Link from "next/link";
import { CalendarPlus, MoreHorizontal } from "lucide-react";
import { useComposerOptional } from "@/lib/composer";
import { Popover, PopoverDemoNote, PopoverHeader } from "@/components/ui/Popover";

const menuItem =
  "flex w-full items-center px-[13px] py-[9px] text-left text-[12.5px] font-medium text-body-2 hover:bg-[rgba(37,99,199,0.06)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-action";

export function PatientHeaderActions({
  patientName,
}: {
  patientName: string;
}) {
  const composer = useComposerOptional();

  return (
    <div className="flex items-center gap-2">
      <Link
        href="/calendar"
        className="flex h-9 items-center gap-[6px] rounded-[9px] border-none bg-action px-4 text-[12.5px] font-semibold text-white hover:bg-action-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
      >
        <CalendarPlus size={14} strokeWidth={2} aria-hidden />
        New Appointment
      </Link>

      <Popover
        label="More patient actions"
        trigger={({ open, toggle }) => (
          <button
            onClick={toggle}
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={open}
            className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-[9px] border border-line bg-card text-muted hover:border-line-hover focus-visible:outline-2 focus-visible:outline-action"
          >
            <MoreHorizontal size={16} strokeWidth={2} aria-hidden />
          </button>
        )}
      >
        {({ close }) => (
          <>
            <PopoverHeader title="Patient actions" />
            <button
              className={menuItem}
              onClick={() => {
                close();
                composer?.openComposer("patient-message", {
                  patientName,
                  subjectType: "patient",
                  subjectLabel: patientName,
                });
              }}
            >
              Message patient
            </button>
            <button
              className={menuItem}
              onClick={() => {
                close();
                composer?.openComposer("reasoning-summary", {
                  patientName,
                  subjectType: "patient",
                  subjectLabel: patientName,
                });
              }}
            >
              Draft summary for report
            </button>
            <Link href="/audit-log" onClick={close} className={menuItem}>
              View audit history
            </Link>
            <PopoverDemoNote>
              Patient-facing drafts open the composer and require your review — nothing is sent.
            </PopoverDemoNote>
          </>
        )}
      </Popover>
    </div>
  );
}
