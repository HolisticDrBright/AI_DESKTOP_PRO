"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, FileSignature, Printer } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ReasonDialog } from "./ReasonDialog";
import { onWorkforceSessionChange } from "@/lib/workforce-session-change";

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
  transcript: "Encounter transcript",
  differential_question: "Differential question",
  lens_evaluation: "Lens evaluation",
  proposed_note: "AI-proposed text (reviewed before signing)",
};

/**
 * An EXPLICIT insertion request from another panel (e.g. the lens panel's
 * add-to-note). Each request carries a fresh `seq` and the note it was made for;
 * only that note's composer applies it, once, to the first section of an
 * EDITABLE note — signed content is never touched, and no other note (opened or
 * started later) ever receives it.
 */
export interface ComposerInsert {
  seq: number;
  noteId: string;
  text: string;
  provenance: { refType: string; refId?: string | null; label: string };
}

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

interface SaveAttempt {
  requestId: string;
  editRevision: number;
  noteId: string | null;
  expectedVersion: number;
  content: Record<string, string>;
  provenance: ProvenanceRef[];
  saveKind: "autosave" | "manual";
}

const SAVE_DEADLINE_MS = 12_000;
const SETTLEMENT_DEADLINE_MS = 8_000;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function validSaveResult(
  value: { noteId?: string; version?: number; savedAt?: string },
): value is { noteId: string; version: number; savedAt: string } {
  return Boolean(value.noteId && UUID.test(value.noteId)
    && Number.isInteger(value.version) && (value.version ?? 0) > 0
    && value.savedAt && Number.isFinite(Date.parse(value.savedAt)));
}

/** The deadline covers both response headers and the body, not just fetch(). */
async function boundedJson<T>(url: string, init: RequestInit = {}, deadlineMs = SETTLEMENT_DEADLINE_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
    const body = await response.json() as T;
    return { response, body };
  } finally {
    clearTimeout(timer);
  }
}

function sameContent(a: Record<string, string>, b: Record<string, string>) {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  return keys.every(key => (a[key] ?? "") === (b[key] ?? ""));
}

