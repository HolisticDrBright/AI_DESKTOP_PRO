"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  CalendarDays,
  Inbox as InboxIcon,
  Paperclip,
  ShieldAlert,
  Sparkles,
  User,
} from "lucide-react";
import { api } from "@/adapters";
import { AdapterError } from "@/adapters/errors";
import type {
  LiveConversation,
  LiveInbox,
  LiveInboxFilters,
  LiveThreadCategory,
  LiveThreadMessage,
  LiveThreadPriority,
  LiveThreadStatus,
} from "@/adapters/live-types";
import { Card, CardTitle } from "@/components/ui/bits";
import { Btn } from "@/components/ui/Btn";
import {
  ClinicalEmpty,
  ClinicalError,
  ClinicalLoading,
  ClinicalNote,
} from "@/components/ui/ClinicalStates";
import { useFeedback } from "@/lib/feedback";
import { patientPath } from "@/lib/routes";

const INPUT =
  "h-8 rounded-lg border border-line bg-card px-3 text-[12.5px] text-body outline-none focus-visible:outline-2 focus-visible:outline-action";
const AREA =
  "min-h-[72px] w-full rounded-lg border border-line bg-card px-3 py-2 text-[12.5px] leading-normal text-body outline-none focus-visible:outline-2 focus-visible:outline-action";
const LABEL = "mb-1 block text-[11px] font-bold tracking-[0.02em] text-subtle uppercase";

const CATEGORIES: { value: LiveThreadCategory; label: string }[] = [
  { value: "general", label: "General" },
  { value: "clinical_question", label: "Clinical question" },
  { value: "refill", label: "Refill" },
  { value: "lab", label: "Lab" },
  { value: "wearable_alert", label: "Wearable alert" },
  { value: "scheduling", label: "Scheduling" },
  { value: "billing", label: "Billing" },
  { value: "program_check_in", label: "Program check-in" },
  { value: "protocol_adherence", label: "Protocol adherence" },
  { value: "administrative", label: "Administrative" },
];
const PRIORITIES: LiveThreadPriority[] = ["low", "normal", "high", "urgent"];

function errText(e: unknown): string {
  return e instanceof AdapterError ? e.message : "Something went wrong. Try again.";
}
function isConflict(e: unknown): boolean {
  return e instanceof AdapterError && e.code === "conflict";
}
function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function PriorityPill({ priority }: { priority: LiveThreadPriority }) {
  const tone =
    priority === "urgent"
      ? "bg-critical-tint text-critical"
      : priority === "high"
        ? "bg-warning-tint text-warning-deep"
        : "bg-slate-tint text-slate-badge";
  return (
    <span className={`inline-flex h-[18px] items-center rounded-full px-2 text-[10px] font-bold ${tone}`}>
      {priority}
    </span>
  );
}

function DeliveryPill({ m }: { m: LiveThreadMessage }) {
  const label =
    m.status === "draft"
      ? "draft"
      : m.status === "queued"
        ? "queued — not sent"
        : m.status === "sent"
          ? "sent (provider confirmed)"
          : m.status === "delivered"
            ? "delivered"
            : m.status === "failed"
              ? "failed"
              : m.status;
  const tone =
    m.status === "delivered" || m.status === "sent"
      ? "bg-positive-tint text-positive-deep"
      : m.status === "failed"
        ? "bg-critical-tint text-critical"
        : "bg-slate-tint text-slate-badge";
  return (
    <span
      className={`inline-flex h-[18px] items-center rounded-full px-2 text-[10px] font-bold ${tone}`}
      data-testid={`message-status-${m.status}`}
    >
      {label}
    </span>
  );
}

/**
 * The Inbox: a three-pane clinical communication workspace over PERSISTED
 * threads. Counts are persisted rows; sending fails closed without a
 * provider; the deterministic urgent-language invariant panel renders
 * regardless of AI availability; AI triage output stays a suggestion until a
 * human accepts it.
 */
