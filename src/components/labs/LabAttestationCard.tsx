"use client";
import { useEffect, useId, useRef, useState } from "react";
import {
  boundAttestation, labAttestationBoundReceipt, labAttestationRefusal, labAttestationReview, verifiedByView,
  type LabAttestationBoundReceipt, type LabAttestationRefusal, type LabAttestationReview,
} from "@/contracts/labAttestationReview";

/**
 * A reviewer's attestation of one clinic lab reading: the reading exactly as the clinic record stores it, beside the
 * transferred report whose SHA-256 the transfer recorded, with the four fields restated by the reviewer and the report
 * hashed in this browser. The report is never uploaded: it is read here only to compute its digest and to show it.
 *
 * What this screen never says on its own: "verified". Only the service's view, read back after the receipt, may say
 * it, and only when it names this receipt's attestation as current (`verifiedByView`). A receipt alone, a request in
 * flight or a lost reply shows as recorded-not-confirmed or as nothing verified.
 *
 * Loads only on an explicit request, and everything it holds belongs to one patient and one reading: the workspace
 * keys it by both, and a late answer for an earlier selection is dropped.
 */
type Code = LabAttestationRefusal | "reauth_required" | "service_unavailable";
type Phase =
  | { kind: "idle" } | { kind: "loading" }
  | { kind: "refused"; code: Code }
  | { kind: "ready"; view: LabAttestationReview };
type Submission =
  | { kind: "none" } | { kind: "sending" }
  | { kind: "refused"; code: Code }
  | { kind: "reading_back"; receipt: LabAttestationBoundReceipt }
  | { kind: "readback_failed"; receipt: LabAttestationBoundReceipt }
  | { kind: "settled"; receipt: LabAttestationBoundReceipt; view: LabAttestationReview };

const MAX_REPORT_BYTES = 25 * 1024 * 1024;
const ORIGIN_LABEL: Record<LabAttestationReview["transfer"]["origin"], string> = {
  uploaded_report_analysis: "Read from an uploaded report", owner_entered: "Entered by the patient",
  personal_import: "Imported from the patient's personal copy", not_recorded: "Not recorded (lab-result/1)",
};
const BLOCKED: Record<NonNullable<LabAttestationReview["blockedBy"]>, string> = {
  reading_superseded: "A corrected reading of this marker has replaced this one. Attest the correction instead.",
  document_unknown: "This reading names no report it was read from (a lab-result/1 transfer, or a value the patient entered or imported). There is nothing to compare it against, so it cannot be attested.",
  unit_unknown: "No unit was recorded for this reading. Unknown stays Unknown, and a reading without a unit cannot be attested.",
  reading_rejected: "This reading was rejected on review and cannot be attested.",
};
const LOAD_REFUSAL: Partial<Record<string, string>> = {
  lab_attestation_disabled: "Value attestation is not enabled for this clinic. This reading stays unverified.",
  lab_attestation_review_refused: "This reading is not available to you for attestation.",
  lab_attestation_refused: "You do not have access to attest readings for this clinic.",
  clinical_role_required: "Attesting a reading needs a clinical role in this clinic.",
  reauth_required: "Sign in again to review this reading.",
};
const SUBMIT_REFUSAL: Partial<Record<string, string>> = {
  ...LOAD_REFUSAL,
  lab_attestation_stale: "This reading changed after you opened it — another reviewer attested it, or its review state moved. Reload it and compare again.",
  lab_attestation_reading_superseded: "A corrected reading has replaced this one since you opened it. Nothing was recorded.",
  lab_attestation_mismatch: "The fields you restated do not match the clinic record. Nothing was recorded.",
  lab_attestation_document_mismatch: "The report you selected is not one this transfer recorded. Nothing was recorded.",
  lab_attestation_document_unknown: "This reading names no report it was read from. Nothing was recorded.",
  lab_attestation_unit_unknown: "No unit was recorded for this reading. Nothing was recorded.",
  lab_attestation_reading_rejected: "This reading was rejected on review. Nothing was recorded.",
  lab_attestation_conflict: "This request was already used for a different attestation. Reload and start again.",
  lab_attestation_invalid: "The attestation could not be read by the service. Nothing was recorded.",
};
const UNAVAILABLE_LOAD = "The attestation record could not be loaded. Nothing has been verified.";
const UNAVAILABLE_SUBMIT = "The attestation could not be recorded. Nothing has been verified.";

