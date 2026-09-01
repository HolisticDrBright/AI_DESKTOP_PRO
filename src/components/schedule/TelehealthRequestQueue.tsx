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
  priceMinor: number;
  cancellationFeeDueMinor: number;
  paymentAuthorizationStatus: "not_authorized" | "authorized" | "withdrawn";
  paymentStatus: "not_due" | "processing" | "paid" | "failed" | "refunded" | "partially_refunded";
  paidMinor: number;
  refundedMinor: number;
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
  const [slotStart, setSlotStart] = useState("");
  const [price, setPrice] = useState("");
  const [publishing, setPublishing] = useState(false);

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

  const publishOpening = async () => {
    const start = new Date(slotStart); const amount = Math.round(Number(price) * 100);
    if (!slotStart || !Number.isFinite(start.getTime()) || !Number.isInteger(amount) || amount < 0) { setError("Enter a valid future start time and visit price."); return; }
    const end = new Date(start.getTime() + 45 * 60_000); setPublishing(true); setError(null);
    try { const response = await fetch("/api/live/telehealth-slots", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ start: start.toISOString(), end: end.toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Los_Angeles", visitTypes: ["initial","follow_up","urgent_question"], priceMinor: amount, currency: "USD", cancellationPolicy: "Cancel or reschedule at least 24 hours before the appointment to avoid the visit fee.", cancellationWindowHours: 24 }) }); const body = await response.json(); if (!response.ok) throw new Error(messageFrom(body,"The opening could not be published.")); setSlotStart(""); setPrice(""); }
    catch(reason){setError(reason instanceof Error?reason.message:"The opening could not be published.");} finally {setPublishing(false);}
  };

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

  const paymentAction = async (row: Row, kind: "charge" | "refund") => {
    const amountMinor = kind === "charge" ? (row.cancellationFeeDueMinor || row.priceMinor) : row.paidMinor - row.refundedMinor;
    if (amountMinor < 1) return;
    const message = kind === "charge" ? `Confirm the visit was delivered and charge ${(amountMinor/100).toFixed(2)} in Stripe test mode?` : `Issue a full test-mode refund of ${(amountMinor/100).toFixed(2)}?`;
    if (!window.confirm(message)) return;
    setBusyId(row.requestId); setError(null);
    try { const response = await fetch("/api/live/telehealth-payments", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: row.requestId, action: kind, expectedVersion: row.version, amountMinor,
        ...(kind === "charge" ? { serviceDelivered: row.cancellationFeeDueMinor === 0 } : { reason: "Full refund approved in Desktop telehealth queue." }) }) });
      const body = await response.json(); if (!response.ok) throw new Error(messageFrom(body, "The payment action was not completed.")); await refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The payment action was not completed."); }
    finally { setBusyId(null); }
  };

  if (loading) return <p className="text-sm text-muted-foreground">Loading requests…</p>;

  return <div className="space-y-3">
    <section className="rounded-xl border bg-card p-4" aria-label="Publish patient-bookable opening">
      <h2 className="font-semibold">Publish an available telehealth time</h2>
      <p className="mt-1 text-xs text-muted-foreground">Only times published here appear in the patient app. Overlapping openings are refused.</p>
      <div className="mt-3 flex flex-wrap gap-2"><input aria-label="Opening start" type="datetime-local" value={slotStart} onChange={(event)=>setSlotStart(event.target.value)} className="rounded-lg border bg-background px-3 py-2 text-sm"/><input aria-label="Visit price" inputMode="decimal" placeholder="Price, e.g. 150" value={price} onChange={(event)=>setPrice(event.target.value)} className="w-40 rounded-lg border bg-background px-3 py-2 text-sm"/><button disabled={publishing} className="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-50" onClick={()=>void publishOpening()}>{publishing?"Publishing…":"Publish opening"}</button></div>
    </section>
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
        <div className="mt-3 rounded-lg border bg-muted/30 p-3 text-xs"><p className="font-semibold">Payment: {row.paymentStatus.replaceAll("_", " ")}</p><p className="mt-1 text-muted-foreground">Card authorization: {row.paymentAuthorizationStatus.replaceAll("_", " ")}</p>
          {row.paymentAuthorizationStatus === "authorized" && !["paid","processing","refunded"].includes(row.paymentStatus) ? <button disabled={busyId===row.requestId} className="mt-2 rounded-lg border px-3 py-2 font-semibold" onClick={()=>void paymentAction(row,"charge")}>{row.cancellationFeeDueMinor>0?"Charge cancellation fee":"Complete visit and charge test card"}</button>:null}
          {["paid","partially_refunded"].includes(row.paymentStatus) && row.paidMinor>row.refundedMinor ? <button disabled={busyId===row.requestId} className="mt-2 rounded-lg border px-3 py-2 font-semibold" onClick={()=>void paymentAction(row,"refund")}>Refund remaining test charge</button>:null}
        </div>
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
