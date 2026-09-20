if (typeof window !== "undefined") throw new Error("clinical-core/recording-acceptance is server-only.");
import { createHash } from "node:crypto";

/** Hosted synthetic acceptance for encounter recording, transcription and
 * review-only drafting (Desktop migrations 20260917070000 onward). Runs only
 * against the synthetic account with fictional identities and fictional audio:
 * a generated tone by default, or a supplied fictional recording made for this
 * purpose. Writing it needs no AWS access; running it does. Every step records
 * what was asked, what came back and whether it matched the contract. A refusal
 * because a plane is not activated, a reviewed release is missing or a provider
 * is not configured is a reported outcome (`not_configured`), never a pass:
 * blocked endpoints returning refusals are not positive end-to-end acceptance.
 * The audio this run stores stays under the reviewed retention deadline and is
 * reported under `retained`; the harness never deletes media itself. */
export type RecordingAcceptanceOutcome = "passed" | "failed" | "not_configured" | "skipped";
export type RecordingAcceptanceStep = { index: number; name: string; expected: string; outcome: RecordingAcceptanceOutcome; status?: number; detail?: string };
export type RecordingAcceptanceReport = {
  schemaVersion: "recording-acceptance/1"; environment: "synthetic-staging"; ok: boolean;
  sourceCommit: string; migrationReleaseHash: string; configurationSha256: string; awsAccountId: string; encounterId: string;
  audio: { source: "generated_tone" | "supplied_file"; contentType: "audio/wav"; bytes: number; sha256: string; segments: number };
  startedAt: string; finishedAt: string; steps: RecordingAcceptanceStep[];
  retained: { recordingId: string; state: string; deletionDeadline: string | null }[]; evidenceSha256: string;
};
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export class RecordingAcceptanceError extends Error { constructor(readonly category: "configuration_invalid" | "boundary_refused") { super(category); } }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const BASE = "/clinical-core/workforce/encounter-recording";
const ROUTES = { authority: `${BASE}/authority`, readiness: `${BASE}/readiness`, start: `${BASE}/start`, state: `${BASE}/state`, command: `${BASE}/command`,
  segment: `${BASE}/segment`, transcription: `${BASE}/transcription`, drafting: `${BASE}/drafting`, cleanupReview: `${BASE}/cleanup-review` } as const;
const SCOPES = ["recording", "transcription", "ai_drafting"] as const;
const NOT_ACTIVATED = ["production_not_activated", "service_unavailable", "provider_unavailable", "prompt_unreviewed"];

