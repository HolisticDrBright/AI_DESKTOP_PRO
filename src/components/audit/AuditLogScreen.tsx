"use client";

import { useEffect, useRef, useState } from "react";
import { ShieldCheck, X } from "lucide-react";
import { api } from "@/adapters";
import { isAdapterError } from "@/adapters/errors";
import type { LiveAuditEvent } from "@/adapters/live-types";
import { ClinicalEmpty, ClinicalError, ClinicalLoading } from "@/components/ui/ClinicalStates";
import { Card } from "@/components/ui/bits";



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
 * Clinical audit viewer: reads the append-only audit_events table for the
 * caller's org through the Desktop-owned `list_audit_events` database
 * function. The demo sessionStorage log is gone with the demo edition.
 */
export function AuditLogScreen() {
  return <LiveAuditLog />;
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
          Append-only audit events for your organization, read through a
          caller-authorized database function. Practitioners see the events they
          performed; org admins see all. Rows are stamped by the database and cannot
          be edited or deleted.
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
        Append-only audit_events row, exposed through a caller-authorized database function.
        Registered generic events reject raw lab values and note text.
      </div>
    </aside>
  );
}