export function InboxWorkspace({ initialThreadId }: { initialThreadId?: string }) {
  const { announce } = useFeedback();
  const [inbox, setInbox] = useState<LiveInbox | null>(null);
  const [inboxError, setInboxError] = useState<string | null>(null);
  const [filters, setFilters] = useState<LiveInboxFilters>({});
  const [selectedId, setSelectedId] = useState<string | null>(initialThreadId ?? null);
  const [thread, setThread] = useState<LiveConversation | null>(null);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Reply composer state.
  const [draftBody, setDraftBody] = useState("");
  const [draftMessageId, setDraftMessageId] = useState<string | null>(null);
  const draftVersionRef = useRef<number | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "conflict" | "failed">("idle");
  const [sendOutcome, setSendOutcome] = useState<string | null>(null);
  const saveTimer = useRef<number | null>(null);
  const draftBodyRef = useRef("");
  draftBodyRef.current = draftBody;

  const [aiMessage, setAiMessage] = useState<string | null>(null);
  const [snoozeUntil, setSnoozeUntil] = useState("");
  const [followUpAt, setFollowUpAt] = useState("");
  const [noteEncounter, setNoteEncounter] = useState("");
  const [encounters, setEncounters] = useState<
    { encounterId: string; visitType: string | null; status: string; startedAt: string | null }[]
  >([]);
  const [attachName, setAttachName] = useState("");

  const loadInbox = useCallback(async (f: LiveInboxFilters) => {
    setInboxError(null);
    try {
      setInbox(await api.inbox.list(f));
    } catch (e) {
      setInboxError(errText(e));
    }
  }, []);

  const loadThread = useCallback(async (id: string) => {
    setThreadError(null);
    try {
      const t = await api.inbox.thread(id);
      setThread(t);
      // Adopt the caller's existing open draft, if any.
      const mine = t.messages.find((m) => m.status === "draft" && m.isMine);
      setDraftMessageId(mine?.id ?? null);
      draftVersionRef.current = mine?.version ?? null;
      setDraftBody(mine?.body ?? "");
      setSaveState("idle");
      setSendOutcome(null);
      try {
        setEncounters(await api.inbox.patientEncounters(t.patient.id));
      } catch {
        setEncounters([]);
      }
      // Read receipts are explicit but automatic on open; idempotent.
      const read = await api.inbox.markRead(id);
      if ((read.markedRead ?? 0) > 0) void loadInbox(filters);
    } catch (e) {
      setThreadError(errText(e));
    }
    // filters intentionally read at call time for the unread refresh only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void loadInbox(filters);
  }, [filters, loadInbox]);
  useEffect(() => {
    if (selectedId) void loadThread(selectedId);
  }, [selectedId, loadThread]);
  useEffect(
    () => () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    },
    [],
  );

  const saveDraftNow = useCallback(async () => {
    if (!selectedId || !draftBodyRef.current.trim()) return;
    setSaveState("saving");
    try {
      const res = await api.inbox.saveDraft({
        conversationId: selectedId,
        body: draftBodyRef.current,
        messageId: draftMessageId,
        expectedVersion: draftVersionRef.current,
      });
      setDraftMessageId(res.messageId ?? draftMessageId);
      draftVersionRef.current = res.version ?? draftVersionRef.current;
      setSaveState("saved");
    } catch (e) {
      setSaveState(isConflict(e) ? "conflict" : "failed");
    }
  }, [selectedId, draftMessageId]);

  const touchDraft = (value: string) => {
    setDraftBody(value);
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void saveDraftNow(), 700);
  };

  const runAction = async (fn: () => Promise<{ message: string }>, refreshList = true) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fn();
      announce(res.message);
      if (selectedId) await loadThread(selectedId);
      if (refreshList) await loadInbox(filters);
    } catch (e) {
      announce(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const workflow = (
    action: "assign" | "queue" | "priority" | "category" | "status" | "follow_up",
    value?: string | null,
    at?: string | null,
  ) => {
    if (!thread) return;
    void runAction(() =>
      api.inbox.workflow({
        conversationId: thread.conversation.id,
        action,
        expectedVersion: thread.conversation.version,
        value: value ?? null,
        at: at ?? null,
      }),
    );
  };

  const send = async () => {
    if (!draftMessageId || busy) return;
    // Flush any pending edit first so what is sent is what is on screen.
    await saveDraftNow();
    setBusy(true);
    setSendOutcome(null);
    try {
      const res = await api.inbox.send({ messageId: draftMessageId });
      // Refresh FIRST (loadThread resets the outcome line), then report the
      // outcome so a refusal stays visible on screen.
      if (selectedId) await loadThread(selectedId);
      if (res.ok === false) {
        setSendOutcome(res.message);
      } else {
        announce(res.message);
        setDraftBody("");
        setDraftMessageId(null);
        draftVersionRef.current = null;
      }
    } catch (e) {
      setSendOutcome(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const c = thread?.conversation ?? null;
  const inboundMessages = useMemo(
    () => (thread?.messages ?? []).filter((m) => m.isFromPatient),
    [thread],
  );
  const latestInbound = inboundMessages[inboundMessages.length - 1] ?? null;
  const suggested = (thread?.aiReviews ?? []).filter((r) => r.status === "suggested");

  if (inboxError && !inbox) {
    return <ClinicalError message={inboxError} onRetry={() => void loadInbox(filters)} />;
  }
  if (!inbox) return <ClinicalLoading label="Loading the inbox…" />;

  return (
    <div
      className="grid gap-3 xl:grid-cols-[300px_minmax(0,1fr)_320px]"
      data-testid="inbox-workspace"
    >
      {/* ------------------------------------------------- pane 1: queue */}
      <div className="flex min-w-0 flex-col gap-3">
        <Card className="px-3 py-3">
          <input
            className={`${INPUT} w-full`}
            placeholder="Search subject or patient…"
            aria-label="Search the inbox"
            value={filters.query ?? ""}
            onChange={(e) => setFilters((f) => ({ ...f, query: e.target.value || null }))}
            data-testid="inbox-search"
          />
          <div className="mt-2 grid grid-cols-2 gap-2">
            <select
              className={INPUT}
              aria-label="Filter by category"
              value={filters.category ?? ""}
              onChange={(e) =>
                setFilters((f) => ({
                  ...f,
                  category: (e.target.value || null) as LiveThreadCategory | null,
                }))
              }
              data-testid="filter-category"
            >
              <option value="">All categories</option>
              {CATEGORIES.map((cat) => (
                <option key={cat.value} value={cat.value}>{cat.label}</option>
              ))}
            </select>
            <select
              className={INPUT}
              aria-label="Filter by priority"
              value={filters.priority ?? ""}
              onChange={(e) =>
                setFilters((f) => ({
                  ...f,
                  priority: (e.target.value || null) as LiveThreadPriority | null,
                }))
              }
              data-testid="filter-priority"
            >
              <option value="">All priorities</option>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
            <select
              className={INPUT}
              aria-label="Filter by status"
              value={filters.status ?? ""}
              onChange={(e) =>
                setFilters((f) => ({
                  ...f,
                  status: (e.target.value || null) as LiveThreadStatus | null,
                }))
              }
              data-testid="filter-status"
            >
              <option value="">All statuses</option>
              <option value="open">Open</option>
              <option value="snoozed">Snoozed</option>
              <option value="resolved">Resolved</option>
            </select>
            <select
              className={INPUT}
              aria-label="Filter by queue"
              value={filters.queue ?? ""}
              onChange={(e) =>
                setFilters((f) => ({
                  ...f,
                  queue: (e.target.value || null) as "practitioner" | "staff" | null,
                }))
              }
              data-testid="filter-queue"
            >
              <option value="">Both queues</option>
              <option value="practitioner">Practitioner</option>
              <option value="staff">Staff</option>
            </select>
          </div>
          <div className="mt-2 flex flex-wrap gap-3 text-[11.5px] font-semibold text-body-2">
            <label className="flex items-center gap-[5px]">
              <input
                type="checkbox"
                checked={filters.unreadOnly ?? false}
                onChange={(e) => setFilters((f) => ({ ...f, unreadOnly: e.target.checked }))}
                data-testid="filter-unread"
              />
              Unread
            </label>
            <label className="flex items-center gap-[5px]">
              <input
                type="checkbox"
                checked={filters.dueOnly ?? false}
                onChange={(e) => setFilters((f) => ({ ...f, dueOnly: e.target.checked }))}
                data-testid="filter-due"
              />
              Due
            </label>
            <label className="flex items-center gap-[5px]">
              <input
                type="checkbox"
                checked={filters.assignedToMe ?? false}
                onChange={(e) => setFilters((f) => ({ ...f, assignedToMe: e.target.checked }))}
                data-testid="filter-mine"
              />
              Mine
            </label>
          </div>
          <p className="m-0 mt-2 text-[11px] text-subtle" data-testid="inbox-counts">
            {inbox.counts.open} open · {inbox.counts.unread} unread · {inbox.counts.urgent} urgent ·{" "}
            {inbox.counts.dueSoon} due · {inbox.counts.mine} mine
          </p>
        </Card>

        {inbox.threads.length === 0 ? (
          <ClinicalEmpty
            icon={<InboxIcon size={20} strokeWidth={1.75} className="text-slate-badge" aria-hidden />}
            title={filters.query || filters.category || filters.status ? "No threads match" : "Inbox empty"}
            message={
              filters.query || filters.category || filters.status
                ? "No conversation matches the current filters."
                : "No patient conversations exist for this organization. Nothing synthetic is shown."
            }
          />
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="thread-list" role="list">
            {inbox.threads.map((t) => (
              <li key={t.id}>
                <button
                  onClick={() => setSelectedId(t.id)}
                  aria-label={`Open conversation: ${t.subject ?? "no subject"} with ${t.patientName}`}
                  aria-current={selectedId === t.id ? "true" : undefined}
                  className={`w-full rounded-[12px] border px-3 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-action ${
                    selectedId === t.id ? "border-action bg-[#F4F8FD]" : "border-line bg-card hover:border-line-hover"
                  }`}
                  data-testid={`thread-${t.id}`}
                >
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-body">
                      {t.subject ?? "No subject"}
                    </span>
                    {t.urgent && (
                      <ShieldAlert size={13} strokeWidth={2.25} className="shrink-0 text-critical" aria-label="Urgent language detected" />
                    )}
                    {t.unreadCount > 0 && (
                      <span className="inline-flex h-[18px] shrink-0 items-center rounded-full bg-action px-[7px] text-[10px] font-bold text-white">
                        {t.unreadCount}
                      </span>
                    )}
                  </span>
                  <span className="mt-[3px] flex items-center gap-2 text-[11px] text-subtle">
                    <span className="min-w-0 truncate">{t.patientName}</span>
                    <PriorityPill priority={t.priority} />
                    <span className="shrink-0">{fmtDateTime(t.lastMessageAt)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ---------------------------------------------- pane 2: the thread */}
      <div className="flex min-w-0 flex-col gap-3">
        {!selectedId ? (
          <ClinicalEmpty
            title="Select a conversation"
            message="Choose a thread from the queue to read and reply."
          />
        ) : threadError ? (
          <ClinicalError message={threadError} onRetry={() => selectedId && void loadThread(selectedId)} />
        ) : !thread || !c ? (
          <ClinicalLoading label="Loading the conversation…" />
        ) : (
          <>
            <Card className="px-4 py-3" data-testid="thread-header">
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle className="mb-0">{c.subject ?? "No subject"}</CardTitle>
                <PriorityPill priority={c.priority} />
                <span className="inline-flex h-[18px] items-center rounded-full bg-slate-tint px-2 text-[10px] font-bold text-slate-badge">
                  {c.status}
                </span>
                <span className="text-[11.5px] text-subtle">{CATEGORIES.find((x) => x.value === c.category)?.label}</span>
              </div>
            </Card>

            {/* Deterministic invariant panel: ALWAYS rendered when flagged —
                independent of any AI availability. */}
            {c.urgent && (
              <Card className="border-critical px-4 py-3" data-testid="urgent-panel">
                <div className="flex items-start gap-2">
                  <ShieldAlert size={16} strokeWidth={2.25} className="mt-[1px] shrink-0 text-critical" aria-hidden />
                  <div>
                    <p className="m-0 text-[12.5px] font-bold text-critical" role="alert">
                      Urgent language detected — immediate human review suggested
                    </p>
                    <p className="m-0 mt-1 text-[12px] text-subtle">
                      The deterministic check matched: {c.urgentTerms.join(", ")}. This is a
                      visibility elevation, not a diagnosis and not a confirmed emergency — a
                      clinician must read the message itself.
                    </p>
                  </div>
                </div>
              </Card>
            )}

            <Card className="px-4 py-3" data-testid="message-list">
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {thread.messages
                  .filter((m) => m.status !== "draft" && m.status !== "cancelled")
                  .map((m) => (
                    <li
                      key={m.id}
                      className={`max-w-[85%] rounded-[12px] border px-3 py-2 ${
                        m.isFromPatient
                          ? "self-start border-hairline-2 bg-surface"
                          : "self-end border-[rgba(37,99,199,0.25)] bg-[#F2F7FD]"
                      }`}
                      data-testid={`message-${m.id}`}
                    >
                      <p className="m-0 text-[12.5px] leading-normal whitespace-pre-wrap text-body">{m.body}</p>
                      <p className="m-0 mt-1 flex items-center gap-2 text-[10.5px] text-faint">
                        {m.isFromPatient ? "Patient" : "Care team"} · {fmtDateTime(m.createdAt)}
                        {!m.isFromPatient && <DeliveryPill m={m} />}
                        {m.failedReason && <span className="text-critical">{m.failedReason}</span>}
                        {m.isFromPatient && m.readAt && <span>read {fmtDateTime(m.readAt)}</span>}
                      </p>
                      {!m.isFromPatient && (
                        <span className="mt-1 flex gap-2">
                          {(m.status === "inbound" || m.status === "sent" || m.status === "delivered") && null}
                        </span>
                      )}
                    </li>
                  ))}
              </ul>
              {thread.attachments.length > 0 && (
                <div className="mt-3 border-t border-hairline-2 pt-2" data-testid="attachment-list">
                  <p className={LABEL}>Attachments (metadata)</p>
                  <ul className="m-0 flex list-none flex-col gap-1 p-0">
                    {thread.attachments.map((a) => (
                      <li key={a.id} className="flex items-center gap-2 text-[12px] text-body">
                        <Paperclip size={12} strokeWidth={2} aria-hidden />
                        <span className="min-w-0 truncate font-medium">{a.fileName}</span>
                        <span className="text-faint">{a.contentType}</span>
                        <span
                          className="inline-flex h-[18px] items-center rounded-full bg-slate-tint px-2 text-[10px] font-bold text-slate-badge"
                          data-testid="attachment-access"
                        >
                          {a.accessible ? "stored" : "metadata only — storage not configured"}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </Card>

            {/* AI copilot: suggestions for HUMAN review; requesting new
                analysis fails closed without a provider. */}
            <Card className="px-4 py-3" data-testid="ai-panel">
              <div className="flex items-center gap-2">
                <CardTitle className="mb-0">
                  <Sparkles size={13} strokeWidth={2} className="text-ai-deep" aria-hidden />
                  AI inbox copilot
                </CardTitle>
                <span className="flex-1" />
                <Btn
                  size="sm"
                  variant="ai"
                  onClick={async () => {
                    try {
                      await api.inbox.copilotAI({ conversationId: c.id });
                    } catch (e) {
                      setAiMessage(errText(e));
                    }
                  }}
                  data-testid="ai-analyze"
                >
                  Analyze thread
                </Btn>
              </div>
              {aiMessage && (
                <p className="m-0 mt-2 text-[12px] font-semibold text-warning-deep" data-testid="ai-not-configured">
                  {aiMessage}
                </p>
              )}
              {suggested.length === 0 ? (
                <p className="m-0 mt-2 text-[12px] text-faint">
                  No pending AI suggestions. AI output never acts on its own — a clinician accepts
                  or dismisses each suggestion.
                </p>
              ) : (
                <ul className="m-0 mt-2 flex list-none flex-col gap-2 p-0">
                  {suggested.map((r) => (
                    <li
                      key={r.id}
                      className="rounded-[10px] border border-[rgba(116,97,201,0.3)] bg-[rgba(116,97,201,0.05)] px-3 py-2"
                      data-testid={`ai-suggestion-${r.kind}`}
                    >
                      <p className="m-0 text-[11px] font-bold tracking-[0.02em] text-ai-deep uppercase">
                        {r.kind.replace(/_/g, " ")} · {r.provider} {r.model} · prompt {r.promptVersion}
                      </p>
                      <p className="m-0 mt-1 text-[12.5px] text-body">
                        {typeof r.content.summary === "string"
                          ? r.content.summary
                          : typeof r.content.body === "string"
                            ? r.content.body
                            : typeof r.content.priority === "string"
                              ? `Suggested priority: ${r.content.priority}`
                              : typeof r.content.category === "string"
                                ? `Suggested category: ${r.content.category}`
                                : typeof r.content.queue === "string"
                                  ? `Suggested queue: ${r.content.queue}`
                                  : Array.isArray(r.content.questions)
                                    ? (r.content.questions as string[]).join(" · ")
                                    : typeof r.content.title === "string"
                                      ? `Suggested task: ${r.content.title}`
                                      : JSON.stringify(r.content)}
                      </p>
                      <div className="mt-2 flex gap-2">
                        <Btn
                          size="sm"
                          disabled={busy}
                          onClick={() => void runAction(() => api.inbox.reviewAiSuggestion(r.id, "accept"))}
                          data-testid={`ai-accept-${r.kind}`}
                        >
                          Accept
                        </Btn>
                        <Btn
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => void runAction(() => api.inbox.reviewAiSuggestion(r.id, "dismiss"))}
                          data-testid={`ai-dismiss-${r.kind}`}
                        >
                          Dismiss
                        </Btn>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            {/* Reply composer */}
            <Card className="px-4 py-3" data-testid="composer">
              <div className="flex items-center gap-2">
                <CardTitle className="mb-0">Reply</CardTitle>
                <span
                  role="status"
                  className="text-[11px] font-bold text-subtle"
                  data-testid="draft-state"
                  data-state={saveState}
                >
                  {saveState === "saving"
                    ? "Saving…"
                    : saveState === "saved"
                      ? "Draft saved"
                      : saveState === "conflict"
                        ? "Conflict — draft changed elsewhere"
                        : saveState === "failed"
                          ? "Save failed"
                          : ""}
                </span>
              </div>
              {saveState === "conflict" && (
                <div className="mt-2 rounded-[10px] border border-critical bg-critical-tint px-3 py-2" data-testid="draft-conflict">
                  <p className="m-0 text-[12px] font-semibold text-critical">
                    This draft was changed in another session. Nothing was overwritten.
                  </p>
                  <Btn
                    size="sm"
                    className="mt-1"
                    onClick={() => selectedId && void loadThread(selectedId)}
                    data-testid="draft-conflict-reload"
                  >
                    Reload latest draft
                  </Btn>
                </div>
              )}
              <textarea
                className={`${AREA} mt-2`}
                value={draftBody}
                placeholder="Write a reply… (drafts autosave; nothing sends without the Send button)"
                aria-label="Reply draft"
                onChange={(e) => touchDraft(e.target.value)}
                data-testid="draft-body"
              />
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Btn
                  variant="primary"
                  disabled={busy || !draftMessageId}
                  onClick={() => void send()}
                  data-testid="send-message"
                >
                  Send
                </Btn>
                {draftMessageId && (
                  <Btn
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void runAction(async () => {
                        const res = await api.inbox.cancelDraft(draftMessageId);
                        setDraftBody("");
                        setDraftMessageId(null);
                        draftVersionRef.current = null;
                        return res;
                      })
                    }
                  >
                    Discard draft
                  </Btn>
                )}
                <span className="flex-1" />
                <input
                  className={`${INPUT} w-[180px]`}
                  value={attachName}
                  placeholder="Attachment file name"
                  aria-label="Attachment file name"
                  onChange={(e) => setAttachName(e.target.value)}
                  data-testid="attach-name"
                />
                <Btn
                  size="sm"
                  disabled={busy || !attachName.trim()}
                  onClick={() =>
                    void runAction(async () => {
                      const res = await api.inbox.registerAttachment({
                        conversationId: c.id,
                        fileName: attachName.trim(),
                        contentType: "application/octet-stream",
                      });
                      setAttachName("");
                      return res;
                    })
                  }
                  data-testid="attach-register"
                >
                  Register metadata
                </Btn>
              </div>
              {sendOutcome && (
                <p
                  className="m-0 mt-2 text-[12.5px] font-semibold text-warning-deep"
                  role="status"
                  data-testid="send-outcome"
                >
                  {sendOutcome}
                </p>
              )}
              <ClinicalNote className="mt-2">
                Sending requires a configured messaging provider. None is configured on this
                deployment, so Send keeps the draft and reports the refusal — nothing is ever
                marked sent or delivered without provider confirmation.
              </ClinicalNote>
            </Card>
          </>
        )}
      </div>

      {/* ------------------------------------- pane 3: context and actions */}
      <div className="flex min-w-0 flex-col gap-3">
        {thread && c ? (
          <>
            <Card className="px-4 py-3" data-testid="patient-context">
              <CardTitle className="mb-1">
                <User size={13} strokeWidth={2} className="text-brand" aria-hidden />
                {thread.patient.name}
              </CardTitle>
              <div className="flex flex-col gap-1 text-[12.5px]">
                <Link
                  href={patientPath(thread.patient.id, "overview")}
                  className="font-semibold text-action hover:underline"
                  data-testid="open-chart"
                >
                  Open patient chart →
                </Link>
                <Link
                  href={patientPath(thread.patient.id, "messages")}
                  className="font-semibold text-action hover:underline"
                >
                  Messages tab →
                </Link>
                <Link href="/calendar" className="flex items-center gap-1 font-semibold text-action hover:underline">
                  <CalendarDays size={12} strokeWidth={2} aria-hidden /> Scheduling →
                </Link>
              </div>
            </Card>

            <Card className="px-4 py-3" data-testid="prefs-panel">
              <CardTitle className="mb-1">Contact preferences &amp; consent</CardTitle>
              {thread.preferences ? (
                <p className="m-0 text-[12px] text-body" data-testid="prefs-summary">
                  Preferred: {thread.preferences.preferredChannel}
                  {thread.preferences.doNotContact && (
                    <span className="ml-2 inline-flex h-[18px] items-center rounded-full bg-critical-tint px-2 text-[10px] font-bold text-critical" data-testid="do-not-contact">
                      DO NOT CONTACT
                    </span>
                  )}
                  <span className="block text-[11.5px] text-subtle">
                    email {thread.preferences.emailOk ? "ok" : "no consent"} · SMS{" "}
                    {thread.preferences.smsOk ? "ok" : "no consent"} · push{" "}
                    {thread.preferences.pushOk ? "ok" : "no consent"}
                  </span>
                </p>
              ) : (
                <p className="m-0 text-[12px] text-faint" data-testid="prefs-missing">
                  No preferences recorded — outbound channels beyond in-app default to refused.
                </p>
              )}
              {thread.consents.length > 0 ? (
                <ul className="m-0 mt-1 flex list-none flex-col gap-[2px] p-0 text-[11.5px] text-subtle">
                  {thread.consents.slice(0, 4).map((cs) => (
                    <li key={cs.id}>
                      {cs.type}: <span className="font-semibold">{cs.status}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="m-0 mt-1 text-[11.5px] text-faint">No consent records on file.</p>
              )}
              <div className="mt-2 flex gap-2">
                <Btn
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void runAction(() =>
                      api.inbox.setPreferences({
                        patientId: thread.patient.id,
                        doNotContact: !(thread.preferences?.doNotContact ?? false),
                        preferredChannel: thread.preferences?.preferredChannel ?? "in_app",
                        emailOk: thread.preferences?.emailOk ?? false,
                        smsOk: thread.preferences?.smsOk ?? false,
                        pushOk: thread.preferences?.pushOk ?? false,
                      }),
                    )
                  }
                  data-testid="toggle-do-not-contact"
                >
                  {thread.preferences?.doNotContact ? "Clear do-not-contact" : "Set do-not-contact"}
                </Btn>
              </div>
            </Card>

            <Card className="px-4 py-3" data-testid="workflow-panel">
              <CardTitle className="mb-2">Workflow</CardTitle>
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap gap-2">
                  <select
                    className={INPUT}
                    value={c.priority}
                    aria-label="Set priority"
                    disabled={busy}
                    onChange={(e) => workflow("priority", e.target.value)}
                    data-testid="set-priority"
                  >
                    {PRIORITIES.map((p) => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </select>
                  <select
                    className={INPUT}
                    value={c.category}
                    aria-label="Set category"
                    disabled={busy}
                    onChange={(e) => workflow("category", e.target.value)}
                    data-testid="set-category"
                  >
                    {CATEGORIES.map((cat) => (
                      <option key={cat.value} value={cat.value}>{cat.label}</option>
                    ))}
                  </select>
                  <select
                    className={INPUT}
                    value={c.assignedQueue}
                    aria-label="Set queue"
                    disabled={busy}
                    onChange={(e) => workflow("queue", e.target.value)}
                    data-testid="set-queue"
                  >
                    <option value="practitioner">Practitioner queue</option>
                    <option value="staff">Staff queue</option>
                  </select>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {c.status !== "resolved" ? (
                    <Btn
                      size="sm"
                      variant="primary"
                      disabled={busy}
                      onClick={() => workflow("status", "resolved")}
                      data-testid="resolve-thread"
                    >
                      Resolve
                    </Btn>
                  ) : (
                    <Btn size="sm" disabled={busy} onClick={() => workflow("status", "open")} data-testid="reopen-thread">
                      Reopen
                    </Btn>
                  )}
                  {c.status === "open" && (
                    <>
                      <input
                        type="datetime-local"
                        className={INPUT}
                        value={snoozeUntil}
                        aria-label="Snooze until"
                        onChange={(e) => setSnoozeUntil(e.target.value)}
                        data-testid="snooze-until"
                      />
                      <Btn
                        size="sm"
                        disabled={busy || !snoozeUntil}
                        onClick={() => workflow("status", "snoozed", new Date(snoozeUntil).toISOString())}
                        data-testid="snooze-thread"
                      >
                        Snooze
                      </Btn>
                    </>
                  )}
                  {c.status === "snoozed" && (
                    <Btn size="sm" disabled={busy} onClick={() => workflow("status", "open")} data-testid="unsnooze-thread">
                      Wake now
                    </Btn>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="date"
                    className={INPUT}
                    value={followUpAt}
                    aria-label="Follow-up date"
                    onChange={(e) => setFollowUpAt(e.target.value)}
                    data-testid="follow-up-date"
                  />
                  <Btn
                    size="sm"
                    disabled={busy || !followUpAt}
                    onClick={() => workflow("follow_up", null, new Date(followUpAt + "T12:00:00").toISOString())}
                    data-testid="set-follow-up"
                  >
                    Set follow-up
                  </Btn>
                  {c.followUpAt && (
                    <Btn size="sm" variant="ghost" disabled={busy} onClick={() => workflow("follow_up", null, null)}>
                      Clear
                    </Btn>
                  )}
                </div>
                {c.followUpAt && (
                  <p className="m-0 text-[11.5px] text-subtle" data-testid="follow-up-shown">
                    Follow-up: {fmtDateTime(c.followUpAt)}
                  </p>
                )}
              </div>
            </Card>

            <Card className="px-4 py-3" data-testid="actions-panel">
              <CardTitle className="mb-2">Convert</CardTitle>
              <div className="flex flex-col gap-2">
                <Btn
                  size="sm"
                  disabled={busy || !latestInbound}
                  onClick={() =>
                    latestInbound &&
                    void runAction(() =>
                      api.inbox.createTask({
                        messageId: latestInbound.id,
                        title: `Follow up: ${c.subject ?? "patient message"}`,
                      }),
                    )
                  }
                  data-testid="create-task"
                >
                  Create task from latest patient message
                </Btn>
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    className={`${INPUT} flex-1`}
                    value={noteEncounter}
                    aria-label="Encounter for the note"
                    onChange={(e) => setNoteEncounter(e.target.value)}
                    data-testid="note-encounter"
                  >
                    <option value="">Choose an encounter…</option>
                    {encounters.map((e) => (
                      <option key={e.encounterId} value={e.encounterId}>
                        {(e.visitType ?? "visit")} · {e.status} · {fmtDateTime(e.startedAt)}
                      </option>
                    ))}
                  </select>
                  <Btn
                    size="sm"
                    disabled={busy || !latestInbound || !noteEncounter}
                    onClick={() =>
                      latestInbound &&
                      void runAction(() =>
                        api.inbox.appendToNote({
                          messageId: latestInbound.id,
                          encounterId: noteEncounter,
                        }),
                      )
                    }
                    data-testid="add-to-note"
                  >
                    Add to unsigned note
                  </Btn>
                </div>
                <p className="m-0 text-[11.5px] text-subtle">
                  Note conversion quotes the message into an <strong>unsigned draft</strong> on the
                  chosen encounter. It never signs anything.
                </p>
              </div>
            </Card>

            {thread.events.length > 0 && (
              <Card className="px-4 py-3" data-testid="history-panel">
                <CardTitle className="mb-1">History</CardTitle>
                <ul className="m-0 flex list-none flex-col gap-[2px] p-0">
                  {thread.events.slice(0, 10).map((e, i) => (
                    <li key={i} className="text-[11.5px] text-subtle">
                      {fmtDateTime(e.createdAt)} — {e.kind.replace(/_/g, " ")}
                      {e.toValue ? `: ${e.toValue}` : ""}
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </>
        ) : (
          <Card className="px-4 py-[13px]">
            <div className="flex items-start gap-2 text-[12px] text-subtle">
              <AlertTriangle size={13} strokeWidth={2} className="mt-[1px] shrink-0 text-slate-badge" aria-hidden />
              Patient context appears when a thread is selected.
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
