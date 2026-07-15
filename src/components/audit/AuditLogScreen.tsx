"use client";

import { ShieldCheck, Trash2 } from "lucide-react";
import { ACTIONS } from "@/adapters/actions";
import { api } from "@/adapters";
import { useAuditEntries, type ReviewOutcome } from "@/adapters/session-store";
import { Card } from "@/components/ui/bits";
import type { Tone } from "@/adapters/types";
import { toneText, toneTint } from "@/lib/tones";

/**
 * Demo session audit log viewer. Reads the sessionStorage-backed store, so it
 * survives route reloads within a browser session and clears when the session
 * ends. This is demo data, not backend persistence — a deployment reads the
 * append-only `audit_events` table.
 */

const OUTCOME_TONE: Record<ReviewOutcome, Tone> = {
  approved: "positive",
  accepted: "positive",
  reviewed: "positive",
  resolved: "positive",
  rejected: "critical",
  flagged: "warning",
  snoozed: "slate",
};

function OutcomeBadge({ outcome, reviewed }: { outcome?: ReviewOutcome; reviewed: boolean }) {
  const label = outcome
    ? outcome[0].toUpperCase() + outcome.slice(1)
    : reviewed
      ? "Recorded"
      : "Pending review";
  const tone: Tone = outcome ? OUTCOME_TONE[outcome] : reviewed ? "slate" : "warning";
  return (
    <span
      className="w-fit rounded-full px-[9px] py-[2px] text-[10.5px] font-semibold"
      style={{ color: toneText[tone], background: toneTint[tone] }}
    >
      {label}
    </span>
  );
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

export function AuditLogScreen() {
  const entries = useAuditEntries();

  return (
    <section
      data-screen-label="Audit Log"
      className="relative mx-auto max-w-[1040px] px-6 pt-[24px] pb-8"
    >
      <div className="mb-1 flex items-center gap-2 text-[11.5px] font-semibold text-faint">
        <span>System</span>
        <span aria-hidden>/</span>
        <span className="rounded-full bg-slate-tint px-[9px] py-[2px] text-[10.5px] font-bold text-slate-badge">
          Demo session
        </span>
      </div>
      <div className="mb-4 flex items-end justify-between gap-3">
        <div>
          <h1 className="m-0 text-[22px] font-bold tracking-[-0.015em]">Audit log</h1>
          <p className="mt-[5px] mb-0 max-w-[640px] text-[13px] leading-[1.5] text-subtle">
            Demo session audit log — recorded in your browser session
            (sessionStorage) and <strong className="font-semibold">not persisted to backend</strong>.
            It survives page reloads this session and clears when the session ends. A
            deployment writes to the append-only audit table with actor, timestamp, and
            before/after state.
          </p>
        </div>
        <button
          onClick={() => api.actions.clearSessionAuditEvents()}
          disabled={entries.length === 0}
          className="flex h-8 shrink-0 cursor-pointer items-center gap-[6px] rounded-lg border border-line bg-card px-3 text-[12.5px] font-semibold text-body hover:border-line-hover focus-visible:outline-2 focus-visible:outline-action disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Trash2 size={13} strokeWidth={2} aria-hidden />
          Clear session log
        </button>
      </div>

      <Card className="overflow-hidden">
        <div className="grid grid-cols-[128px_150px_minmax(0,1fr)_140px_72px] items-center gap-3 border-b border-hairline bg-[rgba(247,250,252,0.6)] px-4 py-[10px] text-[11px] font-bold tracking-[0.03em] text-faint uppercase">
          <span>Action</span>
          <span>Subject type</span>
          <span>Subject</span>
          <span>Outcome</span>
          <span>When</span>
        </div>

        {entries.length === 0 ? (
          <div className="flex flex-col items-center gap-[10px] px-6 py-[64px] text-center">
            <span className="flex h-11 w-11 items-center justify-center rounded-[13px] bg-slate-tint">
              <ShieldCheck size={20} strokeWidth={1.75} className="text-slate-badge" aria-hidden />
            </span>
            <h2 className="m-0 text-[15px] font-bold">No actions recorded this session</h2>
            <p className="m-0 max-w-[420px] text-[12.5px] leading-[1.5] text-subtle">
              Approve, reject, resolve, or act on a hypothesis, lab, snapshot, or queue item
              and it will appear here with its review outcome — and stay after a reload.
            </p>
          </div>
        ) : (
          <ul className="m-0 list-none p-0">
            {entries.map((e) => {
              const label = ACTIONS[e.kind]?.label ?? e.kind;
              return (
                <li
                  key={e.id}
                  className="grid grid-cols-[128px_150px_minmax(0,1fr)_140px_72px] items-center gap-3 border-b border-[#F3F7FA] px-4 py-[11px]"
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
                  <OutcomeBadge outcome={e.outcome} reviewed={e.reviewed} />
                  <span className="text-[11px] text-faint">{timeAgo(e.at)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </section>
  );
}
