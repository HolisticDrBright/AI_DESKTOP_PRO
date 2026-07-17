"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, FileSignature, Printer } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ReasonDialog } from "./ReasonDialog";

/**
 * Clinical note composer (Phase 2 slice 1). Manual authoring, autosave with
 * optimistic concurrency, honest save states, conflict resolution, review →
 * sign → locked → addendum. The server is the authority for every state:
 * "Saved" appears ONLY after the backend confirms persistence, signed content
 * renders read-only from the authoritative version, and corrections are
 * append-only addenda.
 */

export type ComposerNoteType = "soap" | "narrative" | "follow_up" | "adime" | "patient_instructions";

const SECTION_SETS: Record<ComposerNoteType, { key: string; label: string }[]> = {
  soap: [
    { key: "S", label: "Subjective" },
    { key: "O", label: "Objective" },
    { key: "A", label: "Assessment" },
    { key: "P", label: "Plan" },
  ],
  adime: [
    { key: "A", label: "Assessment" },
    { key: "D", label: "Diagnosis (nutrition)" },
    { key: "I", label: "Intervention" },
    { key: "ME", label: "Monitoring & evaluation" },
  ],
  narrative: [{ key: "text", label: "Narrative" }],
  follow_up: [{ key: "text", label: "Follow-up note" }],
  patient_instructions: [{ key: "text", label: "Patient instructions (draft)" }],
};

export const NOTE_TYPE_LABEL: Record<ComposerNoteType, string> = {
  soap: "SOAP",
  narrative: "Narrative",
  follow_up: "Follow-up",
  adime: "ADIME (nutrition)",
  patient_instructions: "Patient instructions",
};

const PROVENANCE_TYPE_LABEL: Record<string, string> = {
  appointment: "Appointment",
  encounter: "This encounter",
  lab_observation: "Lab observation",
  lab_document: "Source document",
  patient_form: "Patient form",
  chart_item: "Chart item",
  practitioner_entered: "Practitioner-entered",
};

interface ProvenanceRef {
  sectionKey: string;
  refType: string;
  refId?: string | null;
  label: string;
}

interface NoteDetail {
  note: {
    noteId: string;
    status: "draft" | "ready_for_review" | "signed" | "amended" | "entered_in_error";
    noteType: ComposerNoteType;
    currentVersion: number;
    statusReason: string | null;
  };
  content: Record<string, string>;
  contentVersion: number;
  lastSavedAt: string | null;
  signature: { version: number; signedAt: string; attestation: string } | null;
  addenda: { addendumId: string; referencedVersion: number; reason: string; content: string; createdAt: string }[];
  provenance: ProvenanceRef[];
}

async function readError(res: Response): Promise<{ code: string; message: string }> {
  const json = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
  return {
    code: json.error?.code ?? "unknown",
    message: json.error?.message ?? "Something went wrong. Please try again.",
  };
}

const sectionCls =
  "w-full resize-y rounded-lg border border-line bg-card px-[10px] py-[8px] text-[13px] leading-[1.55] text-body outline-none focus-visible:outline-2 focus-visible:outline-action disabled:bg-transparent disabled:text-body";

