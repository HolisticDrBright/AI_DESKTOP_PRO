"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { CalendarClock, Stethoscope } from "lucide-react";
import { Card } from "@/components/ui/bits";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ReasonDialog } from "./ReasonDialog";
import { RecordingScribePanel } from "./RecordingScribePanel";
import { NoteComposer, NOTE_TYPE_LABEL, type ComposerNoteType } from "./NoteComposer";

/**
 * Practitioner encounter workspace (live). Quiet and work-focused: header
 * with visit context + explicit state actions, a notes rail, and the
 * composer. Every state shown here is the server's state — the workspace
 * reloads its data after each transition.
 */

interface Encounter {
  encounterId: string;
  patientId: string;
  appointmentId: string | null;
  visitType: string | null;
  status: "scheduled" | "in_progress" | "completed" | "cancelled" | "entered_in_error";
  startedAt: string | null;
  endedAt: string | null;
  statusReason: string | null;
}

interface NoteSummary {
  noteId: string;
  noteType: ComposerNoteType;
  status: string;
  currentVersion: number;
  updatedAt: string;
}

const STATUS_LABEL: Record<Encounter["status"], string> = {
  scheduled: "Scheduled",
  in_progress: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
  entered_in_error: "Entered in error",
};

const NOTE_TYPES: ComposerNoteType[] = ["soap", "narrative", "follow_up", "adime", "patient_instructions"];