function sameProvenance(a: ProvenanceRef[], b: ProvenanceRef[]) {
  if (a.length !== b.length) return false;
  const canonical = (item: ProvenanceRef) => JSON.stringify([
    item.sectionKey, item.refType, item.refId ?? null, item.label,
  ]);
  const left = a.map(canonical).sort();
  const right = b.map(canonical).sort();
  return left.every((item, index) => item === right[index]);
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
  insert = null,
  onInsertTaken,
  onNoteCreated,
  onStateChanged,
}: {
  encounterId: string;
  noteId: string | null;
  noteType: ComposerNoteType;
  /** Whether the encounter still accepts documentation (in_progress/completed). */
  encounterOpen: boolean;
  /** Explicit external insertion request (lens add-to-note). Applied once per seq, by the note it names. */
  insert?: ComposerInsert | null;
  /** Called when this composer has taken the insertion (applied or refused), so it is not delivered again. */
  onInsertTaken?: (seq: number) => void;
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
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [checkingSave, setCheckingSave] = useState(false);
  const [receiptAvailable, setReceiptAvailable] = useState(false);
  const [sessionInvalid, setSessionInvalid] = useState(false);
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
  const saveInFlight = useRef(false);
  const uncertainAttempt = useRef<SaveAttempt | null>(null);
  const followupAutosave = useRef(false);
  const editRevision = useRef(0);
  const lifecycleEpoch = useRef(0);
  const mounted = useRef(true);
  const latest = useRef({ content, provenance, serverVersion, noteId: noteIdState, dirty });
  latest.current = { content, provenance, serverVersion, noteId: noteIdState, dirty };

  const sections = SECTION_SETS[noteType];
  const editable = encounterOpen && !sessionInvalid && !busy
    && (status === "draft" || status === "ready_for_review") && !conflict;

  useEffect(() => {
    mounted.current = true;
    const invalidate = () => {
      lifecycleEpoch.current += 1;
      if (timer.current) clearTimeout(timer.current);
      uncertainAttempt.current = null;
      followupAutosave.current = false;
      editRevision.current += 1;
      latest.current = { content: {}, provenance: [], serverVersion: 0, noteId: null, dirty: false };
      setSessionInvalid(true);
      setLoading(false);
      setLoadError(null);
      setContent({});
      setProvenance([]);
      setNoteIdState(null);
      setStatus("draft");
      setServerVersion(0);
      setSavedAt(null);
      setStatusReason(null);
      setSignature(null);
      setAddenda([]);
      setDirty(false);
      setSaving(false);
      setCheckingSave(false);
      setUnconfirmed(false);
      setReceiptAvailable(false);
      setBusy(false);
      setSignOpen(false);
      setErrorOpen(false);
      setNotice(null);
      setConflict(null);
      setSaveError("Your sign-in or organization changed. Reopen this note under the current session.");
    };
    const stop = onWorkforceSessionChange(invalidate);
    return () => {
      mounted.current = false;
      lifecycleEpoch.current += 1;
      if (timer.current) clearTimeout(timer.current);
      followupAutosave.current = false;
      stop();
    };
  }, []);

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
    const epoch = lifecycleEpoch.current;
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
        if (!alive || lifecycleEpoch.current !== epoch) return;
        applyDetail(json.data);
        setLoading(false);
      })
      .catch((e: Error) => {
        if (!alive || lifecycleEpoch.current !== epoch) return;
        setLoadError(e.message);
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [initialNoteId, applyDetail]);

  const confirmSaved = useCallback((attempt: SaveAttempt, noteId: string, version: number, savedAt: string) => {
    uncertainAttempt.current = null;
    setUnconfirmed(false);
    setReceiptAvailable(false);
    setSaveError(null);
    setServerVersion(version);
    setSavedAt(savedAt);
    setStatus("draft");
    if (!attempt.noteId) {
      setNoteIdState(noteId);
      onNoteCreated(noteId);
    }
    // A newer keystroke is never marked as saved by an older completion.
    const newerEdits = editRevision.current !== attempt.editRevision;
    setDirty(newerEdits);
    followupAutosave.current = newerEdits;
    onStateChanged();
  }, [onNoteCreated, onStateChanged]);

  const checkAttempt = useCallback(async (attempt: SaveAttempt, epoch: number): Promise<boolean> => {
    if (uncertainAttempt.current !== attempt || lifecycleEpoch.current !== epoch || !mounted.current) return false;
    setCheckingSave(true);
    try {
      const params = new URLSearchParams({ encounterId, saveRequestId: attempt.requestId });
      const receipt = await boundedJson<{
        data?: { state: "unconfirmed" | "saved"; noteId?: string; version?: number; savedAt?: string };
      }>(`/api/live/emr/note?${params}`);
      if (uncertainAttempt.current !== attempt || lifecycleEpoch.current !== epoch || !mounted.current) return false;
      if (!receipt.response.ok || !receipt.body.data) throw new Error("receipt_unavailable");
      setReceiptAvailable(true);
      const saved = receipt.body.data;
      if (saved.state !== "saved") {
        setSaveError("Save status is not confirmed yet. Check again before leaving or signing.");
        return false;
      }
      if (!validSaveResult(saved)) throw new Error("receipt_incomplete");
      const detail = await boundedJson<{ data?: NoteDetail }>(
        `/api/live/emr/note?noteId=${encodeURIComponent(saved.noteId)}`,
      );
      if (uncertainAttempt.current !== attempt || lifecycleEpoch.current !== epoch || !mounted.current) return false;
      if (!detail.response.ok || !detail.body.data) throw new Error("note_unavailable");
      const server = detail.body.data;
      if (server.note.noteId === saved.noteId && server.contentVersion === saved.version
        && server.note.noteType === noteType && server.note.status === "draft"
        && sameContent(server.content, attempt.content)
        && sameProvenance(server.provenance, attempt.provenance)) {
        confirmSaved(attempt, saved.noteId, saved.version, saved.savedAt);
        return true;
      }
      // The write has a receipt, but another version or a different payload is
      // authoritative now. Show both copies; do not silently replace edits.
      uncertainAttempt.current = null;
      setUnconfirmed(false);
      setReceiptAvailable(false);
      setConflict(server);
      setSaveError(null);
      return false;
    } catch {
      if (uncertainAttempt.current === attempt && lifecycleEpoch.current === epoch && mounted.current) {
        setSaveError("The save may have completed, but its status could not be verified. Keep this page open and check status; do not start a new save or sign.");
      }
      return false;
    } finally {
      if (lifecycleEpoch.current === epoch && mounted.current) setCheckingSave(false);
    }
  }, [encounterId, noteType, confirmSaved]);

  const sendAttempt = useCallback(async (attempt: SaveAttempt): Promise<boolean> => {
    if (saveInFlight.current || sessionInvalid || !mounted.current) return false;
    saveInFlight.current = true;
    const epoch = lifecycleEpoch.current;
    setSaving(true);
    setSaveError(null);
    try {
      const result = await boundedJson<{
        data?: { noteId: string; version: number; savedAt: string };
        error?: { message?: string };
      }>("/api/live/emr/note", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          encounterId, noteType, content: attempt.content,
          expectedVersion: attempt.expectedVersion, noteId: attempt.noteId ?? undefined,
          saveKind: attempt.saveKind, provenance: attempt.provenance,
          requestId: attempt.requestId,
        }),
      }, SAVE_DEADLINE_MS);
      if (lifecycleEpoch.current !== epoch || !mounted.current) return false;
      if (result.response.status === 409) {
        if (!attempt.noteId) {
          setSaveError("A new note could not be created because the server state changed. Review the encounter before trying again.");
          return false;
        }
        try {
          const authoritative = await boundedJson<{ data?: NoteDetail }>(
            `/api/live/emr/note?noteId=${encodeURIComponent(attempt.noteId)}`,
          );
          if (lifecycleEpoch.current !== epoch || !mounted.current) return false;
          if (!authoritative.response.ok || !authoritative.body.data) throw new Error("note_unavailable");
          setConflict(authoritative.body.data);
        } catch {
          setSaveError("This note changed elsewhere and the latest copy could not be loaded.");
        }
        return false;
      }
      if (!result.response.ok && result.response.status < 500) {
        setSaveError(result.body.error?.message ?? "This save was refused. Your edits are still here.");
        return false;
      }
      if (!result.response.ok || !result.body.data || !validSaveResult(result.body.data)) {
        uncertainAttempt.current = attempt;
        setReceiptAvailable(false);
        setUnconfirmed(true);
        return await checkAttempt(attempt, epoch);
      }
      // A repeat of a previously uncertain write needs the authoritative
      // version and payload check, even if the replay itself returned 200.
      if (uncertainAttempt.current === attempt) return await checkAttempt(attempt, epoch);
      confirmSaved(attempt, result.body.data.noteId, result.body.data.version, result.body.data.savedAt);
      return true;
    } catch {
      if (lifecycleEpoch.current !== epoch || !mounted.current) return false;
      uncertainAttempt.current = attempt;
      setReceiptAvailable(false);
      setUnconfirmed(true);
      return await checkAttempt(attempt, epoch);
    } finally {
      saveInFlight.current = false;
      if (lifecycleEpoch.current === epoch && mounted.current) setSaving(false);
    }
  }, [encounterId, noteType, sessionInvalid, checkAttempt, confirmSaved]);

  const doSave = useCallback(async (
    saveKind: "autosave" | "manual", options?: { expectedVersion?: number },
  ): Promise<boolean> => {
    if (saveInFlight.current || uncertainAttempt.current || sessionInvalid) return false;
    const snap = latest.current;
    const attempt: SaveAttempt = {
      requestId: crypto.randomUUID(),
      editRevision: editRevision.current,
      noteId: snap.noteId,
      expectedVersion: options?.expectedVersion ?? snap.serverVersion,
      content: snap.content,
      provenance: snap.provenance,
      saveKind,
    };
    return sendAttempt(attempt);
  }, [sendAttempt, sessionInvalid]);

  const scheduleAutosave = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (latest.current.dirty && !saveInFlight.current && !uncertainAttempt.current) {
        void doSave("autosave");
      }
    }, 1500);
  }, [doSave]);

  // Only a CONFIRMED save with newer edits may schedule a follow-up. A refused
  // save must not enter an automatic retry loop.
  useEffect(() => {
    if (followupAutosave.current && dirty && !saving && !unconfirmed && !conflict && !sessionInvalid) {
      followupAutosave.current = false;
      scheduleAutosave();
    }
  }, [dirty, saving, unconfirmed, conflict, sessionInvalid, scheduleAutosave]);

  const edit = (key: string, value: string) => {
    if (busy || sessionInvalid) return;
    editRevision.current += 1;
    const next = { ...latest.current.content, [key]: value };
    latest.current = { ...latest.current, content: next, dirty: true };
    setContent(next);
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

  // Explicit external insertion (lens add-to-note): append to the FIRST
  // section with a provenance reference, once per request. Editable drafts
  // only — a signed note is never modified from outside.
  const appliedInsertSeq = useRef(0);
  useEffect(() => {
    if (!insert || insert.seq === appliedInsertSeq.current) return;
    // Another note's request waits for that note; it is never applied here.
    if (insert.noteId !== noteIdState) return;
    appliedInsertSeq.current = insert.seq;
    onInsertTaken?.(insert.seq);
    if (!editable) {
      setNotice(null);
      setSaveError("This note no longer accepts insertions — it is not an editable draft.");
      return;
    }
    const firstKey = sections[0].key;
    editRevision.current += 1;
    const current = latest.current;
    const nextContent = {
      ...current.content,
      [firstKey]: `${(current.content[firstKey] ?? "").trimEnd()}${(current.content[firstKey] ?? "").trim() ? "\n" : ""}${insert.text}`,
    };
    const nextProvenance = [
      ...current.provenance,
      {
        sectionKey: firstKey,
        refType: insert.provenance.refType,
        refId: insert.provenance.refId ?? null,
        label: insert.provenance.label,
      },
    ];
    latest.current = { ...current, content: nextContent, provenance: nextProvenance, dirty: true };
    setContent(nextContent);
    setProvenance(nextProvenance);
    setDirty(true);
    setNotice("Inserted from the lens panel — review, then save.");
    scheduleAutosave();
  }, [insert, noteIdState, onInsertTaken, editable, sections, scheduleAutosave]);

  const noteAction = async (payload: Record<string, unknown>, failLabel: string) => {
    if (saveInFlight.current || uncertainAttempt.current || sessionInvalid) {
      setSaveError("Confirm the note save and current sign-in before changing its review or signature state.");
      return null;
    }
    const epoch = lifecycleEpoch.current;
    setBusy(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/live/emr/note/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ noteId: noteIdState, ...payload }),
      });
      if (lifecycleEpoch.current !== epoch || !mounted.current) return null;
      if (!res.ok) {
        const error = await readError(res);
        if (lifecycleEpoch.current === epoch && mounted.current) setSaveError(error.message);
        return null;
      }
      const reply = (await res.json()) as { data: Record<string, unknown> };
      return lifecycleEpoch.current === epoch && mounted.current ? reply : null;
    } catch {
      if (lifecycleEpoch.current === epoch && mounted.current) {
        setSaveError(`${failLabel} — the service is unreachable.`);
      }
      return null;
    } finally {
      if (lifecycleEpoch.current === epoch && mounted.current) setBusy(false);
    }
  };

  const markReady = async () => {
    if (saveInFlight.current || uncertainAttempt.current || sessionInvalid) return;
    if (latest.current.dirty) {
      const confirmed = await doSave("manual");
      if (!confirmed) return;
      // The React note identity/version update may not have committed yet.
      // A second deliberate click keeps review bound to the saved version.
      setNotice("Draft saved. Select Ready for review again after the saved version appears.");
      return;
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
    if (saveInFlight.current || uncertainAttempt.current || sessionInvalid || latest.current.dirty) return;
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
    editRevision.current += 1;
    const nextProvenance = [
      ...latest.current.provenance,
      { sectionKey: provSection, refType: provType, label: provLabel.trim() },
    ];
    latest.current = { ...latest.current, provenance: nextProvenance, dirty: true };
    setProvenance(nextProvenance);
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

  const saveState = checkingSave
    ? "Checking save status…"
    : saving
      ? "Saving…"
      : unconfirmed
        ? "Save status unconfirmed"
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
            {(conflict.note.status === "draft" || conflict.note.status === "ready_for_review") ? (
              <button
                type="button"
                onClick={() => {
                  const expectedVersion = conflict.contentVersion;
                  setServerVersion(expectedVersion);
                  setStatus(conflict.note.status);
                  setConflict(null);
                  setDirty(true);
                  void doSave("manual", { expectedVersion });
                }}
                className="h-8 cursor-pointer rounded-lg border-none bg-action px-3 text-[12px] font-semibold text-white hover:bg-action-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
              >
                Keep my edits (save over v{conflict.contentVersion})
              </button>
            ) : (
              <span className="self-center text-[11.5px] font-medium text-critical">
                The server version is locked and cannot be overwritten.
              </span>
            )}
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
          {!unconfirmed && !sessionInvalid && (
            <button type="button" onClick={() => void doSave("manual")}
              className="cursor-pointer border-none bg-transparent p-0 font-bold text-critical underline">
              Retry save
            </button>
          )}
        </p>
      )}
      {unconfirmed && (
        <div role="alert" className="mt-2 rounded-lg border border-[rgba(191,70,52,0.4)] bg-critical-tint px-3 py-2 text-[12px] text-critical">
          <p className="m-0 font-semibold">The last save may have completed. Your edits remain on this screen; do not sign or start a new save until its status is confirmed.</p>
          <div className="mt-2 flex gap-3">
            <button type="button" disabled={saving || checkingSave || sessionInvalid}
              onClick={() => { const attempt = uncertainAttempt.current; if (attempt) void checkAttempt(attempt, lifecycleEpoch.current); }}
              className="cursor-pointer border-none bg-transparent p-0 font-bold text-critical underline disabled:opacity-50">
              Check save status
            </button>
            {receiptAvailable && (
              <button type="button" disabled={saving || checkingSave || sessionInvalid}
                onClick={() => { const attempt = uncertainAttempt.current; if (attempt) void sendAttempt(attempt); }}
                className="cursor-pointer border-none bg-transparent p-0 font-bold text-critical underline disabled:opacity-50">
                Retry this same save
              </button>
            )}
          </div>
        </div>
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
            disabled={saving || unconfirmed || sessionInvalid || !dirty}
            onClick={() => void doSave("manual")}
            className="h-9 cursor-pointer rounded-lg border border-line bg-card px-3 text-[12.5px] font-semibold text-body hover:border-line-hover focus-visible:outline-2 focus-visible:outline-action disabled:opacity-50"
          >
            Save now
          </button>
          {status === "draft" && (
            <button
              type="button"
              disabled={busy || saving || unconfirmed || sessionInvalid || serverVersion < 1}
              onClick={() => void markReady()}
              className="flex h-9 cursor-pointer items-center gap-[6px] rounded-lg border border-line bg-card px-3 text-[12.5px] font-semibold text-body hover:border-line-hover focus-visible:outline-2 focus-visible:outline-action disabled:opacity-50"
            >
              <CheckCircle2 size={13} strokeWidth={2.2} aria-hidden />
              Ready for review
            </button>
          )}
          <button
            type="button"
            disabled={busy || saving || unconfirmed || sessionInvalid || serverVersion < 1 || dirty}
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
              disabled={busy || saving || unconfirmed || sessionInvalid}
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
