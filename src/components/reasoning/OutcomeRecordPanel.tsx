"use client";

import { useCallback, useEffect, useState } from "react";

import type { OutcomeLedgerResponse } from "@/contracts/practiceOutcomes";

import { OutcomeRecordView, type OutcomeRecordDraft, type OutcomeRecordState }
  from "./OutcomeRecordView";

type Vocabulary = Extract<OutcomeLedgerResponse, { action: "vocabulary" }>;
type Recorded = Extract<OutcomeLedgerResponse, { action: "contribute" }>;

const EMPTY: OutcomeRecordDraft = { ageYears: "", sex: "not_recorded", conditionCodes: [],
  treatmentCode: "", outcomeCode: "improved", followupBand: "3_to_6_months" };

/** Recording one outcome for one linked patient. */
export function OutcomeRecordPanel({ connectionId }: { connectionId: string }) {
  const [vocabulary, setVocabulary] = useState<OutcomeRecordState["vocabulary"]>(null);
  const [draft, setDraft] = useState<OutcomeRecordDraft>(EMPTY);
  const [recorded, setRecorded] = useState<Recorded | null>(null);
  const [consentAbsent, setConsentAbsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const post = useCallback(async (request: unknown) => {
    const response = await fetch("/api/live/practice-outcomes", {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ surface: "ledger", request }),
      signal: AbortSignal.timeout(25000),
    });
    const payload = await response.json().catch(() => ({})) as { data?: unknown; error?: string };
    if (!response.ok) throw new Error(payload.error ?? "service_unavailable");
    return payload.data;
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const loaded = await post({ action: "vocabulary" }) as Vocabulary;
        if (alive) setVocabulary(loaded.codes);
      } catch { if (alive) setError("The codes this practice counts by could not be read."); }
    })();
    return () => { alive = false; };
  }, [post]);

  const record = useCallback(async () => {
    setBusy(true); setError(null); setConsentAbsent(false); setRecorded(null);
    try {
      setRecorded(await post({
        action: "contribute", connectionId, ageYears: Number(draft.ageYears), sex: draft.sex,
        conditionCodes: draft.conditionCodes, treatmentCode: draft.treatmentCode,
        outcomeCode: draft.outcomeCode, followupBand: draft.followupBand,
      }) as Recorded);
      setDraft(EMPTY);
    } catch (cause) {
      // The clinic distinguishes a missing research consent from every other refusal, and so does
      // this screen: it is the one the practitioner can actually do something about.
      if (cause instanceof Error && cause.message === "practice_outcome_refused") setConsentAbsent(true);
      else setError("That could not be recorded. Nothing was stored.");
    } finally { setBusy(false); }
  }, [connectionId, draft, post]);

  return <OutcomeRecordView state={{
    vocabulary, draft, recorded, consentAbsent, busy, error,
    onDraft: patch => setDraft(current => ({ ...current, ...patch })),
    onRecord: () => void record(),
  }} />;
}