export function EncounterWorkspace({ encounterId, patientId }: { encounterId: string; patientId: string }) {
  const [encounter, setEncounter] = useState<Encounter | null>(null);
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [newNoteType, setNewNoteType] = useState<ComposerNoteType>("soap");
  const [creating, setCreating] = useState(false);
  const [completeOpen, setCompleteOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [errorOpen, setErrorOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/live/emr/encounter?encounterId=${encounterId}`);
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        setError(json.error?.message ?? "This encounter isn't available.");
        setLoading(false);
        return;
      }
      const json = (await res.json()) as { data: { encounter: Encounter; notes: NoteSummary[] } };
      if (json.data.encounter.patientId !== patientId) {
        setError("This encounter belongs to a different chart.");
        setLoading(false);
        return;
      }
      setEncounter(json.data.encounter);
      setNotes(json.data.notes);
      setLoading(false);
    } catch {
      setError("The encounter service is unreachable right now.");
      setLoading(false);
    }
  }, [encounterId, patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  const transition = async (status: "completed" | "cancelled" | "entered_in_error", reason?: string) => {
    setActionError(null);
    try {
      const res = await fetch("/api/live/emr/encounter", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ encounterId, status, reason }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        setActionError(json.error?.message ?? "Could not update the encounter.");
        return;
      }
      await load();
    } catch {
      setActionError("The encounter service is unreachable right now.");
    }
  };

  if (loading) return <Card className="px-4 py-4"><p className="m-0 text-[12.5px] text-subtle">Loading encounter…</p></Card>;
  if (error || !encounter) {
    return (
      <Card className="px-4 py-4">
        <p role="alert" className="m-0 text-[12.5px] font-medium text-critical">{error ?? "Encounter unavailable."}</p>
        <Link href={`/patients/${patientId}/timeline`} className="mt-2 inline-block text-[12px] font-semibold text-action hover:underline">
          Back to the timeline
        </Link>
      </Card>
    );
  }

  const open = encounter.status === "in_progress" || encounter.status === "completed";

  return (
    <div data-testid="encounter-workspace">
      {/* header */}
      <Card className="px-4 py-[12px]">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Stethoscope size={14} strokeWidth={2.2} aria-hidden className="text-brand" />
            <span className="text-[13.5px] font-bold text-ink">
              Encounter — {encounter.visitType ?? "visit"}
            </span>
            <span className="rounded-md border border-line px-[7px] py-[2px] text-[10.5px] font-bold tracking-[0.03em] text-body uppercase" data-testid="encounter-status">
              {STATUS_LABEL[encounter.status]}
            </span>
          </div>
          <div className="flex items-center gap-2 text-[11.5px] text-subtle">
            {encounter.startedAt && (
              <span>
                Started {new Date(encounter.startedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
              </span>
            )}
            {encounter.appointmentId && (
              <Link href="/calendar" className="flex items-center gap-1 font-semibold text-action hover:underline">
                <CalendarClock size={12} strokeWidth={2.2} aria-hidden />
                From appointment
              </Link>
            )}
          </div>
        </div>
        {encounter.status === "entered_in_error" && (
          <p role="alert" className="m-0 mt-2 rounded-lg bg-critical-tint px-3 py-[6px] text-[12px] font-medium text-critical">
            Entered in error{encounter.statusReason ? ` — ${encounter.statusReason}` : ""}. Retained for the record.
          </p>
        )}
        {encounter.status === "in_progress" && (
          <div className="mt-2 flex flex-wrap gap-2 border-t border-hairline pt-2 print:hidden">
            <button
              type="button"
              onClick={() => setCompleteOpen(true)}
              className="h-8 cursor-pointer rounded-lg border-none bg-action px-3 text-[12px] font-semibold text-white hover:bg-action-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            >
              Complete encounter
            </button>
            <button
              type="button"
              onClick={() => setCancelOpen(true)}
              className="h-8 cursor-pointer rounded-lg border border-line bg-card px-3 text-[12px] font-semibold text-body hover:border-line-hover focus-visible:outline-2 focus-visible:outline-action"
            >
              Cancel…
            </button>
            <button
              type="button"
              onClick={() => setErrorOpen(true)}
              className="ml-auto h-8 cursor-pointer rounded-lg border border-line bg-card px-3 text-[12px] font-semibold text-critical hover:border-critical focus-visible:outline-2 focus-visible:outline-action"
            >
              Entered in error…
            </button>
          </div>
        )}
        {actionError && (
          <p role="alert" className="m-0 mt-2 rounded-lg bg-critical-tint px-3 py-[6px] text-[12px] font-semibold text-critical">
            {actionError}
          </p>
        )}
      </Card>

      {/* notes rail + composer */}
      <div className="mt-3 grid grid-cols-[210px_minmax(0,1fr)] items-start gap-3 max-[900px]:grid-cols-1">
        <Card className="px-3 py-[12px] print:hidden">
          <div className="text-[10px] font-bold tracking-[0.04em] text-faint uppercase">Notes</div>
          <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0">
            {notes.map((n) => (
              <li key={n.noteId}>
                <button
                  type="button"
                  onClick={() => {
                    setCreating(false);
                    setActiveNoteId(n.noteId);
                  }}
                  className={`w-full cursor-pointer rounded-lg border px-2 py-[6px] text-left text-[12px] focus-visible:outline-2 focus-visible:outline-action ${
                    activeNoteId === n.noteId
                      ? "border-action bg-panel font-semibold text-ink"
                      : "border-line bg-card text-body hover:border-line-hover"
                  }`}
                >
                  {NOTE_TYPE_LABEL[n.noteType] ?? n.noteType}
                  <span className="block text-[10.5px] font-normal text-subtle">
                    {n.status.replace(/_/g, " ")} · v{n.currentVersion}
                  </span>
                </button>
              </li>
            ))}
            {notes.length === 0 && <li className="text-[11.5px] text-subtle">No notes yet.</li>}
          </ul>
          {open && (
            <div className="mt-3 border-t border-hairline pt-2">
              <label htmlFor="new-note-type" className="mb-[4px] block text-[10px] font-bold tracking-[0.04em] text-faint uppercase">
                New note
              </label>
              <div className="flex items-center gap-[6px]">
                <select
                  id="new-note-type"
                  value={newNoteType}
                  onChange={(e) => setNewNoteType(e.target.value as ComposerNoteType)}
                  className="h-7 min-w-0 flex-1 rounded-md border border-line bg-card px-1 text-[11.5px] text-body outline-none focus-visible:outline-2 focus-visible:outline-action"
                >
                  {NOTE_TYPES.map((t) => (
                    <option key={t} value={t}>{NOTE_TYPE_LABEL[t]}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => {
                    setActiveNoteId(null);
                    setCreating(true);
                  }}
                  className="h-7 cursor-pointer rounded-md border-none bg-action px-2 text-[11.5px] font-semibold text-white hover:bg-action-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                >
                  Start
                </button>
              </div>
            </div>
          )}
          <Link
            href={`/patients/${patientId}/timeline`}
            className="mt-3 block text-[11.5px] font-semibold text-action hover:underline"
          >
            Patient timeline →
          </Link>
        </Card>

        <Card className="px-4 py-[14px]">
          {creating ? (
            <NoteComposer
              key={`new-${newNoteType}`}
              encounterId={encounterId}
              noteId={null}
              noteType={newNoteType}
              encounterOpen={open}
              onNoteCreated={(id) => setActiveNoteId(id)}
              onStateChanged={() => void load()}
            />
          ) : activeNoteId ? (
            <NoteComposer
              key={activeNoteId}
              encounterId={encounterId}
              noteId={activeNoteId}
              noteType={notes.find((n) => n.noteId === activeNoteId)?.noteType ?? "soap"}
              encounterOpen={open}
              onNoteCreated={(id) => setActiveNoteId(id)}
              onStateChanged={() => void load()}
            />
          ) : (
            <p className="m-0 text-[12.5px] text-subtle">
              {notes.length > 0
                ? "Select a note, or start a new one from the rail."
                : open
                  ? "Start a note from the rail to begin documenting this visit."
                  : "No documentation was recorded for this encounter."}
            </p>
          )}
        </Card>
      </div>

      <RecordingScribePanel
        encounterId={encounterId}
        encounterOpen={open}
        onDraftCreated={(id) => {
          setCreating(false);
          setActiveNoteId(id);
          void load();
        }}
      />

      <ConfirmDialog
        open={completeOpen}
        title="Complete this encounter?"
        body="Completion ends the visit. Unsigned drafts stay editable until they are signed."
        confirmLabel="Complete encounter"
        onConfirm={() => {
          setCompleteOpen(false);
          void transition("completed");
        }}
        onCancel={() => setCompleteOpen(false)}
      />
      <ReasonDialog
        open={cancelOpen}
        title="Cancel this encounter?"
        body="The encounter is kept in the record as cancelled."
        confirmLabel="Cancel encounter"
        onConfirm={(reason) => {
          setCancelOpen(false);
          void transition("cancelled", reason);
        }}
        onCancel={() => setCancelOpen(false)}
      />
      <ReasonDialog
        open={errorOpen}
        title="Mark this encounter entered in error?"
        body="Use this when the encounter was opened on the wrong chart. It is retained and labeled — never deleted."
        confirmLabel="Mark entered in error"
        onConfirm={(reason) => {
          setErrorOpen(false);
          void transition("entered_in_error", reason);
        }}
        onCancel={() => setErrorOpen(false)}
      />
    </div>
  );
}
