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
    case "clinical.patients.list":
      return trpcOk(res, orgScopedEmpty ? [] : PATIENTS);
    case "clinical.patients.get": {
      const row = PATIENTS.find((p) => p.id === input.patientId);
      return row ? trpcOk(res, row) : trpcErr(res, 404, "NOT_FOUND", "no such patient");
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
