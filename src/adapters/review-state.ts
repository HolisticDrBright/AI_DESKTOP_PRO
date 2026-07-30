"use client";

import { useSyncExternalStore } from "react";

/**
 * In-memory optimistic review state — the clinical replacement for the demo
 * session store on live mutation paths.
 *
 * WHAT THIS IS: a transient UI mirror. When a practitioner settles a review
 * (marker reviewed, queue item resolved), the mutation goes to the backend and
 * the row there is the record; this map only lets the button flip immediately
 * and roll back if the RPC fails. On reload the screen re-reads the live rows.
 *
 * WHAT THIS IS NOT: storage. Nothing here touches `sessionStorage` or any
 * other persistence — clinical review state must never live in the browser
 * beyond the render that is optimistically showing it. That is the difference
 * from the demo's `session-store.ts`, which persisted review outcomes so a
 * demo visitor's clicks survived reloads. Real outcomes survive reloads by
 * being in the database.
 */

export type ReviewOutcome =
  | "approved"
  | "accepted"
  | "rejected"
  | "dismissed"
  | "flagged"
  | "reviewed"
  | "resolved"
  | "snoozed";

let outcomes: Record<string, ReviewOutcome> = {};

const listeners = new Set<() => void>();
function emit() {
  for (const l of listeners) l();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setReviewOutcome(key: string, outcome: ReviewOutcome): void {
  outcomes = { ...outcomes, [key]: outcome };
  emit();
}

export function getReviewOutcome(key: string): ReviewOutcome | undefined {
  return outcomes[key];
}

export function removeReviewOutcome(key: string): void {
  if (!(key in outcomes)) return;
  const next = { ...outcomes };
  delete next[key];
  outcomes = next;
  emit();
}

export function getReviewSnapshot(): Record<string, ReviewOutcome> {
  return outcomes;
}

const EMPTY: Record<string, ReviewOutcome> = Object.freeze({});

export function useReviewOutcome(key: string): ReviewOutcome | undefined {
  return useSyncExternalStore(
    subscribe,
    () => outcomes[key],
    () => undefined,
  );
}

export function useReviewOutcomes(): Record<string, ReviewOutcome> {
  return useSyncExternalStore(
    subscribe,
    () => outcomes,
    () => EMPTY,
  );
}
