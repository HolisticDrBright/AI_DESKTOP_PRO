"use client";

import { useCallback, useState } from "react";

import type { OutcomeReportResponse } from "@/contracts/practiceOutcomes";

import { PracticeOutcomeView, type PracticeOutcomeState } from "./PracticeOutcomeView";

/** The aggregate view over the practice's outcome ledger. Reads only counts. */
export function PracticeOutcomePanel() {
  const [report, setReport] = useState<OutcomeReportResponse | null>(null);
  const [groupBy, setGroupBy] = useState<PracticeOutcomeState["groupBy"]>(["treatment"]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/live/practice-outcomes", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ surface: "report", request: { action: "report", groupBy } }),
        signal: AbortSignal.timeout(25000),
      });
      const payload = await response.json().catch(() => ({})) as { data?: unknown; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "service_unavailable");
      setReport(payload.data as OutcomeReportResponse);
    } catch { setError("Those counts could not be read. Nothing has been changed."); }
    finally { setBusy(false); }
  }, [groupBy]);

  return <PracticeOutcomeView state={{
    report, groupBy, busy, error,
    // A changed breakdown invalidates the counts on screen, so they go rather than mislabel.
    onGroupBy: value => { setGroupBy(value); setReport(null); },
    onRun: () => void run(),
  }} />;
}
