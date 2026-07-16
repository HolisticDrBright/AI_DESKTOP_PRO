"use client";

import { useEffect, useRef, useState } from "react";
import { ShieldCheck, Trash2, X } from "lucide-react";
import { ACTIONS } from "@/adapters/actions";
import { api } from "@/adapters";
import { USE_LIVE_API } from "@/adapters/mode";
import { isAdapterError } from "@/adapters/errors";
import type { LiveAuditEvent } from "@/adapters/live-types";
import {
  useAuditEntries,
  type ReviewOutcome,
  type SessionAuditEntry,
} from "@/adapters/session-store";
import { ClinicalEmpty, ClinicalError, ClinicalLoading } from "@/components/ui/ClinicalStates";
import { Card } from "@/components/ui/bits";
import type { Tone } from "@/adapters/types";
import { toneText, toneTint } from "@/lib/tones";

/**
 * Detail fields the BACKEND audit table will carry. Typed now, empty in the
 * demo, so the drawer's shape survives the tRPC swap unchanged.
 */
interface AuditBackendFields {
  actorId: string | null;
  requestId: string | null;
  organizationId: string | null;
  beforeState: string | null;
  afterState: string | null;
  ipAddress: string | null;
}
const EMPTY_BACKEND_FIELDS: AuditBackendFields = {
  actorId: null,
  requestId: null,
  organizationId: null,
  beforeState: null,
  afterState: null,
  ipAddress: null,
};

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

/**
 * Canonical dual-mode audit viewer. In demo mode it reads the sessionStorage
 * log; in live mode it reads the append-only audit_events table for the
 * caller's org through the façade (`list_audit_events` RPC via the tRPC layer).
 */
export function AuditLogScreen() {
  return USE_LIVE_API ? <LiveAuditLog /> : <DemoAuditLog />;
}

function DemoAuditLog() {
  const entries = useAuditEntries();
  const [detail, setDetail] = useState<SessionAuditEntry | null>(null);

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
                <li key={e.id}>
                  <button
                    onClick={() => setDetail(e)}
                    aria-label={`Open details for ${label} on ${e.subjectLabel}`}
                    className="grid w-full cursor-pointer grid-cols-[128px_150px_minmax(0,1fr)_140px_72px] items-center gap-3 border-b border-[#F3F7FA] px-4 py-[11px] text-left hover:bg-sunken focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-action"
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
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {detail && <AuditDetailDrawer entry={detail} onClose={() => setDetail(null)} />}
    </section>
  );
}

