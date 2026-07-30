"use client";

/**
 * Inbox — secure patient messaging workspace (MOCK).
 *
 * Seed threads are synthetic; everything the practitioner does (read, reply,
 * internal note, assign, close, create task) lives in the demo session store
 * and is labeled that way. Only the PORTAL channel exists; SMS and email are
 * honestly "future channels — not configured" and can never "send".
 */
import { createSessionStore, newSessionId } from "./session-kv";
import { addSessionQueueItem, recordAuditEntry } from "./session-store";
import type { Priority } from "./types";

export type InboxChannel = "portal" | "sms" | "email";
export type ThreadKind = "message" | "schedule-request" | "refill" | "form" | "billing";

export interface InboxAttachment {
  id: string;
  name: string;
  kind: "pdf" | "image";
  size: string;
}

export interface InboxMessage {
  id: string;
  author: "patient" | "practitioner" | "system";
  authorName: string;
  /** Display time (fixed strings avoid SSR/client hydration drift). */
  atLabel: string;
  body: string;
  attachments?: InboxAttachment[];
  /** Internal note — never visible to the patient. */
  internal?: boolean;
  /** Demo send — this session only, nothing actually delivered. */
  demoSend?: boolean;
}

export interface InboxThread {
  id: string;
  channel: InboxChannel;
  kind: ThreadKind;
  patientId?: string;
  patientName: string;
  subject: string;
  /** Sort key: bigger = newer. */
  order: number;
  atLabel: string;
  unread: boolean;
  priority: Priority | null;
  assignedTo?: string;
  status: "open" | "closed";
  messages: InboxMessage[];
  appointmentRef?: { label: string; href: string };
}

export const CHANNEL_META: Record<
  InboxChannel,
  { label: string; configured: boolean; note: string }
> = {
  portal: { label: "Portal", configured: true, note: "Secure in-app patient messaging" },
  sms: {
    label: "SMS",
    configured: false,
    note: "Future channel — no SMS provider is configured. Nothing can send.",
  },
  email: {
    label: "Email",
    configured: false,
    note: "Future channel — no email provider is configured. Nothing can send.",
  },
};

const msg = (
  author: InboxMessage["author"],
  authorName: string,
  atLabel: string,
  body: string,
  extra?: Partial<InboxMessage>,
): InboxMessage => ({ id: newSessionId(), author, authorName, atLabel, body, ...extra });

/** Seed threads — all synthetic people and content. */
const SEED_THREADS: InboxThread[] = [
  {
    id: "th-avery-timing",
    channel: "portal",
    kind: "message",
    patientId: "p-78435",
    patientName: "Alexandra Morgan",
    subject: "Evening supplement timing",
    order: 100,
    atLabel: "Today 7:42 AM",
    unread: true,
    priority: "Medium",
    status: "open",
    messages: [
      msg(
        "patient",
        "Alexandra Morgan",
        "Today 7:42 AM",
        "Quick question — should I take the magnesium with dinner or right before bed? I've been doing dinner but saw conflicting advice.",
      ),
    ],
  },
  {
    id: "th-priya-labs",
    channel: "portal",
    kind: "message",
    patientId: "p-59318",
    patientName: "Priya Sharma",
    subject: "Feeling more fatigued this week",
    order: 96,
    atLabel: "Today 6:58 AM",
    unread: true,
    priority: "High",
    status: "open",
    messages: [
      msg(
        "patient",
        "Priya Sharma",
        "Today 6:58 AM",
        "The fatigue has been worse since Tuesday — climbing stairs leaves me winded. Should we move the iron panel up?",
      ),
      msg("system", "System", "Today 6:58 AM", "Ferritin trend attached from patient app.", {
        attachments: [{ id: "att-1", name: "ferritin-trend.pdf", kind: "pdf", size: "84 KB" }],
      }),
    ],
  },
  {
    id: "th-michael-reschedule",
    channel: "portal",
    kind: "schedule-request",
    patientId: "p-64201",
    patientName: "Michael Johnson",
    subject: "Reschedule request — Thursday follow-up",
    order: 92,
    atLabel: "Today 8:15 AM",
    unread: true,
    priority: null,
    status: "open",
    appointmentRef: { label: "Thu · Follow-up · 9:00 AM", href: "/calendar" },
    messages: [
      msg(
        "patient",
        "Michael Johnson",
        "Today 8:15 AM",
        "Work travel came up — could we move Thursday's follow-up to Friday morning or next Monday?",
      ),
    ],
  },
  {
    id: "th-marcus-refill",
    channel: "portal",
    kind: "refill",
    patientId: "p-52984",
    patientName: "Marcus Webb",
    subject: "Refill: magnesium glycinate",
    order: 88,
    atLabel: "Yesterday",
    unread: false,
    priority: null,
    status: "open",
    messages: [
      msg(
        "patient",
        "Marcus Webb",
        "Yesterday 4:20 PM",
        "Down to my last week of the magnesium — can I get a refill on the same dose?",
      ),
      msg(
        "practitioner",
        "Dr. Sarah Mitchell",
        "Yesterday 5:02 PM",
        "Approved on my end — the dispensary will confirm pickup or shipping.",
        { internal: false },
      ),
    ],
  },
  {
    id: "th-jessica-form",
    channel: "portal",
    kind: "form",
    patientId: "p-71126",
    patientName: "Jessica Parker",
    subject: "PSS-10 submitted",
    order: 84,
    atLabel: "Yesterday",
    unread: false,
    priority: null,
    status: "open",
    messages: [
      msg("system", "System", "Yesterday 2:10 PM", "Jessica Parker submitted the PSS-10 stress assessment.", {
        attachments: [{ id: "att-2", name: "pss-10-response.pdf", kind: "pdf", size: "36 KB" }],
      }),
    ],
  },
  {
    id: "th-dana-telehealth",
    channel: "portal",
    kind: "message",
    patientId: "p-66473",
    patientName: "Dana Whitfield",
    subject: "Telehealth link for Tuesday",
    order: 80,
    atLabel: "Mon",
    unread: false,
    priority: null,
    assignedTo: "Front desk",
    status: "open",
    messages: [
      msg(
        "patient",
        "Dana Whitfield",
        "Mon 11:04 AM",
        "I didn't get the video link for Tuesday's telehealth — could you resend it?",
      ),
      msg(
        "practitioner",
        "Front desk",
        "Mon 11:30 AM",
        "Internal: link regenerated, waiting on portal confirmation before replying.",
        { internal: true },
      ),
    ],
  },
  {
    id: "th-billing-question",
    channel: "portal",
    kind: "billing",
    patientId: "p-64201",
    patientName: "Michael Johnson",
    subject: "Question about April invoice",
    order: 76,
    atLabel: "Mon",
    unread: false,
    priority: null,
    status: "closed",
    messages: [
      msg("patient", "Michael Johnson", "Mon 9:12 AM", "Was the lab-review visit billed twice in April? I see two similar lines."),
      msg(
        "practitioner",
        "Dr. Sarah Mitchell",
        "Mon 10:05 AM",
        "Good catch — one was the visit, the other the extended panel review. Receipt with both line items re-sent.",
      ),
    ],
  },
];

