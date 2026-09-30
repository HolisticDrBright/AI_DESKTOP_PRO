"use client";

import { useCallback, useEffect, useState } from "react";

import type { DisputeWorkforceResponse, RevisionWorkforceResponse } from "@/contracts/clinicalDisputes";

import { DisputeQueueView, type DisputeQueueState } from "./DisputeQueueView";

/**
 * Loads the contested records and the revision notices, and answers one.
 *
 * A resolution needs written words, and the words are prompted for rather than defaulted: a
 * canned answer to "this is not true of me" would be worse than no answer.
 */
type Disputes = Extract<DisputeWorkforceResponse, { action: "list" }>;
type Notices = Extract<RevisionWorkforceResponse, { action: "list" }>;

async function post(body: unknown) {
  const response = await fetch("/api/live/care-governance", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body), cache: "no-store",
  });
  const payload = await response.json().catch(() => ({})) as { data?: unknown; error?: string };
  if (!response.ok) throw new Error(payload.error ?? "service_unavailable");
  return payload.data;
}

export function DisputeQueuePanel({ prompt }: { prompt?: (message: string) => string | null } = {}) {
  // Resolved inside the handler, never as a default parameter: this component server-renders,
  // and touching `window` during render would crash the page before anyone clicked anything.
  const ask = prompt ?? ((message: string) => window.prompt(message));
  const [disputes, setDisputes] = useState<Disputes["disputes"] | null>(null);
  const [notices, setNotices] = useState<Notices["notices"] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [contested, announced] = await Promise.all([
        post({ surface: "disputes", request: { action: "list" } }) as Promise<Disputes>,
        post({ surface: "revisions", request: { action: "list" } }) as Promise<Notices>,
      ]);
      setDisputes(contested.disputes);
      setNotices(announced.notices);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "service_unavailable"); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const run = useCallback(async (request: unknown) => {
    setBusy(true); setError(null);
    try { await post({ surface: "disputes", request }); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "service_unavailable"); }
    finally { setBusy(false); }
  }, [load]);

  const state: DisputeQueueState = {
    disputes, notices, busy, error,
    onAcknowledge: (disputeId, expectedRevision) =>
      void run({ action: "acknowledge", disputeId, expectedRevision }),
    onResolve: (disputeId, expectedRevision, resolution) => {
      const clinicianResponse = ask("What should the patient be told? They will see this.")?.trim();
      if (!clinicianResponse) return;
      void run({ action: "resolve", disputeId, expectedRevision, resolution, clinicianResponse });
    },
  };
  return <DisputeQueueView state={state} />;
}