function LiveAuditLog() {
  const [events, setEvents] = useState<LiveAuditEvent[] | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [detail, setDetail] = useState<LiveAuditEvent | null>(null);

  useEffect(() => {
    let alive = true;
    setState("loading");
    api.actions
      .listLiveAuditEvents(100)
      .then((rows) => {
        if (!alive) return;
        setEvents(rows);
        setState("ready");
      })
      .catch((e) => {
        if (!alive) return;
        setErrorMsg(isAdapterError(e) ? e.safeMessage : "Unable to load the audit log.");
        setState("error");
      });
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  return (
    <section
      data-screen-label="Audit Log"
      className="relative mx-auto max-w-[1040px] px-6 pt-[24px] pb-8"
    >
      <div className="mb-1 flex items-center gap-2 text-[11.5px] font-semibold text-faint">
        <span>System</span>
        <span aria-hidden>/</span>
        <span className="rounded-full bg-positive-tint px-[9px] py-[2px] text-[10.5px] font-bold text-positive">
          Live · append-only
        </span>
      </div>
      <div className="mb-4">
        <h1 className="m-0 text-[22px] font-bold tracking-[-0.015em]">Audit log</h1>
        <p className="mt-[5px] mb-0 max-w-[660px] text-[13px] leading-[1.5] text-subtle">
          Append-only audit events for your organization, read from the backend under RLS.
          Practitioners see the events they performed; org admins see all. Rows are stamped
          server-side and cannot be edited or deleted.
        </p>
      </div>

      {state === "loading" && <ClinicalLoading label="Loading audit events…" />}
      {state === "error" && (
        <ClinicalError message={errorMsg} onRetry={() => setReloadKey((k) => k + 1)} />
      )}
      {state === "ready" && (events?.length ?? 0) === 0 && (
        <ClinicalEmpty
          icon={<ShieldCheck size={20} strokeWidth={1.75} className="text-slate-badge" aria-hidden />}
          title="No audit events yet"
          message="Reviewing a lab marker or creating a follow-up task records an append-only event here."
        />
      )}
      {state === "ready" && (events?.length ?? 0) > 0 && (
        <Card className="overflow-hidden">
          <div className="grid grid-cols-[160px_minmax(0,1fr)_150px_72px] items-center gap-3 border-b border-hairline bg-[rgba(247,250,252,0.6)] px-4 py-[10px] text-[11px] font-bold tracking-[0.03em] text-faint uppercase">
            <span>Action</span>
            <span>Summary</span>
            <span>Resource</span>
            <span>When</span>
          </div>
          <ul className="m-0 list-none p-0">
            {events!.map((e) => (
              <li key={e.id}>
                <button
                  onClick={() => setDetail(e)}
                  aria-label={`Open details for ${e.action}`}
                  className="grid w-full cursor-pointer grid-cols-[160px_minmax(0,1fr)_150px_72px] items-center gap-3 border-b border-[#F3F7FA] px-4 py-[11px] text-left hover:bg-sunken focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-action"
                >
                  <span className="truncate text-[12.5px] font-semibold text-ink">{e.action}</span>
                  <span className="min-w-0 truncate text-[12.5px] text-body">{e.safeMessage ?? "—"}</span>
                  <span className="min-w-0 truncate text-[12px] text-muted">{e.resourceType ?? "—"}</span>
                  <span className="text-[11px] text-faint">{timeAgo(e.occurredAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {detail && <LiveAuditDrawer event={detail} onClose={() => setDetail(null)} />}
    </section>
  );
}

function LiveAuditDrawer({ event, onClose }: { event: LiveAuditEvent; onClose: () => void }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const Row = ({ label, value }: { label: string; value: React.ReactNode }) => (
    <div className="flex items-start justify-between gap-3 border-t border-hairline-2 px-4 py-[8px] first:border-t-0">
      <span className="shrink-0 text-[11px] text-faint">{label}</span>
      <span className="min-w-0 text-right text-[12px] font-semibold break-words text-ink">{value}</span>
    </div>
  );

  return (
    <aside
      role="dialog"
      aria-label="Audit event details"
      className="glass-overlay animate-fade-up fixed top-3 right-3 bottom-3 z-[95] flex w-[380px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-[20px] border border-[rgba(255,255,255,0.7)] bg-[rgba(255,255,255,0.96)] shadow-[0_20px_56px_rgba(24,42,61,0.2)] outline-1 outline-[rgba(203,214,224,0.6)]"
    >
      <div className="flex items-start gap-[9px] border-b border-hairline px-4 pt-[14px] pb-3">
        <div className="min-w-0 flex-1">
          <h2 ref={headingRef} tabIndex={-1} className="m-0 text-[14px] font-bold outline-none">
            Audit event
          </h2>
          <div className="text-[11px] text-subtle">{event.action}</div>
        </div>
        <button
          onClick={onClose}
          aria-label="Close details"
          className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-faint hover:bg-[rgba(90,107,126,0.1)] hover:text-ink focus-visible:outline-2 focus-visible:outline-action"
        >
          <X size={14} strokeWidth={2} aria-hidden />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-[6px]">
        <Row label="Action" value={event.action} />
        <Row label="Summary" value={event.safeMessage ?? "—"} />
        <Row label="Resource type" value={event.resourceType ?? "—"} />
        <Row label="Resource ID" value={<span className="font-mono text-[10.5px]">{event.resourceId ?? "—"}</span>} />
        <Row label="Actor" value={<span className="font-mono text-[10.5px]">{event.actorUserId ?? "—"}</span>} />
        <Row label="Patient" value={<span className="font-mono text-[10.5px]">{event.patientId ?? "—"}</span>} />
        <Row label="Occurred" value={new Date(event.occurredAt).toLocaleString()} />
        <Row
          label="Metadata"
          value={<span className="font-mono text-[10px] break-all">{JSON.stringify(event.metadata)}</span>}
        />
      </div>

      <div className="shrink-0 border-t border-hairline bg-[rgba(247,250,252,0.7)] px-4 py-[9px] text-[10.5px] leading-[1.45] text-faint">
        Append-only audit_events row, RLS-enforced. Metadata is PHI-safe by construction (no raw
        lab values or note text).
      </div>
    </aside>
  );
}

function AuditDetailDrawer({
  entry,
  onClose,
}: {
  entry: SessionAuditEntry;
  onClose: () => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const backend = EMPTY_BACKEND_FIELDS;

  useEffect(() => {
    headingRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const Row = ({ label, value }: { label: string; value: React.ReactNode }) => (
    <div className="flex items-start justify-between gap-3 border-t border-hairline-2 px-4 py-[8px] first:border-t-0">
      <span className="shrink-0 text-[11px] text-faint">{label}</span>
      <span className="min-w-0 text-right text-[12px] font-semibold break-words text-ink">{value}</span>
    </div>
  );

  return (
    <aside
      role="dialog"
      aria-label="Audit event details"
      className="glass-overlay animate-fade-up fixed top-3 right-3 bottom-3 z-[95] flex w-[380px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-[20px] border border-[rgba(255,255,255,0.7)] bg-[rgba(255,255,255,0.96)] shadow-[0_20px_56px_rgba(24,42,61,0.2)] outline-1 outline-[rgba(203,214,224,0.6)]"
    >
      <div className="flex items-start gap-[9px] border-b border-hairline px-4 pt-[14px] pb-3">
        <div className="min-w-0 flex-1">
          <h2 ref={headingRef} tabIndex={-1} className="m-0 text-[14px] font-bold outline-none">
            Audit event
          </h2>
          <div className="text-[11px] text-subtle">{ACTIONS[entry.kind]?.label ?? entry.kind}</div>
        </div>
        <button
          onClick={onClose}
          aria-label="Close details"
          className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-faint hover:bg-[rgba(90,107,126,0.1)] hover:text-ink focus-visible:outline-2 focus-visible:outline-action"
        >
          <X size={14} strokeWidth={2} aria-hidden />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-[6px]">
        <Row label="Actor" value="Dr. Sarah Mitchell (demo identity)" />
        <Row label="Timestamp" value={new Date(entry.at).toLocaleString()} />
        <Row label="Action" value={ACTIONS[entry.kind]?.label ?? entry.kind} />
        <Row label="Subject type" value={<span className="capitalize">{entry.subjectType}</span>} />
        <Row label="Subject" value={entry.subjectLabel} />
        <Row label="Patient" value={entry.patientName ?? "—"} />
        <Row label="Review state" value={<OutcomeBadge outcome={entry.outcome} reviewed={entry.reviewed} />} />
        <Row label="Source" value="Demo session store (sessionStorage)" />

        <div className="mt-[8px] border-t border-hairline px-4 pt-[10px] pb-[4px]">
          <h3 className="m-0 mb-[4px] text-[10.5px] font-bold tracking-[0.04em] text-faint uppercase">
            Backend fields (live mode only)
          </h3>
          <p className="mt-0 mb-[6px] text-[10.5px] leading-[1.45] text-subtle">
            Demo events never carry these. In live mode (NEXT_PUBLIC_USE_LIVE_API) the audit
            log reads the append-only audit_events table, where they are stamped server-side.
          </p>
        </div>
        <Row label="Actor ID" value={backend.actorId ?? "—"} />
        <Row label="Request ID" value={backend.requestId ?? "—"} />
        <Row label="Organization" value={backend.organizationId ?? "—"} />
        <Row label="Before state" value={backend.beforeState ?? "—"} />
        <Row label="After state" value={backend.afterState ?? "—"} />
      </div>

      <div className="shrink-0 border-t border-hairline bg-[rgba(247,250,252,0.7)] px-4 py-[9px] text-[10.5px] leading-[1.45] text-faint">
        Demo boundary: this event exists only in your browser session and is not persisted
        to any backend.
      </div>
    </aside>
  );
}
