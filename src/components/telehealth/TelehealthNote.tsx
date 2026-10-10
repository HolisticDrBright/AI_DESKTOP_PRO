"use client";

/**
 * Post-visit note — the TELEHEALTH visit record.
 *
 * The AI sections are Zoom AI Companion's summary, imported verbatim and
 * stored as NOT reviewed. The practitioner's own notes sit above them, every
 * AI section is editable, and action items are suggestions the practitioner
 * approves or dismisses. One signature stores all of it together and freezes
 * the note; the prior revision is kept. Until then nothing here is final or
 * patient-facing.
 *
 * This record is signed on the telehealth boundary. It is NOT the chart's
 * signed clinical note. Placing it in the chart is a separate, explicit
 * practitioner action ("Place in chart"): the signed record becomes an
 * UNSIGNED chart draft on the patient's telehealth encounter, under the chart's
 * own review and signature workflow, bound server-side to the exact signed
 * revision. Repeating the action never creates a second chart note
 * (docs/telehealth.md).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Download, FileInput, PenLine } from "lucide-react";
import { api } from "@/adapters";
import { isAdapterError } from "@/adapters/errors";
import { telehealthAccessLost } from "@/lib/telehealth-access-loss";
import type {
  TelehealthActionItem,
  TelehealthChartRecord,
  TelehealthChartTransfer,
  TelehealthDayVisit,
  TelehealthNoteSectionKey,
  TelehealthVisitNote,
} from "@/adapters/telehealth.types";
import { VISIT_NOTE_SECTIONS } from "@/adapters/telehealth.types";
import { Btn, BtnLink } from "@/components/ui/Btn";
import { Card, CardTitle } from "@/components/ui/bits";
import { ClinicalError, ClinicalLoading, ClinicalNote } from "@/components/ui/ClinicalStates";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { TextArea } from "@/components/ui/Field";
import { PageHeader } from "@/components/ui/PageHeader";
import { Pill } from "@/components/ui/Pill";
import { useFeedback } from "@/lib/feedback";
import {
  PhaseChip,
  fmtClock,
  fmtDateTime,
  fmtTime,
  isFullNote,
  loadVisitRow,
  patientLabel,
  viewerTimeZone,
  visitHref,
  visitPhase,
} from "./parts";

type LoadState = "loading" | "ready" | "error";

const EMPTY_SECTIONS: Record<TelehealthNoteSectionKey, string> = {
  summary: "",
  patient_reported: "",
  results_reviewed: "",
  plan_discussed: "",
};

export function TelehealthNoteScreen({ appointmentId, date }: { appointmentId: string; date: string }) {
  const router = useRouter();
  const { announce } = useFeedback();
  const [state, setState] = useState<LoadState>("loading");
  const [row, setRow] = useState<TelehealthDayVisit | null>(null);
  const [error, setError] = useState<{ message: string; signedOut: boolean } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [practitionerNotes, setPractitionerNotes] = useState("");
  const [sections, setSections] = useState<Record<TelehealthNoteSectionKey, string>>(EMPTY_SECTIONS);
  const [actionItems, setActionItems] = useState<TelehealthActionItem[]>([]);
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);
  const [confirmSign, setConfirmSign] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmTransfer, setConfirmTransfer] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const [transferError, setTransferError] = useState<string | null>(null);
  const accessEpoch = useRef(0);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  const dropOpenedNote = useCallback((e: unknown) => {
    if (!telehealthAccessLost(e)) return;
    accessEpoch.current += 1;
    setImporting(false);
    setSigning(false);
    setRow(null);
    setPractitionerNotes("");
    setSections(EMPTY_SECTIONS);
    setActionItems([]);
    setImportMessage(null);
    setActionError(null);
    setConfirmSign(false);
    setState("error");
    setError({ message: isAdapterError(e) ? e.message : "This record isn't available.", signedOut: isAdapterError(e) && e.code === "unauthenticated" });
  }, []);

  const adoptNote = (note: TelehealthVisitNote | null) => {
    setPractitionerNotes(note?.practitionerNotes ?? "");
    setSections(note?.aiSections ?? EMPTY_SECTIONS);
    setActionItems(note?.actionItems ?? []);
  };

  useEffect(() => {
    let cancelled = false;
    const epoch = accessEpoch.current;
    setState("loading");
    loadVisitRow(appointmentId, date)
      .then((result) => {
        if (cancelled || epoch !== accessEpoch.current) return;
        setRow(result);
        const note = result.visit?.note ?? null;
        adoptNote(isFullNote(note) ? note : null);
        setState("ready");
      })
      .catch((e: unknown) => {
        if (cancelled || epoch !== accessEpoch.current) return;
        dropOpenedNote(e);
        setError({
          message: isAdapterError(e) ? e.message : "This visit note could not be loaded.",
          signedOut: isAdapterError(e) && e.code === "unauthenticated",
        });
        setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [appointmentId, date, reloadKey, dropOpenedNote]);

  useEffect(() => () => { accessEpoch.current += 1; }, [appointmentId, date]);

  const importSummary = async () => {
    if (!row) return;
    const epoch = accessEpoch.current;
    setImporting(true);
    setImportMessage(null);
    setActionError(null);
    try {
      const result = await api.telehealth.importNote(row.appointmentId, date, viewerTimeZone());
      if (epoch !== accessEpoch.current) return;
      setRow({ ...row, visit: result.visit });
      const note = result.visit.note;
      if (result.summaryReady && isFullNote(note)) {
        setSections(note.aiSections);
        setActionItems(note.actionItems);
        if (!practitionerNotes) setPractitionerNotes(note.practitionerNotes);
        announce("AI Companion notes imported. Review before signing.");
      } else {
        setImportMessage("Zoom has not produced a usable AI Companion summary yet. It usually appears a few minutes after the meeting ends — try again shortly. Nothing was written.");
      }
    } catch (e) {
      if (epoch !== accessEpoch.current) return;
      dropOpenedNote(e);
      setActionError(isAdapterError(e) ? e.message : "The AI notes could not be imported.");
    } finally {
      if (epoch === accessEpoch.current) setImporting(false);
    }
  };

  const sign = async () => {
    if (!row?.visit?.note) return;
    const epoch = accessEpoch.current;
    setSigning(true);
    setActionError(null);
    try {
      const visit = await api.telehealth.signNote({
        appointmentId: row.appointmentId,
        date,
        timeZone: viewerTimeZone(),
        expectedVersion: row.visit.version,
        practitionerNotes,
        aiSections: sections,
        actionItems: actionItems.map((item) => ({ id: item.id, status: item.status })),
      });
      if (epoch !== accessEpoch.current) return;
      setRow({ ...row, visit });
      setConfirmSign(false);
      announce("Telehealth visit note signed and saved to the visit record.");
      router.refresh();
    } catch (e) {
      if (epoch !== accessEpoch.current) return;
      dropOpenedNote(e);
      setActionError(isAdapterError(e) ? e.message : "The note could not be signed.");
      setConfirmSign(false);
    } finally {
      if (epoch === accessEpoch.current) setSigning(false);
    }
  };

  /**
   * Place the SIGNED record in the chart as an UNSIGNED draft. The request
   * names the exact signed revision and digest this screen is showing, so a
   * stale screen is refused rather than transferred. Safe to repeat: a lost
   * response is settled by the chart's own receipt on the next attempt.
   */
  const transferToChart = async () => {
    const source = row?.visit?.chartTransferSource;
    if (!row || !source) return;
    const epoch = accessEpoch.current;
    setTransferring(true);
    setTransferError(null);
    try {
      const result = await api.telehealth.transferToChart({ appointmentId: row.appointmentId, sourceRevision: source.sourceRevision, sourceDigest: source.sourceDigest });
      if (epoch !== accessEpoch.current) return;
      const visit = await api.telehealth.note(row.appointmentId);
      if (epoch !== accessEpoch.current) return;
      setRow({ ...row, visit });
      setConfirmTransfer(false);
      announce(result.transfer?.state === "completed"
        ? "Telehealth visit note placed in the chart as an unsigned draft."
        : "The chart has not confirmed the transfer yet. Use Inspect to read the chart's receipt.");
      router.refresh();
    } catch (e) {
      if (epoch !== accessEpoch.current) return;
      dropOpenedNote(e);
      setTransferError(isAdapterError(e) ? e.message : "The note could not be placed in the chart.");
      setConfirmTransfer(false);
      // A failed round may have admitted the transfer, or the chart may hold the
      // receipt already: show the record's actual state so Inspect/Retry are offered.
      if (!telehealthAccessLost(e)) {
        try {
          const visit = await api.telehealth.note(row.appointmentId);
          if (epoch === accessEpoch.current) setRow({ ...row, visit });
        } catch { /* the error above stands */ }
      }
    } finally {
      if (epoch === accessEpoch.current) setTransferring(false);
    }
  };

  /** Read the chart's receipt back for a transfer that was admitted but not confirmed; never writes the chart. */
  const inspectTransfer = async () => {
    if (!row) return;
    const epoch = accessEpoch.current;
    setTransferring(true);
    setTransferError(null);
    try {
      const result = await api.telehealth.inspectTransfer(row.appointmentId);
      if (epoch !== accessEpoch.current) return;
      const visit = await api.telehealth.note(row.appointmentId);
      if (epoch !== accessEpoch.current) return;
      setRow({ ...row, visit });
      announce(result.transfer?.state === "completed"
        ? "The chart confirmed the transfer; the draft is linked below."
        : "The chart has no receipt for this transfer yet. Retry placing the note in the chart.");
    } catch (e) {
      if (epoch !== accessEpoch.current) return;
      dropOpenedNote(e);
      setTransferError(isAdapterError(e) ? e.message : "The chart's receipt could not be read.");
    } finally {
      if (epoch === accessEpoch.current) setTransferring(false);
    }
  };

  const pasteQuickNotes = () => {
    const quick = row?.visit?.quickNotes?.trim();
    if (!quick) return;
    setPractitionerNotes((current) => (current.trim() ? `${current.trimEnd()}\n\n${quick}` : quick));
  };

  if (state === "loading") {
    return (
      <section className="mx-auto max-w-[1000px] px-[22px] pt-[18px] pb-6">
        <ClinicalLoading label="Loading the visit note…" />
      </section>
    );
  }
  if (state === "error" || !row) {
    return (
      <section className="mx-auto max-w-[1000px] px-[22px] pt-[18px] pb-6">
        <PageHeader crumb="Workspace / Telehealth / Visit note" title="Visit note" />
        <ClinicalError
          message={error?.message ?? "This visit note could not be loaded."}
          onRetry={reload}
          actionHref={error?.signedOut ? "/login" : undefined}
          actionLabel={error?.signedOut ? "Sign in" : undefined}
        />
      </section>
    );
  }

  const visit = row.visit;
  const note = isFullNote(visit?.note ?? null) ? (visit?.note as TelehealthVisitNote) : null;
  const signed = note?.status === "signed";
  const phase = visitPhase(row, true);
  const meetingClosed = visit?.status === "ended";
  const shutdownPending = visit?.status === "ending";

  return (
    <section data-screen-label="Telehealth visit note" className="mx-auto max-w-[1000px] px-[22px] pt-[18px] pb-6">
      <PageHeader
        crumb="Workspace / Telehealth / Visit note"
        title={
          <span className="flex items-center gap-2">
            {patientLabel(row)} <PhaseChip phase={phase} />
          </span>
        }
        sub={`Visit ${fmtTime(row.startsAt)} – ${fmtTime(row.endsAt)}${visit?.endedAt ? ` · ended ${fmtDateTime(visit.endedAt)}` : ""}`}
        actions={
          <div className="flex items-center gap-2">
            <BtnLink href="/telehealth">Back to day</BtnLink>
            {!signed && (visit?.status === "in_visit" || shutdownPending) && <BtnLink href={visitHref(row)}>Back to visit</BtnLink>}
            {!signed && note && (
              <Btn variant="primary" onClick={() => setConfirmSign(true)} disabled={signing}>
                <PenLine size={13} strokeWidth={2} aria-hidden /> Sign note
              </Btn>
            )}
            {signed && visit?.chartTransferSource && row.patientId && visit.chartTransfer?.state !== "completed" && !visit.chartRecord?.transfer && (
              <Btn variant="primary" onClick={() => setConfirmTransfer(true)} disabled={transferring} data-testid="note-transfer">
                <FileInput size={13} strokeWidth={2} aria-hidden /> {visit.chartTransfer?.state === "admitted" ? "Retry placing in chart" : "Place in chart"}
              </Btn>
            )}
          </div>
        }
      />

      <ClinicalNote className="mb-3">
        <strong>Telehealth visit record.</strong> What is signed here is stored on the telehealth visit, with its
        prior revisions. It is not the chart&apos;s signed clinical note: once signed, <em>Place in chart</em> puts
        it on the patient&apos;s telehealth encounter as an unsigned draft for the chart&apos;s own review and signature.
      </ClinicalNote>

      {transferError && (
        <div data-testid="note-transfer-error" className="mb-3">
          <ClinicalError message={transferError} onRetry={visit?.chartTransfer?.state === "admitted" ? () => void inspectTransfer() : undefined} />
        </div>
      )}

      {visit && (signed || visit.chartTransfer) && <ChartTransferCard transfer={visit.chartTransfer ?? null} record={visit.chartRecord ?? null} patientId={row.patientId} busy={transferring} onInspect={() => void inspectTransfer()} onRetry={() => setConfirmTransfer(true)} />}

      {shutdownPending && (
        <div role="alert" data-testid="note-shutdown-pending" className="mb-3 rounded-[10px] border border-[rgba(214,84,74,0.4)] bg-critical-tint px-[13px] py-[10px] text-[12px] leading-[1.55] text-critical">
          <strong>Zoom has not confirmed the meeting stopped.</strong> You can write here, but the AI Companion summary
          cannot be imported and the visit is not ended until the shutdown is confirmed from the visit screen.
        </div>
      )}

      {!visit && (
        <ClinicalNote className="mb-3">
          This appointment has no visit record on the telehealth service yet. A note appears after the visit is
          started and ended from Desktop Pro.
        </ClinicalNote>
      )}

      {visit && !note && (
        <Card className="mb-3 p-4" data-testid="note-import">
          <CardTitle>AI Companion notes</CardTitle>
          <p className="mt-1 mb-3 text-[12.5px] leading-[1.5] text-body">
            Zoom&apos;s AI Companion writes the first draft of this note. Import it once the meeting has ended;
            it is stored as not reviewed and nothing in it is final until you sign. Importing re-checks the
            patient&apos;s consent to recording and AI notes.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Btn variant="primary" onClick={() => void importSummary()} disabled={importing || !meetingClosed}>
              <Download size={13} strokeWidth={2} aria-hidden /> {importing ? "Importing…" : "Import AI Companion notes"}
            </Btn>
            {!meetingClosed && <span className="text-[12px] text-subtle">Available once Zoom confirms the visit ended.</span>}
          </div>
          {importMessage && (
            <p role="status" className="mt-3 mb-0 rounded-lg border border-hairline-2 bg-surface px-3 py-2 text-[12px] text-subtle">
              {importMessage}
            </p>
          )}
        </Card>
      )}

      {actionError && (
        <p role="alert" data-testid="note-error" className="mb-3 rounded-lg border border-[rgba(214,84,74,0.3)] bg-critical-tint px-3 py-2 text-[12px] text-critical">
          {actionError}
        </p>
      )}

      {visit && (
        <div className="flex flex-col gap-3">
          <Card className="p-4">
            <div className="flex items-center justify-between gap-3">
              <CardTitle>Practitioner notes</CardTitle>
              {!signed && visit.quickNotes.trim() && (
                <Btn size="sm" onClick={pasteQuickNotes}>
                  Paste my quick notes from the call
                </Btn>
              )}
            </div>
            {signed ? (
              <p className="mt-2 mb-0 text-[12.5px] leading-[1.6] whitespace-pre-wrap text-body" data-testid="signed-practitioner-notes">
                {note?.practitionerNotes || "No practitioner notes recorded."}
              </p>
            ) : (
              <TextArea
                aria-label="Practitioner notes"
                className="mt-2 min-h-[120px]"
                value={practitionerNotes}
                onChange={(e) => setPractitionerNotes(e.target.value)}
                placeholder="Your assessment and anything the AI summary missed…"
              />
            )}
          </Card>

          {note && (
            <>
              <Card className="p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle>AI Companion notes</CardTitle>
                  <div className="flex items-center gap-2">
                    <Pill tone="ai">Zoom AI Companion · revision {note.revision}</Pill>
                    <Pill tone={signed ? "positive" : "warning"}>{signed ? "Reviewed and signed" : "Not reviewed"}</Pill>
                  </div>
                </div>
                <p className="mt-1 mb-3 text-[11.5px] text-subtle">
                  Imported {fmtDateTime(note.importedAt)}. Zoom&apos;s original text is kept alongside your edits. Zoom&apos;s
                  current summary arrives as one document and is shown whole under Summary as plain text; it is not
                  split into the sections below by any model.
                </p>
                <div className="flex flex-col gap-3">
                  {VISIT_NOTE_SECTIONS.map(({ key, label }) => (
                    <div key={key}>
                      <div className="mb-1 text-[11.5px] font-semibold text-subtle">{label}</div>
                      {signed ? (
                        <p className="m-0 text-[12.5px] leading-[1.6] whitespace-pre-wrap text-body">
                          {note.aiSections[key] || "Nothing recorded for this section."}
                        </p>
                      ) : (
                        <TextArea
                          aria-label={label}
                          className={key === "summary" ? "min-h-[160px]" : undefined}
                          value={sections[key]}
                          onChange={(e) => setSections((current) => ({ ...current, [key]: e.target.value }))}
                          placeholder="Nothing recorded for this section."
                        />
                      )}
                    </div>
                  ))}
                </div>
              </Card>

              <Card className="p-4">
                <CardTitle>Action items</CardTitle>
                <p className="mt-1 mb-2 text-[11.5px] text-subtle">
                  Suggested by the AI summary. Approving one records your decision; it does not create a task,
                  order, or appointment on its own.
                </p>
                {actionItems.length === 0 ? (
                  <p className="m-0 text-[12.5px] text-subtle">No action items were suggested.</p>
                ) : (
                  <ul className="m-0 list-none divide-y divide-hairline p-0">
                    {actionItems.map((item) => (
                      <li key={item.id} className="flex items-center justify-between gap-3 py-2">
                        <span className="text-[12.5px] text-body">{item.text}</span>
                        {signed ? (
                          <Pill tone={item.status === "approved" ? "positive" : item.status === "dismissed" ? "slate" : "warning"}>
                            {item.status}
                          </Pill>
                        ) : (
                          <span className="flex items-center gap-1">
                            {(["approved", "dismissed"] as const).map((status) => (
                              <Btn
                                key={status}
                                size="sm"
                                variant={item.status === status ? "primary" : "outline"}
                                onClick={() =>
                                  setActionItems((current) =>
                                    current.map((entry) =>
                                      entry.id === item.id ? { ...entry, status: entry.status === status ? "suggested" : status } : entry,
                                    ),
                                  )
                                }
                              >
                                {status === "approved" ? "Approve" : "Dismiss"}
                              </Btn>
                            ))}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </>
          )}

          <Card className="p-4">
            <CardTitle>Recording and flagged moments</CardTitle>
            <p className="mt-1 mb-2 text-[12px] leading-[1.5] text-body">
              {visit.providerMeetingId
                ? "The recording, if the meeting was recorded, stays in Zoom under the practice account and its retention settings. Nothing is copied here."
                : "No meeting was opened for this visit."}
            </p>
            {visit.flags.length === 0 ? (
              <p className="m-0 text-[12px] text-subtle">No moments were flagged.</p>
            ) : (
              <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
                {visit.flags.map((flag, index) => (
                  <li key={`${flag.atSeconds}-${index}`} className="rounded-full bg-ai-tint px-[9px] py-[3px] text-[11px] font-semibold text-ai-deep">
                    {fmtClock(flag.atSeconds)} · {flag.label}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {visit.noteHistory.length > 0 && (
            <Card className="p-4">
              <CardTitle>Prior revisions</CardTitle>
              <ul className="m-0 mt-2 list-none p-0 text-[12px] leading-[1.5] text-body">
                {visit.noteHistory.map((revision) => (
                  <li key={`${revision.revision}-${revision.importedAt}`}>
                    Revision {revision.revision} · {revision.status === "signed" ? "signed" : "not reviewed"} · imported{" "}
                    {fmtDateTime(revision.importedAt)}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {signed && note && (
            <div data-testid="note-signed">
              <ClinicalNote>
                Signed {fmtDateTime(note.signedAt)}. This telehealth visit note is frozen. Corrections are made in the
                chart: place the note in the chart, then amend the chart note with a reason — the original stays as
                signed here.
              </ClinicalNote>
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmTransfer}
        title="Place this signed note in the chart?"
        body="The signed telehealth visit record (reviewed AI sections, your notes and your action-item decisions) is placed on this patient's telehealth encounter as an UNSIGNED chart draft, with its provenance. It is reviewed and signed through the chart like any other note; your visit signature does not sign the chart. Approved action items are copied as text — no order, task or protocol change is created. Repeating this never creates a second chart note."
        confirmLabel={transferring ? "Placing…" : "Place in chart"}
        onConfirm={() => void transferToChart()}
        onCancel={() => setConfirmTransfer(false)}
      />

      <ConfirmDialog
        open={confirmSign}
        title="Sign this telehealth visit note?"
        body="Your practitioner notes, the reviewed AI sections and your action-item decisions are stored together on the telehealth visit and the note is frozen; the previous revision is kept. This is not a chart note. Approved action items are decisions only — tasks, orders and appointments are created separately."
        confirmLabel={signing ? "Signing…" : "Sign note"}
        onConfirm={() => void sign()}
        onCancel={() => setConfirmSign(false)}
      />
    </section>
  );
}

/**
 * The chart side of a signed telehealth record: nothing yet, an admitted
 * transfer the chart has not confirmed (inspect or retry — never a silent
 * second write), or the chart's receipt with a link to the encounter draft.
 */
function ChartTransferCard({ transfer, record, patientId, busy, onInspect, onRetry }: {
  transfer: TelehealthChartTransfer | null;
  record: TelehealthChartRecord | null;
  patientId: string | null;
  busy: boolean;
  onInspect: () => void;
  onRetry: () => void;
}) {
  const chart = record?.transfer ?? null;
  // The chart is the authority: its receipt means the draft exists even when
  // the visit record has not yet recorded it (a lost completion). That state is
  // shown as what it is — reconciled by Inspect, never by a second write.
  const reconciled = transfer?.state === "completed";
  const unreconciled = !reconciled && chart !== null;
  const completed = reconciled || unreconciled;
  const encounterId = transfer?.encounterId ?? chart?.encounterId ?? null;
  return (
    <div data-testid="note-chart-transfer" data-transfer-state={reconciled ? "completed" : unreconciled ? "unreconciled" : transfer?.state ?? "none"} className="mb-3">
    <Card>
      <CardTitle>Chart</CardTitle>
      {record?.legalHold && (
        <p className="mt-2 mb-0 text-[12px] leading-[1.5] text-critical"><strong>Legal hold.</strong> This patient&apos;s records are under a hold; nothing about this visit may be deleted while it stands.</p>
      )}
      {completed && encounterId && patientId ? (
        <div className="mt-2">
          <p className="m-0 text-[12.5px] leading-[1.55] text-ink">
            Placed in the chart {fmtDateTime(transfer?.transferredAt ?? chart?.transferredAt ?? null)} as an unsigned draft
            {chart?.noteStatus ? <> · chart note <strong>{chart.noteStatus.replace("_", " ")}</strong>{chart.noteCurrentVersion ? ` v${chart.noteCurrentVersion}` : ""}</> : null}.
          </p>
          <a
            href={`/patients/${patientId}/encounter/${encounterId}`}
            data-testid="note-chart-link"
            className="mt-1 inline-block rounded-lg px-2 py-[6px] text-[12.5px] font-semibold text-action hover:bg-[rgba(37,99,199,0.06)] focus-visible:outline-2 focus-visible:outline-action"
          >
            Open the chart draft ↗
          </a>
          <p className="mt-2 mb-0 text-[11.5px] leading-[1.5] text-subtle">
            Review, edit and sign it there. Corrections after signing are chart addenda with a reason; the original
            text and this visit record are kept.
          </p>
          {unreconciled && (
            <div className="mt-2" role="status">
              <p className="m-0 text-[12px] leading-[1.5] text-ink">
                <strong>Receipt not yet recorded on the visit.</strong> The chart confirms this draft, but the visit
                record did not receive the confirmation. Inspect records the chart&apos;s receipt; nothing is written to
                the chart again.
              </p>
              <Btn className="mt-2" onClick={onInspect} disabled={busy} data-testid="note-transfer-inspect">Inspect</Btn>
            </div>
          )}
        </div>
      ) : transfer?.state === "admitted" ? (
        <div className="mt-2" role="status">
          <p className="m-0 text-[12.5px] leading-[1.55] text-ink">
            <strong>Transfer not confirmed.</strong> A transfer of revision {transfer.sourceRevision} was admitted
            {" "}{fmtDateTime(transfer.admittedAt)} but the chart has not confirmed it. Inspect reads the chart&apos;s receipt;
            Retry repeats the same transfer — neither creates a second chart note.
          </p>
          <div className="mt-2 flex gap-2">
            <Btn onClick={onInspect} disabled={busy} data-testid="note-transfer-inspect">Inspect</Btn>
            <Btn variant="primary" onClick={onRetry} disabled={busy}>Retry</Btn>
          </div>
        </div>
      ) : (
        <p className="mt-2 mb-0 text-[12px] leading-[1.5] text-subtle">
          {patientId
            ? "Not in the chart yet. Use Place in chart to add it to the patient's telehealth encounter as an unsigned draft."
            : "This visit has no linked patient record, so it cannot be placed in a chart."}
        </p>
      )}
    </Card>
    </div>
  );
}