export function NoteComposer({
  encounterId,
  noteId: initialNoteId,
  noteType,
  encounterOpen,
  onNoteCreated,
  onStateChanged,
}: {
  encounterId: string;
  noteId: string | null;
  noteType: ComposerNoteType;
  /** Whether the encounter still accepts documentation (in_progress/completed). */
  encounterOpen: boolean;
  onNoteCreated: (noteId: string) => void;
  onStateChanged: () => void;
}) {
  const [noteIdState, setNoteIdState] = useState(initialNoteId);
  const [status, setStatus] = useState<NoteDetail["note"]["status"]>("draft");
  const [statusReason, setStatusReason] = useState<string | null>(null);
  const [content, setContent] = useState<Record<string, string>>({});
  const [serverVersion, setServerVersion] = useState(0);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<NoteDetail | null>(null);
  const [signature, setSignature] = useState<NoteDetail["signature"]>(null);
  const [addenda, setAddenda] = useState<NoteDetail["addenda"]>([]);
  const [provenance, setProvenance] = useState<ProvenanceRef[]>([]);
  const [loading, setLoading] = useState(Boolean(initialNoteId));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [signOpen, setSignOpen] = useState(false);
  const [errorOpen, setErrorOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [addendumReason, setAddendumReason] = useState("");
  const [addendumText, setAddendumText] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [provSection, setProvSection] = useState("");
  const [provType, setProvType] = useState("practitioner_entered");
  const [provLabel, setProvLabel] = useState("");

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ content, provenance, serverVersion, noteId: noteIdState, dirty });
  latest.current = { content, provenance, serverVersion, noteId: noteIdState, dirty };

  const sections = SECTION_SETS[noteType];
  const editable = encounterOpen && (status === "draft" || status === "ready_for_review") && !conflict;

  const applyDetail = useCallback((d: NoteDetail) => {
    setNoteIdState(d.note.noteId);
    setStatus(d.note.status);
    setStatusReason(d.note.statusReason);
    setContent(d.content);
    setServerVersion(d.contentVersion);
    setSavedAt(d.lastSavedAt);
    setSignature(d.signature);
    setAddenda(d.addenda);
    setProvenance(d.provenance);
    setDirty(false);
  }, []);

  // Initial load / post-refresh recovery: the server's copy is authoritative.
  useEffect(() => {
    let alive = true;
    if (!initialNoteId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    fetch(`/api/live/emr/note?noteId=${initialNoteId}`)
      .then(async (res) => {
        if (!res.ok) throw new Error((await readError(res)).message);
        return res.json() as Promise<{ data: NoteDetail }>;
      })
      .then((json) => {
        if (!alive) return;
        applyDetail(json.data);
        setLoading(false);
      })
      .catch((e: Error) => {
        if (!alive) return;
        setLoadError(e.message);
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [initialNoteId, applyDetail]);

  const doSave = useCallback(
    async (saveKind: "autosave" | "manual") => {
      const snap = latest.current;
      setSaving(true);
      setSaveError(null);
      try {
        const res = await fetch("/api/live/emr/note", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            encounterId,
            noteType,
            content: snap.content,
            expectedVersion: snap.serverVersion,
            noteId: snap.noteId ?? undefined,
            saveKind,
            provenance: snap.provenance,
          }),
        });
        if (res.status === 409) {
          // The authoritative copy moved on — load it and let the
          // practitioner resolve side by side. Local edits are preserved.
          const authoritative = await fetch(`/api/live/emr/note?noteId=${snap.noteId}`);
          if (authoritative.ok) {
            const json = (await authoritative.json()) as { data: NoteDetail };
            setConflict(json.data);
          } else {
            setSaveError("This note changed elsewhere and the latest copy could not be loaded.");
          }
          return;
        }
        if (!res.ok) {
          setSaveError((await readError(res)).message);
          return;
        }
        const json = (await res.json()) as { data: { noteId: string; version: number; savedAt: string } };
        setServerVersion(json.data.version);
        setSavedAt(json.data.savedAt);
        setStatus("draft");
        if (!snap.noteId) {
          setNoteIdState(json.data.noteId);
          onNoteCreated(json.data.noteId);
        }
        // Edits made while the request was in flight stay unsaved.
        setDirty(latest.current.content !== snap.content || latest.current.provenance !== snap.provenance);
        onStateChanged();
      } catch {
        setSaveError("The save service is unreachable. Your text is still here — retry when connected.");
      } finally {
        setSaving(false);
      }
    },
    [encounterId, noteType, onNoteCreated, onStateChanged],
  );

  const scheduleAutosave = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (latest.current.dirty) void doSave("autosave");
    }, 1500);
  }, [doSave]);

  const edit = (key: string, value: string) => {
    setContent((c) => ({ ...c, [key]: value }));
    setDirty(true);
    setNotice(null);
    scheduleAutosave();
  };

  // Warn before closing with unsaved changes.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (latest.current.dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  const noteAction = async (payload: Record<string, unknown>, failLabel: string) => {
    setBusy(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/live/emr/note/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ noteId: noteIdState, ...payload }),
      });
      if (!res.ok) {
        setSaveError((await readError(res)).message);
        return null;
      }
      return (await res.json()) as { data: Record<string, unknown> };
    } catch {
      setSaveError(`${failLabel} — the service is unreachable.`);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const markReady = async () => {
    if (dirty) {
      await doSave("manual");
      if (latest.current.dirty) return; // save failed; keep editing state
    }
    const ok = await noteAction({ action: "ready" }, "Could not mark ready");
    if (ok) {
      setStatus("ready_for_review");
      setNotice("Marked ready for review.");
      onStateChanged();
    }
  };

  const sign = async () => {
    setSignOpen(false);
    const res = await noteAction(
      { action: "sign", expectedVersion: serverVersion },
      "Could not sign",
    );
    if (res) {
      const d = res.data as { alreadySigned: boolean; version: number; signedAt: string };
      setStatus("signed");
      setSignature({
        version: d.version,
        signedAt: d.signedAt,
        attestation: "I attest this note is accurate and complete.",
      });
      setNotice(d.alreadySigned ? "Already signed — no duplicate signature created." : "Note signed.");
      onStateChanged();
    }
  };

  const submitAddendum = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addendumReason.trim() || !addendumText.trim()) return;
    const res = await noteAction(
      { action: "addendum", reason: addendumReason.trim(), content: addendumText.trim() },
      "Could not add the addendum",
    );
    if (res) {
      setStatus("amended");
      setAddenda((a) => [
        ...a,
        {
          addendumId: String((res.data as { addendumId?: string }).addendumId ?? Math.random()),
          referencedVersion: signature?.version ?? serverVersion,
          reason: addendumReason.trim(),
          content: addendumText.trim(),
          createdAt: new Date().toISOString(),
        },
      ]);
      setAddendumReason("");
      setAddendumText("");
      setNotice("Addendum recorded. The original note is unchanged.");
      onStateChanged();
    }
  };

  const markErrorConfirmed = async (reason: string) => {
    setErrorOpen(false);
    const ok = await noteAction({ action: "error", reason }, "Could not mark entered in error");
    if (ok) {
      setStatus("entered_in_error");
      setStatusReason(reason);
      onStateChanged();
    }
  };

  const addProvenanceRef = () => {
    if (!provSection || !provLabel.trim()) return;
    setProvenance((p) => [
      ...p,
      { sectionKey: provSection, refType: provType, label: provLabel.trim() },
    ]);
    setProvLabel("");
    setDirty(true);
    scheduleAutosave();
  };

  const missingSections = useMemo(
    () => sections.filter((s) => !(content[s.key] ?? "").trim()).map((s) => s.label),
    [sections, content],
  );

  if (loading) return <p className="m-0 p-4 text-[12.5px] text-subtle">Loading note…</p>;
  if (loadError) {
    return (
      <p role="alert" className="m-0 rounded-lg bg-critical-tint p-3 text-[12.5px] font-medium text-critical">
        {loadError}
      </p>
    );
  }

  const saveState = saving
    ? "Saving…"
    : dirty
      ? "Unsaved changes"
      : savedAt
        ? `Saved ${new Date(savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · v${serverVersion}`
        : "Not saved yet";

  return (
    <div className="min-w-0" data-testid="note-composer">
      {/* status strip */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[12.5px] font-bold text-ink">{NOTE_TYPE_LABEL[noteType]} note</span>
          <span className="rounded-md border border-line px-[7px] py-[2px] text-[10.5px] font-bold tracking-[0.03em] text-body uppercase">
            {status.replace(/_/g, " ")}
          </span>
        </div>
        <span role="status" className="text-[11.5px] font-medium text-subtle" data-testid="save-state">
          {saveState}
        </span>
      </div>

      {status === "entered_in_error" && (
        <p role="alert" className="m-0 mb-3 rounded-lg bg-critical-tint px-3 py-[8px] text-[12px] font-medium text-critical">
          Entered in error{statusReason ? ` — ${statusReason}` : ""}. This note is retained for the record and excluded from active care.
        </p>
      )}

      {noteType === "patient_instructions" && status !== "entered_in_error" && (
        <p className="m-0 mb-3 rounded-lg border border-line bg-panel px-3 py-[8px] text-[11.5px] leading-[1.5] text-body">
          Patient-facing draft. Signing records it in the chart — it is <strong>not</strong> published
          to the patient; publication is a separate, reviewed step (later phase).
        </p>
      )}

      {/* conflict view */}
      {conflict && (
        <div className="mb-3 rounded-[12px] border border-[rgba(191,70,52,0.4)] bg-critical-tint p-3" data-testid="conflict-view">
          <p className="m-0 text-[12.5px] font-bold text-critical">
            This note changed in another tab or session (server has v{conflict.contentVersion}).
          </p>
          <p className="m-0 mt-1 text-[11.5px] leading-[1.5] text-body">
            Compare side by side, then choose which version to continue from. Nothing is lost until you choose.
          </p>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <div className="min-w-0 rounded-lg border border-line bg-card p-2">
              <div className="text-[10px] font-bold tracking-[0.04em] text-faint uppercase">Your unsaved copy</div>
              {sections.map((s) => (
                <p key={s.key} className="m-0 mt-1 text-[11.5px] leading-[1.45] whitespace-pre-wrap text-body">
                  <strong>{s.label}:</strong> {(content[s.key] ?? "").trim() || "—"}
                </p>
              ))}
            </div>
            <div className="min-w-0 rounded-lg border border-line bg-card p-2">
              <div className="text-[10px] font-bold tracking-[0.04em] text-faint uppercase">Server v{conflict.contentVersion}</div>
              {sections.map((s) => (
                <p key={s.key} className="m-0 mt-1 text-[11.5px] leading-[1.45] whitespace-pre-wrap text-body">
                  <strong>{s.label}:</strong> {(conflict.content[s.key] ?? "").trim() || "—"}
                </p>
              ))}
            </div>
          </div>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => {
                applyDetail(conflict);
                setConflict(null);
                setNotice("Continued from the server version.");
              }}
              className="h-8 cursor-pointer rounded-lg border border-line bg-card px-3 text-[12px] font-semibold text-body hover:border-line-hover focus-visible:outline-2 focus-visible:outline-action"
            >
              Use server version
            </button>
            <button
              type="button"
              onClick={() => {
                setServerVersion(conflict.contentVersion);
                setStatus(conflict.note.status);
                setConflict(null);
                setDirty(true);
                void doSave("manual");
              }}
              className="h-8 cursor-pointer rounded-lg border-none bg-action px-3 text-[12px] font-semibold text-white hover:bg-action-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            >
              Keep my edits (save over v{conflict.contentVersion})
            </button>
          </div>
        </div>
      )}

      {/* sections */}
      <div className="flex flex-col gap-[10px] print:gap-2">
        {sections.map((s) => (
          <div key={s.key}>
            <label
              htmlFor={`section-${s.key}`}
              className="mb-[4px] block text-[10px] font-bold tracking-[0.04em] text-faint uppercase"
            >
              {s.label}
            </label>
            {editable ? (
              <textarea
                id={`section-${s.key}`}
                value={content[s.key] ?? ""}
                onChange={(e) => edit(s.key, e.target.value)}
                rows={noteType === "soap" || noteType === "adime" ? 3 : 8}
                className={sectionCls}
              />
            ) : (
              <p className="m-0 min-h-[20px] rounded-lg border border-hairline bg-panel px-[10px] py-[8px] text-[13px] leading-[1.55] whitespace-pre-wrap text-body">
                {(content[s.key] ?? "").trim() || "—"}
              </p>
            )}
          </div>
        ))}
      </div>

      {/* missing info — real derived gaps, not decoration */}
      {editable && missingSections.length > 0 && (
        <p className="m-0 mt-2 text-[11px] text-subtle">
          Missing information: {missingSections.join(", ")}.
        </p>
      )}

      {saveError && (
        <p role="alert" className="m-0 mt-2 rounded-lg bg-critical-tint px-3 py-[8px] text-[12px] font-semibold text-critical">
          {saveError}{" "}
          <button
            type="button"
            onClick={() => void doSave("manual")}
            className="cursor-pointer border-none bg-transparent p-0 font-bold text-critical underline"
          >
            Retry save
          </button>
        </p>
      )}
      {notice && (
        <p role="status" className="m-0 mt-2 rounded-lg bg-positive-tint px-3 py-[8px] text-[12px] font-medium text-ink">
          {notice}
        </p>
      )}

      {/* actions */}
      {editable && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-hairline pt-3 print:hidden">
          <button
            type="button"
            disabled={saving || !dirty}
            onClick={() => void doSave("manual")}
            className="h-9 cursor-pointer rounded-lg border border-line bg-card px-3 text-[12.5px] font-semibold text-body hover:border-line-hover focus-visible:outline-2 focus-visible:outline-action disabled:opacity-50"
          >
            Save now
          </button>
          {status === "draft" && (
            <button
              type="button"
              disabled={busy || serverVersion < 1}
              onClick={() => void markReady()}
              className="flex h-9 cursor-pointer items-center gap-[6px] rounded-lg border border-line bg-card px-3 text-[12.5px] font-semibold text-body hover:border-line-hover focus-visible:outline-2 focus-visible:outline-action disabled:opacity-50"
            >
              <CheckCircle2 size={13} strokeWidth={2.2} aria-hidden />
              Ready for review
            </button>
          )}
          <button
            type="button"
            disabled={busy || serverVersion < 1 || dirty}
            onClick={() => setSignOpen(true)}
            className="flex h-9 cursor-pointer items-center gap-[6px] rounded-lg border-none bg-action px-3 text-[12.5px] font-semibold text-white hover:bg-action-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-50"
            title={dirty ? "Save before signing" : undefined}
          >
            <FileSignature size={13} strokeWidth={2.2} aria-hidden />
            Sign note
          </button>
          {noteIdState && (
            <button
              type="button"
              disabled={busy}
              onClick={() => setErrorOpen(true)}
              className="ml-auto h-9 cursor-pointer rounded-lg border border-line bg-card px-3 text-[12px] font-semibold text-critical hover:border-critical focus-visible:outline-2 focus-visible:outline-action disabled:opacity-50"
            >
              Entered in error…
            </button>
          )}
        </div>
      )}

      {/* signed read-only affordances */}
      {(status === "signed" || status === "amended") && signature && (
        <div className="mt-3 border-t border-hairline pt-3">
          <p className="m-0 text-[12px] text-body" data-testid="signature-line">
            <FileSignature size={12} strokeWidth={2.2} aria-hidden className="mr-1 inline-block align-[-1px]" />
            Signed at v{signature.version} ·{" "}
            {new Date(signature.signedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })} —{" "}
            <span className="text-subtle">&ldquo;{signature.attestation}&rdquo;</span>
          </p>
          <p className="m-0 mt-1 text-[11px] text-faint">
            Signed content is locked. Corrections are recorded below as addenda; the original never changes.
          </p>

          {addenda.length > 0 && (
            <ul className="m-0 mt-2 flex list-none flex-col gap-2 p-0" data-testid="addenda-list">
              {addenda.map((a) => (
                <li key={a.addendumId} className="rounded-lg border border-line bg-panel px-3 py-[8px]">
                  <div className="text-[10.5px] font-bold tracking-[0.03em] text-faint uppercase">
                    Addendum · re: v{a.referencedVersion} ·{" "}
                    {new Date(a.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
                  </div>
                  <div className="mt-[2px] text-[11.5px] font-semibold text-body">Reason: {a.reason}</div>
                  <p className="m-0 mt-[2px] text-[12.5px] leading-[1.5] whitespace-pre-wrap text-body">{a.content}</p>
                </li>
              ))}
            </ul>
          )}

          <form onSubmit={submitAddendum} className="mt-3 rounded-lg border border-line bg-card p-3 print:hidden">
            <div className="text-[10px] font-bold tracking-[0.04em] text-faint uppercase">Add addendum (append-only)</div>
            <label htmlFor="addendum-reason" className="mt-2 mb-[4px] block text-[10px] font-bold tracking-[0.04em] text-faint uppercase">
              Reason
            </label>
            <input
              id="addendum-reason"
              value={addendumReason}
              onChange={(e) => setAddendumReason(e.target.value)}
              className="h-8 w-full rounded-lg border border-line bg-card px-[10px] text-[12.5px] text-body outline-none focus-visible:outline-2 focus-visible:outline-action"
            />
            <label htmlFor="addendum-text" className="mt-2 mb-[4px] block text-[10px] font-bold tracking-[0.04em] text-faint uppercase">
              Correction
            </label>
            <textarea
              id="addendum-text"
              value={addendumText}
              onChange={(e) => setAddendumText(e.target.value)}
              rows={2}
              className={sectionCls}
            />
            <button
              type="submit"
              disabled={busy || !addendumReason.trim() || !addendumText.trim()}
              className="mt-2 h-8 cursor-pointer rounded-lg border-none bg-action px-3 text-[12px] font-semibold text-white hover:bg-action-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-50"
            >
              Record addendum
            </button>
          </form>

          <button
            type="button"
            onClick={() => window.print()}
            className="mt-2 flex h-8 cursor-pointer items-center gap-[6px] rounded-lg border border-line bg-card px-3 text-[12px] font-semibold text-body hover:border-line-hover focus-visible:outline-2 focus-visible:outline-action print:hidden"
          >
            <Printer size={12} strokeWidth={2.2} aria-hidden />
            Print view
          </button>
        </div>
      )}

      {/* provenance */}
      {status !== "entered_in_error" && (
        <div className="mt-3 border-t border-hairline pt-3 print:hidden" data-testid="provenance-panel">
          <div className="text-[10px] font-bold tracking-[0.04em] text-faint uppercase">Provenance</div>
          {provenance.length === 0 ? (
            <p className="m-0 mt-1 text-[11.5px] text-subtle">
              No references yet. Statements without a reference are treated as practitioner-entered.
            </p>
          ) : (
            <ul className="m-0 mt-1 flex list-none flex-col gap-1 p-0">
              {provenance.map((r, i) => (
                <li key={`${r.sectionKey}-${i}`} className="text-[11.5px] text-body">
                  <span className="font-semibold">{r.sectionKey}</span> ·{" "}
                  <span className={r.refType === "practitioner_entered" ? "font-semibold text-subtle" : ""}>
                    {PROVENANCE_TYPE_LABEL[r.refType] ?? r.refType}
                  </span>{" "}
                  — {r.label}
                </li>
              ))}
            </ul>
          )}
          {editable && (
            <div className="mt-2 flex flex-wrap items-center gap-[6px]">
              <label className="sr-only" htmlFor="prov-section">Section</label>
              <select
                id="prov-section"
                value={provSection}
                onChange={(e) => setProvSection(e.target.value)}
                className="h-7 rounded-md border border-line bg-card px-1 text-[11.5px] text-body outline-none focus-visible:outline-2 focus-visible:outline-action"
              >
                <option value="">Section…</option>
                {sections.map((s) => (
                  <option key={s.key} value={s.key}>{s.label}</option>
                ))}
              </select>
              <label className="sr-only" htmlFor="prov-type">Reference type</label>
              <select
                id="prov-type"
                value={provType}
                onChange={(e) => setProvType(e.target.value)}
                className="h-7 rounded-md border border-line bg-card px-1 text-[11.5px] text-body outline-none focus-visible:outline-2 focus-visible:outline-action"
              >
                {Object.entries(PROVENANCE_TYPE_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
              <label className="sr-only" htmlFor="prov-label">Reference label</label>
              <input
                id="prov-label"
                value={provLabel}
                onChange={(e) => setProvLabel(e.target.value)}
                placeholder="e.g. hs-CRP 2.8 mg/L (Jul panel)"
                className="h-7 min-w-0 flex-1 rounded-md border border-line bg-card px-2 text-[11.5px] text-body outline-none focus-visible:outline-2 focus-visible:outline-action"
              />
              <button
                type="button"
                onClick={addProvenanceRef}
                disabled={!provSection || !provLabel.trim()}
                className="h-7 cursor-pointer rounded-md border border-line bg-card px-2 text-[11.5px] font-semibold text-body hover:border-line-hover focus-visible:outline-2 focus-visible:outline-action disabled:opacity-50"
              >
                Add reference
              </button>
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={signOpen}
        title="Sign this note?"
        body={`Signing freezes version ${serverVersion} exactly as written. Corrections afterwards require an addendum — the signed content never changes. "I attest this note is accurate and complete."`}
        confirmLabel="Sign and lock"
        onConfirm={() => void sign()}
        onCancel={() => setSignOpen(false)}
      />
      <ReasonDialog
        open={errorOpen}
        title="Mark this note entered in error?"
        body="The note is kept in the record and labeled entered-in-error. It is never deleted."
        confirmLabel="Mark entered in error"
        onConfirm={(reason) => void markErrorConfirmed(reason)}
        onCancel={() => setErrorOpen(false)}
      />
    </div>
  );
}
