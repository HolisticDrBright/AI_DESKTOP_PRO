if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}
import { trpcMutation, trpcQuery } from "./trpc.server";
import { TRPC_BASE_URL } from "./config";
import { getClinicalAccessToken } from "./session.server";
import { AdapterError } from "./errors";

/**
 * Live scribe namespace (server-only): consent-gated encounter recording +
 * AI scribe (Milestone 1). Every mutation lands in a SECURITY DEFINER RPC
 * (migrations 0022/0023) via the backend's clinical.scribe.* procedures —
 * consent scopes, ACTIVE revocation, bound single-use tokens, the recording
 * state machine, provider enablement and the durable deletion workflow are
 * all database-enforced. This module threads the caller's session, shapes
 * typed DTOs, and proxies the binary chunk/completion endpoints.
 *
 * Capture tokens pass through untouched and are never logged or persisted
 * here; the raw audio bytes stream through uploadChunk without buffering
 * beyond the request body.
 */

const BACKEND_ORIGIN = TRPC_BASE_URL.replace(/\/api\/trpc\/?$/, "");

export type ConsentScope = "recording" | "transcription" | "ai_drafting";
export type ConsentMethod = "verbal_attested" | "written" | "electronic_signature";

export interface ConsentDocument {
  id: string;
  scope: ConsentScope;
  version: number;
  locale: string;
  jurisdiction: string | null;
  title: string;
  body: string;
  presentationFormat: string;
  contentSha256: string;
  effectiveDate: string;
  shared: boolean;
}

export interface ParticipantConsent {
  id: string;
  scope: ConsentScope;
  status: "granted" | "withdrawn";
  method: string;
  grantedAt: string;
  withdrawnAt: string | null;
  representative: boolean;
  consentDocumentId: string;
}

export interface RecordingParticipant {
  id: string;
  kind: "patient" | "caregiver" | "practitioner" | "other";
  displayName: string;
  relationship: string | null;
  canSelfConsent: boolean;
  joinedAt: string;
  leftAt: string | null;
  consents: ParticipantConsent[];
}

export interface BeginRecordingResult {
  recordingId: string;
  sessionId: string;
  captureToken: string;
  expiresAt: string;
  contentType: string;
  maxBytes: number;
  provider: string;
}

export interface HeartbeatResult {
  ok: boolean;
  status: "active" | "paused" | "revoked" | "closed";
  captureToken: string | null;
  expiresAt: string | null;
}

export interface RecordingStatus {
  id: string;
  encounterId: string;
  patientId: string;
  provider: string;
  status: string;
  contentType: string | null;
  audioBytes: number | null;
  durationMs: number | null;
  legalHold: boolean;
  deletionDeadline: string;
  audioDeletedAt: string | null;
  deletionProof: string | null;
  failureReason: string | null;
  validationResult: Record<string, unknown> | null;
  createdAt: string;
  transitions: { from: string | null; to: string; reason: string | null; at: string }[];
}

export interface TranscriptSegment {
  id: string;
  seq: number;
  speaker: string | null;
  startMs: number | null;
  endMs: number | null;
  rawText: string;
  confidence: number | null;
  providerRevisions: { revision: number; text: string; confidence: number | null }[];
  corrections: { version: number; sourceRevision: number; text: string; reason: string | null }[];
  effectiveText: string;
  effectiveSource: "raw" | "provider_revision" | "correction";
}

export interface LiveTranscript {
  transcriptId: string;
  encounterId: string;
  provider: string;
  revision: number;
  status: "accepted" | "corrected" | "finalized";
  finalizedAt: string | null;
  segments: TranscriptSegment[];
}

export interface DeletionStatus {
  recordingStatus: string;
  audioDeletedAt: string | null;
  deletionProof: string | null;
  legalHold: boolean;
  jobs: {
    id: string;
    target: "local" | "provider";
    status: string;
    attempts: number;
    lastError: string | null;
    nextAttemptAt: string;
    deadLetteredAt: string | null;
    confirmationRef: string | null;
  }[];
}

export interface ProviderStatus {
  mode: "fixture" | "live" | "disabled";
  provider: string | null;
  available: boolean;
  reason: string | null;
}