/** Fictional audio: a 16 kHz mono 16-bit PCM WAV of a quiet tone with silence gaps. No voice, no words, no person. */
export function fictionalWav(seconds = 6, sampleRate = 16000): Uint8Array {
  const frames = Math.floor(seconds * sampleRate), data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate, on = Math.floor(t) % 2 === 0; // one second of tone, one of silence
    const sample = on ? Math.round(Math.sin(2 * Math.PI * 440 * t) * 6000) : 0;
    data.writeInt16LE(sample, i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(data.length, 40);
  return new Uint8Array(Buffer.concat([header, data]));
}
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

export async function runRecordingAcceptance(input: {
  apiOrigin: string; workforceIdToken: string; consumerIdToken: string; encounterId: string; locale?: string; jurisdiction: string;
  audio?: { bytes: Uint8Array; source: "supplied_file" }; expectedAwsAccountId: string; observedAwsAccountId: string; sourceCommit: string; migrationReleaseHash: string;
  fetch?: FetchLike; now?: () => number; wait?: (ms: number) => Promise<void>; maxPasses?: number;
}): Promise<RecordingAcceptanceReport> {
  const fetcher = input.fetch ?? fetch, now = input.now ?? Date.now, wait = input.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const startedAt = new Date(now()).toISOString(), origin = validate(input), locale = input.locale ?? "en";
  const audioBytes = input.audio?.bytes ?? fictionalWav();
  if (audioBytes.byteLength < 44 || audioBytes.byteLength > 64 * 1024 * 1024 || Buffer.from(audioBytes.subarray(0, 4)).toString("latin1") !== "RIFF") throw new RecordingAcceptanceError("configuration_invalid");
  const steps: RecordingAcceptanceStep[] = [];
  let index = 0;
  const step = async (name: string, expected: string, work: () => Promise<{ outcome: RecordingAcceptanceOutcome; status?: number; detail?: string }>) => {
    index += 1;
    try { const r = await work(); steps.push({ index, name, expected, ...r }); return r; }
    catch (error) { const detail = error instanceof Error && /^[a-z_:0-9-]+$/.test(error.message) ? error.message : "step_failed"; steps.push({ index, name, expected, outcome: "failed", detail }); return { outcome: "failed" as const, detail }; }
  };
  const skip = async (names: string[], detail: string) => { for (const name of names) await step(name, "not run", async () => ({ outcome: "skipped", detail })); };
  const send = async (path: string, bearer: string, body: Uint8Array | Record<string, unknown>, headers: Record<string, string> = {}) => {
    let response: Response;
    try {
      const json = !(body instanceof Uint8Array);
      response = await fetcher(`${origin}${path}`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, ...(json ? { "content-type": "application/json" } : {}), ...headers },
        body: json ? JSON.stringify(body) : (body as unknown as BodyInit), redirect: "manual", signal: AbortSignal.timeout(25_000) });
    } catch { return { status: 0, body: null as unknown }; }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 4 * 1024 * 1024) return { status: response.status, body: null as unknown };
    try { return { status: response.status, body: JSON.parse(new TextDecoder().decode(bytes)) as unknown }; } catch { return { status: response.status, body: null as unknown }; }
  };
  const data = (r: { body: unknown }) => (r.body && typeof r.body === "object" && "data" in (r.body as object) ? (r.body as { data: unknown }).data : null) as Record<string, unknown> | null;
  const capabilities = (r: { body: unknown }) => (r.body && typeof r.body === "object" && "capabilities" in (r.body as object) ? (r.body as { capabilities: unknown }).capabilities : null) as Record<string, unknown> | null;
  const errorCode = (r: { body: unknown }) => (r.body && typeof r.body === "object" && typeof (r.body as { error?: unknown }).error === "string" ? (r.body as { error: string }).error : undefined);
  const notActivated = (r: { status: number; body: unknown }) => r.status === 503 && NOT_ACTIVATED.includes(errorCode(r) ?? "");
  const retained: RecordingAcceptanceReport["retained"] = [];
  const audio: RecordingAcceptanceReport["audio"] = { source: input.audio?.source ?? "generated_tone", contentType: "audio/wav", bytes: audioBytes.byteLength, sha256: sha256(audioBytes), segments: 0 };
  const REST_AFTER_WORKSPACE = ["consumer token refused on workforce recording routes", "participants and consents", "readiness", "start capture", "start replay is idempotent",
    "segment uploads", "recovery state", "finish", "transcription request", "transcription completes", "transcript read", "drafting request", "drafting completes", "proposed note read", "cleanup review"];

  // 1. Consent workspace: the recording plane must be activated and the reviewed consent releases must exist for this locale and jurisdiction.
  const releases: Partial<Record<(typeof SCOPES)[number], string>> = {};
  const workspace = await step("consent workspace", "200 workspace for the encounter listing consent releases for recording, transcription and ai_drafting; 503 production_not_activated is not_configured", async () => {
    const r = await send(ROUTES.authority, input.workforceIdToken, { action: "workspace", encounterId: input.encounterId, locale, jurisdiction: input.jurisdiction });
    if (notActivated(r)) return { outcome: "not_configured", status: 503, detail: errorCode(r) };
    const d = data(r);
    if (r.status !== 200 || !d || d.encounterId !== input.encounterId || !Array.isArray(d.consentReleases)) return { outcome: "failed", status: r.status, detail: errorCode(r) ?? "workspace_invalid" };
    for (const release of d.consentReleases as { id: string; scope: string }[]) if (SCOPES.includes(release.scope as never) && !releases[release.scope as (typeof SCOPES)[number]]) releases[release.scope as (typeof SCOPES)[number]] = release.id;
    const missing = SCOPES.filter((s) => !releases[s]);
    if (capabilities(r)?.audioCapture !== false) return { outcome: "failed", status: 200, detail: "capabilities_claim_audio_capture" };
    if (missing.length) return { outcome: "not_configured", status: 200, detail: `consent_release_missing:${missing.join(",")}` };
    return { outcome: "passed", status: 200, detail: `encounterStatus:${String(d.encounterStatus)}` };
  });
  if (workspace.outcome !== "passed") { await skip(REST_AFTER_WORKSPACE, workspace.detail ?? "workspace_not_passed"); return finish(); }

  // 2. A consumer token never reaches workforce recording routes.
  await step("consumer token refused on workforce recording routes", "401/403 for a consumer token on authority, readiness and transcription", async () => {
    const results = await Promise.all([
      send(ROUTES.authority, input.consumerIdToken, { action: "workspace", encounterId: input.encounterId, locale, jurisdiction: input.jurisdiction }),
      send(ROUTES.readiness, input.consumerIdToken, { encounterId: input.encounterId }),
      send(ROUTES.transcription, input.consumerIdToken, { operation: "list", input: { recordingId: input.encounterId } })]);
    const ok = results.every((r) => [401, 403].includes(r.status));
    return { outcome: ok ? "passed" : "failed", detail: results.map((r) => r.status).join(",") };
  });
  // 3. Two fictional participants, each consenting to every scope under the reviewed releases.
  const consents = await step("participants and consents", "patient and practitioner participants added; six consent grants recorded", async () => {
    const participants: string[] = [];
    for (const kind of ["patient", "practitioner"] as const) {
      const r = await send(ROUTES.authority, input.workforceIdToken, { action: "addParticipant", encounterId: input.encounterId, commandId: uuid(now), kind, displayName: `FICTIONAL ACCEPTANCE ${kind.toUpperCase()}`, canSelfConsent: true });
      const d = data(r); if (r.status !== 200 || !d || !UUID.test(String(d.participantId))) return { outcome: "failed", status: r.status, detail: `participant:${errorCode(r) ?? "invalid"}` };
      participants.push(String(d.participantId));
    }
    let grants = 0;
    for (const participantId of participants) for (const scope of SCOPES) {
      const r = await send(ROUTES.authority, input.workforceIdToken, { action: "grantConsent", participantId, releaseId: releases[scope], commandId: uuid(now), method: "written",
        acknowledgment: "FICTIONAL ACCEPTANCE ACKNOWLEDGMENT. Synthetic account, no person, no clinical content.", representativeAuthorityId: null });
      const d = data(r); if (r.status !== 200 || !d || !UUID.test(String(d.consentId))) return { outcome: "failed", status: r.status, detail: `grant:${scope}:${errorCode(r) ?? "invalid"}` };
      grants += 1;
    }
    return { outcome: "passed", status: 200, detail: `grants:${grants}` };
  });
  if (consents.outcome !== "passed") { await skip(REST_AFTER_WORKSPACE.slice(2), "consents_not_recorded"); return finish(); }
  // 4. Readiness: capture and storage releases are reviewed rows; without them the plane refuses and that is reported.
  let maxSegmentBytes = 0;
  const contentType = "audio/wav";
  const readiness = await step("readiness", "200 ready with audio/wav among the content types and bounded segment size; 503 is not_configured", async () => {
    const r = await send(ROUTES.readiness, input.workforceIdToken, { encounterId: input.encounterId });
    if (notActivated(r)) return { outcome: "not_configured", status: 503, detail: errorCode(r) };
    const d = data(r);
    if (r.status !== 200 || !d || d.ready !== true || d.encounterId !== input.encounterId) return { outcome: "failed", status: r.status, detail: errorCode(r) ?? "readiness_invalid" };
    const types = Array.isArray(d.contentTypes) ? (d.contentTypes as string[]) : [];
    if (!types.includes("audio/wav")) return { outcome: "failed", status: 200, detail: `wav_not_offered:${types.join("|")}` };
    maxSegmentBytes = Number(d.maxSegmentBytes);
    if (!Number.isSafeInteger(maxSegmentBytes) || maxSegmentBytes < 1 || Number(d.maxRecordingBytes) < audioBytes.byteLength) return { outcome: "failed", status: 200, detail: "bounds_too_small_for_fixture" };
    return { outcome: "passed", status: 200, detail: `maxSegmentBytes:${maxSegmentBytes};audioRetentionHours:${String(d.audioRetentionHours)}` };
  });
  if (readiness.outcome !== "passed") { await skip(REST_AFTER_WORKSPACE.slice(3), readiness.detail ?? "not_ready"); return finish(); }
  // 5 and 6. Start once; the same command replayed returns the receipt without a second credential.
  let recordingId = "", sessionId = "", captureToken = "", deletionDeadline: string | null = null;
  const startCommand = uuid(now);
  const started = await step("start capture", "200 capturing with a capture token, credential version 0 and a deletion deadline", async () => {
    const r = await send(ROUTES.start, input.workforceIdToken, { encounterId: input.encounterId, commandId: startCommand, contentType });
    if (notActivated(r)) return { outcome: "not_configured", status: 503, detail: errorCode(r) };
    const d = data(r);
    if (r.status !== 200 || !d || d.status !== "capturing" || d.replayed !== false || !HASH.test(String(d.captureToken)) || !UUID.test(String(d.recordingId)) || !UUID.test(String(d.sessionId)))
      return { outcome: "failed", status: r.status, detail: errorCode(r) ?? "start_invalid" };
    recordingId = String(d.recordingId); sessionId = String(d.sessionId); captureToken = String(d.captureToken); deletionDeadline = typeof d.deletionDeadline === "string" ? d.deletionDeadline : null;
    retained.push({ recordingId, state: "capturing", deletionDeadline });
    return { outcome: "passed", status: 200 };
  });
  if (started.outcome !== "passed") { await skip(REST_AFTER_WORKSPACE.slice(4), started.detail ?? "not_started"); return finish(); }
  await step("start replay is idempotent", "same commandId returns the same recording with replayed true and no capture token", async () => {
    const r = await send(ROUTES.start, input.workforceIdToken, { encounterId: input.encounterId, commandId: startCommand, contentType });
    const d = data(r);
    const ok = r.status === 200 && d?.recordingId === recordingId && d.replayed === true && d.captureToken === null;
    return { outcome: ok ? "passed" : "failed", status: r.status, detail: errorCode(r) };
  });
  // 7. Segments: fictional audio in bounded chunks, each bound to its own digest; a wrong digest is refused and stores nothing.
  const chunk = Math.min(maxSegmentBytes, 1024 * 1024), chunks: Uint8Array[] = [];
  for (let offset = 0; offset < audioBytes.byteLength; offset += chunk) chunks.push(audioBytes.subarray(offset, Math.min(offset + chunk, audioBytes.byteLength)));
  audio.segments = chunks.length;
  const upload = (sequence: number, bytes: Uint8Array, digest: string) => send(ROUTES.segment, input.workforceIdToken, bytes, { "content-type": contentType, "x-alp-recording-id": recordingId,
    "x-alp-session-id": sessionId, "x-alp-capture-token": captureToken, "x-alp-sequence": String(sequence), "x-alp-sha256": digest });
  const segments = await step("segment uploads", `${chunks.length} segments stored with matching sequence and digest; a mismatched digest is refused with 400`, async () => {
    const bad = await upload(0, chunks[0], sha256(Buffer.concat([chunks[0], Buffer.from([1])])));
    if (bad.status !== 400 || errorCode(bad) !== "request_invalid") return { outcome: "failed", status: bad.status, detail: `tampered_digest:${errorCode(bad) ?? bad.status}` };
    for (let sequence = 0; sequence < chunks.length; sequence++) {
      const digest = sha256(chunks[sequence]), r = await upload(sequence, chunks[sequence], digest), d = data(r);
      if (r.status !== 200 || !d || d.recordingId !== recordingId || d.sequence !== sequence || d.sha256 !== digest || d.bytes !== chunks[sequence].byteLength || d.status !== "stored")
        return { outcome: "failed", status: r.status, detail: `segment:${sequence}:${errorCode(r) ?? "receipt_invalid"}` };
    }
    return { outcome: "passed", status: 200, detail: `segments:${chunks.length}` };
  });
  // 8. Recovery state agrees with what was stored and carries the inventory digest the close must name.
  let inventorySha256 = "", credentialVersion = 0;
  const state = await step("recovery state", "storedSegments equals uploads, no pending segment, no processing, audio not deleted", async () => {
    const r = await send(ROUTES.state, input.workforceIdToken, { recordingId }), d = data(r);
    if (r.status !== 200 || !d || d.recordingId !== recordingId) return { outcome: "failed", status: r.status, detail: errorCode(r) };
    inventorySha256 = String(d.inventorySha256); credentialVersion = Number(d.credentialVersion);
    const ok = segments.outcome === "passed" && d.storedSegments === chunks.length && d.pendingSegments === 0 && d.processingRequested === false && d.audioDeleted === false && HASH.test(inventorySha256);
    return { outcome: ok ? "passed" : "failed", status: 200, detail: `stored:${String(d.storedSegments)};pending:${String(d.pendingSegments)}` };
  });
  // 9. Finish: closes the capture against the exact inventory; processing is not requested by finishing.
  const finished = await step("finish", "200 closed with the inventory digest, processingRequested false, audioDeleted false", async () => {
    if (state.outcome !== "passed") return { outcome: "skipped", detail: "state_not_passed" };
    const r = await send(ROUTES.command, input.workforceIdToken, { recordingId, commandId: uuid(now), action: "finish", expectedVersion: credentialVersion, inventorySha256 }), d = data(r);
    const ok = r.status === 200 && d?.recordingId === recordingId && d.statusAtCommand === "closed" && d.inventorySha256 === inventorySha256 && d.processingRequested === false && d.audioDeleted === false;
    if (ok) retained[retained.length - 1] = { recordingId, state: "finished_audio_retained_until_deadline", deletionDeadline };
    return { outcome: ok ? "passed" : "failed", status: r.status, detail: errorCode(r) };
  });
  if (finished.outcome !== "passed") { await skip(REST_AFTER_WORKSPACE.slice(8), "recording_not_finished"); return finish(); }
  // 10 to 12. Transcription: request, bounded polling of the provider job, exact-version read.
  const transcription = (body: Record<string, unknown>) => send(ROUTES.transcription, input.workforceIdToken, body);
  let transcriptId = "";
  const requested = await step("transcription request", "200 requested or processing job for this recording; 503 is not_configured", async () => {
    const commandId = uuid(now), r = await transcription({ operation: "request", input: { recordingId, commandId } });
    if (notActivated(r)) return { outcome: "not_configured", status: 503, detail: errorCode(r) };
    const d = data(r);
    const ok = r.status === 200 && d?.recordingId === recordingId && d.commandId === commandId && ["requested", "processing"].includes(String(d.status)) && d.segmentCount === chunks.length
      && capabilities(r)?.aiDrafting === false;
    return { outcome: ok ? "passed" : "failed", status: r.status, detail: errorCode(r) ?? `status:${String(d?.status)}` };
  });
  if (requested.outcome !== "passed") { await skip(REST_AFTER_WORKSPACE.slice(9), requested.detail ?? "transcription_not_requested"); return finish(); }
  await step("transcription completes", "advance passes end with the job completed and one provider transcript version; a provider failure is reported as failed", async () => {
    for (let i = 0; i < (input.maxPasses ?? 60); i++) {
      const r = await transcription({ operation: "advance", input: { recordingId } }), d = data(r);
      if (r.status !== 200 || !d || d.recordingId !== recordingId) return { outcome: "failed", status: r.status, detail: errorCode(r) };
      const job = d.job as { status?: string; failureCode?: string | null } | null, versions = Array.isArray(d.versions) ? (d.versions as Record<string, unknown>[]) : [];
      if (job?.status === "completed" && versions.length) { const provider = versions.find((v) => v.kind === "provider") ?? versions[0]; transcriptId = String(provider.transcriptId); return { outcome: "passed", status: 200, detail: `passes:${i + 1};words:${String(provider.wordCount)}` }; }
      if (job?.status === "failed" || job?.status === "cancelled") return { outcome: "failed", status: 200, detail: `job_${job.status}:${job.failureCode ?? "unknown"}` };
      await wait(5000);
    }
    return { outcome: "failed", status: 200, detail: "still_processing_after_max_passes" };
  });
  if (!transcriptId) { await skip(REST_AFTER_WORKSPACE.slice(10), "transcript_absent"); return finish(); }
  await step("transcript read", "200 content for the exact transcript whose digest matches its text", async () => {
    const r = await transcription({ operation: "read", input: { transcriptId } }), d = data(r);
    const ok = r.status === 200 && d?.transcriptId === transcriptId && d.recordingId === recordingId && typeof d.text === "string" && d.contentSha256 === sha256(d.text as string);
    return { outcome: ok ? "passed" : "failed", status: r.status, detail: ok ? `chars:${(d!.text as string).length}` : errorCode(r) ?? "content_or_digest_mismatch" };
  });
  // 13 to 15. Drafting: review-only proposed note from the exact transcript version; the provider may be unconfigured (reported, not passed).
  const drafting = (body: Record<string, unknown>) => send(ROUTES.drafting, input.workforceIdToken, body);
  let proposedNoteId = "";
  const draftRequested = await step("drafting request", "200 requested soap draft bound to the transcript; 503 not activated, provider unavailable or prompt unreviewed is not_configured", async () => {
    const commandId = uuid(now), r = await drafting({ operation: "request", input: { recordingId, transcriptId, commandId, noteType: "soap" } });
    if (notActivated(r)) return { outcome: "not_configured", status: 503, detail: errorCode(r) };
    const d = data(r), c = capabilities(r);
    const ok = r.status === 200 && d?.recordingId === recordingId && d.transcriptId === transcriptId && d.commandId === commandId && d.noteType === "soap" && c?.writesClinicalNotes === false && c.reason === "review_only";
    return { outcome: ok ? "passed" : "failed", status: r.status, detail: errorCode(r) ?? `status:${String(d?.status)}` };
  });
  if (draftRequested.outcome !== "passed") { await skip(REST_AFTER_WORKSPACE.slice(12, 14), draftRequested.detail ?? "drafting_not_requested"); }
  else {
    await step("drafting completes", "advance passes end with the job completed and one proposed note version", async () => {
      for (let i = 0; i < (input.maxPasses ?? 60); i++) {
        const r = await drafting({ operation: "advance", input: { recordingId } }), d = data(r);
        if (r.status !== 200 || !d || d.recordingId !== recordingId) return { outcome: "failed", status: r.status, detail: errorCode(r) };
        const job = d.job as { status?: string; failureCode?: string | null } | null, versions = Array.isArray(d.versions) ? (d.versions as Record<string, unknown>[]) : [];
        if (job?.status === "completed" && versions.length) { proposedNoteId = String(versions[0].proposedNoteId); return { outcome: "passed", status: 200, detail: `passes:${i + 1};model:${String(versions[0].model)}` }; }
        if (job?.status === "failed" || job?.status === "cancelled") return { outcome: "failed", status: 200, detail: `job_${job.status}:${job.failureCode ?? "unknown"}` };
        await wait(5000);
      }
      return { outcome: "failed", status: 200, detail: "still_processing_after_max_passes" };
    });
    await step("proposed note read", "200 proposed-note/1 document for the exact note, bound to the transcript, with sections and visible cautions", async () => {
      if (!proposedNoteId) return { outcome: "skipped", detail: "proposed_note_absent" };
      const r = await drafting({ operation: "read", input: { proposedNoteId } }), d = data(r), doc = (d?.document ?? null) as Record<string, unknown> | null;
      const ok = r.status === 200 && d?.proposedNoteId === proposedNoteId && d.recordingId === recordingId && doc?.contract === "proposed-note/1" && doc.transcriptId === transcriptId
        && Array.isArray(doc.sections) && (doc.sections as unknown[]).length >= 1 && Array.isArray(doc.cautions) && capabilities(r)?.writesClinicalNotes === false;
      return { outcome: ok ? "passed" : "failed", status: r.status, detail: ok ? `sections:${(doc!.sections as unknown[]).length};cautions:${(doc!.cautions as unknown[]).length}` : errorCode(r) ?? "document_invalid" };
    });
  }
  // 16. Cleanup review: the recording is visible to the reviewed cleanup process; nothing is deleted by this run.
  await step("cleanup review", "200 processing status and queue page for the recording; media stays until its deadline and is reported retained", async () => {
    const r = await send(ROUTES.cleanupReview, input.workforceIdToken, { action: "processing", recordingId });
    if (notActivated(r)) return { outcome: "not_configured", status: 503, detail: errorCode(r) };
    const d = data(r);
    if (r.status !== 200 || !d || d.recordingId !== recordingId) return { outcome: "failed", status: r.status, detail: errorCode(r) ?? "processing_status_invalid" };
    const queue = await send(ROUTES.cleanupReview, input.workforceIdToken, { action: "queue" }), q = data(queue);
    const ok = queue.status === 200 && Array.isArray(q?.items);
    return { outcome: ok ? "passed" : "failed", status: queue.status, detail: ok ? `queued:${(q!.items as unknown[]).length}` : errorCode(queue) };
  });
  return finish();

  function finish(): RecordingAcceptanceReport {
    const finishedAt = new Date(now()).toISOString();
    const configurationSha256 = sha256(JSON.stringify({ origin, account: input.expectedAwsAccountId, encounterId: input.encounterId, locale, jurisdiction: input.jurisdiction, audio: audio.sha256, sourceCommit: input.sourceCommit, migrationReleaseHash: input.migrationReleaseHash }));
    const passed = (name: string) => steps.some((s) => s.name === name && s.outcome === "passed");
    // Positive acceptance needs the whole pipeline: consent, capture, close, transcript and a review-only draft. Refusals are reported, never counted.
    const ok = steps.every((s) => s.outcome === "passed" || s.outcome === "skipped") && ["finish", "transcription completes", "transcript read", "proposed note read"].every(passed);
    const report: Omit<RecordingAcceptanceReport, "evidenceSha256"> = { schemaVersion: "recording-acceptance/1", environment: "synthetic-staging", ok, sourceCommit: input.sourceCommit,
      migrationReleaseHash: input.migrationReleaseHash, configurationSha256, awsAccountId: input.expectedAwsAccountId, encounterId: input.encounterId, audio, startedAt, finishedAt, steps, retained };
    return { ...report, evidenceSha256: sha256(JSON.stringify({ ...report, startedAt: undefined, finishedAt: undefined })) };
  }
}

