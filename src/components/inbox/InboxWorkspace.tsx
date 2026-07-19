"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  CalendarClock,
  CheckCheck,
  ClipboardPlus,
  Flag,
  Lock,
  Paperclip,
  Search,
  Send,
  StickyNote,
  UserRound,
} from "lucide-react";
import {
  assignThread,
  CHANNEL_META,
  createTaskFromThread,
  markThreadRead,
  sendReply,
  setThreadPriority,
  setThreadStatus,
  useInboxThreads,
  type InboxChannel,
  type InboxThread,
} from "@/adapters/inbox.mock";
import { getProfileExtras } from "@/adapters/patient-profile.mock";
import { patientLedger } from "@/adapters/billing.mock";
import { useFeedback } from "@/lib/feedback";
import { formatMinor } from "@/lib/money";
import { patientPath } from "@/lib/routes";
import { cn } from "@/lib/cn";
import { Card } from "@/components/ui/bits";
import { Btn, BtnLink } from "@/components/ui/Btn";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { TextArea, TextInput } from "@/components/ui/Field";
import { Pill, Tag } from "@/components/ui/Pill";
import { DemoNote } from "@/components/ui/DemoNote";

type ListFilter = "open" | "unread" | "priority" | "assigned" | "schedule-request" | "closed";

const FILTERS: { id: ListFilter; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "unread", label: "Unread" },
  { id: "priority", label: "Priority" },
  { id: "assigned", label: "Assigned" },
  { id: "schedule-request", label: "Schedule requests" },
  { id: "closed", label: "Closed" },
];

function applyFilter(threads: InboxThread[], filter: ListFilter, q: string): InboxThread[] {
  let rows = threads;
  if (filter === "open") rows = rows.filter((t) => t.status === "open");
  if (filter === "unread") rows = rows.filter((t) => t.unread && t.status === "open");
  if (filter === "priority") rows = rows.filter((t) => t.priority != null && t.status === "open");
  if (filter === "assigned") rows = rows.filter((t) => t.assignedTo != null && t.status === "open");
  if (filter === "schedule-request") rows = rows.filter((t) => t.kind === "schedule-request");
  if (filter === "closed") rows = rows.filter((t) => t.status === "closed");
  if (q) {
    const needle = q.toLowerCase();
    rows = rows.filter((t) =>
      `${t.subject} ${t.patientName} ${t.messages.map((m) => m.body).join(" ")}`
        .toLowerCase()
        .includes(needle),
    );
  }
  return rows;
}

/**
 * Inbox — three panes: filters + thread list · conversation · patient
 * context. Portal is the only configured channel; SMS/email are labeled
 * future channels and cannot send. Replies are review-gated and every send
 * is a labeled demo send.
 */
