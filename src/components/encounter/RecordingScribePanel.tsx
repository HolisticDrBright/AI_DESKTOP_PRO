"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Mic, Pause, Play, Square, Trash2, FileText, ShieldCheck, AlertTriangle } from "lucide-react";
import { Card } from "@/components/ui/bits";

/**
 * Consent-gated encounter recording + AI scribe (Milestone 1).
 *
 * Everything here is UI over server-enforced rules (migrations 0022/0023):
 *  - recording cannot start until EVERY participant granted the recording
 *    scope (the server refuses; the button is merely honest about it)
 *  - every chunk re-validates the bound token + session + consent server-side;
 *    a 409 means capture is no longer authorized and the recorder stops
 *  - heartbeats revalidate consent and rotate the chunk token; a late
 *    participant join pauses capture until they are identified + consented
 *  - the scribe draft is ALWAYS a new proposed note — existing practitioner
 *    drafts are never overwritten (database-guaranteed)
 *  - deletion is a durable, verified workflow (per-target confirmations)
 *
 * The recording status strip is persistent and unmistakable: role="status",
 * assertive live region, color + icon + text (never color alone).
 *
 * Raw capture tokens live only in memory (refs). Recovery after a refresh
 * re-discovers the recording server-side and obtains a FRESH token via
 * heartbeat — tokens are never persisted anywhere.
 */

type Scope = "recording" | "transcription" | "ai_drafting";
const SCOPES: Scope[] = ["recording", "transcription", "ai_drafting"];
const SCOPE_LABEL: Record<Scope, string> = {
  recording: "Recording",
  transcription: "Transcription",
  ai_drafting: "AI drafting",
};

interface ConsentDoc {
  id: string;
  scope: Scope;
  version: number;
  title: string;
  body: string;
  jurisdiction: string | null;
}
interface Participant {
  id: string;
  kind: string;
  displayName: string;
  canSelfConsent: boolean;
  leftAt: string | null;
  consents: { id: string; scope: Scope; status: "granted" | "withdrawn" }[];
}
interface ProviderInfo {
  mode: string;
  provider: string | null;
  available: boolean;
  reason: string | null;
}
interface TranscriptSeg {
  id: string;
  seq: number;
  speaker: string | null;
  rawText: string;
  effectiveText: string;
  effectiveSource: "raw" | "provider_revision" | "correction";
  corrections: { version: number; text: string }[];
}
interface Transcript {
  transcriptId: string;
  revision: number;
  status: "accepted" | "corrected" | "finalized";
  segments: TranscriptSeg[];
}
interface DeletionInfo {
  recordingStatus: string;
  audioDeletedAt: string | null;
  deletionProof: string | null;
  jobs: { id: string; target: string; status: string; attempts: number; lastError: string | null }[];
}

type CapturePhase =
  | "idle"
  | "recording"
  | "paused"
  | "device_lost"
  | "reconnecting"
  | "revoked"
  | "stopping"
  | "uploading"
  | "processing"
  | "transcript_ready"
  | "failed";

const PHASE_LABEL: Record<CapturePhase, string> = {
  idle: "Not recording",
  recording: "Recording in progress",
  paused: "Recording paused",
  device_lost: "Microphone disconnected — recording paused",
  reconnecting: "Connection lost — retrying upload",
  revoked: "Consent withdrawn — recording stopped",
  stopping: "Stopping…",
  uploading: "Uploading audio…",
  processing: "Transcribing…",
  transcript_ready: "Transcript ready for review",
  failed: "Recording failed",
};

const PHASE_TONE: Record<CapturePhase, string> = {
  idle: "bg-surface-2 text-subtle",
  recording: "bg-critical/15 text-critical",
  paused: "bg-warn/20 text-ink",
  device_lost: "bg-warn/20 text-ink",
  reconnecting: "bg-warn/20 text-ink",
  revoked: "bg-critical/15 text-critical",
  stopping: "bg-surface-2 text-subtle",
  uploading: "bg-action/10 text-action",
  processing: "bg-action/10 text-action",
  transcript_ready: "bg-ok/15 text-ink",
  failed: "bg-critical/15 text-critical",
};

async function postJson<T>(url: string, body: unknown, method = "POST"): Promise<{ ok: boolean; status: number; data?: T; message?: string }> {
  try {
    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as { data?: T; error?: { message?: string } };
    return { ok: res.ok, status: res.status, data: json.data, message: json.error?.message };
  } catch {
    return { ok: false, status: 0, message: "The recording service is unreachable." };
  }
}

