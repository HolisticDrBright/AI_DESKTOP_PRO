"use client";

/**
 * Today — the practitioner's daily brief (MOCK assembly layer).
 *
 * Pulls one coherent picture from the calendar template, front-desk session
 * overlays, inbox, review queue, wearables, billing, and sync log so that
 * acting anywhere (check-in, reply, checkout, resolve) visibly updates the
 * brief. Every item links to its source screen.
 */
import { getCalendar, type Appointment } from "./calendar.mock";
import {
  getApptOverride,
  telehealthReadiness,
  useApptSession,
  type ApptOverride,
} from "./appointments.session";
import { useInboxThreads, type InboxThread } from "./inbox.mock";
import { getTaskQueue, type QueueItem } from "./tasks.mock";
import {
  useReviewOutcomes,
  useSessionQueueItems,
  type SessionQueueItem,
} from "./session-store";
import { WEARABLE_ALERTS, type WearableAlert } from "./tracking.mock";
import { getFailedSyncs, type SyncLogEntry } from "./integrations.mock";
import { MEMBERSHIPS, patientLedger, useSessionInvoices } from "./billing.mock";
import { patientPath } from "@/lib/routes";

export interface TodayAppointment {
  appt: Appointment;
  override?: ApptOverride;
  telehealth: { ready: boolean; detail: string };
  balanceMinor: number;
  hasAlerts: boolean;
}

export interface UnsignedNote {
  id: string;
  patientName: string;
  patientId: string;
  encounterLabel: string;
  ageLabel: string;
}

/** Demo unsigned-notes fixture — links into Chart & Timeline. */
export const UNSIGNED_NOTES: UnsignedNote[] = [
  { id: "un-1", patientName: "Michael Johnson", patientId: "p-64201", encounterLabel: "Initial consult · Jul 12", ageLabel: "7 days unsigned" },
  { id: "un-2", patientName: "Priya Sharma", patientId: "p-59318", encounterLabel: "Lab review · Jul 15", ageLabel: "4 days unsigned" },
];

/**
 * Effective demo weekday: the calendar template covers Mon–Fri; on a
 * weekend the brief shows Monday's template with an explicit note.
 */
export function effectiveWeekday(now = new Date()): { weekday: number; isWeekendFallback: boolean } {
  const js = now.getDay(); // 0 Sun … 6 Sat
  if (js === 0 || js === 6) return { weekday: 1, isWeekendFallback: true };
  return { weekday: js, isWeekendFallback: false };
}

export function todaysAppointments(weekday: number): TodayAppointment[] {
  const cal = getCalendar();
  return cal.appointments
    .filter((a) => a.weekday === weekday && a.type !== "break")
    .sort((a, b) => a.start - b.start)
    .map((appt) => ({
      appt,
      override: getApptOverride(appt.id),
      telehealth: telehealthReadiness(appt),
      balanceMinor: appt.patientId ? patientLedger(appt.patientId).balanceMinor : 0,
      hasAlerts: appt.patientId === "p-78435" || appt.patientId === "p-59318",
    }));
}

export interface TodayData {
  weekday: number;
  isWeekendFallback: boolean;
  schedule: TodayAppointment[];
  arrivals: TodayAppointment[];
  telehealthPending: TodayAppointment[];
  unreadThreads: InboxThread[];
  scheduleRequests: InboxThread[];
  tasksDue: QueueItem[];
  sessionTasks: SessionQueueItem[];
  openTaskCount: number;
  labReviews: QueueItem[];
  approvals: QueueItem[];
  unsignedNotes: UnsignedNote[];
  wearableAlerts: WearableAlert[];
  failedSyncs: SyncLogEntry[];
  attention: { id: string; title: string; sub: string; href: string; tone: "critical" | "warning" | "slate" }[];
}

/** Client hook — subscribes to every session store the brief reads. */
export function useTodayData(): TodayData {
  // Subscriptions (values partly unused directly; they drive recompute).
  useApptSession();
  useSessionInvoices();
  const threads = useInboxThreads();
  const sessionTasks = useSessionQueueItems();
  const reviews = useReviewOutcomes();

  const { weekday, isWeekendFallback } = effectiveWeekday();
  const schedule = todaysAppointments(weekday);
  const arrivals = schedule.filter(
    (s) => s.override?.status === "arrived" || s.override?.status === "checked-in",
  );
  const telehealthPending = schedule.filter(
    (s) => s.appt.type === "telehealth" && !s.telehealth.ready && s.override?.status !== "cancelled",
  );

  const openThreads = threads.filter((t) => t.status === "open");
  const unreadThreads = openThreads.filter((t) => t.unread);
  const scheduleRequests = openThreads.filter((t) => t.kind === "schedule-request");

  const queue = getTaskQueue();
  const resolvedKeys = new Set(
    Object.entries(reviews)
      .filter(([k, o]) => k.startsWith("queue:") && (o === "resolved" || o === "snoozed"))
      .map(([k]) => k.slice("queue:".length)),
  );
  const openQueue = queue.filter((q) => !resolvedKeys.has(q.id));
  const tasksDue = openQueue.filter((q) => q.dueInDays <= 0).slice(0, 6);
  const labReviews = openQueue.filter(
    (q) => q.category === "new-lab" || q.category === "extraction-review",
  );
  const approvals = openQueue.filter(
    (q) =>
      q.category === "protocol-approval" ||
      q.category === "experiment-approval" ||
      q.category === "refill-request",
  );

  const failedSyncs = getFailedSyncs();

  const attention: TodayData["attention"] = [];
  for (const w of WEARABLE_ALERTS.filter((w) => w.severity === "critical")) {
    attention.push({
      id: w.id,
      title: w.title,
      sub: `${w.patientName} · ${w.atLabel}`,
      href: patientPath(w.patientId, "tracking") + "?view=wearables",
      tone: "critical",
    });
  }
  for (const m of MEMBERSHIPS.filter((m) => m.status === "past_due")) {
    attention.push({
      id: m.id,
      title: `Membership past due — ${m.name}`,
      sub: `${m.patientName} · ${m.nextChargeLabel}`,
      href: "/billing?tab=subscriptions",
      tone: "warning",
    });
  }
  for (const s of failedSyncs) {
    attention.push({
      id: s.id,
      title: `Sync failed — ${s.connector}`,
      sub: s.counts,
      href: "/integrations?tab=sync-log",
      tone: "warning",
    });
  }

  return {
    weekday,
    isWeekendFallback,
    schedule,
    arrivals,
    telehealthPending,
    unreadThreads,
    scheduleRequests,
    tasksDue,
    sessionTasks,
    openTaskCount: openQueue.length + sessionTasks.length,
    labReviews,
    approvals,
    unsignedNotes: UNSIGNED_NOTES,
    wearableAlerts: WEARABLE_ALERTS,
    failedSyncs,
    attention,
  };
}