async function backendFetch(
  path: string,
  init: RequestInit & { sessionToken?: string | null },
): Promise<Response> {
  const token = await getClinicalAccessToken(init.sessionToken);
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  try {
    return await fetch(`${BACKEND_ORIGIN}${path}`, { ...init, headers, cache: "no-store" });
  } catch (e) {
    throw new AdapterError(
      "unavailable",
      undefined,
      `scribe fetch ${path}: ${e instanceof Error ? e.message : "network error"}`,
    );
  }
}

function throwFromRoute(status: number, body: { error?: { code?: string; message?: string } }): never {
  const code = body.error?.code ?? "";
  if (status === 401) throw new AdapterError("unauthenticated");
  if (status === 403) throw new AdapterError("forbidden");
  if (status === 404) throw new AdapterError("not_found");
  if (status === 409) {
    // capture_refused / completion_refused / invalid_state — the recording UI
    // must treat every 409 as "stop capturing and re-check state".
    throw new AdapterError("conflict", routeConflictMessage(code));
  }
  if (status === 413) throw new AdapterError("invalid", "The recording chunk was too large.");
  throw new AdapterError("unavailable", undefined, `scribe route ${status} ${code}`);
}

function routeConflictMessage(code: string): string {
  switch (code) {
    case "capture_refused":
      return "Recording authorization is no longer valid. Capture has stopped.";
    case "completion_refused":
      return "The upload could not be completed with this authorization.";
    case "invalid_state":
      return "The recording is not in a state that accepts this action.";
    default:
      return "The recording state changed. Refresh to continue.";
  }
}

