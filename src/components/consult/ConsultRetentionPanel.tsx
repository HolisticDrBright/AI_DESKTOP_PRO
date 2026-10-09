"use client";

import { useCallback, useEffect, useState } from "react";

import type { ConsultPurgeRefusal, ConsultRetentionResponse } from "@/contracts/consultRetention";

import { ConsultRetentionView, type ConsultRetentionState } from "./ConsultRetentionView";

type Settings = Extract<ConsultRetentionResponse, { action: "settings_read" }>;
type Pending = Extract<ConsultRetentionResponse, { action: "pending" }>;
type Swept = Extract<ConsultRetentionResponse, { action: "sweep" }>;
type Purged = Extract<ConsultRetentionResponse, { action: "purge" }>;

/** The practice's consult retention policy, and the sweep that applies it. */
export function ConsultRetentionPanel({ purgeRequestId }: { purgeRequestId?: string } = {}) {
  const [window, setWindow] = useState<number | null>(null);
  const [counts, setCounts] = useState<ConsultRetentionState["counts"]>(null);
  const [draftDays, setDraftDays] = useState("");
  const [lastRefusal, setLastRefusal] = useState<ConsultPurgeRefusal | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const post = useCallback(async (request: unknown) => {
    const response = await fetch("/api/live/consult-retention", {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request), signal: AbortSignal.timeout(25000),
    });
    const payload = await response.json().catch(() => ({})) as { data?: unknown; error?: string };
    if (!response.ok) throw new Error(payload.error ?? "service_unavailable");
    return payload.data;
  }, []);

  const load = useCallback(async () => {
    try {
      const settings = await post({ action: "settings_read" }) as Settings;
      setWindow(settings.purgeContactAfterDays);
      setDraftDays(settings.purgeContactAfterDays === null ? "" : String(settings.purgeContactAfterDays));
      const pending = await post({ action: "pending" }) as Pending;
      setCounts({ purgeable: pending.purgeable, stillHeld: pending.stillHeld, alreadyPurged: pending.alreadyPurged });
    } catch { setError("Your retention settings could not be read. Nothing has been changed."); }
  }, [post]);

  useEffect(() => { void load(); }, [load]);

  const setRetention = useCallback(async (days: number | null) => {
    setBusy(true); setError(null); setNotice(null); setLastRefusal(null);
    try {
      await post({ action: "settings_set", purgeContactAfterDays: days });
      setNotice(days === null
        ? "Saved. Nothing is erased automatically — enquiries keep their contact details until you erase them."
        : `Saved. Unanswered enquiries become erasable ${days} days after they arrive.`);
      await load();
    } catch { setError("That could not be saved. Your retention window is unchanged."); }
    finally { setBusy(false); }
  }, [load, post]);

  const sweep = useCallback(async () => {
    setBusy(true); setError(null); setNotice(null); setLastRefusal(null);
    try {
      const swept = await post({ action: "sweep" }) as Swept;
      setNotice(swept.skipped === "no_retention_window_is_set"
        ? "Nothing was erased: no retention window is set, and the sweep never invents one."
        : `Contact details erased on ${swept.purged} enquir${swept.purged === 1 ? "y" : "ies"}.`);
      await load();
    } catch { setError("The sweep could not run. Nothing was erased."); }
    finally { setBusy(false); }
  }, [load, post]);

  // One request, erased on request from the queue. The refusal is shown, not thrown.
  const purge = useCallback(async (requestId: string) => {
    setBusy(true); setError(null); setNotice(null); setLastRefusal(null);
    try {
      const result = await post({ action: "purge", requestId }) as Purged;
      if (result.purged) setNotice("Contact details erased. The enquiry itself is still on record.");
      else setLastRefusal(result.refusal);
      await load();
    } catch { setError("That could not be erased. Nothing was changed."); }
    finally { setBusy(false); }
  }, [load, post]);

  useEffect(() => { if (purgeRequestId) void purge(purgeRequestId); }, [purge, purgeRequestId]);

  return <ConsultRetentionView state={{
    window, counts, draftDays, lastRefusal, busy, error, notice,
    onDraftDays: setDraftDays, onSetWindow: days => void setRetention(days), onSweep: () => void sweep(),
  }} />;
}
