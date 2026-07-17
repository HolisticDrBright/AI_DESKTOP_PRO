/**
 * CONTRACT-FIXTURE BACKEND — NOT the real clinical backend.
 *
 * A tiny in-memory server that speaks the exact wire contract the desktop's
 * live path expects (Supabase-auth token endpoint + superjson-shaped tRPC
 * procedures). It exists so the live-mode UI can be exercised end-to-end —
 * loading a real queue, resolving an item, loading a labs workspace, reviewing
 * a marker, persisting across browser reloads, reading the audit trail — in
 * environments where the deployed tRPC backend
 * and the clinical Supabase project are unreachable (sandboxes, offline dev).
 *
 * The real data layer is verified separately against the actual project
 * (supabase/tests/*.sql, run via MCP). This stub holds SYNTHETIC fixture data
 * only — no PHI — and everything lives in process memory: restart = reset.
 *
 * Run:   node scripts/live-stub-server.mjs        (port 3999, STUB_PORT to change)
 * Then:  NEXT_PUBLIC_USE_LIVE_API=true npm run build
 *        TRPC_BASE_URL=http://127.0.0.1:3999/api/trpc \
 *        CLINICAL_SUPABASE_URL=http://127.0.0.1:3999 \
 *        CLINICAL_SUPABASE_ANON_KEY=stub CLINICAL_DEMO_EMAIL=demo@local \
 *        CLINICAL_DEMO_PASSWORD=demo CLINICAL_ORG_ID=org-fixture \
 *        npx next start -p 3114
 */
import { createServer } from "node:http";

const PORT = Number(process.env.STUB_PORT ?? 3999);

/* ------------------------------------------------------------ fixture state */

const PATIENTS = [
  { id: "aaaaaaaa-1111-2222-3333-444444444401", mrn: "FX-0001", first_name: "Fixture", last_name: "Patient", date_of_birth: "1990-04-12", sex: "female", status: "active" },
  { id: "aaaaaaaa-1111-2222-3333-444444444402", mrn: "FX-0002", first_name: "Sample", last_name: "Client", date_of_birth: "1984-09-03", sex: "male", status: "active" },
];

const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();

// Organization roster (membership management fixtures). The signed-in fixture
// practitioner is the org owner; guard errors reuse the backend's exact
// server-owned copy so the desktop's message allowlist passes them through.
let memberSeq = 2;
const revokedBearers = new Set();
const members = new Map([
  ["mem-1", {
    membershipId: "mem-1",
    userId: "user-demo",
    email: "practitioner@fixture.local",
    displayName: "Demo Practitioner",
    role: "owner",
    status: "active",
    joinedAt: "2026-07-01T00:00:00Z",
  }],
  ["mem-2", {
    membershipId: "mem-2",
    userId: "user-colleague",
    email: "colleague@fixture.local",
    displayName: null,
    role: "practitioner",
    status: "active",
    joinedAt: "2026-07-02T00:00:00Z",
  }],
]);

// EMR fixtures (Phase 2 slice 1): encounters + notes with the same semantics
// as the 0021 RPCs — version conflicts, frozen-after-sign, idempotent sign,
// append-only addenda, org-scoped visibility, clinical-only timeline.
let emrSeq = 0;
const encounters = new Map(); // id → { id, organizationId, patientId, appointmentId, visitType, status, startedAt, endedAt, statusReason, createdAt }
const emrNotes = new Map();   // id → { id, encounterId, patientId, organizationId, noteType, status, currentVersion, versions: Map<v,{content,savedAt,sha}>, signature, addenda: [], provenance: [], statusReason }

/* ---- scribe (0022/0023 semantics): consent-gated recording + transcripts ---- */
const scribeDocs = [
  { id: "99999999-aaaa-bbbb-cccc-000000000001", scope: "recording", version: 1, locale: "en", jurisdiction: "US-CA", title: "Recording consent", body: "You agree this visit may be audio recorded.", presentationFormat: "text/markdown", contentSha256: "1".repeat(64), effectiveDate: "2026-01-01", shared: false },
  { id: "99999999-aaaa-bbbb-cccc-000000000002", scope: "transcription", version: 1, locale: "en", jurisdiction: "US-CA", title: "Transcription consent", body: "You agree the recording may be transcribed.", presentationFormat: "text/markdown", contentSha256: "2".repeat(64), effectiveDate: "2026-01-01", shared: false },
  { id: "99999999-aaaa-bbbb-cccc-000000000003", scope: "ai_drafting", version: 1, locale: "en", jurisdiction: "US-CA", title: "AI drafting consent", body: "You agree an AI scribe may draft a note for practitioner review.", presentationFormat: "text/markdown", contentSha256: "3".repeat(64), effectiveDate: "2026-01-01", shared: false },
];
let scribeSeq = 0;
const scribeId = (tag) => `99999999-${tag}-4444-5555-${String(444444444400 + ++scribeSeq)}`;
const scribeParticipants = new Map(); // id -> {id, encounterId, kind, displayName, canSelfConsent, leftAt, consents: []}
const scribeRecordings = new Map();   // id -> rec
const scribeSessions = new Map();     // id -> {id, recordingId, status, pauseReason}
const scribeTokens = new Map();       // token -> {recordingId, sessionId, action, revoked, consumed}
const scribeTranscripts = new Map();  // recordingId -> transcript
const scribeGenerations = new Map();  // `${transcriptId}:${rev}:${tmpl}` -> {noteId, generationId}
const scribeAccessLog = [];           // SECURITY log — never merged into auditEvents

function scribeAllConsented(encounterId, scope) {
  const active = [...scribeParticipants.values()].filter((p) => p.encounterId === encounterId && !p.leftAt);
  if (active.length === 0) return false;
  return active.every((p) => p.consents.some((c) => c.scope === scope && c.status === "granted"));
}
function scribeTransition(rec, to, reason) {
  rec.transitions.push({ from: rec.status, to, reason, at: new Date().toISOString() });
  rec.status = to;
}
function scribePauseLive(encounterId, reason) {
  for (const sess of scribeSessions.values()) {
    const rec = scribeRecordings.get(sess.recordingId);
    if (rec && rec.encounterId === encounterId && sess.status === "active") {
      sess.status = "paused";
      sess.pauseReason = reason;
      if (rec.status === "capturing") scribeTransition(rec, "paused", reason);
    }
  }
}
function scribeRevokeLive(encounterId) {
  for (const t of scribeTokens.values()) {
    const rec = scribeRecordings.get(t.recordingId);
    if (rec && rec.encounterId === encounterId && !t.consumed) t.revoked = true;
  }
  for (const sess of scribeSessions.values()) {
    const rec = scribeRecordings.get(sess.recordingId);
    if (rec && rec.encounterId === encounterId && ["active", "paused"].includes(sess.status)) {
      sess.status = "revoked";
      sess.pauseReason = "consent_withdrawn";
      if (rec.status === "capturing") scribeTransition(rec, "paused", "consent withdrawn");
    }
  }
}
function scribeTranscriptDto(recordingId) {
  const t = scribeTranscripts.get(recordingId);
  if (!t) return null;
  return {
    transcriptId: t.transcriptId,
    encounterId: t.encounterId,
    provider: "fixture",
    revision: t.revision,
    status: t.status,
    finalizedAt: t.finalizedAt ?? null,
    segments: t.segments.map((seg) => {
      const latest = seg.corrections[seg.corrections.length - 1] ?? null;
      return {
        id: seg.id, seq: seg.seq, speaker: seg.speaker, startMs: seg.startMs, endMs: seg.endMs,
        rawText: seg.rawText, confidence: seg.confidence,
        providerRevisions: [],
        corrections: seg.corrections.map((c, i) => ({ version: i + 1, sourceRevision: 0, text: c, reason: null })),
        effectiveText: latest ?? seg.rawText,
        effectiveSource: latest ? "correction" : "raw",
      };
    }),
  };
}

const nowIso = () => new Date().toISOString();

function emrAudit(action, resourceId, message, patientId) {
  pushAudit(action, action.startsWith("encounter") ? "encounter" : "clinical_note", resourceId, message, {}, patientId);
}