export const scribeLive = {
  providerStatus(sessionToken?: string | null): Promise<ProviderStatus> {
    return trpcQuery<ProviderStatus>("clinical.scribe.providerStatus", undefined, sessionToken);
  },

  consentDocuments(organizationId: string, sessionToken?: string | null): Promise<ConsentDocument[]> {
    return trpcQuery<ConsentDocument[]>("clinical.scribe.consentDocuments", { organizationId }, sessionToken);
  },

  participants(encounterId: string, sessionToken?: string | null): Promise<RecordingParticipant[]> {
    return trpcQuery<RecordingParticipant[]>("clinical.scribe.participants", { encounterId }, sessionToken);
  },

  addParticipant(
    input: {
      encounterId: string;
      kind: RecordingParticipant["kind"];
      displayName: string;
      relationship?: string;
      canSelfConsent: boolean;
    },
    sessionToken?: string | null,
  ): Promise<{ participantId: string }> {
    return trpcMutation<{ participantId: string }>("clinical.scribe.addParticipant", input, sessionToken);
  },

  recordConsent(
    input: {
      participantId: string;
      scope: ConsentScope;
      consentDocumentId: string;
      method: ConsentMethod;
      signerAcknowledgment: string;
      jurisdiction?: string;
      representative?: { name: string; relationship?: string; basis: string; authority: string };
    },
    sessionToken?: string | null,
  ): Promise<{ consentId: string }> {
    return trpcMutation<{ consentId: string }>("clinical.scribe.recordConsent", input, sessionToken);
  },

  withdrawConsent(input: { consentId: string; reason?: string }, sessionToken?: string | null): Promise<{ ok: true }> {
    return trpcMutation<{ ok: true }>("clinical.scribe.withdrawConsent", input, sessionToken);
  },

  beginRecording(
    input: { encounterId: string; contentType: string },
    sessionToken?: string | null,
  ): Promise<BeginRecordingResult> {
    return trpcMutation<BeginRecordingResult>("clinical.scribe.beginRecording", input, sessionToken);
  },

  heartbeat(sessionId: string, sessionToken?: string | null): Promise<HeartbeatResult> {
    return trpcMutation<HeartbeatResult>("clinical.scribe.heartbeat", { sessionId }, sessionToken);
  },

  resume(sessionId: string, sessionToken?: string | null): Promise<{ ok: true }> {
    return trpcMutation<{ ok: true }>("clinical.scribe.resume", { sessionId }, sessionToken);
  },

  issueCompletionAuthorization(
    sessionId: string,
    sessionToken?: string | null,
  ): Promise<{ completionToken: string; expiresAt: string }> {
    return trpcMutation<{ completionToken: string; expiresAt: string }>(
      "clinical.scribe.issueCompletionAuthorization",
      { sessionId },
      sessionToken,
    );
  },

  /** One audio chunk → backend binary route; authorization revalidates per chunk. */
  async uploadChunk(
    input: { recordingId: string; captureToken: string; bytes: ArrayBuffer },
    sessionToken?: string | null,
  ): Promise<{ receivedBytes: number; totalBytes: number }> {
    const res = await backendFetch(`/api/clinical/scribe/recordings/${input.recordingId}/chunks`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "x-capture-token": input.captureToken },
      body: Buffer.from(input.bytes),
      sessionToken,
    });
    const body = (await res.json().catch(() => ({}))) as {
      data?: { receivedBytes: number; totalBytes: number };
      error?: { code?: string };
    };
    if (!res.ok || !body.data) throwFromRoute(res.status, body);
    return body.data;
  },

  async completeUpload(
    input: { recordingId: string; completionToken: string; durationMs: number },
    sessionToken?: string | null,
  ): Promise<{ status: string; idempotent: boolean; totalBytes: number }> {
    const res = await backendFetch(`/api/clinical/scribe/recordings/${input.recordingId}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ completionToken: input.completionToken, durationMs: input.durationMs }),
      sessionToken,
    });
    const body = (await res.json().catch(() => ({}))) as {
      data?: { status: string; idempotent: boolean; totalBytes: number };
      error?: { code?: string };
    };
    if (!res.ok || !body.data) throwFromRoute(res.status, body);
    return body.data;
  },

  queueTranscription(recordingId: string, sessionToken?: string | null): Promise<{ ok: true }> {
    return trpcMutation<{ ok: true }>("clinical.scribe.queueTranscription", { recordingId }, sessionToken);
  },

  recording(recordingId: string, sessionToken?: string | null): Promise<RecordingStatus> {
    return trpcQuery<RecordingStatus>("clinical.scribe.recording", { recordingId }, sessionToken);
  },

  recordingsForEncounter(
    encounterId: string,
    sessionToken?: string | null,
  ): Promise<{ id: string; status: string; provider: string; createdAt: string; audioDeletedAt: string | null }[]> {
    return trpcQuery("clinical.scribe.recordingsForEncounter", { encounterId }, sessionToken);
  },

  captureSession(
    recordingId: string,
    sessionToken?: string | null,
  ): Promise<{ id: string; status: "active" | "paused" | "revoked" | "closed"; pauseReason: string | null; lastHeartbeatAt: string } | null> {
    return trpcQuery("clinical.scribe.captureSession", { recordingId }, sessionToken);
  },

  transcript(recordingId: string, sessionToken?: string | null): Promise<LiveTranscript | null> {
    return trpcQuery<LiveTranscript | null>("clinical.scribe.transcript", { recordingId }, sessionToken);
  },

  correctSegment(
    input: { segmentId: string; correctedText: string; reason?: string },
    sessionToken?: string | null,
  ): Promise<{ version: number }> {
    return trpcMutation<{ version: number }>("clinical.scribe.correctSegment", input, sessionToken);
  },

  setReview(transcriptId: string, sessionToken?: string | null): Promise<{ ok: true }> {
    return trpcMutation<{ ok: true }>("clinical.scribe.setReview", { transcriptId }, sessionToken);
  },

  finalizeTranscript(transcriptId: string, sessionToken?: string | null): Promise<{ ok: true }> {
    return trpcMutation<{ ok: true }>("clinical.scribe.finalizeTranscript", { transcriptId }, sessionToken);
  },

  generateDraft(
    input: { transcriptId: string; noteType: string },
    sessionToken?: string | null,
  ): Promise<{ noteId: string; generationId: string; idempotent: boolean }> {
    return trpcMutation<{ noteId: string; generationId: string; idempotent: boolean }>(
      "clinical.scribe.generateDraft",
      input,
      sessionToken,
    );
  },

  requestDeletion(recordingId: string, sessionToken?: string | null): Promise<{ ok: true }> {
    return trpcMutation<{ ok: true }>("clinical.scribe.requestDeletion", { recordingId }, sessionToken);
  },

  deletionStatus(recordingId: string, sessionToken?: string | null): Promise<DeletionStatus> {
    return trpcQuery<DeletionStatus>("clinical.scribe.deletionStatus", { recordingId }, sessionToken);
  },

  logAccess(
    input: { transcriptId: string; kind: "accessed" | "exported" },
    sessionToken?: string | null,
  ): Promise<{ ok: true }> {
    return trpcMutation<{ ok: true }>("clinical.scribe.logAccess", input, sessionToken);
  },
};