async function post(path: string, body: unknown, signal: AbortSignal): Promise<{ ok: true; data: unknown } | { ok: false; code: Code }> {
  try {
    const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store", signal });
    const payload = await response.json().catch(() => null) as { data?: unknown; error?: { code?: unknown } } | null;
    if (response.ok) return { ok: true, data: payload?.data };
    const code = payload?.error?.code;
    return { ok: false, code: typeof code === "string" && (labAttestationRefusal.safeParse(code).success || code === "reauth_required") ? code as Code : "service_unavailable" };
  } catch (error) {
    if (signal.aborted) throw error;
    return { ok: false, code: "service_unavailable" };
  }
}
async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}
const requestId = () => crypto.randomUUID();

export function LabAttestationCard({ patientId, observationId }: { patientId: string; observationId: string }) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [submission, setSubmission] = useState<Submission>({ kind: "none" });
  const [restated, setRestated] = useState({ marker: "", value: "", unit: "", observedAt: "" });
  const [outcome, setOutcome] = useState<"verified" | "refuted" | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [report, setReport] = useState<{ name: string; size: number; type: string; sha256: string | null; url: string | null; error: string | null } | null>(null);
  const attempt = useRef<string | null>(null);
  const fieldId = useId();
  const active = useRef<AbortController | null>(null);
  const preview = useRef<string | null>(null);
  useEffect(() => () => { active.current?.abort(); if (preview.current) URL.revokeObjectURL(preview.current); }, []);

  const begin = () => { active.current?.abort(); const controller = new AbortController(); active.current = controller; return controller; };
  async function load() {
    const controller = begin();
    setPhase({ kind: "loading" }); setSubmission({ kind: "none" }); attempt.current = null;
    setRestated({ marker: "", value: "", unit: "", observedAt: "" }); setOutcome(null); setConfirmed(false);
    try {
      const answer = await post("/api/live/lab-attestations/review", { patientId, observationId }, controller.signal);
      if (controller.signal.aborted) return;
      if (!answer.ok) { setPhase({ kind: "refused", code: answer.code }); return; }
      const view = labAttestationReview.safeParse(answer.data);
      if (!view.success || view.data.patientRecordId !== patientId || view.data.observationId !== observationId) { setPhase({ kind: "refused", code: "service_unavailable" }); return; }
      setPhase({ kind: "ready", view: view.data });
    } catch { /* superseded by a newer request or unmounted */ }
  }
  async function readBack(receipt: LabAttestationBoundReceipt, controller: AbortController) {
    setSubmission({ kind: "reading_back", receipt });
    const answer = await post("/api/live/lab-attestations/review", { patientId, observationId }, controller.signal);
    if (controller.signal.aborted) return;
    const view = answer.ok ? labAttestationReview.safeParse(answer.data) : null;
    if (!view?.success || view.data.patientRecordId !== patientId || view.data.observationId !== observationId) { setSubmission({ kind: "readback_failed", receipt }); return; }
    setPhase({ kind: "ready", view: view.data }); setSubmission({ kind: "settled", receipt, view: view.data });
  }
  async function submit(view: LabAttestationReview) {
    if (!report?.sha256 || !outcome || !confirmed) return;
    const controller = begin();
    // One request id per attempt: a retry after a lost reply is the same request, answered from its own record.
    attempt.current ??= requestId();
    let body;
    try {
      body = boundAttestation(view, { requestId: attempt.current, outcome, documentSha256: report.sha256,
        restated: { marker: restated.marker, value: Number(restated.value), unit: restated.unit, observedAt: restated.observedAt } });
    } catch { setSubmission({ kind: "refused", code: "lab_attestation_invalid" }); return; }
    setSubmission({ kind: "sending" });
    try {
      const answer = await post("/api/live/lab-attestations", body, controller.signal);
      if (controller.signal.aborted) return;
      if (!answer.ok) { setSubmission({ kind: "refused", code: answer.code }); return; }
      const receipt = labAttestationBoundReceipt.safeParse(answer.data);
      if (!receipt.success || receipt.data.observationId !== observationId || receipt.data.patientRecordId !== patientId) {
        setSubmission({ kind: "refused", code: "service_unavailable" }); return;
      }
      await readBack(receipt.data, controller);
    } catch { /* superseded or unmounted */ }
  }
  async function chooseReport(file: File | undefined) {
    if (preview.current) { URL.revokeObjectURL(preview.current); preview.current = null; }
    if (!file) { setReport(null); return; }
    const base = { name: file.name, size: file.size, type: file.type, sha256: null, url: null };
    if (file.size <= 0 || file.size > MAX_REPORT_BYTES) { setReport({ ...base, error: "Choose a report between 1 byte and 25 MB." }); return; }
    if (!["application/pdf", "image/jpeg", "image/png"].includes(file.type)) { setReport({ ...base, error: "Choose the report as a PDF, JPG or PNG." }); return; }
    try {
      const sha256 = await sha256Hex(file);
      const url = URL.createObjectURL(file); preview.current = url;
      setReport({ ...base, sha256, url, error: null });
    } catch { setReport({ ...base, error: "This report could not be read in the browser." }); }
  }

  const view = phase.kind === "ready" ? phase.view : null;
  const recorded = view?.transfer.documents ?? [];
  const reportMatches = Boolean(report?.sha256 && recorded.includes(report.sha256));
  const fieldMismatch = view ? {
    marker: restated.marker !== "" && restated.marker !== view.reading.marker,
    value: restated.value !== "" && Number(restated.value) !== view.reading.value,
    unit: restated.unit !== "" && restated.unit !== view.reading.unit,
    observedAt: restated.observedAt !== "" && Date.parse(restated.observedAt) !== Date.parse(view.reading.observedAt),
  } : null;
  const restatedComplete = Boolean(view && restated.marker && restated.value && restated.unit && restated.observedAt
    && fieldMismatch && !Object.values(fieldMismatch).some(Boolean) && Number.isFinite(Number(restated.value)));
  const busy = phase.kind === "loading" || submission.kind === "sending" || submission.kind === "reading_back";
  const canSubmit = Boolean(view?.attestable && reportMatches && restatedComplete && outcome && confirmed && !busy && submission.kind !== "settled");
  const verifiedNow = view ? verifiedByView(view) : false;
  const stateText = !view ? "" : verifiedNow ? "Verified — measured value only, from the clinic record. The reference range is not verified."
    : view.verification.state === "refuted" ? "Refuted — a reviewer recorded that the report does not show this reading."
      : "Not verified — needs human review.";

  return <section className="mt-3 border-t border-hairline pt-3 text-xs" aria-label="Value attestation">
    <h3 className="font-semibold">Value attestation</h3>
    <p>Compare this reading with the report it was read from. This attests the measured value only: it approves nothing clinically and never verifies a reference range.</p>
    <button type="button" disabled={busy} onClick={() => void load()} className="my-2 rounded border border-line px-3 py-2 disabled:opacity-50">
      {phase.kind === "loading" ? "Loading the clinic record…" : phase.kind === "idle" ? "Open value attestation" : "Reload value attestation"}
    </button>
    {phase.kind === "refused" ? <p role={phase.code === "lab_attestation_disabled" ? "status" : "alert"}>
      {LOAD_REFUSAL[phase.code] ?? UNAVAILABLE_LOAD}
    </p> : null}
    {view ? <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      <div role="group" aria-label="Clinic reading as stored">
        <h4 className="font-semibold">Clinic reading, as stored</h4>
        <dl className="grid grid-cols-2 gap-1">
          <dt>Marker</dt><dd>{view.reading.marker}</dd>
          <dt>Value</dt><dd>{view.reading.valueText}</dd>
          <dt>Unit</dt><dd>{view.reading.unit ?? "Unknown"}</dd>
          <dt>Draw time</dt><dd>{view.reading.observedAt}</dd>
          <dt>Review state</dt><dd>{view.reviewStatus}</dd>
          <dt>Laboratory flag</dt><dd>Not transferred</dd>
          {view.transfer.appAssessment ? <><dt>App&rsquo;s assessment</dt><dd>{view.transfer.appAssessment} (the app&rsquo;s, unreviewed — not a laboratory flag)</dd></> : null}
          <dt>Verification</dt><dd data-testid="attestation-state">{stateText}</dd>
        </dl>
      </div>
      <div role="group" aria-label="Transferred report">
        <h4 className="font-semibold">Transferred report</h4>
        <p>{view.transfer.contract} · {ORIGIN_LABEL[view.transfer.origin]}</p>
        {recorded.length ? <><p>Recorded SHA-256 of the report{recorded.length > 1 ? "s" : ""} this reading was read from:</p>
          <ul>{recorded.map(d => <li key={d} className="font-mono break-all">{d}</li>)}</ul></> : <p>No report digest was recorded.</p>}
        {view.attestable ? <label className="mt-2 block">Select the report you compared (stays in this browser; it is not uploaded)
          <input type="file" accept="application/pdf,image/jpeg,image/png" className="mt-1 block" disabled={busy}
            onChange={event => void chooseReport(event.currentTarget.files?.[0])}/></label> : null}
        {report ? <div className="mt-1">
          <p>{report.name} · {report.size} bytes</p>
          {report.error ? <p role="alert">{report.error}</p> : null}
          {report.sha256 ? <p>Selected file SHA-256: <span className="font-mono break-all">{report.sha256}</span></p> : null}
          {report.sha256 ? <p role="status">{reportMatches ? "This is a report the transfer recorded." : "This file is not any report the transfer recorded. It cannot be attested against."}</p> : null}
          {/* A local blob of the reviewer's own file: nothing for the image optimizer to fetch or cache. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {report.url && reportMatches && report.type.startsWith("image/") ? <img src={report.url} alt="Selected report" className="mt-1 max-h-64 border border-line"/> : null}
          {report.url && reportMatches && report.type === "application/pdf" ? <object data={report.url} type="application/pdf" aria-label="Selected report" className="mt-1 h-64 w-full border border-line">The PDF cannot be shown here; open your copy beside this panel.</object> : null}
        </div> : null}
      </div>
    </div> : null}
    {view && !view.attestable && view.blockedBy ? <p role="status" className="mt-2">{BLOCKED[view.blockedBy]}</p> : null}
    {view?.attestable ? <form className="mt-3" aria-label="Restate and attest" onSubmit={event => { event.preventDefault(); void submit(view); }}>
      <p>Type the reading exactly as the clinic record above shows it. The service compares each field with what it holds.</p>
      {([["marker", "Marker"], ["value", "Value"], ["unit", "Unit"], ["observedAt", "Draw time (as shown above)"]] as const).map(([key, label]) =>
        <div key={key} className="mt-1">
          <label htmlFor={`${fieldId}-${key}`}>{label}</label>
          <input id={`${fieldId}-${key}`} className="ml-2 rounded border border-line px-2 py-1" value={restated[key]} disabled={busy || submission.kind === "settled"}
            onChange={event => { const value = event.currentTarget.value; setRestated(r => ({ ...r, [key]: value })); attempt.current = null; }}/>
          {fieldMismatch?.[key] ? <span role="alert" className="ml-2">Does not match the clinic record.</span> : null}
        </div>)}
      <fieldset className="mt-2" disabled={busy || submission.kind === "settled"}>
        <legend>What does the selected report show?</legend>
        <label className="block"><input type="radio" name="attestation-outcome" checked={outcome === "verified"} onChange={() => { setOutcome("verified"); attempt.current = null; }}/> The same marker, value, unit and draw time</label>
        <label className="block"><input type="radio" name="attestation-outcome" checked={outcome === "refuted"} onChange={() => { setOutcome("refuted"); attempt.current = null; }}/> Something different from this reading</label>
      </fieldset>
      <label className="mt-2 block"><input type="checkbox" checked={confirmed} disabled={busy || submission.kind === "settled"} onChange={event => setConfirmed(event.currentTarget.checked)}/> I compared the four fields above with the report whose SHA-256 is shown.</label>
      <button type="submit" disabled={!canSubmit} className="mt-2 rounded border border-line px-3 py-2 disabled:opacity-50">
        {submission.kind === "sending" ? "Recording…" : submission.kind === "refused" && submission.code === "service_unavailable" ? "Try again" : "Record attestation"}
      </button>
    </form> : null}
    {submission.kind === "refused" ? <p role="alert" className="mt-2">{SUBMIT_REFUSAL[submission.code] ?? UNAVAILABLE_SUBMIT}</p> : null}
    {submission.kind === "reading_back" ? <p role="status" className="mt-2">Attestation recorded. Reading it back from the clinic record…</p> : null}
    {submission.kind === "readback_failed" ? <div className="mt-2"><p role="alert">Your attestation was recorded, but the clinic record could not be read back. Nothing is shown as verified until it is.</p>
      <button type="button" className="mt-1 rounded border border-line px-3 py-2" onClick={() => { const controller = begin(); void readBack(submission.receipt, controller).catch(() => undefined); }}>Read back again</button></div> : null}
    {submission.kind === "settled" ? <p role="status" className="mt-2">{
      verifiedByView(submission.view, submission.receipt) ? "Read back: the clinic record now shows this reading as verified (measured value only)."
        : submission.receipt.outcome === "refuted" && submission.view.verification.state === "refuted" && submission.view.verification.current === submission.receipt.attestationId
          ? "Read back: the clinic record now shows this reading as refuted."
          : "Read back: the clinic record does not show your attestation as current. Reload before relying on it."}</p> : null}
  </section>;
}
