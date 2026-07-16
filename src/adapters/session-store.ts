"use client";

import { useSyncExternalStore } from "react";
import type { ActionKind } from "./actions";

/**
 * Demo session store — the isolated boundary for mock, in-session state.
 *
 * Two concerns live here: the demo audit log and per-subject review outcomes.
 * Both are backed by `sessionStorage` so they survive route reloads within a
 * browser session but are cleared when the session ends — a demo, never a
 * pretend backend. Every consumer treats this as "demo — not persisted".
 *
 * This is the shape a real `api.actions.*` tRPC mutation + `audit_events`
 * table will replace: the components subscribe through the adapter facade and
 * the hooks below, not to sessionStorage directly.
 */

export type ReviewOutcome =
  | "approved"
  | "accepted"
  | "rejected"
  | "flagged"
  | "reviewed"
  | "resolved"
  | "snoozed";

export interface SessionAuditEntry {
  id: string;
  at: string;
  kind: ActionKind;
  subjectType: string;
  subjectLabel: string;
  patientName?: string;
  /** True when the action settles a review as practitioner-reviewed. */
  reviewed: boolean;
  outcome?: ReviewOutcome;
}

const AUDIT_KEY = "aidp:demo:audit";
const REVIEW_KEY = "aidp:demo:reviews";

const EMPTY_AUDIT: readonly SessionAuditEntry[] = Object.freeze([]);

let auditCache: SessionAuditEntry[] | null = null;
let reviewCache: Record<string, ReviewOutcome> | null = null;

const listeners = new Set<() => void>();
function emit() {
  for (const l of listeners) l();
}
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `id-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
  }
}

/* ------------------------------------------------------------------ audit */

function readAudit(): SessionAuditEntry[] {
  if (auditCache) return auditCache;
  if (typeof window === "undefined") return auditCache = [];
  try {
    auditCache = JSON.parse(window.sessionStorage.getItem(AUDIT_KEY) ?? "[]");
  } catch {
    auditCache = [];
  }
  return auditCache!;
}

function persistAudit(next: SessionAuditEntry[]) {
  auditCache = next;
  if (typeof window !== "undefined") {
    try {
      window.sessionStorage.setItem(AUDIT_KEY, JSON.stringify(next));
    } catch {
      /* quota / disabled storage — keep the in-memory mirror */
    }
  }
  emit();
}

/** Prepend an audit entry (newest first). Returns the stored entry. */
export function recordAuditEntry(
  e: Omit<SessionAuditEntry, "id" | "at"> & { at?: string },
): SessionAuditEntry {
  const entry: SessionAuditEntry = {
    id: newId(),
    at: e.at ?? new Date().toISOString(),
    kind: e.kind,
    subjectType: e.subjectType,
    subjectLabel: e.subjectLabel,
    patientName: e.patientName,
    reviewed: e.reviewed,
    outcome: e.outcome,
  };
  persistAudit([entry, ...readAudit()]);
  return entry;
}

export function listAuditEntries(): SessionAuditEntry[] {
  return readAudit();
}

export function clearAuditEntries() {
  persistAudit([]);
}

/* --------------------------------------------------------------- reviews */

function readReviews(): Record<string, ReviewOutcome> {
  if (reviewCache) return reviewCache;
  if (typeof window === "undefined") return reviewCache = {};
  try {
    reviewCache = JSON.parse(window.sessionStorage.getItem(REVIEW_KEY) ?? "{}");
  } catch {
    reviewCache = {};
  }
  return reviewCache!;
}

function persistReviews(next: Record<string, ReviewOutcome>) {
  reviewCache = next;
  if (typeof window !== "undefined") {
    try {
      window.sessionStorage.setItem(REVIEW_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  }
  emit();
}

/** Record a review outcome for a stable subject key (e.g. "snapshot:p-78435"). */
export function setReviewOutcome(key: string, outcome: ReviewOutcome) {
  persistReviews({ ...readReviews(), [key]: outcome });
}

export function getReviewOutcome(key: string): ReviewOutcome | undefined {
  return readReviews()[key];
}

export function getReviewSnapshot(): Record<string, ReviewOutcome> {
  return readReviews();
}

export function clearReviewOutcomes() {
  persistReviews({});
}

const EMPTY_REVIEWS: Readonly<Record<string, ReviewOutcome>> = Object.freeze({});

/* -------------------------------------------------- session queue items */

/**
 * Queue items ADDED during this demo session (e.g. "convert to task" from the
 * reasoning workspace). Merged into the tasks queue on render. Session-only.
 */
export interface SessionQueueItem {
  id: string;
  title: string;
  patientName: string;
  patientId: string;
  category: string;
  priority: "High" | "Medium" | "Low";
  createdAt: string;
  seeds: string[];
}

const QUEUE_ADD_KEY = "aidp:demo:queue-added";
let queueCache: SessionQueueItem[] | null = null;
const EMPTY_QUEUE: readonly SessionQueueItem[] = Object.freeze([]);

function readQueue(): SessionQueueItem[] {
  if (queueCache) return queueCache;
  if (typeof window === "undefined") return queueCache = [];
  try {
    queueCache = JSON.parse(window.sessionStorage.getItem(QUEUE_ADD_KEY) ?? "[]");
  } catch {
    queueCache = [];
  }
  return queueCache!;
}

export function addSessionQueueItem(
  item: Omit<SessionQueueItem, "id" | "createdAt">,
): SessionQueueItem {
  const entry: SessionQueueItem = { ...item, id: newId(), createdAt: new Date().toISOString() };
  queueCache = [entry, ...readQueue()];
  if (typeof window !== "undefined") {
    try {
      window.sessionStorage.setItem(QUEUE_ADD_KEY, JSON.stringify(queueCache));
    } catch { /* ignore */ }
  }
  emit();
  return entry;
}

export function listSessionQueueItems(): SessionQueueItem[] {
  return readQueue();
}

export function useSessionQueueItems(): SessionQueueItem[] {
  return useSyncExternalStore(
    subscribe,
    listSessionQueueItems,
    () => EMPTY_QUEUE as SessionQueueItem[],
  );
}

/* ----------------------------------------------------------------- hooks */

export function useAuditEntries(): SessionAuditEntry[] {
  return useSyncExternalStore(
    subscribe,
    listAuditEntries,
    () => EMPTY_AUDIT as SessionAuditEntry[],
  );
}

export function useReviewOutcome(key: string): ReviewOutcome | undefined {
  return useSyncExternalStore(
    subscribe,
    () => getReviewOutcome(key),
    () => undefined,
  );
}

export function useReviewOutcomes(): Record<string, ReviewOutcome> {
  return useSyncExternalStore(
    subscribe,
    getReviewSnapshot,
    () => EMPTY_REVIEWS as Record<string, ReviewOutcome>,
  );
}
