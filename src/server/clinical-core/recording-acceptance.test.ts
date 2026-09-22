import { describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { fictionalWav, runRecordingAcceptance, RecordingAcceptanceError } from "./recording-acceptance";

// The transport is a fictional router: these cases pin what the hosted run asks for and how it grades what comes back.
const token = (letter: string) => `eyJ${letter.repeat(12)}.${Buffer.from(JSON.stringify({ sub: letter })).toString("base64url")}.${letter.repeat(20)}`;
const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const enc = "11111111-1111-4111-8111-111111111111", rec = "22222222-2222-4222-8222-222222222222", ses = "33333333-3333-4333-8333-333333333333";
const rel = (n: string) => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const transcript = rel("5"), note = rel("6"), time = "2026-09-20T12:00:00.000Z";
const base = { apiOrigin: "https://abcdefghij.execute-api.us-east-2.amazonaws.com", workforceIdToken: token("w"), consumerIdToken: token("c"), encounterId: enc, jurisdiction: "US-SYNTHETIC",
  expectedAwsAccountId: "588966314750", observedAwsAccountId: "588966314750", sourceCommit: "a".repeat(40), migrationReleaseHash: "b".repeat(64), now: () => 1_800_000_000_000, wait: async () => {} };
const caps = { consent: { consentManagement: true, audioCapture: false, reason: "audio_transport_not_configured" }, tr: { transcription: true, aiDrafting: false, reason: "ai_drafting_not_configured" }, dr: { aiDrafting: true, writesClinicalNotes: false, reason: "review_only" } };
type Call = { path: string; auth: string; body: unknown; headers: Record<string, string> };
/** A fictional deployment that behaves per contract; `overrides` replaces the answer for a path (and operation) to model refusals. */
function deployment(overrides: Partial<Record<string, (call: Call, n: number) => Response | null>> = {}) {
  const calls: Call[] = []; const counts = new Map<string, number>(); let advances = 0, draftAdvances = 0; const wav = fictionalWav();
  const fetch = async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname.replace("/clinical-core/workforce/encounter-recording/", ""), headers = Object.fromEntries(Object.entries(init?.headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = init?.body instanceof Uint8Array ? init.body : JSON.parse(String(init?.body)); const call = { path, auth: headers.authorization, body, headers }; calls.push(call);
    const n = (counts.get(path) ?? 0) + 1; counts.set(path, n);
    const key = `${path}${body && !(body instanceof Uint8Array) && (body.operation ?? body.action) ? ":" + (body.operation ?? body.action) : ""}`;
    const override = overrides[key]?.(call, n) ?? overrides[path]?.(call, n); if (override) return override;
    if (call.auth !== "Bearer " + token("w")) return json(401, { error: "reauth_required" });
    if (path === "authority") {
      if (body.action === "workspace") return json(200, { data: { encounterId: enc, encounterStatus: "in_progress", participants: [], consentReleases: ["recording", "transcription", "ai_drafting"].map((scope, i) => ({ id: rel(String(i + 7)), scope, version: "v1", locale: "en", jurisdiction: "US-SYNTHETIC", contentSha256: "c".repeat(64) })), activeCapture: null, finishedCaptures: [] }, capabilities: caps.consent });
      if (body.action === "addParticipant") return json(200, { data: { participantId: rel(body.kind === "patient" ? "a" : "b") }, capabilities: caps.consent });
      if (body.action === "grantConsent") return json(200, { data: { consentId: rel("c") }, capabilities: caps.consent });
    }
    if (path === "readiness") return json(200, { data: { encounterId: enc, ready: true, authorityEpoch: 3, checkedAt: time, expiresAt: time, maxRecordingBytes: 100_000_000, maxSegmentBytes: 65536, maxSegments: 4096, audioRetentionHours: 24, contentTypes: ["audio/webm", "audio/wav"], captureStarted: false, processingRequested: false } });
    if (path === "start") return json(200, { data: { recordingId: rec, sessionId: ses, encounterId: enc, commandId: body.commandId, contentType: "audio/wav", status: "capturing", replayed: n > 1, captureToken: n > 1 ? null : "d".repeat(64), credentialVersion: 0, authorityEpoch: 3, expiresAt: time, deletionDeadline: "2026-09-21T12:00:00.000Z" } });
    if (path === "segment") {
      const digest = createHash("sha256").update(body as Uint8Array).digest("hex");
      if (headers["x-alp-sha256"] !== digest) return json(400, { error: "request_invalid" });
      return json(200, { data: { segmentId: rel("e"), recordingId: headers["x-alp-recording-id"], sequence: Number(headers["x-alp-sequence"]), sha256: digest, bytes: (body as Uint8Array).byteLength, authorityEpoch: 3, status: "stored" } });
    }
    if (path === "state") return json(200, { data: { recordingId: rec, sessionId: ses, status: "capturing", credentialVersion: 0, authorityEpoch: 3, currentAuthorityEpoch: 3, tokenExpiresAt: time, deletionDeadline: time, storedSegments: Math.ceil(wav.byteLength / 65536), pendingSegments: 0, reservedBytes: wav.byteLength, nextSequence: Math.ceil(wav.byteLength / 65536), inventorySha256: "f".repeat(64), disposition: null, processingRequested: false, audioDeleted: false } });
    if (path === "command") return json(200, { data: { recordingId: rec, commandId: body.commandId, action: body.action, statusAtCommand: "closed", credentialVersion: 1, expiresAt: time, inventorySha256: body.inventorySha256, processingRequested: false, audioDeleted: false, replayed: false, captureToken: null, requiresCredentialRecovery: false } });
    if (path === "transcription") {
      if (body.operation === "request") return json(200, { data: { jobId: rel("1"), recordingId: rec, commandId: body.input.commandId, status: "requested", segmentCount: Math.ceil(wav.byteLength / 65536), inventorySha256: "f".repeat(64), replayed: false }, capabilities: caps.tr });
      if (body.operation === "advance") { advances++; const done = advances >= 2; return json(200, { data: { recordingId: rec, status: "closed", job: { jobId: rel("1"), status: done ? "completed" : "processing", providerJobName: "fictional", failureCode: null, segmentCount: 1, inventorySha256: "f".repeat(64), createdAt: time, updatedAt: time }, versions: done ? [{ transcriptId: transcript, version: 1, kind: "provider", contentSha256: createHash("sha256").update("FICTIONAL TONE").digest("hex"), byteLength: 14, wordCount: 2, supersedesId: null, authorId: rel("2"), reason: null, createdAt: time }] : [] }, capabilities: caps.tr }); }
      if (body.operation === "read") return json(200, { data: { transcriptId: transcript, recordingId: rec, version: 1, contentSha256: createHash("sha256").update("FICTIONAL TONE").digest("hex"), text: "FICTIONAL TONE" }, capabilities: caps.tr });
    }
    if (path === "drafting") {
      if (body.operation === "request") return json(200, { data: { jobId: rel("3"), recordingId: rec, transcriptId: body.input.transcriptId, commandId: body.input.commandId, noteType: "soap", status: "requested", replayed: false }, capabilities: caps.dr });
      if (body.operation === "advance") { draftAdvances++; const done = draftAdvances >= 1; return json(200, { data: { recordingId: rec, status: "closed", latestTranscript: { transcriptId: transcript, version: 1 }, job: { jobId: rel("3"), status: done ? "completed" : "requested", noteType: "soap", transcriptId: transcript, failureCode: null, createdAt: time, updatedAt: time }, versions: done ? [{ proposedNoteId: note, version: 1, noteType: "soap", transcriptId: transcript, contentSha256: "9".repeat(64), byteLength: 200, sectionCount: 4, model: "fictional-model", createdBy: rel("2"), createdAt: time }] : [] }, capabilities: caps.dr }); }
      if (body.operation === "read") return json(200, { data: { proposedNoteId: note, recordingId: rec, version: 1, contentSha256: "9".repeat(64), document: { contract: "proposed-note/1", noteType: "soap", transcriptId: transcript, transcriptSha256: "8".repeat(64), model: "fictional-model", promptSha256: "7".repeat(64), sections: [{ key: "s", label: "Subjective", text: "FICTIONAL" }], cautions: ["Audio contained no speech."] } }, capabilities: caps.dr });
    }
    if (path === "cleanup-review") return body.action === "processing" ? json(200, { data: { recordingId: rec, scope: "recording", state: "retained" } }) : json(200, { data: { items: [{ recordingId: rec }], nextAfter: null } });
    return json(404, { error: "route_not_found" });
  };
  return { fetch, calls };
}
describe("hosted recording, transcription and drafting acceptance", () => {
  test("drives consent, capture, segments, close, transcription, review-only drafting and cleanup review, and binds the report to source, migrations, audio and configuration", async () => {
    const d = deployment();
    const report = await runRecordingAcceptance({ ...base, fetch: d.fetch });
    expect(report.execution).toBe("production"); expect(report).not.toHaveProperty("productionActivationEvidence");
    expect(report.verdict).toEqual({ mode: "exploratory", expectedExecution: null, mandatory: ["finish", "transcription completes", "transcript read", "proposed note read"], unmet: [] });
    expect(report.steps.filter((s) => s.outcome !== "passed")).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.steps.map((s) => s.name)).toEqual(["consent workspace", "consumer token refused on workforce recording routes", "participants and consents", "readiness", "start capture", "start replay is idempotent",
      "segment uploads", "recovery state", "finish", "transcription request", "transcription completes", "transcript read", "drafting request", "drafting completes", "proposed note read", "cleanup review"]);
    expect(report.audio).toMatchObject({ source: "generated_tone", contentType: "audio/wav", segments: Math.ceil(fictionalWav().byteLength / 65536) });
    expect(report.audio.bytes).toBe(fictionalWav().byteLength); expect(report.audio.sha256).toBe(createHash("sha256").update(fictionalWav()).digest("hex"));
    expect(report.retained).toEqual([{ recordingId: rec, state: "finished_audio_retained_until_deadline", deletionDeadline: "2026-09-21T12:00:00.000Z" }]);
    // Consents: two participants, six grants, each naming the reviewed release for its scope.
    const grants = d.calls.filter((c) => c.path === "authority" && (c.body as { action: string }).action === "grantConsent");
    expect(grants).toHaveLength(6); expect(new Set(grants.map((c) => (c.body as { releaseId: string }).releaseId)).size).toBe(3);
    // Segments: the tampered digest first, then every chunk in order under the capture token.
    const uploads = d.calls.filter((c) => c.path === "segment");
    expect(uploads[0].headers["x-alp-sha256"]).not.toBe(createHash("sha256").update(uploads[0].body as Uint8Array).digest("hex"));
    expect(uploads.slice(1).map((c) => c.headers["x-alp-sequence"])).toEqual(uploads.slice(1).map((_, i) => String(i)));
    expect(uploads.every((c) => c.headers["x-alp-capture-token"] === "d".repeat(64) && c.headers["content-type"] === "audio/wav")).toBe(true);
    // The close names the exact inventory; transcription and drafting bind to the recording and transcript.
    expect(d.calls.find((c) => c.path === "command")!.body).toMatchObject({ action: "finish", expectedVersion: 0, inventorySha256: "f".repeat(64) });
    expect(d.calls.find((c) => c.path === "drafting")!.body).toMatchObject({ operation: "request", input: { recordingId: rec, transcriptId: transcript, noteType: "soap" } });
    expect(report.steps.find((s) => s.name === "transcription completes")!.detail).toBe("passes:2;words:2");
    expect(report).toMatchObject({ schemaVersion: "recording-acceptance/1", environment: "synthetic-staging", awsAccountId: "588966314750", encounterId: enc });
    expect(report.configurationSha256).toMatch(/^[a-f0-9]{64}$/); expect(report.evidenceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(report)).not.toContain(token("w").slice(0, 20)); expect(JSON.stringify(report)).not.toContain("d".repeat(64));
  });
  test("a run answered by qualification execution is reported as such and is never production activation evidence", async () => {
    // Each run gets its own fictional deployment: replay counters carry across calls, so a shared one would answer a second start as a replay.
    const marked = (d = deployment()) => async (url: string, init?: RequestInit) => { const r = await d.fetch(url, init); return new Response(await r.arrayBuffer(), { status: r.status, headers: { "content-type": "application/json", "x-clinical-execution": "qualification" } }); };
    const report = await runRecordingAcceptance({ ...base, fetch: marked() });
    expect(report.execution).toBe("qualification"); expect(report.ok).toBe(true);
    // In acceptance mode every step is mandatory and the expected execution must answer; a production-answered run cannot qualify as qualification.
    const accepted = await runRecordingAcceptance({ ...base, mode: "acceptance", expectedExecution: "qualification", fetch: marked() });
    expect(accepted.ok).toBe(true); expect(accepted.verdict.mandatory).toHaveLength(16); expect(accepted.verdict.unmet).toEqual([]);
    const wrong = await runRecordingAcceptance({ ...base, mode: "acceptance", expectedExecution: "qualification", fetch: deployment().fetch });
    expect(wrong.ok).toBe(false); expect(wrong.execution).toBe("production");
    const notActivated = deployment({ "authority:workspace": () => json(503, { error: "production_not_activated", phiAllowed: false }) });
    const partial = await runRecordingAcceptance({ ...base, mode: "acceptance", expectedExecution: "production", fetch: notActivated.fetch });
    expect(partial.ok).toBe(false); expect(partial.verdict.unmet).toHaveLength(16); expect(partial.steps).toHaveLength(16);
    await expect(runRecordingAcceptance({ ...base, mode: "acceptance", fetch: deployment().fetch })).rejects.toThrow("configuration_invalid");
    const plain = await runRecordingAcceptance({ ...base, fetch: deployment().fetch });
    expect(plain.evidenceSha256).not.toBe(report.evidenceSha256);
  });
  test("a recording plane that is not activated is not_configured and everything after is skipped; never a pass", async () => {
    const d = deployment({ "authority:workspace": () => json(503, { error: "production_not_activated", phiAllowed: false }) });
    const report = await runRecordingAcceptance({ ...base, fetch: d.fetch });
    expect(report.ok).toBe(false);
    expect(report.steps[0]).toMatchObject({ outcome: "not_configured", detail: "production_not_activated" });
    expect(report.steps.slice(1).every((s) => s.outcome === "skipped")).toBe(true); expect(d.calls).toHaveLength(1);
  });
  test("a missing reviewed consent release, an unconfigured drafting provider and a provider failure are each reported for what they are", async () => {
    const missing = deployment({ "authority:workspace": () => json(200, { data: { encounterId: enc, encounterStatus: "in_progress", participants: [], consentReleases: [{ id: rel("7"), scope: "recording", version: "v1", locale: "en", jurisdiction: "US-SYNTHETIC", contentSha256: "c".repeat(64) }], activeCapture: null, finishedCaptures: [] }, capabilities: caps.consent }) });
    const noRelease = await runRecordingAcceptance({ ...base, fetch: missing.fetch });
    expect(noRelease.steps[0]).toMatchObject({ outcome: "not_configured", detail: "consent_release_missing:transcription,ai_drafting" }); expect(noRelease.ok).toBe(false);
    const provider = deployment({ "drafting:request": () => json(503, { error: "provider_unavailable" }) });
    const noDrafting = await runRecordingAcceptance({ ...base, fetch: provider.fetch });
    expect(noDrafting.ok).toBe(false);
    expect(noDrafting.steps.map((s) => [s.name, s.outcome]).slice(12)).toEqual([["drafting request", "not_configured"], ["drafting completes", "skipped"], ["proposed note read", "skipped"], ["cleanup review", "passed"]]);
    expect(noDrafting.steps.find((s) => s.name === "transcript read")!.outcome).toBe("passed");
    const failing = deployment({ "transcription:advance": () => json(200, { data: { recordingId: rec, status: "closed", job: { jobId: rel("1"), status: "failed", providerJobName: null, failureCode: "provider_failed:fictional", segmentCount: 1, inventorySha256: "f".repeat(64), createdAt: time, updatedAt: time }, versions: [] }, capabilities: caps.tr }) });
    const failed = await runRecordingAcceptance({ ...base, fetch: failing.fetch });
    expect(failed.ok).toBe(false);
    expect(failed.steps.find((s) => s.name === "transcription completes")).toMatchObject({ outcome: "failed", detail: "job_failed:provider_failed:fictional" });
    expect(failed.steps.slice(11).every((s) => s.outcome === "skipped")).toBe(true);
    expect(failed.retained).toEqual([{ recordingId: rec, state: "finished_audio_retained_until_deadline", deletionDeadline: "2026-09-21T12:00:00.000Z" }]);
  });
  test("a consumer token that is accepted on a workforce route, or a tampered segment that is stored, fails the run", async () => {
    const leaky = deployment({ readiness: (call) => (call.auth === "Bearer " + token("c") ? json(200, { data: {} }) : null) });
    const report = await runRecordingAcceptance({ ...base, fetch: leaky.fetch });
    expect(report.steps[1]).toMatchObject({ outcome: "failed", detail: "401,200,401" }); expect(report.ok).toBe(false);
    const storing = deployment({ segment: (call, n) => (n === 1 ? json(200, { data: { segmentId: rel("e"), recordingId: rec, sequence: 0, sha256: call.headers["x-alp-sha256"], bytes: 1, authorityEpoch: 3, status: "stored" } }) : null) });
    const stored = await runRecordingAcceptance({ ...base, fetch: storing.fetch });
    expect(stored.steps.find((s) => s.name === "segment uploads")).toMatchObject({ outcome: "failed", detail: "tampered_digest:200" }); expect(stored.ok).toBe(false);
  });
  test("refuses the production account, a mismatched observed account, non-execute-api origins, equal tokens and malformed inputs before any request", async () => {
    const d = deployment();
    await expect(runRecordingAcceptance({ ...base, fetch: d.fetch, expectedAwsAccountId: "173535830222", observedAwsAccountId: "173535830222" })).rejects.toBeInstanceOf(RecordingAcceptanceError);
    await expect(runRecordingAcceptance({ ...base, fetch: d.fetch, observedAwsAccountId: "111122223333" })).rejects.toThrow("boundary_refused");
    for (const patch of [{ apiOrigin: "https://example.com" }, { consumerIdToken: token("w") }, { encounterId: "not-a-uuid" }, { jurisdiction: "bad;jurisdiction" }, { sourceCommit: "short" }, { locale: "EN_US" }] as const)
      await expect(runRecordingAcceptance({ ...base, fetch: d.fetch, ...patch })).rejects.toThrow("configuration_invalid");
    await expect(runRecordingAcceptance({ ...base, fetch: d.fetch, audio: { bytes: new Uint8Array(10), source: "supplied_file" } })).rejects.toThrow("configuration_invalid");
    expect(d.calls).toHaveLength(0);
    const wav = fictionalWav(1, 8000);
    expect(Buffer.from(wav.subarray(0, 4)).toString("latin1")).toBe("RIFF"); expect(wav.byteLength).toBe(44 + 8000 * 2);
  });
});
