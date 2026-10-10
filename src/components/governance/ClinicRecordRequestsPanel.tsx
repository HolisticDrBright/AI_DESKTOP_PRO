"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { ClinicRecordRequestRecord, ClinicRecordWorkforceRequest, ClinicRecordWorkforceResponse } from "@/contracts/clinicRecordRequests";

import { ClinicRecordRequestsView, type ClinicRecordQueueState, type ClinicRecordReview } from "./ClinicRecordRequestsView";

/**
 * Loads the clinic's patient record requests and answers one.
 *
 * Every decision carries the revision the practitioner looked at and a decision
 * id minted when they confirm, so a retry after a lost response replays the
 * same decision and a stale screen is refused rather than applied twice. A
 * refusal or a declined correction needs written words, prompted for, never
 * defaulted. The patient's text is cleared when the session is lost.
 */
type Queue = Extract<ClinicRecordWorkforceResponse, { action: "queue" }>;

async function post(request: ClinicRecordWorkforceRequest) {
  const response = await fetch("/api/live/clinic-records", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request }), cache: "no-store",
  });
  const payload = await response.json().catch(() => ({})) as { data?: unknown; error?: string };
  if (!response.ok) throw new Error(payload.error ?? "service_unavailable");
  return payload.data;
}
const uuid = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : "00000000-0000-4000-8000-000000000000");

export function ClinicRecordRequestsPanel({ prompt, confirm }: { prompt?: (message: string) => string | null; confirm?: (message: string) => boolean } = {}) {
  // Resolved inside the handler, never as a default parameter: this component server-renders.
  const ask = prompt ?? ((message: string) => window.prompt(message));
  const sure = confirm ?? ((message: string) => window.confirm(message));
  const [requests, setRequests] = useState<ClinicRecordRequestRecord[] | null>(null);
  const [review, setReview] = useState<ClinicRecordReview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One decision id per confirmed decision: the same id is replayed on retry, never re-minted.
  const decisions = useRef(new Map<string, string>());

  const fail = useCallback((cause: unknown) => {
    const code = cause instanceof Error ? cause.message : "service_unavailable";
    setError(code);
    // Lost authorization removes the patient's text from the screen.
    if (code === "reauth_required" || code === "identity_refused") { setRequests([]); setReview(null); }
  }, []);
  const load = useCallback(async () => {
    setError(null);
    try {
      const queue = await post({ action: "queue", limit: 100 }) as Queue;
      setRequests(queue.requests);
    } catch (cause) { fail(cause); }
  }, [fail]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const clear = () => { if (document.visibilityState === "hidden") setReview(null); };
    document.addEventListener("visibilitychange", clear);
    return () => document.removeEventListener("visibilitychange", clear);
  }, []);

  const open = useCallback(async (requestId: string) => {
    setBusy(true); setError(null);
    try { setReview(await post({ action: "review", requestId }) as ClinicRecordReview); }
    catch (cause) { fail(cause); }
    finally { setBusy(false); }
  }, [fail]);
  const decide = useCallback(async (request: ClinicRecordRequestRecord, build: (decisionId: string) => ClinicRecordWorkforceRequest) => {
    const key = `${request.requestId}:${request.revision}`;
    const decisionId = decisions.current.get(key) ?? uuid();
    decisions.current.set(key, decisionId);
    setBusy(true); setError(null);
    try { await post(build(decisionId)); decisions.current.delete(key); await load(); await open(request.requestId); }
    catch (cause) { fail(cause); }
    finally { setBusy(false); }
  }, [fail, load, open]);

  const state: ClinicRecordQueueState = {
    requests, review, busy, error,
    onRefresh: () => void load(),
    onOpen: (requestId) => void open(requestId),
    onBeginReview: (r) => void decide(r, (decisionId) => ({ action: "begin_review", requestId: r.requestId, expectedRevision: r.revision, decisionId })),
    onFulfill: (r, include, excluded) => {
      if (!sure(`Prepare a copy for this patient with: ${include.join(", ")}? Only signed and reviewed records are included; the copy is a snapshot taken now.`)) return;
      void decide(r, (decisionId) => ({ action: "fulfill", requestId: r.requestId, expectedRevision: r.revision, decisionId, sections: include as never, excluded: excluded as never }));
    },
    onRefuse: (r) => {
      const reason = ask("Why is this copy request refused? The patient will see this.")?.trim();
      if (!reason) return;
      void decide(r, (decisionId) => ({ action: "refuse", requestId: r.requestId, expectedRevision: r.revision, decisionId, reasonCode: "other", reason }));
    },
    onAmend: (r) => {
      const content = ask("Addendum text. It is appended to the signed note with your name and the signed version; the original is never rewritten.")?.trim();
      if (!content) return;
      if (!sure("Append this addendum to the signed note and mark the correction accepted?")) return;
      void decide(r, (decisionId) => ({ action: "amend", requestId: r.requestId, expectedRevision: r.revision, decisionId, addendumReason: "Patient correction request accepted", addendumContent: content }));
    },
    onDecline: (r) => {
      const reason = ask("Why does the record stand as signed? The patient will see this, and their disagreement stays recorded.")?.trim();
      if (!reason) return;
      void decide(r, (decisionId) => ({ action: "decline", requestId: r.requestId, expectedRevision: r.revision, decisionId, reasonCode: "record_accurate", reason }));
    },
  };
  return <ClinicRecordRequestsView state={state} />;
}
