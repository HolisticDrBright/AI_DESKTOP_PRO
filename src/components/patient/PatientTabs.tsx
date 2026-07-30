"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import { parsePatientPath, patientPath, PATIENT_TABS } from "@/lib/routes";

export function PatientTabs({ patientId }: { patientId: string }) {
  const pathname = usePathname();
  const activeTab = parsePatientPath(pathname)?.tab ?? "overview";

  return (
    <div
      role="tablist"
      aria-label="Patient sections"
      className="mb-4 flex gap-[2px] overflow-x-auto border-b border-line pt-[6px]"
    >
      {PATIENT_TABS.map((tab) => {
        const selected = tab.id === activeTab;
        return (
          <Link
            key={tab.id}
            href={patientPath(patientId, tab.id)}
            role="tab"
            aria-selected={selected}
            className={cn(
              "-mb-px border-b-2 px-3 pt-[9px] pb-[10px] text-[13px] whitespace-nowrap focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-action",
              selected
                ? "border-action font-[650] text-action-deep"
                : "border-transparent font-medium text-muted hover:text-ink",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