const queue = new Map(
  [
    { id: "bbbbbbbb-1111-2222-3333-444444444401", itemType: "abnormal_result", title: "Recheck hs-CRP after abnormal result", priority: "high", status: "open", patientId: PATIENTS[0].id, patientName: "Fixture Patient", assigneeName: "Demo Practitioner", dueAt: iso(-2 * 864e5), createdAt: iso(3 * 864e5) },
    { id: "bbbbbbbb-1111-2222-3333-444444444402", itemType: "lab_extraction", title: "Verify extracted markers from uploaded panel", priority: "medium", status: "open", patientId: PATIENTS[0].id, patientName: "Fixture Patient", assigneeName: "Demo Practitioner", dueAt: iso(0), createdAt: iso(2 * 864e5) },
    { id: "bbbbbbbb-1111-2222-3333-444444444403", itemType: "hypothesis", title: "Review updated reasoning hypothesis", priority: "medium", status: "open", patientId: PATIENTS[1].id, patientName: "Sample Client", assigneeName: null, dueAt: null, createdAt: iso(864e5) },
    { id: "bbbbbbbb-1111-2222-3333-444444444404", itemType: "assessment", title: "Quarterly org QA checklist", priority: "low", status: "resolved", patientId: null, patientName: null, assigneeName: "Demo Practitioner", dueAt: null, createdAt: iso(5 * 864e5) },
  ].map((r) => [r.id, r]),
);

/**
 * Labs workspace fixture for the first patient. Markers mutate in memory when
 * reviewed, so — exactly like the real backend — a review decision survives a
 * browser reload and the workspace's reviewSummary is recomputed per read.
 */
const labMarkers = [
  {
    id: "eeeeeeee-1111-2222-3333-444444444401",
    name: "hs-CRP", unit: "mg/L", current: 2.8, currentDisplay: "2.8 mg/L",
    prior: 3.4, priorDisplay: "3.4 mg/L", changeDisplay: "▼ 0.6", changePct: -17.6,
    labRangeText: "< 1.0 mg/L", optimalRange: { unit: "mg/L", source: "Not configured" },
    status: "high", trend: "improving",
    series: [{ date: "May", value: 3.4 }, { date: "Jul", value: 2.8 }],
    confidence: 97, confidenceBand: "high", reviewState: "awaiting-review",
    collectedAt: iso(15 * 864e5),
    source: { reportName: "Fixture panel — July", location: "p. 2", snippet: "hs-CRP 2.8 mg/L (H)", confidenceNote: "Extraction confidence 97% (fixture)", documentId: "ffffffff-1111-2222-3333-444444444401" },
    provenance: { sourceType: "measured", sourceName: "Fixture panel — July", lastUpdated: iso(6 * 864e5) },
    relatedSystems: [], relatedContext: [], relatedHypotheses: [], relatedProtocols: [], seeds: [],
  },
  {
    id: "eeeeeeee-1111-2222-3333-444444444402",
    name: "Ferritin", unit: "ng/mL", current: 96, currentDisplay: "96 ng/mL",
    labRangeText: "30–400 ng/mL", optimalRange: { unit: "ng/mL", source: "Not configured" },
    status: "normal", trend: "needs-review",
    series: [{ date: "Jul", value: 96 }],
    confidence: 55, confidenceBand: "low", reviewState: "not-reviewed",
    collectedAt: iso(15 * 864e5),
    source: { reportName: "Fixture panel — July", location: "p. 3", snippet: "Ferritin 96 ng/mL", confidenceNote: "Extraction confidence 55% — verify against source (fixture)", documentId: "ffffffff-1111-2222-3333-444444444401" },
    provenance: { sourceType: "measured", sourceName: "Fixture panel — July", lastUpdated: iso(6 * 864e5) },
    relatedSystems: [], relatedContext: [], relatedHypotheses: [], relatedProtocols: [], seeds: [],
  },
  {
    id: "eeeeeeee-1111-2222-3333-444444444403",
    name: "TSH", unit: "mIU/L", current: 2.1, currentDisplay: "2.1 mIU/L",
    labRangeText: "0.4–4.0 mIU/L", optimalRange: { unit: "mIU/L", source: "Not configured" },
    status: "normal", trend: "stable",
    series: [{ date: "May", value: 2.3 }, { date: "Jul", value: 2.1 }],
    confidence: 99, confidenceBand: "high", reviewState: "reviewed",
    collectedAt: iso(15 * 864e5),
    source: { reportName: "Fixture panel — July", location: "p. 3", snippet: "TSH 2.1 mIU/L", confidenceNote: "Extraction confidence 99% (fixture)", documentId: "ffffffff-1111-2222-3333-444444444401" },
    provenance: { sourceType: "measured", sourceName: "Fixture panel — July", lastUpdated: iso(6 * 864e5) },
    relatedSystems: [], relatedContext: [], relatedHypotheses: [], relatedProtocols: [], seeds: [],
  },
  {
    id: "eeeeeeee-1111-2222-3333-444444444406",
    name: "Sodium", unit: "mmol/L", current: 141, currentDisplay: "141 mmol/L",
    labRangeText: "Not provided by lab", optimalRange: { unit: "mmol/L", source: "Not configured" },
    status: "unknown", trend: "needs-review",
    series: [{ date: "Jul", value: 141 }],
    confidence: null, confidenceBand: "unknown", reviewState: "not-reviewed",
    collectedAt: iso(15 * 864e5),
    source: { reportName: "Fixture panel — July", location: "Structured result preview", snippet: "Sodium 141 mmol/L", confidenceNote: "Extraction confidence was not recorded — verify against the source before relying on this result.", documentId: "ffffffff-1111-2222-3333-444444444401" },
    provenance: { sourceType: "measured", sourceName: "Fixture panel — July", lastUpdated: iso(6 * 864e5) },
    relatedSystems: [], relatedContext: [], relatedHypotheses: [], relatedProtocols: [], seeds: [],
  },
];

const labReports = [
  { id: "ffffffff-1111-2222-3333-444444444401", name: "Fixture panel — July", lab: "Fixture Lab", collectedAt: iso(15 * 864e5), uploadedAt: iso(6 * 864e5), markerCount: 3 },
];

function labsWorkspaceFor(patient) {
  const reviewed = labMarkers.filter((m) => m.reviewState === "reviewed").length;
  return {
    patientId: patient.id,
    patientName: `${patient.first_name} ${patient.last_name}`,
    lastUpload: labReports[labReports.length - 1].uploadedAt,
    lastSynced: new Date().toISOString(),
    reviewSummary: {
      reviewed,
      awaiting: labMarkers.length - reviewed,
      lowConfidence: labMarkers.filter((m) => m.confidenceBand === "low").length,
      abnormal: labMarkers.filter((m) => m.status !== "normal" && m.status !== "optimal").length,
    },
    reports: [...labReports].reverse(),
    queue: [],
    markers: labMarkers,
  };
}

/** Fixture ingestion result for an uploaded PDF: 2 markers, 1 low-confidence. */
function ingestUploadFixture(patientId) {
  const docId = "ffffffff-1111-2222-3333-444444444402";
  labReports.push({
    id: docId,
    name: "Uploaded panel (fixture extraction)",
    lab: "Fixture Lab",
    collectedAt: new Date().toISOString(),
    uploadedAt: new Date().toISOString(),
    markerCount: 2,
  });
  labMarkers.push(
    {
      id: "eeeeeeee-1111-2222-3333-444444444404",
      name: "Glucose", unit: "mg/dL", current: 92, currentDisplay: "92 mg/dL",
      labRangeText: "65-99 mg/dL", optimalRange: { unit: "mg/dL", source: "Not configured" },
      status: "normal", trend: "needs-review",
      series: [{ date: "Jul", value: 92 }],
      confidence: 93, confidenceBand: "high", reviewState: "awaiting-review",
      collectedAt: new Date().toISOString(),
      source: { reportName: "Uploaded panel (fixture extraction)", location: "p. 1", snippet: "Glucose 92 mg/dL", confidenceNote: "Extraction confidence 93% (fixture)", documentId: docId },
      provenance: { sourceType: "measured", sourceName: "Uploaded panel", lastUpdated: new Date().toISOString() },
      relatedSystems: [], relatedContext: [], relatedHypotheses: [], relatedProtocols: [], seeds: [],
    },
    {
      id: "eeeeeeee-1111-2222-3333-444444444405",
      name: "Osmolality", unit: "mOsm/kg", current: 285, currentDisplay: "285 mOsm/kg",
      labRangeText: "275-295 mOsm/kg", optimalRange: { unit: "mOsm/kg", source: "Not configured" },
      status: "normal", trend: "needs-review",
      series: [{ date: "Jul", value: 285 }],
      confidence: 58, confidenceBand: "low", reviewState: "not-reviewed",
      collectedAt: new Date().toISOString(),
      source: { reportName: "Uploaded panel (fixture extraction)", location: "p. 1", snippet: "Osmolality 285 mOsm/kg", confidenceNote: "Extraction confidence 58% — verify against source (fixture)", documentId: docId },
      provenance: { sourceType: "measured", sourceName: "Uploaded panel", lastUpdated: new Date().toISOString() },
      relatedSystems: [], relatedContext: [], relatedHypotheses: [], relatedProtocols: [], seeds: [],
    },
  );
  const queueId = "bbbbbbbb-1111-2222-3333-444444444405";
  queue.set(queueId, {
    id: queueId,
    itemType: "lab_extraction",
    title: "Verify 1 low-confidence marker from uploaded panel",
    priority: "medium",
    status: "open",
    patientId,
    patientName: "Fixture Patient",
    assigneeName: "Demo Practitioner",
    dueAt: null,
    createdAt: new Date().toISOString(),
  });
  pushAudit(
    "lab_document.ingest",
    "lab_document",
    docId,
    "Lab document extracted (2 markers)",
    { marker_count: 2, low_confidence_count: 1, matched_definitions: 1, review_queue_item_id: queueId },
    patientId,
  );
  return {
    documentId: docId,
    status: "extracted",
    inserted: 2,
    matched: 1,
    lowConfidence: 1,
    queueItemId: queueId,
  };
}