export function RecordingScribePanel({
  encounterId,
  encounterOpen,
  onDraftCreated,
}: {
  encounterId: string;
  encounterOpen: boolean;
  onDraftCreated: (noteId: string) => void;
}) {
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [documents, setDocuments] = useState<ConsentDoc[]>([]);
  const [provider, setProvider] = useState<ProviderInfo | null>(null);
  const [phase, setPhase] = useState<CapturePhase>("idle");
  const [statusDetail, setStatusDetail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [recoverable, setRecoverable] = useState<{ recordingId: string; sessionId: string; sessionStatus: string } | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [deletion, setDeletion] = useState<DeletionInfo | null>(null);
  const [busy, setBusy] = useState(false);

  // consent form state
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState("patient");
  const [newSelfConsent, setNewSelfConsent] = useState(true);
  const [repName, setRepName] = useState("");
  const [repBasis, setRepBasis] = useState("minor_guardian");
  const [repAuthority, setRepAuthority] = useState("");
  const [ack, setAck] = useState<Record<string, boolean>>({});

  // correction editor state
  const [editingSegment, setEditingSegment] = useState<string | null>(null);
  const [editText, setEditText] = useState("");

  // capture internals — tokens only ever live here (never persisted)
  const sessionIdRef = useRef<string | null>(null);
  const recordingIdRef = useRef<string | null>(null);
  const tokenRef = useRef<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const queueRef = useRef<Blob[]>([]);
  const pumpingRef = useRef(false);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef<number>(0);
  const phaseRef = useRef<CapturePhase>("idle");
  phaseRef.current = phase;

  const setPhaseAndDetail = useCallback((p: CapturePhase, detail?: string | null) => {
    setPhase(p);
    setStatusDetail(detail ?? null);
  }, []);

  const loadConsent = useCallback(async () => {
    const res = await fetch(`/api/live/scribe/consent?encounterId=${encounterId}`);
    const json = (await res.json().catch(() => ({}))) as {
      data?: { participants: Participant[]; documents: ConsentDoc[]; provider: ProviderInfo };
      error?: { message?: string };
    };
    if (!res.ok || !json.data) {
      setError(json.error?.message ?? "Consent state is unavailable.");
      return null;
    }
    setParticipants(json.data.participants);
    setDocuments(json.data.documents);
    setProvider(json.data.provider);
    setError(null);
    return json.data;
  }, [encounterId]);

  const loadTranscript = useCallback(async (recId: string) => {
    const res = await fetch(`/api/live/scribe/transcript?recordingId=${recId}`);
    const json = (await res.json().catch(() => ({}))) as { data?: Transcript | null };
    if (res.ok) setTranscript(json.data ?? null);
    return json.data ?? null;
  }, []);

  const loadDeletion = useCallback(async (recId: string) => {
    const res = await fetch(`/api/live/scribe/recording?recordingId=${recId}&view=deletion`);
    const json = (await res.json().catch(() => ({}))) as { data?: DeletionInfo };
    if (res.ok && json.data) setDeletion(json.data);
    return json.data ?? null;
  }, []);

  /** Discover server state on mount: an in-flight recording (refresh/second
   *  tab), a ready transcript, or a completed deletion. */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await loadConsent();
      const res = await fetch(`/api/live/scribe/recording?encounterId=${encounterId}`);
      const json = (await res.json().catch(() => ({}))) as {
        data?: {
          recordings: { id: string; status: string }[];
          liveRecordingId: string | null;
          captureSession: { id: string; status: string } | null;
        };
      };
      if (cancelled || !res.ok || !json.data) return;
      const { recordings, liveRecordingId, captureSession } = json.data;
      if (liveRecordingId && captureSession && ["active", "paused"].includes(captureSession.status)) {
        setRecoverable({ recordingId: liveRecordingId, sessionId: captureSession.id, sessionStatus: captureSession.status });
        setPhaseAndDetail("paused", "A recording for this encounter was interrupted (page reload or another tab).");
        setRecordingId(liveRecordingId);
        return;
      }
      const latest = recordings[0];
      if (!latest) return;
      setRecordingId(latest.id);
      if (["transcript_ready", "review_pending", "finalized"].includes(latest.status)) {
        setPhaseAndDetail("transcript_ready");
        await loadTranscript(latest.id);
      } else if (["transcription_queued", "transcribing", "uploaded"].includes(latest.status)) {
        setPhaseAndDetail("processing");
        pollTranscript(latest.id);
      } else if (["deletion_pending", "deleted"].includes(latest.status)) {
        await loadDeletion(latest.id);
        await loadTranscript(latest.id);
        setPhaseAndDetail("idle");
      } else if (latest.status === "failed" || latest.status === "quarantined") {
        setPhaseAndDetail("failed", `The last recording was ${latest.status}.`);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [encounterId]);

  const consentComplete = useMemo(() => {
    const active = participants.filter((p) => !p.leftAt);
    if (active.length === 0) return { recording: false, transcription: false, ai_drafting: false };
    const complete = (scope: Scope) =>
      active.every((p) => p.consents.some((c) => c.scope === scope && c.status === "granted"));
    return { recording: complete("recording"), transcription: complete("transcription"), ai_drafting: complete("ai_drafting") };
  }, [participants]);

  // ------------------------------------------------------------- capture
  const stopEverything = useCallback(() => {
    if (heartbeatRef.current) clearInterval(heartbeatRef.current);
    heartbeatRef.current = null;
    try {
      if (recorderRef.current && recorderRef.current.state !== "inactive") recorderRef.current.stop();
    } catch {
      /* recorder already gone */
    }
    recorderRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    tokenRef.current = null;
  }, []);

  useEffect(() => stopEverything, [stopEverything]);

  /** Upload queued chunks strictly in order; server revalidates each one. */
  const pumpQueue = useCallback(async () => {
    if (pumpingRef.current) return;
    pumpingRef.current = true;
    try {
      let retries = 0;
      while (queueRef.current.length > 0) {
        const recId = recordingIdRef.current;
        const token = tokenRef.current;
        if (!recId || !token) break;
        const chunk = queueRef.current[0];
        let res: Response;
        try {
          res = await fetch("/api/live/scribe/chunk", {
            method: "POST",
            headers: { "content-type": "application/octet-stream", "x-recording-id": recId, "x-capture-token": token },
            body: chunk,
          });
        } catch {
          // Network interruption: keep the chunk, back off, let the heartbeat
          // rotate the token; capture continues locally.
          retries += 1;
          if (phaseRef.current === "recording") setPhaseAndDetail("reconnecting", "Audio is buffered locally and will retry.");
          if (retries > 40) break;
          await new Promise((r) => setTimeout(r, Math.min(5000, 500 * retries)));
          continue;
        }
        if (res.ok) {
          queueRef.current.shift();
          retries = 0;
          if (phaseRef.current === "reconnecting") setPhaseAndDetail("recording");
          continue;
        }
        if (res.status === 409) {
          // Authorization revoked / session paused — STOP sending immediately.
          const wasPaused = phaseRef.current === "paused" || phaseRef.current === "device_lost";
          if (!wasPaused) {
            try {
              recorderRef.current?.pause();
            } catch {
              /* recorder already stopped */
            }
          }
          break;
        }
        // other errors: drop into reconnect backoff
        retries += 1;
        if (retries > 40) break;
        await new Promise((r) => setTimeout(r, Math.min(5000, 500 * retries)));
      }
    } finally {
      pumpingRef.current = false;
    }
  }, [setPhaseAndDetail]);

  const heartbeat = useCallback(async () => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;
    const r = await postJson<{ ok: boolean; status: string; captureToken: string | null }>(
      "/api/live/scribe/recording",
      { action: "heartbeat", sessionId },
      "PATCH",
    );
    if (!r.ok) {
      if (r.status === 409 || r.status === 422 || r.status === 400) {
        // Session revoked (consent withdrawn) — active revocation reached us.
        stopEverything();
        setPhaseAndDetail("revoked");
        await loadConsent();
      }
      return;
    }
    if (r.data?.ok && r.data.captureToken) {
      tokenRef.current = r.data.captureToken; // rotation
      if (phaseRef.current === "paused") setPhaseAndDetail("recording");
      void pumpQueue();
    } else if (r.data && !r.data.ok) {
      // Paused server-side (late participant join). Stop the mic locally too.
      try {
        recorderRef.current?.pause();
      } catch {
        /* recorder already stopped */
      }
      if (phaseRef.current === "recording" || phaseRef.current === "reconnecting") {
        setPhaseAndDetail("paused", "Capture paused — a new participant must be identified and consent before it can resume.");
        await loadConsent();
      }
    }
  }, [loadConsent, pumpQueue, setPhaseAndDetail, stopEverything]);

  const attachRecorder = useCallback(
    (stream: MediaStream, contentType: string) => {
      streamRef.current = stream;
      for (const track of stream.getAudioTracks()) {
        track.onended = () => {
          try {
            recorderRef.current?.pause();
          } catch {
            /* recorder already stopped */
          }
          setPhaseAndDetail("device_lost", "Reconnect a microphone, then resume — or stop and keep what was captured.");
        };
      }
      const recorder = new MediaRecorder(stream, { mimeType: contentType });
      recorder.ondataavailable = (e: BlobEvent) => {
        if (e.data && e.data.size > 0) {
          queueRef.current.push(e.data);
          void pumpQueue();
        }
      };
      recorderRef.current = recorder;
      recorder.start(1500);
    },
    [pumpQueue, setPhaseAndDetail],
  );

  const start = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const contentType = typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "audio/mp4";
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        setPhaseAndDetail("failed", "Microphone access was denied. Recording needs an available, permitted microphone.");
        return;
      }
      const begin = await postJson<{
        recordingId: string;
        sessionId: string;
        captureToken: string;
      }>("/api/live/scribe/recording", { encounterId, contentType });
      if (!begin.ok || !begin.data) {
        stream.getTracks().forEach((t) => t.stop());
        if (begin.status === 409) {
          setPhaseAndDetail("paused", "This encounter is already being recorded — possibly in another tab. Recover it below or stop it there first.");
          const res = await fetch(`/api/live/scribe/recording?encounterId=${encounterId}`);
          const json = (await res.json().catch(() => ({}))) as {
            data?: { liveRecordingId: string | null; captureSession: { id: string; status: string } | null };
          };
          if (json.data?.liveRecordingId && json.data.captureSession) {
            setRecoverable({
              recordingId: json.data.liveRecordingId,
              sessionId: json.data.captureSession.id,
              sessionStatus: json.data.captureSession.status,
            });
            setRecordingId(json.data.liveRecordingId);
          }
        } else {
          setError(begin.message ?? "Recording could not start.");
        }
        return;
      }
      recordingIdRef.current = begin.data.recordingId;
      sessionIdRef.current = begin.data.sessionId;
      tokenRef.current = begin.data.captureToken;
      setRecordingId(begin.data.recordingId);
      setRecoverable(null);
      setTranscript(null);
      setDeletion(null);
      startedAtRef.current = Date.now();
      attachRecorder(stream, contentType);
      heartbeatRef.current = setInterval(() => void heartbeat(), 15_000);
      setPhaseAndDetail("recording");
    } finally {
      setBusy(false);
    }
  }, [attachRecorder, encounterId, heartbeat, setPhaseAndDetail]);

  /** Recover an interrupted capture session (refresh/crash/second tab). */
  const recover = useCallback(async () => {
    if (!recoverable) return;
    setBusy(true);
    setError(null);
    try {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        setPhaseAndDetail("failed", "Microphone access was denied. Recording needs an available, permitted microphone.");
        return;
      }
      recordingIdRef.current = recoverable.recordingId;
      sessionIdRef.current = recoverable.sessionId;
      if (recoverable.sessionStatus === "paused") {
        const resumed = await postJson("/api/live/scribe/recording", { action: "resume", sessionId: recoverable.sessionId }, "PATCH");
        if (!resumed.ok) {
          stream.getTracks().forEach((t) => t.stop());
          setError(resumed.message ?? "The paused recording cannot resume until every participant has consented.");
          return;
        }
      }
      const beat = await postJson<{ ok: boolean; captureToken: string | null }>(
        "/api/live/scribe/recording",
        { action: "heartbeat", sessionId: recoverable.sessionId },
        "PATCH",
      );
      if (!beat.ok || !beat.data?.captureToken) {
        stream.getTracks().forEach((t) => t.stop());
        setError(beat.message ?? "The interrupted recording could not be recovered.");
        return;
      }
      tokenRef.current = beat.data.captureToken;
      startedAtRef.current = Date.now();
      attachRecorder(stream, "audio/webm");
      heartbeatRef.current = setInterval(() => void heartbeat(), 15_000);
      setRecoverable(null);
      setPhaseAndDetail("recording", "Recovered — capture is running again.");
    } finally {
      setBusy(false);
    }
  }, [attachRecorder, heartbeat, recoverable, setPhaseAndDetail]);

  const resumeAfterPause = useCallback(async () => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;
    setBusy(true);
    try {
      const r = await postJson("/api/live/scribe/recording", { action: "resume", sessionId }, "PATCH");
      if (!r.ok) {
        // A 409 on resume is a consent/state precondition (0022), not a
        // transient failure — say so plainly.
        setError(
          r.status === 409
            ? "Capture cannot resume until every participant has consented."
            : (r.message ?? "Capture could not resume."),
        );
        return;
      }
      const beat = await postJson<{ ok: boolean; captureToken: string | null }>(
        "/api/live/scribe/recording",
        { action: "heartbeat", sessionId },
        "PATCH",
      );
      if (beat.ok && beat.data?.captureToken) tokenRef.current = beat.data.captureToken;
      try {
        if (recorderRef.current?.state === "paused") recorderRef.current.resume();
      } catch {
        /* recorder gone — device flow will restart */
      }
      setPhaseAndDetail("recording");
      setError(null);
      void pumpQueue();
    } finally {
      setBusy(false);
    }
  }, [pumpQueue, setPhaseAndDetail]);

  const stopAndUpload = useCallback(async () => {
    const recId = recordingIdRef.current;
    const sessionId = sessionIdRef.current;
    if (!recId || !sessionId) return;
    setBusy(true);
    setPhaseAndDetail("stopping");
    try {
      // flush the recorder's final chunk
      await new Promise<void>((resolve) => {
        const rec = recorderRef.current;
        if (!rec || rec.state === "inactive") return resolve();
        rec.onstop = () => resolve();
        try {
          rec.stop();
        } catch {
          resolve();
        }
      });
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;

      setPhaseAndDetail("uploading");
      // Drain: the recorder's final ondataavailable may have started its own
      // pump (the guard makes ours return instantly) — wait until the queue
      // is truly empty, not merely until one pump call returns.
      const drainDeadline = Date.now() + 30_000;
      while (queueRef.current.length > 0 && Date.now() < drainDeadline) {
        await pumpQueue();
        if (queueRef.current.length > 0) await new Promise((r) => setTimeout(r, 200));
      }
      if (queueRef.current.length > 0) {
        setPhaseAndDetail("failed", "Some audio could not be uploaded. The recording was not completed.");
        return;
      }
      const durationMs = Math.max(1000, Date.now() - startedAtRef.current);
      const auth = await postJson<{ completionToken: string }>(
        "/api/live/scribe/recording",
        { action: "completionToken", sessionId },
        "PATCH",
      );
      if (!auth.ok || !auth.data) {
        setPhaseAndDetail("failed", auth.message ?? "Upload completion was not authorized.");
        return;
      }
      const done = await postJson<{ status: string }>(
        "/api/live/scribe/recording",
        { action: "complete", recordingId: recId, completionToken: auth.data.completionToken, durationMs },
        "PATCH",
      );
      tokenRef.current = null;
      if (!done.ok || !done.data) {
        setPhaseAndDetail("failed", done.message ?? "The upload could not be completed.");
        return;
      }
      if (done.data.status === "quarantined") {
        setPhaseAndDetail("failed", "The audio failed content validation and was quarantined. It will not be processed.");
        return;
      }
      const queued = await postJson("/api/live/scribe/recording", { action: "queue", recordingId: recId }, "PATCH");
      if (!queued.ok) {
        setPhaseAndDetail("failed", queued.message ?? "Transcription could not be queued.");
        return;
      }
      setPhaseAndDetail("processing");
      pollTranscript(recId);
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pumpQueue, setPhaseAndDetail]);

  const pollTranscript = useCallback(
    (recId: string, attempt = 0) => {
      void (async () => {
        const t = await loadTranscript(recId);
        if (t) {
          setPhaseAndDetail("transcript_ready");
          return;
        }
        if (attempt >= 30) {
          setPhaseAndDetail("failed", "Transcription did not complete. Check the recording status and retry.");
          return;
        }
        setTimeout(() => pollTranscript(recId, attempt + 1), 1500);
      })();
    },
    [loadTranscript, setPhaseAndDetail],
  );

  // -------------------------------------------------------------- consent
  const addParticipant = useCallback(async () => {
    if (!newName.trim()) return;
    setBusy(true);
    try {
      const rep = !newSelfConsent;
      const r = await postJson("/api/live/scribe/consent", {
        action: "addParticipant",
        encounterId,
        kind: newKind,
        displayName: newName.trim(),
        canSelfConsent: newSelfConsent,
      });
      if (!r.ok) {
        setError(r.message ?? "The participant could not be added.");
        return;
      }
      setNewName("");
      setNewSelfConsent(true);
      if (!rep) {
        setRepName("");
        setRepAuthority("");
      }
      await loadConsent();
    } finally {
      setBusy(false);
    }
  }, [encounterId, loadConsent, newKind, newName, newSelfConsent]);

  const grantConsent = useCallback(
    async (participant: Participant, scope: Scope) => {
      const doc = documents.find((d) => d.scope === scope);
      if (!doc) {
        setError(`No active consent document exists for ${SCOPE_LABEL[scope]}.`);
        return;
      }
      const ackKey = `${participant.id}:${scope}`;
      if (!ack[ackKey]) {
        setError("Confirm the participant reviewed the consent language (check the box) first.");
        return;
      }
      if (!participant.canSelfConsent && (!repName.trim() || !repAuthority.trim())) {
        setError("This participant cannot self-consent: enter the representative's name and authority.");
        return;
      }
      setBusy(true);
      try {
        const r = await postJson("/api/live/scribe/consent", {
          action: "recordConsent",
          participantId: participant.id,
          scope,
          consentDocumentId: doc.id,
          method: "electronic_signature",
          signerAcknowledgment: `Reviewed and agreed to "${doc.title}" (v${doc.version}).`,
          representative: participant.canSelfConsent
            ? undefined
            : { name: repName.trim(), basis: repBasis, authority: repAuthority.trim() },
        });
        if (!r.ok) {
          setError(r.message ?? "Consent could not be recorded.");
          return;
        }
        setError(null);
        await loadConsent();
      } finally {
        setBusy(false);
      }
    },
    [ack, documents, loadConsent, repAuthority, repBasis, repName],
  );

  const withdraw = useCallback(
    async (consentId: string) => {
      setBusy(true);
      try {
        const r = await postJson("/api/live/scribe/consent", { action: "withdrawConsent", consentId, reason: "withdrawn in visit" });
        if (!r.ok) {
          setError(r.message ?? "The consent could not be withdrawn.");
          return;
        }
        await loadConsent();
        // If capture was live, the server has revoked it; reflect promptly.
        if (["recording", "reconnecting", "paused"].includes(phaseRef.current)) void heartbeat();
      } finally {
        setBusy(false);
      }
    },
    [heartbeat, loadConsent],
  );

  // ----------------------------------------------------------- transcript
  const correctSegment = useCallback(
    async (segmentId: string) => {
      if (!editText.trim() || !recordingId) return;
      setBusy(true);
      try {
        const r = await postJson("/api/live/scribe/transcript", {
          action: "correct",
          segmentId,
          correctedText: editText.trim(),
          reason: "practitioner correction",
        });
        if (!r.ok) {
          setError(r.message ?? "The correction could not be saved.");
          return;
        }
        setEditingSegment(null);
        setEditText("");
        await loadTranscript(recordingId);
      } finally {
        setBusy(false);
      }
    },
    [editText, loadTranscript, recordingId],
  );

  const finalize = useCallback(async () => {
    if (!transcript || !recordingId) return;
    setBusy(true);
    try {
      await postJson("/api/live/scribe/transcript", { action: "review", transcriptId: transcript.transcriptId });
      const r = await postJson("/api/live/scribe/transcript", { action: "finalize", transcriptId: transcript.transcriptId });
      if (!r.ok) {
        setError(r.message ?? "The transcript could not be finalized.");
        return;
      }
      await loadTranscript(recordingId);
    } finally {
      setBusy(false);
    }
  }, [loadTranscript, recordingId, transcript]);

  const generateDraft = useCallback(async () => {
    if (!transcript) return;
    setBusy(true);
    try {
      const r = await postJson<{ noteId: string; idempotent: boolean }>("/api/live/scribe/transcript", {
        action: "generateDraft",
        transcriptId: transcript.transcriptId,
        noteType: "soap",
      });
      if (!r.ok || !r.data) {
        setError(r.message ?? "The scribe draft could not be generated.");
        return;
      }
      setError(null);
      setStatusDetail(
        r.data.idempotent
          ? "This transcript revision already has a proposed draft — opened it instead of creating a duplicate."
          : "Proposed draft created as a NEW note. Review it side-by-side; your existing notes were not touched.",
      );
      onDraftCreated(r.data.noteId);
    } finally {
      setBusy(false);
    }
  }, [onDraftCreated, transcript]);

  const requestDeletion = useCallback(async () => {
    if (!recordingId) return;
    setBusy(true);
    try {
      const r = await postJson("/api/live/scribe/recording", { action: "requestDeletion", recordingId }, "PATCH");
      if (!r.ok) {
        setError(r.message ?? "Deletion could not be requested.");
        return;
      }
      // Poll the durable workflow until every target confirms.
      const poll = async (attempt: number) => {
        const d = await loadDeletion(recordingId);
        if (d?.recordingStatus === "deleted" || attempt >= 20) return;
        setTimeout(() => void poll(attempt + 1), 1200);
      };
      await poll(0);
    } finally {
      setBusy(false);
    }
  }, [loadDeletion, recordingId]);

  // ------------------------------------------------------------------ UI
  const live = ["recording", "paused", "device_lost", "reconnecting"].includes(phase);
  const audioDeleted = deletion?.recordingStatus === "deleted";

  return (
    <Card className="px-4 py-[14px]">
      <div data-testid="scribe-panel" data-recording-id={recordingId ?? ""}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="m-0 flex items-center gap-[6px] text-[13px] font-bold text-ink">
          <Mic size={13} strokeWidth={2.4} aria-hidden /> Visit recording &amp; AI scribe
        </h3>
        {provider && (
          <span className="text-[11px] font-medium text-subtle" data-testid="scribe-provider">
            {provider.available ? `Provider: ${provider.provider} (${provider.mode})` : "Provider unavailable"}
          </span>
        )}
      </div>

      {/* Persistent, unmistakable recording status — never color alone. */}
      <div
        role="status"
        aria-live="assertive"
        data-testid="recording-status"
        data-phase={phase}
        className={`mt-2 flex items-center gap-2 rounded-lg px-3 py-2 text-[12.5px] font-bold ${PHASE_TONE[phase]}`}
      >
        {live && phase === "recording" ? (
          <span className="inline-block h-[10px] w-[10px] animate-pulse rounded-full bg-critical" aria-hidden />
        ) : (
          <span className="inline-block h-[10px] w-[10px] rounded-full bg-current opacity-60" aria-hidden />
        )}
        <span>{PHASE_LABEL[phase]}</span>
        {statusDetail && <span className="font-medium text-[11.5px] opacity-90">{statusDetail}</span>}
      </div>

      {error && (
        <p role="alert" className="mt-2 mb-0 flex items-start gap-1 text-[11.5px] font-semibold text-critical">
          <AlertTriangle size={12} strokeWidth={2.4} aria-hidden className="mt-[1px] shrink-0" /> {error}
        </p>
      )}

      {provider && !provider.available && (
        <p className="mt-2 mb-0 text-[11.5px] text-subtle" data-testid="provider-refusal">
          {provider.reason ?? "No transcription provider is available in this mode."}
        </p>
      )}

      {/* ------------------------------------------------ consent capture */}
      <section className="mt-3" data-testid="consent-section">
        <h4 className="m-0 flex items-center gap-[5px] text-[12px] font-bold text-ink">
          <ShieldCheck size={12} strokeWidth={2.4} aria-hidden /> Participants &amp; consent
        </h4>
        <p className="mt-1 mb-0 text-[11.5px] text-subtle">
          Every participant must grant each scope before it can be used. Withdrawing recording consent stops capture immediately.
        </p>
        <ul className="m-0 mt-2 list-none space-y-2 p-0">
          {participants.map((p) => (
            <li key={p.id} className="rounded-lg border border-line px-3 py-2" data-testid={`participant-${p.kind}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] font-semibold text-ink">
                  {p.displayName}
                  <span className="ml-1 text-[10.5px] font-medium uppercase tracking-wide text-subtle">{p.kind}</span>
                  {!p.canSelfConsent && (
                    <span className="ml-1 rounded bg-warn/20 px-1 text-[10px] font-semibold text-ink">representative required</span>
                  )}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                {SCOPES.map((scope) => {
                  const granted = p.consents.find((c) => c.scope === scope && c.status === "granted");
                  const doc = documents.find((d) => d.scope === scope);
                  const ackKey = `${p.id}:${scope}`;
                  if (granted) {
                    return (
                      <span key={scope} className="flex items-center gap-1 rounded bg-ok/15 px-[6px] py-[2px] text-[10.5px] font-semibold text-ink">
                        {SCOPE_LABEL[scope]} ✓
                        <button
                          type="button"
                          onClick={() => void withdraw(granted.id)}
                          className="cursor-pointer border-none bg-transparent p-0 text-[10.5px] font-semibold text-critical underline"
                          data-testid={`withdraw-${p.kind}-${scope}`}
                        >
                          withdraw
                        </button>
                      </span>
                    );
                  }
                  return (
                    <span key={scope} className="flex items-center gap-1 text-[10.5px]">
                      <label className="flex cursor-pointer items-center gap-1 text-subtle">
                        <input
                          type="checkbox"
                          checked={Boolean(ack[ackKey])}
                          onChange={(e) => setAck((a) => ({ ...a, [ackKey]: e.target.checked }))}
                          data-testid={`ack-${p.kind}-${scope}`}
                        />
                        read {doc ? `“${doc.title}” v${doc.version}` : SCOPE_LABEL[scope]}
                      </label>
                      <button
                        type="button"
                        disabled={busy || !doc}
                        onClick={() => void grantConsent(p, scope)}
                        className="h-6 cursor-pointer rounded border border-line bg-surface px-[6px] text-[10.5px] font-semibold text-ink hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
                        data-testid={`grant-${p.kind}-${scope}`}
                      >
                        Grant {SCOPE_LABEL[scope]}
                      </button>
                    </span>
                  );
                })}
              </div>
            </li>
          ))}
          {participants.length === 0 && (
            <li className="text-[11.5px] text-subtle">No participants registered yet — add everyone present.</li>
          )}
        </ul>

        <div className="mt-2 flex flex-wrap items-end gap-2" data-testid="add-participant">
          <label className="text-[10.5px] font-semibold text-subtle">
            Name
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="mt-[2px] block h-7 w-40 rounded border border-line bg-surface px-2 text-[11.5px] text-ink"
              data-testid="participant-name"
            />
          </label>
          <label className="text-[10.5px] font-semibold text-subtle">
            Role
            <select
              value={newKind}
              onChange={(e) => setNewKind(e.target.value)}
              className="mt-[2px] block h-7 rounded border border-line bg-surface px-1 text-[11.5px] text-ink"
              data-testid="participant-kind"
            >
              <option value="patient">Patient</option>
              <option value="caregiver">Caregiver</option>
              <option value="practitioner">Practitioner</option>
              <option value="other">Other</option>
            </select>
          </label>
          <label className="flex items-center gap-1 pb-[6px] text-[10.5px] font-semibold text-subtle">
            <input
              type="checkbox"
              checked={!newSelfConsent}
              onChange={(e) => setNewSelfConsent(!e.target.checked)}
              data-testid="participant-needs-rep"
            />
            cannot self-consent (minor / LAR)
          </label>
          <button
            type="button"
            disabled={busy || !newName.trim()}
            onClick={() => void addParticipant()}
            className="h-7 cursor-pointer rounded-md border-none bg-action px-2 text-[11.5px] font-semibold text-white hover:bg-action-deep disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="add-participant-btn"
          >
            Add participant
          </button>
        </div>
        {!newSelfConsent || participants.some((p) => !p.canSelfConsent && !p.consents.some((c) => c.status === "granted")) ? (
          <div className="mt-2 flex flex-wrap items-end gap-2 rounded-lg bg-warn/10 px-2 py-2" data-testid="representative-fields">
            <label className="text-[10.5px] font-semibold text-subtle">
              Representative name
              <input
                value={repName}
                onChange={(e) => setRepName(e.target.value)}
                className="mt-[2px] block h-7 w-40 rounded border border-line bg-surface px-2 text-[11.5px] text-ink"
                data-testid="rep-name"
              />
            </label>
            <label className="text-[10.5px] font-semibold text-subtle">
              Legal basis
              <select
                value={repBasis}
                onChange={(e) => setRepBasis(e.target.value)}
                className="mt-[2px] block h-7 rounded border border-line bg-surface px-1 text-[11.5px] text-ink"
                data-testid="rep-basis"
              >
                <option value="minor_guardian">Guardian of a minor</option>
                <option value="legal_authorized_representative">Legally authorized representative</option>
                <option value="surrogate_unable_to_consent">Surrogate — unable to consent</option>
              </select>
            </label>
            <label className="text-[10.5px] font-semibold text-subtle">
              Authority
              <input
                value={repAuthority}
                onChange={(e) => setRepAuthority(e.target.value)}
                placeholder="e.g. custodial parent per intake record"
                className="mt-[2px] block h-7 w-56 rounded border border-line bg-surface px-2 text-[11.5px] text-ink"
                data-testid="rep-authority"
              />
            </label>
          </div>
        ) : null}
      </section>

      {/* ------------------------------------------------------- controls */}
      <section className="mt-3 flex flex-wrap items-center gap-2" data-testid="recording-controls">
        {!live && phase !== "uploading" && phase !== "processing" && !audioDeleted && (
          <button
            type="button"
            disabled={busy || !encounterOpen || !provider?.available || !consentComplete.recording || Boolean(recoverable)}
            onClick={() => void start()}
            className="flex h-8 cursor-pointer items-center gap-[6px] rounded-lg border-none bg-critical px-3 text-[12px] font-bold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="start-recording"
          >
            <Mic size={12} strokeWidth={2.4} aria-hidden /> Start recording
          </button>
        )}
        {!consentComplete.recording && participants.length > 0 && !live && (
          <span className="text-[11px] font-medium text-subtle" data-testid="consent-gate-hint">
            Recording consent is not complete for every participant.
          </span>
        )}
        {recoverable && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void recover()}
            className="flex h-8 cursor-pointer items-center gap-[6px] rounded-lg border border-line bg-surface px-3 text-[12px] font-bold text-ink hover:bg-surface-2 disabled:opacity-50"
            data-testid="recover-recording"
          >
            <Play size={12} strokeWidth={2.4} aria-hidden /> Recover interrupted recording
          </button>
        )}
        {(phase === "paused" || phase === "device_lost") && !recoverable && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void resumeAfterPause()}
            className="flex h-8 cursor-pointer items-center gap-[6px] rounded-lg border border-line bg-surface px-3 text-[12px] font-bold text-ink hover:bg-surface-2 disabled:opacity-50"
            data-testid="resume-recording"
          >
            <Play size={12} strokeWidth={2.4} aria-hidden /> Resume
          </button>
        )}
        {live && (
          <>
            {phase === "recording" && (
              <button
                type="button"
                onClick={() => {
                  try {
                    recorderRef.current?.pause();
                  } catch {
                    /* recorder gone */
                  }
                  setPhaseAndDetail("paused", "Paused by the practitioner.");
                }}
                className="flex h-8 cursor-pointer items-center gap-[6px] rounded-lg border border-line bg-surface px-3 text-[12px] font-bold text-ink hover:bg-surface-2"
                data-testid="pause-recording"
              >
                <Pause size={12} strokeWidth={2.4} aria-hidden /> Pause
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => void stopAndUpload()}
              className="flex h-8 cursor-pointer items-center gap-[6px] rounded-lg border-none bg-ink px-3 text-[12px] font-bold text-white hover:opacity-90 disabled:opacity-50"
              data-testid="stop-recording"
            >
              <Square size={12} strokeWidth={2.4} aria-hidden /> Stop &amp; transcribe
            </button>
          </>
        )}
        {phase === "revoked" && (
          <span className="text-[11.5px] font-semibold text-critical">
            Recording consent was withdrawn. Captured audio is retained pending deletion or renewed consent.
          </span>
        )}
      </section>

      {/* ------------------------------------------------------ transcript */}
      {transcript && (
        <section className="mt-3" data-testid="transcript-section">
          <div className="flex items-center justify-between gap-2">
            <h4 className="m-0 text-[12px] font-bold text-ink">
              Transcript
              <span className="ml-2 rounded bg-surface-2 px-1 text-[10.5px] font-semibold text-subtle" data-testid="transcript-status">
                {transcript.status} · r{transcript.revision}
              </span>
            </h4>
            <div className="flex gap-2">
              {transcript.status !== "finalized" && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void finalize()}
                  className="h-7 cursor-pointer rounded-md border border-line bg-surface px-2 text-[11px] font-semibold text-ink hover:bg-surface-2 disabled:opacity-50"
                  data-testid="finalize-transcript"
                >
                  Mark reviewed &amp; finalize
                </button>
              )}
              <button
                type="button"
                disabled={busy || !consentComplete.ai_drafting}
                onClick={() => void generateDraft()}
                className="flex h-7 cursor-pointer items-center gap-1 rounded-md border-none bg-action px-2 text-[11px] font-semibold text-white hover:bg-action-deep disabled:cursor-not-allowed disabled:opacity-50"
                data-testid="generate-draft"
              >
                <FileText size={11} strokeWidth={2.4} aria-hidden /> Generate proposed draft
              </button>
            </div>
          </div>
          {!consentComplete.ai_drafting && (
            <p className="mt-1 mb-0 text-[11px] text-subtle">AI drafting requires every participant&apos;s consent.</p>
          )}
          <ul className="m-0 mt-2 list-none space-y-1 p-0">
            {transcript.segments.map((s) => (
              <li key={s.id} className="rounded-lg border border-line px-3 py-[6px]" data-testid={`segment-${s.seq}`}>
                <div className="flex items-start justify-between gap-2">
                  <p className="m-0 text-[12px] text-ink">
                    <span className="mr-1 text-[10.5px] font-bold uppercase tracking-wide text-subtle">{s.speaker ?? "voice"}</span>
                    <span data-testid={`segment-${s.seq}-effective`}>{s.effectiveText}</span>
                    <span
                      className={`ml-1 rounded px-1 text-[9.5px] font-bold uppercase ${
                        s.effectiveSource === "correction" ? "bg-action/10 text-action" : "bg-surface-2 text-subtle"
                      }`}
                    >
                      {s.effectiveSource === "correction" ? "corrected" : s.effectiveSource === "provider_revision" ? "revised" : "raw ASR"}
                    </span>
                  </p>
                  {transcript.status !== "finalized" && (
                    <button
                      type="button"
                      onClick={() => {
                        setEditingSegment(s.id);
                        setEditText(s.effectiveText);
                      }}
                      className="cursor-pointer border-none bg-transparent p-0 text-[10.5px] font-semibold text-action underline"
                      data-testid={`correct-${s.seq}`}
                    >
                      correct
                    </button>
                  )}
                </div>
                {s.effectiveSource === "correction" && (
                  <p className="m-0 mt-[2px] text-[10.5px] text-subtle" data-testid={`segment-${s.seq}-raw`}>
                    Raw ASR (immutable): <span className="line-through">{s.rawText}</span>
                  </p>
                )}
                {editingSegment === s.id && (
                  <div className="mt-1 flex items-end gap-2">
                    <textarea
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      rows={2}
                      className="w-full rounded border border-line bg-surface px-2 py-1 text-[11.5px] text-ink"
                      data-testid="correction-text"
                    />
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void correctSegment(s.id)}
                      className="h-7 cursor-pointer rounded-md border-none bg-action px-2 text-[11px] font-semibold text-white hover:bg-action-deep disabled:opacity-50"
                      data-testid="save-correction"
                    >
                      Save correction
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* --------------------------------------------------- audio deletion */}
      {recordingId && (transcript || audioDeleted || deletion || ["revoked", "failed"].includes(phase)) && (
        <section className="mt-3" data-testid="deletion-section">
          {audioDeleted ? (
            <p className="m-0 flex items-center gap-1 text-[11.5px] font-semibold text-ink" data-testid="deletion-verified">
              <ShieldCheck size={12} strokeWidth={2.4} aria-hidden className="text-ok" />
              Audio deleted and verified {deletion?.audioDeletedAt ? `at ${new Date(deletion.audioDeletedAt).toLocaleString()}` : ""}.
              The transcript and signed documentation are retained under the clinical record policy.
            </p>
          ) : (
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void requestDeletion()}
                className="flex h-7 cursor-pointer items-center gap-1 rounded-md border border-line bg-surface px-2 text-[11px] font-semibold text-critical hover:bg-surface-2 disabled:opacity-50"
                data-testid="request-deletion"
              >
                <Trash2 size={11} strokeWidth={2.4} aria-hidden /> Delete audio now
              </button>
              <span className="text-[10.5px] text-subtle">
                Deletion is a verified workflow: audio is only marked deleted after every storage target confirms.
              </span>
            </div>
          )}
          {deletion && !audioDeleted && deletion.jobs.length > 0 && (
            <ul className="m-0 mt-1 list-none p-0 text-[10.5px] text-subtle" data-testid="deletion-jobs">
              {deletion.jobs.map((j) => (
                <li key={j.id}>
                  {j.target} target: {j.status} (attempts {j.attempts}){j.lastError ? ` — ${j.lastError}` : ""}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      </div>
    </Card>
  );
}