interface InboxSessionState {
  read: Record<string, boolean>;
  replies: Record<string, InboxMessage[]>;
  priority: Record<string, Priority | null>;
  assigned: Record<string, string | undefined>;
  status: Record<string, "open" | "closed">;
}

const store = createSessionStore<InboxSessionState>("aidp:demo:inbox", {
  read: {},
  replies: {},
  priority: {},
  assigned: {},
  status: {},
});

function applyState(thread: InboxThread, s: InboxSessionState): InboxThread {
  const replies = s.replies[thread.id] ?? [];
  return {
    ...thread,
    unread: s.read[thread.id] ? false : thread.unread,
    priority: thread.id in s.priority ? s.priority[thread.id] : thread.priority,
    assignedTo: thread.id in s.assigned ? s.assigned[thread.id] : thread.assignedTo,
    status: s.status[thread.id] ?? thread.status,
    messages: [...thread.messages, ...replies],
  };
}

export function listThreads(state?: InboxSessionState): InboxThread[] {
  const s = state ?? store.get();
  return SEED_THREADS.map((t) => applyState(t, s)).sort((a, b) => b.order - a.order);
}

export function getThread(id: string, state?: InboxSessionState): InboxThread | undefined {
  return listThreads(state).find((t) => t.id === id);
}

export function useInboxThreads(): InboxThread[] {
  const s = store.use();
  return listThreads(s);
}

export function useUnreadThreadCount(): number {
  const s = store.use();
  return listThreads(s).filter((t) => t.unread && t.status === "open").length;
}

export function markThreadRead(id: string) {
  store.update((s) => ({ ...s, read: { ...s.read, [id]: true } }));
}

export function setThreadPriority(id: string, priority: Priority | null) {
  store.update((s) => ({ ...s, priority: { ...s.priority, [id]: priority } }));
}

export function assignThread(id: string, who: string | undefined) {
  store.update((s) => ({ ...s, assigned: { ...s.assigned, [id]: who } }));
}

export function setThreadStatus(id: string, status: "open" | "closed") {
  store.update((s) => ({ ...s, status: { ...s.status, [id]: status } }));
}

/**
 * Mock send. Appends to the session thread and audits. Patient-facing —
 * caller must have passed the review confirmation first. Nothing is
 * delivered anywhere; the message is labeled "Demo send" in the UI.
 */
export function sendReply(threadId: string, body: string, opts?: { internal?: boolean }) {
  const t = SEED_THREADS.find((x) => x.id === threadId);
  const message = msg("practitioner", "Dr. Sarah Mitchell", "Now", body, {
    internal: opts?.internal,
    demoSend: !opts?.internal,
  });
  store.update((s) => ({
    ...s,
    replies: { ...s.replies, [threadId]: [...(s.replies[threadId] ?? []), message] },
    read: { ...s.read, [threadId]: true },
  }));
  recordAuditEntry({
    kind: "message_patient",
    subjectType: opts?.internal ? "internal note" : "patient message",
    subjectLabel: t?.subject ?? threadId,
    patientName: t?.patientName,
    reviewed: true,
  });
  return {
    ok: true,
    message: opts?.internal
      ? "Internal note added. (demo — this session only)"
      : "Reply recorded. (demo send — nothing was delivered to a patient)",
  };
}

/** Create a review-queue task from a thread (shows up on /tasks + Today). */
export function createTaskFromThread(thread: InboxThread) {
  addSessionQueueItem({
    title: `Inbox follow-up: ${thread.subject}`,
    patientName: thread.patientName,
    patientId: thread.patientId ?? "",
    category: "Patient message",
    priority: thread.priority ?? "Medium",
    seeds: [`From inbox thread "${thread.subject}" (${thread.atLabel}).`],
  });
  recordAuditEntry({
    kind: "create_task",
    subjectType: "task",
    subjectLabel: `Inbox follow-up: ${thread.subject}`,
    patientName: thread.patientName,
    reviewed: true,
  });
  return { ok: true, message: "Task created in the review queue. (demo — session queue)" };
}