/**
 * Schedule fixture: seeded on the FIRST calendar request, relative to the
 * requested week, so the e2e run always finds appointments in view. Booked
 * and status-changed rows mutate in memory like the real backend.
 */
const PRACTITIONER_USER_ID = "dddddddd-1111-2222-3333-444444444401";
let scheduleSeeded = false;
let apptSeq = 0;
const scheduleAppointments = [];
function seedScheduleFor(fromIso) {
  if (scheduleSeeded) return;
  scheduleSeeded = true;
  const from = new Date(fromIso);
  const at = (dayOffset, h, m = 0) => {
    const d = new Date(from);
    d.setDate(d.getDate() + dayOffset);
    d.setHours(h, m, 0, 0);
    return d;
  };
  scheduleAppointments.push(
    {
      id: "abababab-1111-2222-3333-444444444401",
      patientId: PATIENTS[0].id, patientName: "Fixture Patient",
      practitionerUserId: PRACTITIONER_USER_ID, practitionerName: "Demo Practitioner",
      title: null, appointmentType: "follow-up", location: "Room 1", telehealthUrl: null,
      status: "confirmed", startsAt: at(1, 15).toISOString(), endsAt: at(1, 15, 45).toISOString(),
    },
    {
      id: "abababab-1111-2222-3333-444444444402",
      patientId: null, patientName: null,
      practitionerUserId: PRACTITIONER_USER_ID, practitionerName: "Demo Practitioner",
      title: "Admin block", appointmentType: "break", location: "Admin", telehealthUrl: null,
      status: "scheduled", startsAt: at(2, 12).toISOString(), endsAt: at(2, 13).toISOString(),
    },
  );
}

const auditEvents = [];
let auditSeq = 0;
function pushAudit(action, resourceType, resourceId, safeMessage, metadata, patientId = null) {
  auditEvents.unshift({
    id: `cccccccc-1111-2222-3333-${String(444444444400 + ++auditSeq)}`,
    action,
    resourceType,
    resourceId,
    safeMessage,
    metadata,
    patientId,
    actorUserId: "dddddddd-1111-2222-3333-444444444401",
    occurredAt: new Date().toISOString(),
  });
}

/* --------------------------------------------------------------- wire utils */

const json = (res, status, value) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
};
const trpcOk = (res, value) => json(res, 200, { result: { data: { json: value } } });
const trpcErr = (res, status, code, message) =>
  json(res, status, { error: { json: { message, data: { code, httpStatus: status } } } });

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        resolve({});
      }
    });
  });

const readRaw = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });

/** Just enough multipart parsing for the fixture: text fields + file presence. */
function parseMultipart(buffer, contentType) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType ?? "");
  if (!boundary) return { fields: {}, hasFile: false, fileBytes: 0 };
  const marker = `--${(boundary[1] ?? boundary[2]).trim()}`;
  const raw = buffer.toString("latin1");
  const fields = {};
  let hasFile = false;
  let fileBytes = 0;
  for (const part of raw.split(marker)) {
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;
    const headers = part.slice(0, headerEnd);
    const value = part.slice(headerEnd + 4).replace(/\r\n$/, "");
    const name = /name="([^"]+)"/.exec(headers)?.[1];
    if (!name) continue;
    if (/filename="/.test(headers)) {
      hasFile = true;
      fileBytes = value.length;
    } else {
      fields[name] = value;
    }
  }
  return { fields, hasFile, fileBytes };
}

/* ------------------------------------------------------------------- server */

createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  // Supabase-auth-shaped token endpoint (identity only, fixture tokens).
  // Handles both password and refresh_token grants; echoes a stable email so
  // the desktop's cookie-session sign-in flow can be exercised end-to-end.
  // Password reset fixtures: request always succeeds (enumeration-safe, like
  // Supabase); completing requires the fixture recovery token.
  if (url.pathname === "/auth/v1/recover" && req.method === "POST") {
    await readBody(req);
    return json(res, 200, {});
  }
  if (url.pathname === "/auth/v1/user" && req.method === "PUT") {
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const body = await readBody(req);
    if (bearer !== "recovery-token-fixture" || !body.password) {
      return json(res, 401, { error: "invalid_token" });
    }
    return json(res, 200, { id: "dddddddd-1111-2222-3333-444444444401", email: "practitioner@fixture.local" });
  }

  if (url.pathname === "/auth/v1/token") {
    const body = await readBody(req);
    // Revoked-refresh fixture: exercises the desktop middleware's clear-session
    // path exactly like Supabase rejecting a rotated-out token.
    if (body.refresh_token === "revoked-refresh-token") {
      return json(res, 400, { error: "invalid_grant", error_description: "Token revoked" });
    }
    // Per-user fixture identities (org edge cases): the bearer carries a
    // suffix so tRPC handlers can answer with that user's memberships.
    const email = body.email ?? "demo@local";
    const suffix =
      email === "no-orgs@fixture.local" ? "--noorg"
      : email === "dual-org@fixture.local" ? "--multi"
      : "";
    return json(res, 200, {
      access_token: `fixture-access-token${suffix}`,
      refresh_token: "fixture-refresh-token",
      expires_in: 3600,
      user: { email },
    });
  }

  // Test control: revoke ALL memberships for a bearer mid-session — mirrors an
  // admin removing the practitioner while their app is open (rows vanish under
  // RLS; org-scoped calls become forbidden).
  if (url.pathname === "/__control/revoke-memberships" && req.method === "POST") {
    const body = await readBody(req);
    revokedBearers.add(String(body.bearer ?? ""));
    return json(res, 200, { ok: true });
  }

  // Authorized source-document download (same contract as the real backend).
  const docMatch = /^\/api\/clinical\/labs\/document\/([0-9a-f-]{36})$/.exec(url.pathname);
  if (docMatch && req.method === "GET") {
    if (!/^Bearer .+/.test(req.headers.authorization ?? "")) {
      return json(res, 401, { error: { code: "unauthenticated", message: "Authentication required" } });
    }
    const knownDocs = ["ffffffff-1111-2222-3333-444444444401", "ffffffff-1111-2222-3333-444444444402"];
    if (!knownDocs.includes(docMatch[1])) {
      return json(res, 403, { error: { code: "forbidden", message: "Document not found or not accessible" } });
    }
    pushAudit("document.viewed", "lab_document", docMatch[1], "Source document viewed", {}, PATIENTS[0].id);
    res.writeHead(200, { "content-type": "application/pdf" });
    return res.end("%PDF-1.4 fixture source document\n%%EOF");
  }

  // Multipart lab-PDF ingestion endpoint (same contract as the real backend).
  if (url.pathname === "/api/clinical/labs/upload" && req.method === "POST") {
    if (!/^Bearer .+/.test(req.headers.authorization ?? "")) {
      return json(res, 401, { error: { code: "unauthenticated", message: "Authentication required" } });
    }
    const raw = await readRaw(req);
    const { fields, hasFile, fileBytes } = parseMultipart(raw, req.headers["content-type"]);
    if (!hasFile || fileBytes === 0 || !fields.patientId) {
      return json(res, 400, { error: { code: "invalid", message: "A PDF file is required" } });
    }
    const patient = PATIENTS.find((p) => p.id === fields.patientId);
    if (!patient) {
      return json(res, 403, { error: { code: "forbidden", message: "Patient not found or not accessible" } });
    }
    return json(res, 200, { data: ingestUploadFixture(patient.id) });
  }

  // ===== scribe binary endpoints (0022 token semantics) =====
  const chunkMatch = /^\/api\/clinical\/scribe\/recordings\/([0-9a-f-]{36})\/chunks$/.exec(url.pathname);
  if (chunkMatch && req.method === "POST") {
    if (!/^Bearer .+/.test(req.headers.authorization ?? "")) return json(res, 401, { error: { code: "unauthenticated", message: "auth" } });
    const rec = scribeRecordings.get(chunkMatch[1]);
    if (!rec) return json(res, 404, { error: { code: "not_found", message: "recording" } });
    const token = req.headers["x-capture-token"] ?? "";
    const t = scribeTokens.get(token);
    const sess = t ? scribeSessions.get(t.sessionId) : null;
    if (!t || t.recordingId !== rec.id || t.action !== "chunk" || t.revoked || !sess || sess.status !== "active" ||
        !scribeAllConsented(rec.encounterId, "recording")) {
      return json(res, 409, { error: { code: "capture_refused", message: "Capture is no longer authorized" } });
    }
    const bytes = await new Promise((resolve) => {
      const parts = [];
      req.on("data", (c) => parts.push(c));
      req.on("end", () => resolve(Buffer.concat(parts)));
    });
    rec.bytes += bytes.length;
    return json(res, 200, { data: { receivedBytes: bytes.length, totalBytes: rec.bytes } });
  }
  const completeMatch = /^\/api\/clinical\/scribe\/recordings\/([0-9a-f-]{36})\/complete$/.exec(url.pathname);
  if (completeMatch && req.method === "POST") {
    if (!/^Bearer .+/.test(req.headers.authorization ?? "")) return json(res, 401, { error: { code: "unauthenticated", message: "auth" } });
    const rec = scribeRecordings.get(completeMatch[1]);
    if (!rec) return json(res, 404, { error: { code: "not_found", message: "recording" } });
    if (["uploaded", "transcription_queued", "transcribing", "transcript_ready", "review_pending", "finalized"].includes(rec.status)) {
      return json(res, 200, { data: { status: rec.status, idempotent: true, totalBytes: rec.bytes } });
    }
    const body = await readBody(req);
    const t = scribeTokens.get(body.completionToken ?? "");
    if (!t || t.recordingId !== rec.id || t.action !== "complete" || t.revoked || t.consumed ||
        !scribeAllConsented(rec.encounterId, "recording")) {
      return json(res, 409, { error: { code: "completion_refused", message: "Completion is not authorized" } });
    }
    t.consumed = true;
    rec.durationMs = Number(body.durationMs) || 60000;
    const sess = scribeSessions.get(t.sessionId);
    if (sess && ["active", "paused"].includes(sess.status)) sess.status = "closed";
    scribeTransition(rec, "uploading", "upload received");
    scribeTransition(rec, "uploaded", "upload complete");
    pushAudit("recording.uploaded", "encounter_recording", rec.id, "Recording uploaded", {}, rec.patientId);
    return json(res, 200, { data: { status: "uploaded", idempotent: false, totalBytes: rec.bytes } });
  }

  if (!url.pathname.startsWith("/api/trpc/")) return json(res, 404, { error: "not found" });

  // Every procedure requires a bearer — exercises the desktop's auth path.
  if (!/^Bearer .+/.test(req.headers.authorization ?? "")) {
    return trpcErr(res, 401, "UNAUTHORIZED", "missing bearer");
  }

  const proc = url.pathname.slice("/api/trpc/".length);
  const input =
    req.method === "GET"
      ? JSON.parse(url.searchParams.get("input") ?? "{}").json ?? {}
      : (await readBody(req)).json ?? {};

  // Membership view for this bearer — mirrors organizations.mine under RLS.
  // Revoked/suspended memberships simply vanish (status filter), exactly like
  // the real backend; org ids never come from the browser's claims.
  const bearerToken = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  const memberOrgIds = revokedBearers.has(bearerToken)
    ? []
    : bearerToken.endsWith("--noorg")
      ? []
      : bearerToken.endsWith("--multi")
        ? ["org-fixture", "org-second"]
        : ["org-fixture"];

  // Faithful organizationProcedure mirror: ANY org-scoped call from a
  // non-member is forbidden, regardless of which org id the client presents.
  if (
    input && typeof input === "object" && typeof input.organizationId === "string" &&
    !memberOrgIds.includes(input.organizationId)
  ) {
    return trpcErr(res, 403, "FORBIDDEN", "Not a member of this organization");
  }
  // org-second is a second, EMPTY practice for the dual-org fixture user —
  // switching must never leak org-fixture's records into it.
  const orgScopedEmpty =
    input && typeof input === "object" && input.organizationId === "org-second";

  switch (proc) {
    // ===== scribe: consent, capture, transcript, draft, deletion =====
    case "clinical.scribe.providerStatus":
      return trpcOk(res, { mode: "fixture", provider: "fixture", available: true, reason: null });
    case "clinical.scribe.consentDocuments":
      return trpcOk(res, orgScopedEmpty ? [] : scribeDocs);
    case "clinical.scribe.participants": {
      const rows = [...scribeParticipants.values()].filter((p) => p.encounterId === input.encounterId);
      return trpcOk(res, rows.map((p) => ({
        id: p.id, kind: p.kind, displayName: p.displayName, relationship: null,
        canSelfConsent: p.canSelfConsent, joinedAt: p.joinedAt, leftAt: p.leftAt,
        consents: p.consents.map((c) => ({
          id: c.id, scope: c.scope, status: c.status, method: c.method,
          grantedAt: c.grantedAt, withdrawnAt: c.withdrawnAt ?? null,
          representative: Boolean(c.representative), consentDocumentId: c.consentDocumentId,
        })),
      })));
    }
    case "clinical.scribe.addParticipant": {
      const e = encounters.get(input.encounterId);
      if (!e) return trpcErr(res, 404, "NOT_FOUND", "encounter not found");
      const id = scribeId("aaaa");
      scribeParticipants.set(id, {
        id, encounterId: input.encounterId, kind: input.kind, displayName: input.displayName,
        canSelfConsent: input.canSelfConsent !== false, leftAt: null, joinedAt: new Date().toISOString(), consents: [],
      });
      // late join pauses live capture until the new participant consents
      scribePauseLive(input.encounterId, "participant_joined");
      pushAudit("consent.participant_added", "encounter_recording_participant", id, "Participant added", {}, e.patientId);
      return trpcOk(res, { participantId: id });
    }
    case "clinical.scribe.recordConsent": {
      const p = scribeParticipants.get(input.participantId);
      if (!p) return trpcErr(res, 404, "NOT_FOUND", "participant not found");
      if (!p.canSelfConsent && !input.representative) {
        return trpcErr(res, 400, "BAD_REQUEST", "representative basis and authority are required");
      }
      const existing = p.consents.find((c) => c.scope === input.scope && c.status === "granted");
      if (existing) return trpcOk(res, { consentId: existing.id });
      const id = scribeId("bbbb");
      p.consents.push({
        id, scope: input.scope, status: "granted", method: input.method,
        grantedAt: new Date().toISOString(), consentDocumentId: input.consentDocumentId,
        representative: input.representative ?? null,
      });
      pushAudit("consent.granted", "encounter_consent", id, "Consent recorded", { scope: input.scope }, null);
      return trpcOk(res, { consentId: id });
    }
    case "clinical.scribe.withdrawConsent": {
      for (const p of scribeParticipants.values()) {
        const c = p.consents.find((x) => x.id === input.consentId);
        if (c) {
          if (c.status === "withdrawn") return trpcOk(res, { ok: true });
          c.status = "withdrawn";
          c.withdrawnAt = new Date().toISOString();
          if (c.scope === "recording") scribeRevokeLive(p.encounterId);
          pushAudit("consent.withdrawn", "encounter_consent", c.id, "Consent withdrawn", { scope: c.scope }, null);
          return trpcOk(res, { ok: true });
        }
      }
      return trpcErr(res, 404, "NOT_FOUND", "consent not found");
    }
    case "clinical.scribe.beginRecording": {
      const e = encounters.get(input.encounterId);
      if (!e) return trpcErr(res, 404, "NOT_FOUND", "encounter not found");
      if (e.status !== "in_progress") return trpcErr(res, 412, "PRECONDITION_FAILED", "encounter is not in progress");
      if (!scribeAllConsented(input.encounterId, "recording")) {
        return trpcErr(res, 412, "PRECONDITION_FAILED", "recording consent has not been granted by all participants");
      }
      const live = [...scribeRecordings.values()].find(
        (r) => r.encounterId === input.encounterId && ["authorized", "capturing", "paused", "uploading"].includes(r.status),
      );
      if (live) return trpcErr(res, 412, "PRECONDITION_FAILED", "a recording is already in progress for this encounter");
      const recId = scribeId("cccc");
      const sessId = scribeId("dddd");
      const token = `stub-chunk-${recId}-1`;
      const rec = {
        id: recId, encounterId: input.encounterId, patientId: e.patientId, provider: "fixture",
        status: "authorized", contentType: input.contentType, maxBytes: input.maxBytes ?? 268435456,
        bytes: 0, durationMs: null, legalHold: false, audioDeletedAt: null, deletionProof: null,
        failureReason: null, validationResult: null, deletionJobs: [], rotation: 1,
        createdAt: new Date().toISOString(), transitions: [],
        deletionDeadline: new Date(Date.now() + 864e5).toISOString(),
      };
      scribeRecordings.set(recId, rec);
      scribeSessions.set(sessId, { id: sessId, recordingId: recId, status: "active", pauseReason: null });
      scribeTokens.set(token, { recordingId: recId, sessionId: sessId, action: "chunk", revoked: false, consumed: false });
      scribeTransition(rec, "capturing", "begin_recording");
      pushAudit("recording.started", "encounter_recording", recId, "Recording started", { provider: "fixture" }, e.patientId);
      return trpcOk(res, {
        recordingId: recId, sessionId: sessId, captureToken: token,
        expiresAt: new Date(Date.now() + 120000).toISOString(),
        contentType: input.contentType, maxBytes: rec.maxBytes, provider: "fixture",
      });
    }
    case "clinical.scribe.heartbeat": {
      const sess = scribeSessions.get(input.sessionId);
      if (!sess) return trpcErr(res, 404, "NOT_FOUND", "session not found");
      if (sess.status === "revoked") return trpcErr(res, 412, "PRECONDITION_FAILED", "capture session revoked");
      const rec = scribeRecordings.get(sess.recordingId);
      if (sess.status !== "active") return trpcOk(res, { ok: false, status: sess.status, captureToken: null, expiresAt: null });
      if (!scribeAllConsented(rec.encounterId, "recording")) {
        scribeRevokeLive(rec.encounterId);
        return trpcErr(res, 412, "PRECONDITION_FAILED", "recording consent is no longer valid");
      }
      rec.rotation += 1;
      const token = `stub-chunk-${rec.id}-${rec.rotation}`;
      scribeTokens.set(token, { recordingId: rec.id, sessionId: sess.id, action: "chunk", revoked: false, consumed: false });
      return trpcOk(res, { ok: true, status: "active", captureToken: token, expiresAt: new Date(Date.now() + 120000).toISOString() });
    }
    case "clinical.scribe.resume": {
      const sess = scribeSessions.get(input.sessionId);
      if (!sess) return trpcErr(res, 404, "NOT_FOUND", "session not found");
      if (sess.status === "revoked") return trpcErr(res, 412, "PRECONDITION_FAILED", "a revoked session cannot resume");
      const rec = scribeRecordings.get(sess.recordingId);
      if (!scribeAllConsented(rec.encounterId, "recording")) {
        return trpcErr(res, 412, "PRECONDITION_FAILED", "all participants must consent before resuming");
      }
      if (rec.status === "paused") scribeTransition(rec, "capturing", "resume");
      else if (rec.status !== "capturing") return trpcErr(res, 409, "CONFLICT", "invalid transition");
      sess.status = "active";
      sess.pauseReason = null;
      return trpcOk(res, { ok: true });
    }
    case "clinical.scribe.issueCompletionAuthorization": {
      const sess = scribeSessions.get(input.sessionId);
      if (!sess) return trpcErr(res, 404, "NOT_FOUND", "session not found");
      if (sess.status === "revoked") return trpcErr(res, 412, "PRECONDITION_FAILED", "capture session revoked");
      const rec = scribeRecordings.get(sess.recordingId);
      if (!["capturing", "paused"].includes(rec.status)) {
        return trpcErr(res, 412, "PRECONDITION_FAILED", "recording is not ready for upload completion");
      }
      if (!scribeAllConsented(rec.encounterId, "recording")) {
        return trpcErr(res, 412, "PRECONDITION_FAILED", "recording consent is no longer valid");
      }
      const token = `stub-complete-${rec.id}`;
      scribeTokens.set(token, { recordingId: rec.id, sessionId: sess.id, action: "complete", revoked: false, consumed: false });
      return trpcOk(res, { completionToken: token, expiresAt: new Date(Date.now() + 120000).toISOString() });
    }
    case "clinical.scribe.queueTranscription": {
      const rec = scribeRecordings.get(input.recordingId);
      if (!rec) return trpcErr(res, 404, "NOT_FOUND", "recording not found");
      if (rec.status !== "uploaded") return trpcErr(res, 409, "CONFLICT", "invalid transition");
      scribeTransition(rec, "transcription_queued", "queued");
      // fixture worker: same contract as production (transcribing → ready),
      // but only when every participant granted transcription
      if (scribeAllConsented(rec.encounterId, "transcription")) {
        scribeTransition(rec, "transcribing", "transcription started (worker)");
        const tid = scribeId("eeee");
        scribeTranscripts.set(rec.id, {
          transcriptId: tid, encounterId: rec.encounterId, revision: 1, status: "accepted", finalizedAt: null,
          segments: [
            { id: scribeId("ffff"), seq: 1, speaker: "clinician", startMs: 0, endMs: 4000,
              rawText: "Blood pressure today is one eighteen over seventy six, seated.", confidence: 0.94, corrections: [] },
            { id: scribeId("abcd"), seq: 2, speaker: "patient", startMs: 4200, endMs: 9000,
              rawText: "I have been sleeping poorly for about two weeks.", confidence: 0.91, corrections: [] },
          ],
        });
        scribeTransition(rec, "transcript_ready", "transcript received (worker)");
        pushAudit("transcription.batch_received", "encounter_transcript", tid, "Transcript received", { segments: 2, provider: "fixture" }, rec.patientId);
      }
      return trpcOk(res, { ok: true });
    }
    case "clinical.scribe.recording": {
      const rec = scribeRecordings.get(input.recordingId);
      if (!rec) return trpcErr(res, 404, "NOT_FOUND", "recording not found");
      return trpcOk(res, {
        id: rec.id, encounterId: rec.encounterId, patientId: rec.patientId, provider: "fixture",
        status: rec.status, contentType: rec.contentType, audioBytes: rec.bytes, durationMs: rec.durationMs,
        legalHold: rec.legalHold, deletionDeadline: rec.deletionDeadline, audioDeletedAt: rec.audioDeletedAt,
        deletionProof: rec.deletionProof, failureReason: rec.failureReason, validationResult: rec.validationResult,
        createdAt: rec.createdAt,
        transitions: rec.transitions.map((t) => ({ from: t.from, to: t.to, reason: t.reason, at: t.at })),
      });
    }
    case "clinical.scribe.recordingsForEncounter": {
      const rows = [...scribeRecordings.values()]
        .filter((r) => r.encounterId === input.encounterId)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return trpcOk(res, rows.map((r) => ({
        id: r.id, status: r.status, provider: "fixture", createdAt: r.createdAt, audioDeletedAt: r.audioDeletedAt,
      })));
    }
    case "clinical.scribe.captureSession": {
      const sess = [...scribeSessions.values()].find((x) => x.recordingId === input.recordingId);
      if (!sess) return trpcOk(res, null);
      return trpcOk(res, { id: sess.id, status: sess.status, pauseReason: sess.pauseReason, lastHeartbeatAt: new Date().toISOString() });
    }
    case "clinical.scribe.transcript":
      return trpcOk(res, scribeTranscriptDto(input.recordingId));
    case "clinical.scribe.correctSegment": {
      for (const t of scribeTranscripts.values()) {
        const seg = t.segments.find((x) => x.id === input.segmentId);
        if (seg) {
          if (t.status === "finalized") return trpcErr(res, 400, "BAD_REQUEST", "transcript is finalized");
          seg.corrections.push(input.correctedText);
          t.revision += 1;
          t.status = "corrected";
          pushAudit("transcription.corrected", "encounter_transcript", t.transcriptId, "Transcript corrected", { version: seg.corrections.length }, null);
          return trpcOk(res, { version: seg.corrections.length });
        }
      }
      return trpcErr(res, 404, "NOT_FOUND", "segment not found");
    }
    case "clinical.scribe.setReview": {
      for (const [recId, t] of scribeTranscripts) {
        if (t.transcriptId === input.transcriptId) {
          const rec = scribeRecordings.get(recId);
          if (rec.status === "transcript_ready") scribeTransition(rec, "review_pending", "transcript review");
          return trpcOk(res, { ok: true });
        }
      }
      return trpcErr(res, 404, "NOT_FOUND", "transcript not found");
    }
    case "clinical.scribe.finalizeTranscript": {
      for (const [recId, t] of scribeTranscripts) {
        if (t.transcriptId === input.transcriptId) {
          const rec = scribeRecordings.get(recId);
          if (t.status !== "finalized") {
            t.status = "finalized";
            t.finalizedAt = new Date().toISOString();
            if (rec.status === "review_pending") scribeTransition(rec, "finalized", "transcript finalized");
            pushAudit("transcription.finalized", "encounter_transcript", t.transcriptId, "Transcript finalized", {}, rec.patientId);
          }
          return trpcOk(res, { ok: true });
        }
      }
      return trpcErr(res, 404, "NOT_FOUND", "transcript not found");
    }
    case "clinical.scribe.generateDraft": {
      let found = null;
      let foundRecId = null;
      for (const [recId, t] of scribeTranscripts) {
        if (t.transcriptId === input.transcriptId) { found = t; foundRecId = recId; }
      }
      if (!found) return trpcErr(res, 404, "NOT_FOUND", "transcript not found");
      const rec = scribeRecordings.get(foundRecId);
      if (!scribeAllConsented(rec.encounterId, "ai_drafting")) {
        return trpcErr(res, 412, "PRECONDITION_FAILED", "AI drafting consent has not been granted by all participants");
      }
      const key = `${found.transcriptId}:${found.revision}:m1-scribe-tmpl-v1`;
      const prior = scribeGenerations.get(key);
      if (prior) return trpcOk(res, { ...prior, idempotent: true });
      const effective = found.segments
        .map((seg) => seg.corrections[seg.corrections.length - 1] ?? seg.rawText)
        .join("\n");
      emrSeq += 1;
      const noteId = `eeeeeeee-3333-4444-5555-${String(444444444400 + emrSeq)}`;
      const e = encounters.get(rec.encounterId);
      const note = {
        id: noteId, encounterId: rec.encounterId, patientId: e.patientId, organizationId: e.organizationId,
        noteType: input.noteType, status: "draft", currentVersion: 1,
        versions: new Map(), signature: null, addenda: [],
        provenance: [{ sectionKey: "S", refType: "transcript", refId: found.transcriptId, label: `Encounter transcript r${found.revision} (AI scribe source)` }],
        statusReason: null, createdAt: nowIso(),
      };
      note.versions.set(1, {
        content: { S: `AI scribe draft (unreviewed, proposed). Verify against the source transcript before signing.\n\n${effective}`, O: "", A: "", P: "" },
        savedAt: nowIso(),
      });
      emrNotes.set(noteId, note);
      const generationId = scribeId("dead");
      scribeGenerations.set(key, { noteId, generationId });
      pushAudit("scribe.draft_generated", "clinical_note", noteId, "Scribe draft generated", { transcript_revision: found.revision, model: "fixture-scribe-1", provider: "fixture" }, e.patientId);
      return trpcOk(res, { noteId, generationId, idempotent: false });
    }
    case "clinical.scribe.requestDeletion": {
      const rec = scribeRecordings.get(input.recordingId);
      if (!rec) return trpcErr(res, 404, "NOT_FOUND", "recording not found");
      if (rec.legalHold) return trpcErr(res, 412, "PRECONDITION_FAILED", "recording is under legal hold");
      if (rec.status === "deleted") return trpcOk(res, { ok: true });
      scribeTransition(rec, "deletion_pending", "deletion requested");
      // durable worker model: first attempt fails (retry visible), next confirms
      rec.deletionJobs = [{ id: scribeId("beef"), target: "local", status: "failed", attempts: 1, lastError: "simulated storage outage — will retry", nextAttemptAt: new Date().toISOString(), deadLetteredAt: null, confirmationRef: null }];
      return trpcOk(res, { ok: true });
    }
    case "clinical.scribe.deletionStatus": {
      const rec = scribeRecordings.get(input.recordingId);
      if (!rec) return trpcErr(res, 404, "NOT_FOUND", "recording not found");
      // advance the retrying worker one step per poll
      const job = rec.deletionJobs[0];
      if (job && job.status === "failed") {
        job.status = "confirmed";
        job.attempts += 1;
        job.confirmationRef = "local-purge:stub";
        rec.audioDeletedAt = new Date().toISOString();
        rec.deletionProof = "local-purge:stub";
        scribeTransition(rec, "deleted", "all deletion targets confirmed (worker)");
        pushAudit("recording.deleted", "encounter_recording", rec.id, "Recording audio deleted", { provider: "fixture" }, rec.patientId);
      }
      return trpcOk(res, {
        recordingStatus: rec.status, audioDeletedAt: rec.audioDeletedAt, deletionProof: rec.deletionProof,
        legalHold: rec.legalHold,
        jobs: rec.deletionJobs.map((j) => ({ ...j })),
      });
    }
    case "clinical.scribe.logAccess": {
      scribeAccessLog.push({ transcriptId: input.transcriptId, kind: input.kind, at: new Date().toISOString() });
      return trpcOk(res, { ok: true });
    }
    case "clinical.patients.list":
      return trpcOk(res, orgScopedEmpty ? [] : PATIENTS);
    case "clinical.patients.get": {
      const row = PATIENTS.find((p) => p.id === input.patientId);
      return row ? trpcOk(res, row) : trpcErr(res, 404, "NOT_FOUND", "no such patient");
    }
    // ===== EMR: encounters + notes (0021 semantics) =====
    case "clinical.encounters.start": {
      const patient = PATIENTS.find((p) => p.id === input.patientId);
      if (!patient) return trpcErr(res, 403, "FORBIDDEN", "not authorized for this patient");
      if (input.appointmentId) {
        const existing = [...encounters.values()].find(
          (e) => e.appointmentId === input.appointmentId && e.status === "in_progress",
        );
        if (existing) return trpcOk(res, { encounterId: existing.id });
      }
      emrSeq += 1;
      const id = `eeeeeeee-2222-3333-4444-${String(444444444400 + emrSeq)}`;
      encounters.set(id, {
        id,
        organizationId: input.organizationId,
        patientId: input.patientId,
        appointmentId: input.appointmentId ?? null,
        visitType: input.visitType ?? "follow-up",
        status: "in_progress",
        startedAt: nowIso(),
        endedAt: null,
        statusReason: null,
        createdAt: nowIso(),
      });
      emrAudit("encounter.started", id, "Encounter started", input.patientId);
      return trpcOk(res, { encounterId: id });
    }
    case "clinical.encounters.setStatus": {
      const e = encounters.get(input.encounterId);
      if (!e) return trpcErr(res, 404, "NOT_FOUND", "encounter not found");
      const allowed =
        (e.status === "in_progress" && ["completed", "cancelled", "entered_in_error"].includes(input.status)) ||
        (e.status === "scheduled" && ["cancelled", "entered_in_error"].includes(input.status));
      if (!allowed) return trpcErr(res, 400, "BAD_REQUEST", `invalid transition from ${e.status}`);
      e.status = input.status;
      if (input.status === "completed") e.endedAt = nowIso();
      if (input.reason) e.statusReason = input.reason;
      emrAudit(`encounter.${input.status}`, e.id, `Encounter ${input.status}`, e.patientId);
      return trpcOk(res, { ok: true });
    }
    case "clinical.encounters.get": {
      const e = encounters.get(input.encounterId);
      if (!e || !memberOrgIds.includes(e.organizationId)) {
        return trpcErr(res, 404, "NOT_FOUND", "Encounter not found or access denied");
      }
      const notesFor = [...emrNotes.values()]
        .filter((n) => n.encounterId === e.id)
        .map((n) => ({
          noteId: n.id, encounterId: n.encounterId, patientId: n.patientId,
          noteType: n.noteType, status: n.status, currentVersion: n.currentVersion,
          authorUserId: "dddddddd-1111-2222-3333-444444444401",
          statusReason: n.statusReason ?? null, createdAt: n.createdAt, updatedAt: nowIso(),
        }));
      return trpcOk(res, {
        encounter: {
          encounterId: e.id, organizationId: e.organizationId, patientId: e.patientId,
          appointmentId: e.appointmentId, visitType: e.visitType, status: e.status,
          startedAt: e.startedAt, endedAt: e.endedAt, statusReason: e.statusReason, createdAt: e.createdAt,
        },
        notes: notesFor,
      });
    }
    case "clinical.encounters.forPatient": {
      const list = [...encounters.values()]
        .filter((e) => e.patientId === input.patientId && memberOrgIds.includes(e.organizationId))
        .map((e) => ({
          encounterId: e.id, organizationId: e.organizationId, patientId: e.patientId,
          appointmentId: e.appointmentId, visitType: e.visitType, status: e.status,
          startedAt: e.startedAt, endedAt: e.endedAt, statusReason: e.statusReason, createdAt: e.createdAt,
        }));
      return trpcOk(res, list);
    }
    case "clinical.notes.save": {
      const e = encounters.get(input.encounterId);
      if (!e) return trpcErr(res, 404, "NOT_FOUND", "encounter not found");
      if (!["in_progress", "completed"].includes(e.status)) {
        return trpcErr(res, 400, "BAD_REQUEST", "encounter is not open for documentation");
      }
      let n;
      if (input.noteId) {
        n = emrNotes.get(input.noteId);
        if (!n) return trpcErr(res, 404, "NOT_FOUND", "note not found");
        if (!["draft", "ready_for_review"].includes(n.status)) {
          return trpcErr(res, 400, "BAD_REQUEST", "note content is frozen after signing — use an addendum");
        }
        if (n.currentVersion !== input.expectedVersion) {
          return trpcErr(res, 409, "CONFLICT", "version conflict");
        }
        n.currentVersion += 1;
        n.status = "draft";
      } else {
        if (input.expectedVersion !== 0) return trpcErr(res, 409, "CONFLICT", "version conflict");
        emrSeq += 1;
        const id = `eeeeeeee-3333-4444-5555-${String(444444444400 + emrSeq)}`;
        n = {
          id, encounterId: e.id, patientId: e.patientId, organizationId: e.organizationId,
          noteType: input.noteType, status: "draft", currentVersion: 1,
          versions: new Map(), signature: null, addenda: [], provenance: [],
          statusReason: null, createdAt: nowIso(),
        };
        emrNotes.set(id, n);
        emrAudit("note.draft_created", id, "Draft note created", e.patientId);
      }
      n.versions.set(n.currentVersion, { content: input.content, savedAt: nowIso() });
      n.provenance = Array.isArray(input.provenance) ? input.provenance : [];
      return trpcOk(res, { noteId: n.id, version: n.currentVersion, savedAt: nowIso() });
    }
    case "clinical.notes.get": {
      const n = emrNotes.get(input.noteId);
      if (!n || !memberOrgIds.includes(n.organizationId)) {
        return trpcErr(res, 404, "NOT_FOUND", "Note not found or access denied");
      }
      const v = n.versions.get(n.currentVersion);
      return trpcOk(res, {
        note: {
          noteId: n.id, encounterId: n.encounterId, patientId: n.patientId,
          noteType: n.noteType, status: n.status, currentVersion: n.currentVersion,
          authorUserId: "dddddddd-1111-2222-3333-444444444401",
          statusReason: n.statusReason ?? null, createdAt: n.createdAt, updatedAt: nowIso(),
        },
        content: v?.content ?? {},
        contentVersion: n.currentVersion,
        lastSavedAt: v?.savedAt ?? null,
        signature: n.signature,
        addenda: n.addenda,
        provenance: n.provenance,
      });
    }
    case "clinical.notes.markReady": {
      const n = emrNotes.get(input.noteId);
      if (!n) return trpcErr(res, 404, "NOT_FOUND", "note not found");
      if (n.status !== "draft") return trpcErr(res, 400, "BAD_REQUEST", "only a draft can be marked ready");
      n.status = "ready_for_review";
      emrAudit("note.ready_for_review", n.id, "Note marked ready for review", n.patientId);
      return trpcOk(res, { ok: true });
    }
    case "clinical.notes.sign": {
      const n = emrNotes.get(input.noteId);
      if (!n) return trpcErr(res, 404, "NOT_FOUND", "note not found");
      if (n.signature) {
        if (n.signature.version === input.expectedVersion) {
          return trpcOk(res, {
            signatureId: n.signature.signatureId, alreadySigned: true,
            version: n.signature.version, signedAt: n.signature.signedAt,
          });
        }
        return trpcErr(res, 400, "BAD_REQUEST", "note is already signed");
      }
      if (!["draft", "ready_for_review"].includes(n.status)) {
        return trpcErr(res, 400, "BAD_REQUEST", `note cannot be signed from status ${n.status}`);
      }
      if (n.currentVersion !== input.expectedVersion) {
        return trpcErr(res, 409, "CONFLICT", "version conflict");
      }
      emrSeq += 1;
      n.signature = {
        signatureId: `eeeeeeee-4444-5555-6666-${String(444444444400 + emrSeq)}`,
        version: n.currentVersion,
        signedBy: "dddddddd-1111-2222-3333-444444444401",
        signedAt: nowIso(),
        attestation: "I attest this note is accurate and complete.",
      };
      n.status = "signed";
      emrAudit("note.signed", n.id, "Note signed", n.patientId);
      return trpcOk(res, {
        signatureId: n.signature.signatureId, alreadySigned: false,
        version: n.signature.version, signedAt: n.signature.signedAt,
      });
    }
    case "clinical.notes.addAddendum": {
      const n = emrNotes.get(input.noteId);
      if (!n) return trpcErr(res, 404, "NOT_FOUND", "note not found");
      if (!["signed", "amended"].includes(n.status)) {
        return trpcErr(res, 400, "BAD_REQUEST", "addenda apply to signed notes");
      }
      emrSeq += 1;
      const addendum = {
        addendumId: `eeeeeeee-5555-6666-7777-${String(444444444400 + emrSeq)}`,
        referencedVersion: n.signature?.version ?? n.currentVersion,
        authorUserId: "dddddddd-1111-2222-3333-444444444401",
        reason: input.reason, content: input.content, createdAt: nowIso(),
      };
      n.addenda.push(addendum);
      n.status = "amended";
      emrAudit("note.addendum_created", n.id, "Addendum added", n.patientId);
      return trpcOk(res, { addendumId: addendum.addendumId });
    }
    case "clinical.notes.markError": {
      const n = emrNotes.get(input.noteId);
      if (!n) return trpcErr(res, 404, "NOT_FOUND", "note not found");
      n.status = "entered_in_error";
      n.statusReason = input.reason;
      emrAudit("note.entered_in_error", n.id, "Note marked entered in error", n.patientId);
      return trpcOk(res, { ok: true });
    }
    case "clinical.notes.timeline": {
      const patient = PATIENTS.find((p) => p.id === input.patientId);
      if (!patient) return trpcErr(res, 404, "NOT_FOUND", "Patient not found or access denied");
      const events = [];
      for (const e of encounters.values()) {
        if (e.patientId !== input.patientId || !memberOrgIds.includes(e.organizationId)) continue;
        if (e.startedAt) events.push({ eventAt: e.startedAt, eventType: "encounter.started", title: `Encounter started (${e.visitType})`, refType: "encounter", refId: e.id, detail: { status: e.status } });
        if (e.status === "completed" && e.endedAt) events.push({ eventAt: e.endedAt, eventType: "encounter.completed", title: "Encounter completed", refType: "encounter", refId: e.id, detail: {} });
      }
      for (const n of emrNotes.values()) {
        if (n.patientId !== input.patientId || !memberOrgIds.includes(n.organizationId)) continue;
        events.push({ eventAt: n.createdAt, eventType: "note.draft_created", title: `Draft note created (${n.noteType})`, refType: "clinical_note", refId: n.id, detail: { status: n.status } });
        if (n.signature) events.push({ eventAt: n.signature.signedAt, eventType: "note.signed", title: "Note signed", refType: "clinical_note", refId: n.id, detail: { version: n.signature.version } });
        for (const a of n.addenda) events.push({ eventAt: a.createdAt, eventType: "note.addendum", title: "Addendum added", refType: "clinical_note", refId: n.id, detail: { referencedVersion: a.referencedVersion } });
        if (n.status === "entered_in_error") events.push({ eventAt: nowIso(), eventType: "note.entered_in_error", title: "Note entered in error", refType: "clinical_note", refId: n.id, detail: {} });
      }
      for (const appt of scheduleAppointments ?? []) {
        if (appt.patientId === input.patientId) {
          events.push({ eventAt: appt.startsAt, eventType: "appointment", title: appt.appointmentType ?? "appointment", refType: "appointment", refId: appt.id, detail: { status: appt.status } });
        }
      }
      events.sort((a, b) => (a.eventAt < b.eventAt ? 1 : -1));
      return trpcOk(res, events);
    }

    case "clinical.organizations.mine": {
      const mine = [];
      if (memberOrgIds.includes("org-fixture")) {
        mine.push({
          organizationId: "org-fixture",
          name: "Fixture Clinic",
          slug: "fixture-clinic",
          role: bearerToken.endsWith("--multi") ? "practitioner" : "owner",
        });
      }
      if (memberOrgIds.includes("org-second")) {
        mine.push({ organizationId: "org-second", name: "Second Practice", slug: "second-practice", role: "practitioner" });
      }
      return trpcOk(res, mine);
    }
    case "clinical.organizations.claim":
      return trpcOk(res, { activated: 0 });
    case "clinical.organizations.members":
      if (orgScopedEmpty) return trpcErr(res, 403, "FORBIDDEN", "Administrator role required");
      return trpcOk(res, [...members.values()]);
    case "clinical.organizations.invite": {
      const email = String(input.email ?? "").toLowerCase();
      if ([...members.values()].some((m) => m.email === email)) {
        return trpcErr(res, 409, "CONFLICT", "That person is already a member of this organization.");
      }
      memberSeq += 1;
      const membershipId = `mem-${memberSeq}`;
      // Fixture convention: emails starting with "new-" have no account yet,
      // so the invite email path runs; everything else is an existing account.
      const invitedNewUser = email.startsWith("new-");
      members.set(membershipId, {
        membershipId,
        userId: `user-${memberSeq}`,
        email,
        displayName: null,
        role: String(input.role ?? "member"),
        status: "invited",
        joinedAt: new Date().toISOString(),
      });
      return trpcOk(res, { membershipId, invitedNewUser });
    }
    case "clinical.organizations.setRole": {
      const row = members.get(String(input.membershipId ?? ""));
      if (!row) return trpcErr(res, 404, "NOT_FOUND", "membership not found");
      const owners = [...members.values()].filter((m) => m.role === "owner" && m.status === "active");
      if (row.role === "owner" && input.role !== "owner" && owners.length === 1) {
        return trpcErr(res, 400, "BAD_REQUEST", "An organization must keep at least one owner.");
      }
      row.role = String(input.role ?? row.role);
      return trpcOk(res, { ok: true });
    }
    case "clinical.organizations.remove": {
      const row = members.get(String(input.membershipId ?? ""));
      if (!row) return trpcErr(res, 404, "NOT_FOUND", "membership not found");
      if (row.email === "practitioner@fixture.local") {
        return trpcErr(res, 400, "BAD_REQUEST", "You cannot remove your own membership.");
      }
      if (row.role === "owner") {
        return trpcErr(res, 400, "BAD_REQUEST", "An organization must keep at least one owner.");
      }
      members.delete(row.membershipId);
      return trpcOk(res, { ok: true });
    }
    case "clinical.tasks.getQueue":
      return trpcOk(res, orgScopedEmpty ? [] : [...queue.values()]);
    case "clinical.tasks.resolve": {
      const item = queue.get(input.itemId);
      if (!item) return trpcErr(res, 404, "NOT_FOUND", "no such item");
      if (item.status === "resolved") {
        return trpcOk(res, { id: item.id, status: "resolved", previousStatus: "resolved", alreadyResolved: true });
      }
      const previous = item.status;
      item.status = "resolved";
      pushAudit(
        "review_task.resolve",
        "review_queue_item",
        item.id,
        "Review task resolved",
        { previous_status: previous, item_type: item.itemType, note_present: Boolean(input.note) },
        item.patientId,
      );
      return trpcOk(res, {
        id: item.id,
        status: "resolved",
        previousStatus: previous,
        alreadyResolved: false,
        auditEventId: auditEvents[0].id,
      });
    }
    case "clinical.labs.getWorkspace": {
      const row = PATIENTS.find((p) => p.id === input.patientId);
      if (!row) return trpcErr(res, 404, "NOT_FOUND", "no such patient");
      return trpcOk(res, labsWorkspaceFor(row));
    }
    case "clinical.labs.reviewMarker": {
      const marker = labMarkers.find((m) => m.id === input.observationId);
      if (!marker) return trpcErr(res, 404, "NOT_FOUND", "no such observation");
      const previous = marker.reviewState;
      marker.reviewState = input.decision === "accepted" ? "reviewed" : "awaiting-review";
      pushAudit(
        "biomarker.review",
        "biomarker_observation",
        marker.id,
        `Biomarker review: ${input.decision}`,
        { decision: input.decision, note_present: Boolean(input.note) },
        PATIENTS[0].id,
      );
      return trpcOk(res, {
        ok: true,
        reviewStatus: input.decision,
        reviewedAt: new Date().toISOString(),
        previousStatus: previous,
        message: `Review saved (${input.decision}).`,
      });
    }
    case "clinical.actions.listAuditEvents":
      return trpcOk(res, auditEvents.slice(0, Math.min(Number(input.limit ?? 50), 200)));
    case "clinical.schedule.getCalendar": {
      seedScheduleFor(input.fromIso);
      const from = Date.parse(input.fromIso);
      const to = Date.parse(input.toIso);
      return trpcOk(res, {
        appointments: scheduleAppointments.filter((a) => {
          const t = Date.parse(a.startsAt);
          return t >= from && t < to;
        }),
        practitioners: [
          { userId: PRACTITIONER_USER_ID, displayName: "Demo Practitioner", credentials: "ND", specialty: null },
        ],
      });
    }
    case "clinical.schedule.book": {
      seedScheduleFor(input.startsAtIso);
      const patient = input.patientId ? PATIENTS.find((p) => p.id === input.patientId) : null;
      if (input.patientId && !patient) {
        return trpcErr(res, 403, "FORBIDDEN", "not authorized for this patient");
      }
      const id = `abababab-1111-2222-3333-4444444444${String(10 + ++apptSeq)}`;
      scheduleAppointments.push({
        id,
        patientId: patient ? patient.id : null,
        patientName: patient ? `${patient.first_name} ${patient.last_name}` : null,
        practitionerUserId: input.practitionerUserId, practitionerName: "Demo Practitioner",
        title: input.title ?? null, appointmentType: input.appointmentType,
        location: input.location ?? null, telehealthUrl: null,
        status: "scheduled", startsAt: input.startsAtIso, endsAt: input.endsAtIso,
      });
      pushAudit(
        "appointment.book", "appointment", id,
        `Appointment booked (${input.appointmentType})`,
        { appointment_type: input.appointmentType, starts_at: input.startsAtIso },
        patient ? patient.id : null,
      );
      return trpcOk(res, {
        ok: true, id, status: "scheduled",
        startsAt: input.startsAtIso, endsAt: input.endsAtIso, message: "Appointment booked.",
      });
    }
    case "clinical.schedule.updateStatus": {
      const appt = scheduleAppointments.find((a) => a.id === input.appointmentId);
      if (!appt) return trpcErr(res, 404, "NOT_FOUND", "no such appointment");
      const prev = appt.status;
      appt.status = input.status;
      pushAudit(
        "appointment.status", "appointment", appt.id,
        `Appointment ${input.status}`,
        { previous_status: prev, status: input.status },
        appt.patientId,
      );
      return trpcOk(res, {
        ok: true, id: appt.id, status: input.status, previousStatus: prev,
        alreadySet: false, message: `Appointment ${input.status}.`,
      });
    }
    default:
      return trpcErr(res, 404, "NOT_FOUND", `unknown procedure ${proc}`);
  }
}).listen(PORT, () => {
  console.log(`[live-stub] contract-fixture backend on http://127.0.0.1:${PORT} — synthetic data, in-memory, NOT the real backend`);
});
