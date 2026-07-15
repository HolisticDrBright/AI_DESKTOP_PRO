"use client";

import { useState } from "react";
import { RotateCw, ShieldCheck } from "lucide-react";
import { ACTIONS, getMockAuditLog, type MockAuditEntry } from "@/adapters/actions";
import { Card } from "@/components/ui/bits";

/**
 * Session audit log viewer. Reads the in-memory mock audit trail that the
 * review-to-action layer writes to. It is intentionally session-scoped and not
 * persisted — a real deployment would read the append-only `audit_events`
 * table. No PHI beyond the subject label the practitioner is already viewing.
 */
export function AuditLogScreen() {
  const [entries, setEntries] = useState<readonly MockAuditEntry[]>(() =>
    [...getMockAuditLog()].reverse(),
  );

  const refresh = () => setEntries([...getMockAuditLog()].reverse());

  return (
    <section
      data-screen-label="Audit Log"
      className="relative mx-auto max-w-[1040px] px-6 pt-[24px] pb-8"
    >
      <div className="mb-1 flex items-center gap-2 text-[11.5px] font-semibold text-faint">
        <span>System</span>
        <span aria-hidden>/</span>
        <span className="rounded-full bg-slate-tint px-[9px] py-[2px] text-[10.5px] font-bold text-slate-badge">
          Session scope
        </span>
      </div>
      <div className="mb-4 flex items-end justify-between gap-3">
        <div>
          <h1 className="m-0 text-[22px] font-bold tracking-[-0.015em]">Audit log</h1>
          <p className="mt-[5px] mb-0 max-w-[620px] text-[13px] leading-[1.5] text-subtle">
            Review actions taken this session. Recorded in memory for demonstration; a
            deployment writes to the append-only audit table with actor, timestamp, and
            before/after state.
          </p>
        </div>
        <button
          onClick={refresh}
          className="flex h-8 shrink-0 cursor-pointer items-center gap-[6px] rounded-lg border border-line bg-card px-3 text-[12.5px] font-semibold text-body hover:border-line-hover focus-visible:outline-2 focus-visible:outline-action"
        >
          <RotateCw size={13} strokeWidth={2} aria-hidden />
          Refresh
        </button>
      </div>

      <Card className="overflow-hidden">
        <div className="grid grid-cols-[128px_150px_minmax(0,1fr)_130px] items-center gap-3 border-b border-hairline bg-[rgba(247,250,252,0.6)] px-4 py-[10px] text-[11px] font-bold tracking-[0.03em] text-faint uppercase">
          <span>Action</span>
          <span>Subject type</span>
          <span>Subject</span>
          <span>Review state</span>
        </div>

        {entries.length === 0 ? (
          <div className="flex flex-col items-center gap-[10px] px-6 py-[64px] text-center">
            <span className="flex h-11 w-11 items-center justify-center rounded-[13px] bg-slate-tint">
              <ShieldCheck size={20} strokeWidth={1.75} className="text-slate-badge" aria-hidden />
            </span>
            <h2 className="m-0 text-[15px] font-bold">No actions recorded yet</h2>
            <p className="m-0 max-w-[420px] text-[12.5px] leading-[1.5] text-subtle">
              Approve, reject, or act on a hypothesis, lab, or snapshot and it will appear
              here with its review state.
            </p>
          </div>
        ) : (
          <ul className="m-0 list-none p-0">
            {entries.map((e, i) => {
              const label = ACTIONS[e.kind]?.label ?? e.kind;
              return (
                <li
                  key={`${e.at}-${i}`}
                  className="grid grid-cols-[128px_150px_minmax(0,1fr)_130px] items-center gap-3 border-b border-[#F3F7FA] px-4 py-[11px]"
                >
                  <span className="text-[12.5px] font-semibold text-ink">{label}</span>
                  <span className="text-[12px] text-muted capitalize">{e.subjectType}</span>
                  <span className="min-w-0">
                    <span className="block truncate text-[12.5px] text-body">
                      {e.subjectLabel}
                    </span>
                    {e.patientName && (
                      <span className="block text-[11px] text-faint">{e.patientName}</span>
                    )}
                  </span>
                  <span
                    className={
                      e.reviewed
                        ? "w-fit rounded-full bg-positive-tint px-[9px] py-[2px] text-[10.5px] font-semibold text-positive"
                        : "w-fit rounded-full bg-warning-tint px-[9px] py-[2px] text-[10.5px] font-semibold text-warning-deep"
                    }
                  >
                    {e.reviewed ? "Reviewed" : "Pending review"}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </section>
  );
}
