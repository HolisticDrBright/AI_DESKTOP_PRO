"use client";

import { useCallback, useEffect, useState } from "react";

type Row = {
  requestId: string;
  consumerPersonId: string;
  status: "requested" | "awaiting_provider" | "scheduled" | "reschedule_requested" | "cancelled";
  visitType: string;
  preferredSlots: string[];
  timeZone: string;
  note: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  joinUrl: string | null;
  version: number;
  updatedAt: string;
};

function messageFrom(body: unknown, fallback: string) {
  if (body && typeof body === "object" && "message" in body && typeof body.message === "string") return body.message;
  return fallback;
}

export function TelehealthRequestQueue() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const response = await fetch("/api/live/telehealth-requests", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(messageFrom(body, "Appointment requests are unavailable."));
      setRows(Array.isArray(body) ? body : body.data ?? []);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Appointment requests are unavailable.");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const action = async (row: Row, kind: "schedule" | "reschedule" | "cancel", selectedSlot?: string) => {
    setBusyId(row.requestId); setError(null);
    try {
      const start = selectedSlot ? new Date(selectedSlot) : null;
      const end = start ? new Date(start.getTime() + 45 * 60_000) : null;
      const response = await fetch("/api/live/telehealth-requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: row.requestId,
          action: kind,
          expectedVersion: row.version,
          ...(start && end ? {
            scheduledStart: start.toISOString(),
            scheduledEnd: end.toISOString(),
            timeZone: row.timeZone,
          } : {}),
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(messageFrom(body, "The request was not changed."));
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The request was not changed.");
    } finally { setBusyId(null); }
  };

  if (loading) return <p className="text-sm text-muted-foreground">Loading requests…</p>;

  return <div className="space-y-3">
    {error ? <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div> : null}
    {rows.length === 0 ? <p className="text-sm text-muted-foreground">No appointment requests.</p> : rows.map((row) => {
      const canSchedule = row.status === "requested" || row.status === "reschedule_requested" || row.status === "awaiting_provider";
      const scheduleAction = row.scheduledStart ? "reschedule" : "schedule";
      return <article key={row.requestId} className="rounded-xl border bg-card p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="font-semibold capitalize">{row.visitType.replaceAll("_", " ")}</p>
            <p className="text-xs text-muted-foreground">Patient ref {row.consumerPersonId.slice(0, 8)}… · {row.status.replaceAll("_", " ")}</p>
          </div>
          <span className="rounded-full bg-muted px-2 py-1 text-xs">v{row.version}</span>
        </div>
        {row.note ? <p className="mt-3 text-sm">{row.note}</p> : null}
        {row.scheduledStart ? <p className="mt-3 text-sm font-medium">Selected: {new Date(row.scheduledStart).toLocaleString()}</p> : null}
        {row.joinUrl ? <a className="mt-3 inline-flex rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground" href={row.joinUrl} target="_blank" rel="noreferrer">Open meeting</a> : null}
        {canSchedule ? <div className="mt-4 space-y-2">
          <p className="text-xs font-semibold">Choose one of the patient’s preferred times</p>
          <div className="flex flex-wrap gap-2">
            {row.preferredSlots.map((slot) => <button key={slot} disabled={busyId === row.requestId} className="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-50" onClick={() => void action(row, scheduleAction, slot)}>{new Date(slot).toLocaleString()}</button>)}
          </div>
        </div> : null}
        {row.status !== "cancelled" ? <button disabled={busyId === row.requestId} className="mt-3 rounded-lg border px-3 py-2 text-xs font-semibold disabled:opacity-50" onClick={() => void action(row, "cancel")}>Cancel request</button> : null}
      </article>;
    })}
  </div>;
}