function validate(input: { apiOrigin: string; workforceIdToken: string; consumerIdToken: string; encounterId: string; jurisdiction: string; locale?: string; expectedAwsAccountId: string; observedAwsAccountId: string; sourceCommit: string; migrationReleaseHash: string }) {
  let url: URL;
  try { url = new URL(input.apiOrigin); } catch { throw new RecordingAcceptanceError("configuration_invalid"); }
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || !/^[a-z0-9]{10}\.execute-api\.[a-z0-9-]+\.amazonaws\.com$/.test(url.hostname)) throw new RecordingAcceptanceError("configuration_invalid");
  for (const token of [input.workforceIdToken, input.consumerIdToken]) if (!/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new RecordingAcceptanceError("configuration_invalid");
  if (input.workforceIdToken === input.consumerIdToken || !UUID.test(input.encounterId) || !/^[A-Za-z0-9 _-]{1,80}$/.test(input.jurisdiction) || (input.locale !== undefined && !/^[a-z]{2}(-[A-Za-z0-9]{2,8})?$/.test(input.locale)))
    throw new RecordingAcceptanceError("configuration_invalid");
  if (!/^[a-f0-9]{40}$/.test(input.sourceCommit) || !HASH.test(input.migrationReleaseHash)) throw new RecordingAcceptanceError("configuration_invalid");
  // The intended account is asserted by the caller from STS; the production account is refused whatever the caller says.
  if (!/^[0-9]{12}$/.test(input.expectedAwsAccountId) || input.observedAwsAccountId !== input.expectedAwsAccountId || input.expectedAwsAccountId === "173535830222") throw new RecordingAcceptanceError("boundary_refused");
  return url.origin;
}
function uuid(now: () => number) {
  const bytes = createHash("sha256").update(`${now()}:${Math.random()}`).digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