export function InboxWorkspace({
  initialThread,
  initialFilter,
}: {
  initialThread?: string;
  initialFilter?: string;
}) {
  const { announce } = useFeedback();
  const threads = useInboxThreads();
  const [filter, setFilter] = useState<ListFilter>(
    FILTERS.some((f) => f.id === initialFilter) ? (initialFilter as ListFilter) : "open",
  );
  const [channel, setChannel] = useState<InboxChannel>("portal");
  const [q, setQ] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(initialThread ?? null);
  const [draft, setDraft] = useState("");
  const [internal, setInternal] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [confirmSend, setConfirmSend] = useState(false);

  const visible = useMemo(
    () => (channel === "portal" ? applyFilter(threads, filter, q) : []),
    [threads, filter, q, channel],
  );
  const selected = threads.find((t) => t.id === selectedId) ?? null;

  useEffect(() => {
    if (selected && selected.unread) markThreadRead(selected.id);
  }, [selected]);

  const extras = selected?.patientId ? getProfileExtras(selected.patientId) : null;
  const ledger = selected?.patientId ? patientLedger(selected.patientId) : null;

  const doSend = () => {
    if (!selected) return;
    const r = sendReply(selected.id, draft.trim(), { internal });
    announce(r.message);
    setDraft("");
    setReviewed(false);
    setInternal(false);
  };

  return (
    <section data-screen-label="Inbox" className="flex h-full min-h-0 flex-col px-[22px] pt-[14px] pb-4">
      <div className="mb-3 flex items-center gap-3">
        <div>
          <div className="text-[11.5px] font-semibold text-faint">Workspace / Inbox</div>
          <h1 className="m-0 text-[19px] font-bold tracking-[-0.015em]">Inbox</h1>
        </div>
        <div className="ml-auto flex items-center gap-1" role="tablist" aria-label="Channels">
          {(Object.keys(CHANNEL_META) as InboxChannel[]).map((c) => {
            const meta = CHANNEL_META[c];
            const active = channel === c;
            return (
              <button
                key={c}
                role="tab"
                aria-selected={active}
                onClick={() => setChannel(c)}
                className={cn(
                  "flex h-8 cursor-pointer items-center gap-[6px] rounded-lg border px-3 text-[12px] font-semibold focus-visible:outline-2 focus-visible:outline-action",
                  active
                    ? "border-nav-active-line bg-nav-active text-action-deep"
                    : "border-line bg-card text-muted hover:border-line-hover",
                )}
              >
                {meta.label}
                {!meta.configured && <Tag>future</Tag>}
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[280px_minmax(0,1fr)_300px] gap-3">
        {/* Pane 1 — filters + thread list */}
        <Card className="flex min-h-0 flex-col overflow-hidden">
          <div className="border-b border-hairline p-2">
            <div className="relative mb-2">
              <Search size={13} className="absolute top-1/2 left-[9px] -translate-y-1/2 text-faint" aria-hidden />
              <TextInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search threads…" aria-label="Search threads" className="pl-[28px]" />
            </div>
            <div className="flex flex-wrap gap-1">
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  onClick={() => setFilter(f.id)}
                  aria-pressed={filter === f.id}
                  className={cn(
                    "h-6 cursor-pointer rounded-full border px-[8px] text-[10.5px] font-semibold focus-visible:outline-2 focus-visible:outline-action",
                    filter === f.id
                      ? "border-nav-active-line bg-nav-active text-action-deep"
                      : "border-line bg-card text-muted hover:border-line-hover",
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {channel !== "portal" ? (
              <p className="m-0 px-3 py-6 text-center text-[12px] leading-[1.5] text-faint">
                {CHANNEL_META[channel].note}
              </p>
            ) : visible.length === 0 ? (
              <p className="m-0 px-3 py-6 text-center text-[12px] text-faint">No threads match.</p>
            ) : (
              visible.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setSelectedId(t.id)}
                  aria-current={t.id === selectedId ? "true" : undefined}
                  className={cn(
                    "block w-full cursor-pointer border-b border-hairline px-3 py-[9px] text-left hover:bg-sunken focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-action",
                    t.id === selectedId && "bg-nav-active",
                  )}
                >
                  <span className="flex items-center gap-[6px]">
                    <span className={cn("truncate text-[12.5px]", t.unread ? "font-bold text-ink" : "font-medium text-body")}>
                      {t.patientName}
                    </span>
                    {t.unread && <span aria-label="Unread" className="h-[7px] w-[7px] shrink-0 rounded-full bg-action" />}
                    <span className="ml-auto shrink-0 text-[10.5px] text-faint">{t.atLabel}</span>
                  </span>
                  <span className="mt-[1px] block truncate text-[12px] text-body">{t.subject}</span>
                  <span className="mt-[2px] flex items-center gap-1">
                    {t.kind !== "message" && <Tag>{t.kind}</Tag>}
                    {t.priority && <Pill tone={t.priority === "High" ? "critical" : "slate"}>{t.priority}</Pill>}
                    {t.assignedTo && <Tag>@{t.assignedTo}</Tag>}
                  </span>
                </button>
              ))
            )}
          </div>
        </Card>

        {/* Pane 2 — conversation */}
        <Card className="flex min-h-0 flex-col overflow-hidden">
          {!selected ? (
            <div className="flex flex-1 items-center justify-center">
              <p className="m-0 max-w-[300px] text-center text-[12.5px] leading-[1.5] text-faint">
                Select a thread. Replies are review-gated; nothing sends outside this demo session.
              </p>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 border-b border-hairline px-4 py-[10px]">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] font-bold text-ink">{selected.subject}</div>
                  <div className="text-[11.5px] text-subtle">
                    {selected.patientName} · {CHANNEL_META[selected.channel].label} · {selected.status}
                    {selected.appointmentRef && (
                      <>
                        {" · "}
                        <Link href={selected.appointmentRef.href} className="font-semibold text-action">
                          {selected.appointmentRef.label}
                        </Link>
                      </>
                    )}
                  </div>
                </div>
                <Btn
                  size="sm"
                  onClick={() => {
                    setThreadPriority(selected.id, selected.priority ? null : "High");
                    announce(selected.priority ? "Priority cleared. (demo)" : "Marked priority High. (demo)");
                  }}
                  aria-pressed={selected.priority != null}
                >
                  <Flag size={12} aria-hidden /> {selected.priority ? "Clear priority" : "Priority"}
                </Btn>
                <Btn
                  size="sm"
                  onClick={() => {
                    assignThread(selected.id, selected.assignedTo ? undefined : "Front desk");
                    announce(selected.assignedTo ? "Unassigned. (demo)" : "Assigned to Front desk. (demo)");
                  }}
                >
                  <UserRound size={12} aria-hidden /> {selected.assignedTo ? "Unassign" : "Assign"}
                </Btn>
                <Btn
                  size="sm"
                  onClick={() => {
                    const r = createTaskFromThread(selected);
                    announce(r.message);
                  }}
                >
                  <ClipboardPlus size={12} aria-hidden /> Task
                </Btn>
                <Btn
                  size="sm"
                  onClick={() => {
                    setThreadStatus(selected.id, selected.status === "open" ? "closed" : "open");
                    announce(selected.status === "open" ? "Thread closed. (demo)" : "Thread reopened. (demo)");
                  }}
                >
                  <CheckCheck size={12} aria-hidden /> {selected.status === "open" ? "Close" : "Reopen"}
                </Btn>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                {selected.messages.map((m) => (
                  <div
                    key={m.id}
                    className={cn(
                      "mb-3 max-w-[85%] rounded-xl border px-3 py-[8px]",
                      m.internal
                        ? "ml-auto border-[rgba(199,126,20,0.35)] bg-warning-tint"
                        : m.author === "practitioner"
                          ? "ml-auto border-nav-active-line bg-nav-active"
                          : m.author === "system"
                            ? "border-hairline bg-sunken"
                            : "border-line bg-card",
                    )}
                  >
                    <div className="mb-[2px] flex items-center gap-2 text-[10.5px] font-semibold text-subtle">
                      {m.internal && <StickyNote size={11} className="text-warning-deep" aria-hidden />}
                      {m.authorName}
                      <span className="font-normal text-faint">{m.atLabel}</span>
                      {m.internal && <Pill tone="warning">Internal — never visible to patient</Pill>}
                      {m.demoSend && <Pill tone="slate">Demo send — not delivered</Pill>}
                    </div>
                    <p className="m-0 text-[12.5px] leading-[1.5] whitespace-pre-wrap text-body">{m.body}</p>
                    {m.attachments?.map((a) => (
                      <span key={a.id} className="mt-1 inline-flex items-center gap-1 rounded-md border border-line bg-card px-2 py-[3px] text-[11px] font-medium text-body">
                        <Paperclip size={11} aria-hidden /> {a.name} · {a.size}
                      </span>
                    ))}
                  </div>
                ))}
              </div>

              <div className="border-t border-hairline px-4 py-3">
                <TextArea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder={internal ? "Internal note (never visible to the patient)…" : "Reply to the patient (review required before send)…"}
                  aria-label={internal ? "Internal note" : "Reply"}
                  rows={2}
                />
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <label className="flex cursor-pointer items-center gap-[6px] text-[11.5px] font-medium text-body-2">
                    <input type="checkbox" checked={internal} onChange={(e) => { setInternal(e.target.checked); setReviewed(false); }} />
                    Internal note
                  </label>
                  {!internal && (
                    <label className="flex cursor-pointer items-center gap-[6px] text-[11.5px] font-medium text-body-2">
                      <input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} />
                      I reviewed this patient-facing content
                    </label>
                  )}
                  <span className="ml-auto text-[10.5px] text-faint">
                    <Lock size={10} className="inline" aria-hidden /> Secure portal · demo send only
                  </span>
                  <Btn
                    variant="primary"
                    size="sm"
                    disabled={!draft.trim() || (!internal && !reviewed)}
                    onClick={() => (internal ? doSend() : setConfirmSend(true))}
                  >
                    <Send size={12} aria-hidden /> {internal ? "Add note" : "Send reply"}
                  </Btn>
                </div>
              </div>
            </>
          )}
        </Card>

        {/* Pane 3 — patient / context inspector */}
        <Card className="flex min-h-0 flex-col overflow-y-auto">
          {!selected ? (
            <p className="m-0 px-4 py-6 text-center text-[12px] text-faint">Thread context appears here.</p>
          ) : (
            <div className="flex flex-col gap-3 p-4">
              <div>
                <div className="text-[13px] font-bold text-ink">{selected.patientName}</div>
                {selected.patientId ? (
                  <div className="mt-1 flex flex-wrap gap-1">
                    <BtnLink size="sm" href={patientPath(selected.patientId)}>Open patient</BtnLink>
                    <BtnLink size="sm" href={patientPath(selected.patientId, "messages")}>All messages</BtnLink>
                  </div>
                ) : (
                  <p className="m-0 text-[11.5px] text-subtle">Not linked to a chart.</p>
                )}
              </div>
              {extras && (
                <div className="rounded-lg border border-hairline bg-sunken px-3 py-[8px] text-[11.5px] leading-[1.6] text-body">
                  <span className="block"><span className="font-semibold text-subtle">Next:</span> {extras.booking.nextAppointmentLabel}</span>
                  <span className="block"><span className="font-semibold text-subtle">Last visit:</span> {extras.booking.lastVisitLabel} ({extras.booking.sinceLastVisit} ago)</span>
                  <span className="block"><span className="font-semibold text-subtle">Prefers:</span> {extras.contact.preferred}</span>
                  {ledger && (
                    <span className="block">
                      <span className="font-semibold text-subtle">Balance:</span>{" "}
                      {ledger.balanceMinor > 0 ? <span className="font-semibold text-warning-deep">{formatMinor(ledger.balanceMinor)}</span> : "Settled"}
                    </span>
                  )}
                </div>
              )}
              {extras && extras.medicalAlerts.length > 0 && (
                <div>
                  <p className="m-0 mb-1 text-[11px] font-bold tracking-[0.05em] text-faint uppercase">Medical alerts</p>
                  <div className="flex flex-wrap gap-1">
                    {extras.medicalAlerts.map((a) => <Pill key={a.label} tone={a.tone}>{a.label}</Pill>)}
                  </div>
                </div>
              )}
              {selected.kind === "schedule-request" && (
                <div className="rounded-lg border border-nav-active-line bg-nav-active px-3 py-[8px]">
                  <p className="m-0 mb-1 flex items-center gap-1 text-[11.5px] font-bold text-action-deep">
                    <CalendarClock size={12} aria-hidden /> Schedule request
                  </p>
                  <BtnLink size="sm" href="/calendar" variant="primary">Open calendar to rebook</BtnLink>
                </div>
              )}
              <DemoNote>
                Demo threads — secure portal only. SMS/email channels are unconfigured and cannot
                send. Replies stay in this browser session.
              </DemoNote>
            </div>
          )}
        </Card>
      </div>

      <ConfirmDialog
        open={confirmSend}
        title="Send this reply to the patient?"
        body="Patient-facing content requires your review. Demo send — the reply is recorded in this session only; nothing is delivered."
        confirmLabel="Send (demo)"
        onCancel={() => setConfirmSend(false)}
        onConfirm={() => {
          setConfirmSend(false);
          doSend();
        }}
      />
    </section>
  );
}
