"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { ChevronDown, Search, Users, X } from "lucide-react";
import { listPatients } from "@/adapters/patients.mock";
import { USE_LIVE_API } from "@/adapters/mode";
import { parsePatientPath, patientPath } from "@/lib/routes";
import { cn } from "@/lib/cn";
import { InitialsAvatar } from "@/components/ui/bits";
import { TextInput } from "@/components/ui/Field";
import { Popover, PopoverDemoNote, PopoverHeader } from "@/components/ui/Popover";

/**
 * Collapsible in-chart patient picker: switch patients without leaving the
 * current tab. Demo roster only — live mode routes through the real
 * directory instead of listing patients client-side.
 */
export function PatientPicker({ currentId }: { currentId: string }) {
  const pathname = usePathname();
  const tab = parsePatientPath(pathname)?.tab ?? "overview";
  const [query, setQuery] = useState("");
  const roster = listPatients();
  const normalized = query.trim().toLowerCase();
  const visible = normalized
    ? roster.filter((patient) =>
        `${patient.name} ${patient.mrn}`.toLowerCase().includes(normalized),
      )
    : roster;

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
      panelRole="dialog"
      panelClassName="w-[330px]"
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
          <PopoverHeader title="Find a patient" note="Keeps your current tab" />
          <div className="border-b border-hairline p-3">
            <div className="relative" role="search">
              <Search size={14} className="absolute top-1/2 left-[10px] -translate-y-1/2 text-faint" aria-hidden />
              <TextInput
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search by patient name or ID…"
                aria-label="Search patients"
                className="pr-8 pl-[31px]"
              />
              {query && (
                <button
                  onClick={() => setQuery("")}
                  aria-label="Clear patient search"
                  className="absolute top-1/2 right-[6px] flex h-6 w-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-faint hover:bg-sunken hover:text-ink focus-visible:outline-2 focus-visible:outline-action"
                >
                  <X size={13} aria-hidden />
                </button>
              )}
            </div>
            <p className="mt-[6px] mb-0 text-[10.5px] text-faint" aria-live="polite">
              {normalized ? `${visible.length} patient${visible.length === 1 ? "" : "s"} found` : `${roster.length} patients`}
            </p>
          </div>
          <div className="max-h-[300px] overflow-y-auto">
            {visible.map((p) => (
              <Link
                key={p.id}
                href={patientPath(p.id, tab)}
                onClick={() => {
                  setQuery("");
                  close();
                }}
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
            {visible.length === 0 && (
              <div className="px-5 py-8 text-center">
                <Search size={20} className="mx-auto mb-2 text-faint" aria-hidden />
                <p className="m-0 text-[12.5px] font-semibold text-ink">No patients found</p>
                <p className="mt-1 mb-0 text-[11.5px] leading-[1.45] text-subtle">Check the spelling or search by patient ID.</p>
              </div>
            )}
          </div>
          <PopoverDemoNote>Searchable demo roster — live mode uses the organization’s patient directory.</PopoverDemoNote>
        </>
      )}
    </Popover>
  );
}
