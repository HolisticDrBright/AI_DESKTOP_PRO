"use client";

/**
 * Post-visit note.
 *
 * The AI sections are Zoom AI Companion's summary, imported verbatim and
 * stored as NOT reviewed. The practitioner's own notes sit above them, every
 * AI section is editable, and action items are suggestions the practitioner
 * approves or dismisses. One signature stores all of it together and freezes
 * the note. Until then nothing here is final or patient-facing.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Download, PenLine } from "lucide-react";
import { api } from "@/adapters";
import { isAdapterError } from "@/adapters/errors";
import type {
  TelehealthActionItem,
  TelehealthDayVisit,
  TelehealthNoteSectionKey,
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
import { PhaseChip, fmtClock, fmtDateTime, fmtTime, patientLabel, visitHref, visitPhase } from "./parts";

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

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    api.telehealth
      .visit(appointmentId, date)
      .then((result) => {
        if (cancelled) return;
        setRow(result);
        const note = result.visit?.note ?? null;
        setPractitionerNotes(note?.practitionerNotes ?? "");
        setSections(note?.aiSections ?? EMPTY_SECTIONS);
        setActionItems(note?.actionItems ?? []);
        setState("ready");
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError({
          message: isAdapterError(e) ? e.message : "This visit note could not be loaded.",
          signedOut: isAdapterError(e) && e.code === "unauthenticated",
        });
        setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [appointmentId, date, reloadKey]);

  const importSummary = async () => {
    if (!row) return;
    setImporting(true);
    setImportMessage(null);
    setActionError(null);
    try {
      const result = await api.telehealth.importNote(row.appointmentId);
      setRow({ ...row, visit: result.visit });
      if (result.summaryReady && result.visit.note) {
        setSections(result.visit.note.aiSections);
        setActionItems(result.visit.note.actionItems);
        if (!practitionerNotes) setPractitionerNotes(result.visit.note.practitionerNotes);
        announce("AI Companion notes imported. Review before signing.");
      } else {
        setImportMessage("Zoom has not produced the AI Companion summary yet. It usually appears a few minutes after the meeting ends — try again shortly.");
      }
    } catch (e) {
      setActionError(isAdapterError(e) ? e.message : "The AI notes could not be imported.");
    } finally {
      setImporting(false);
    }
  };

  const sign = async () => {
    if (!row?.visit?.note) return;
    setSigning(true);
    setActionError(null);
    try {
      const visit = await api.telehealth.signNote({
        appointmentId: row.appointmentId,
        expectedVersion: row.visit.version,
        practitionerNotes,
        aiSections: sections,
        actionItems: actionItems.map((item) => ({ id: item.id, status: item.status })),
      });
      setRow({ ...row, visit });
      setConfirmSign(false);
      announce("Visit note signed and saved to the record.");
      router.refresh();
    } catch (e) {
      setActionError(isAdapterError(e) ? e.message : "The note could not be signed.");
      setConfirmSign(false);
    } finally {
      setSigning(false);
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
  const note = visit?.note ?? null;
  const signed = note?.status === "signed";
  const phase = visitPhase(row, true);

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
            {!signed && visit?.status !== "ended" && <BtnLink href={visitHref(row)}>Back to visit</BtnLink>}
            {!signed && note && (
              <Btn variant="primary" onClick={() => setConfirmSign(true)} disabled={signing}>
                <PenLine size={13} strokeWidth={2} aria-hidden /> Sign note
              </Btn>
            )}
          </div>
        }
      />

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
            it is stored as not reviewed and nothing in it is final until you sign.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Btn variant="primary" onClick={() => void importSummary()} disabled={importing || visit.status !== "ended"}>
              <Download size={13} strokeWidth={2} aria-hidden /> {importing ? "Importing…" : "Import AI Companion notes"}
            </Btn>
            {visit.status !== "ended" && <span className="text-[12px] text-subtle">Available after the visit ends.</span>}
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
                  Imported {fmtDateTime(note.importedAt)}. Zoom&apos;s original text is kept alongside your edits.
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

          {signed && note && (
            <div data-testid="note-signed">
              <ClinicalNote>
                Signed {fmtDateTime(note.signedAt)}. This note is frozen; corrections are recorded as a new visit note.
              </ClinicalNote>
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmSign}
        title="Sign this visit note?"
        body="Your practitioner notes, the reviewed AI sections and your action-item decisions are stored together and the note is frozen. Approved action items are decisions only — tasks, orders and appointments are created separately."
        confirmLabel={signing ? "Signing…" : "Sign note"}
        onConfirm={() => void sign()}
        onCancel={() => setConfirmSign(false)}
      />
    </section>
  );
}
