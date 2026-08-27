if (typeof window !== "undefined") {
  throw new Error("clinical-core/synthetic-acceptance is server-only.");
}

import type { SyntheticAcceptanceManifest } from "./synthetic-fixtures";

export class SyntheticAcceptanceError extends Error {
  constructor(
    readonly category: "configuration_invalid" | "boundary_refused" | "workflow_failed",
    readonly operationIndex?: number,
    readonly statusCode?: number,
    readonly refusalCategory?: string,
  ) {
    super(category);
    this.name = "SyntheticAcceptanceError";
  }
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export async function runSyntheticApiAcceptance(input: {
  apiOrigin: string;
  workforceIdToken: string;
  consumerIdToken: string;
  isolationWorkforceIdToken: string;
  manifest: SyntheticAcceptanceManifest;
  fetch?: FetchLike;
}): Promise<{ passed: 46; externalRequests: 46 }> {
  const fetcher = input.fetch ?? fetch;
  const origin = validateConfiguration(input);
  let operationIndex = 0;
  const call = (path: string, bearer: string, expected: number | number[], body?: Record<string, unknown>) => {
    operationIndex += 1;
    return request(fetcher, origin, path, bearer, expected, body, operationIndex);
  };
  const workforcePosture = data(await call("/clinical-core/workforce/posture", input.workforceIdToken, 200),
    ["contractVersion", "environment", "dataClassification", "identityPool", "authenticated", "phiAllowed", "realPatientDataAllowed"]);
  const consumerPosture = data(await call("/clinical-core/consumer/posture", input.consumerIdToken, 200),
    ["contractVersion", "environment", "dataClassification", "identityPool", "authenticated", "phiAllowed", "realPatientDataAllowed"]);
  for (const [posture, pool] of [[workforcePosture, "workforce"], [consumerPosture, "consumer"]] as const) {
    if (posture.contractVersion !== "clinical-core/1" || posture.environment !== "synthetic-staging"
      || posture.dataClassification !== "synthetic_only" || posture.identityPool !== pool
      || posture.authenticated !== true || posture.phiAllowed !== false || posture.realPatientDataAllowed !== false) {
      throw new SyntheticAcceptanceError("workflow_failed");
    }
  }
  const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
  const issue = await call("/clinical-core/workforce/invitations", input.workforceIdToken, 201, {
    patientRecordId: input.manifest.fixture.patientRecordId,
    expiresAt,
    idempotencyKey: `acceptance:${Date.now()}`,
  });
  const invitation = data(issue, ["invitationId", "connectionId", "expiresAt", "token"]);
  const token = string(invitation.token);
  if (!/^[A-HJ-NP-Z2-9]{13}$/.test(token)) throw new SyntheticAcceptanceError("workflow_failed");

  const claimed = data(await call("/clinical-core/consumer/invitations/claim", input.consumerIdToken, 200, { token }),
    ["connectionId", "patientRecordId", "consumerPersonId", "state", "verifiedAt"]);
  if (claimed.connectionId !== invitation.connectionId || claimed.patientRecordId !== input.manifest.fixture.patientRecordId
    || claimed.consumerPersonId !== input.manifest.fixture.consumerPersonId || claimed.state !== "verified") {
    throw new SyntheticAcceptanceError("workflow_failed");
  }

  await call("/clinical-core/consumer/invitations/claim", input.consumerIdToken, 404, { token });
  await call("/clinical-core/workforce/invitations", input.consumerIdToken, [401, 403], {
    patientRecordId: input.manifest.fixture.patientRecordId, expiresAt,
  });
  await call("/clinical-core/workforce/invitations", input.workforceIdToken, 400, {
    patientRecordId: input.manifest.fixture.patientRecordId, expiresAt, patientName: "refused",
  });
  await call("/clinical-core/workforce/invitations", input.isolationWorkforceIdToken, 400, {
    patientRecordId: input.manifest.fixture.patientRecordId, expiresAt,
  });

  const grant = data(await call("/clinical-core/consumer/consents/grant", input.consumerIdToken, 201, {
    connectionId: string(claimed.connectionId),
    artifactId: input.manifest.fixture.consentArtifactId,
    scope: "programs",
    method: "patient_app",
    representativeAuthority: "self",
  }), ["consentId", "connectionId", "scope", "status", "version", "recordedAt"]);
  if (grant.status !== "granted" || grant.version !== 1) throw new SyntheticAcceptanceError("workflow_failed");
  await call("/clinical-core/consumer/consents/grant", input.consumerIdToken, 409, {
    connectionId: string(claimed.connectionId), artifactId: input.manifest.fixture.consentArtifactId,
    scope: "programs", method: "patient_app", representativeAuthority: "self",
  });
  const revoke = data(await call("/clinical-core/consumer/consents/revoke", input.consumerIdToken, 201, {
    connectionId: string(claimed.connectionId), scope: "programs", reasonCode: "patient_request",
  }), ["consentId", "connectionId", "scope", "status", "version", "recordedAt"]);
  if (revoke.status !== "revoked" || revoke.version !== 2) throw new SyntheticAcceptanceError("workflow_failed");

  const connectionBeforeLabConsent = nullableData(await call(
    "/clinical-core/consumer/connection", input.consumerIdToken, 200,
  ));
  if (!connectionBeforeLabConsent || connectionBeforeLabConsent.connectionId !== claimed.connectionId
    || connectionBeforeLabConsent.patientRecordId !== input.manifest.fixture.patientRecordId
    || connectionBeforeLabConsent.state !== "verified"
    || connectionBeforeLabConsent.labResultsImportConsent !== "not_granted") {
    throw new SyntheticAcceptanceError("workflow_failed");
  }

  const labConsentArtifact = data(await call(
    "/clinical-core/consumer/consent-artifact?scope=lab_results_import", input.consumerIdToken, 200,
  ), ["artifactId", "scope", "artifactVersion", "contentSha256", "jurisdiction", "approvedAt"]);
  if (labConsentArtifact.scope !== "lab_results_import"
    || labConsentArtifact.artifactId !== input.manifest.fixture.labConsentArtifactId) {
    throw new SyntheticAcceptanceError("workflow_failed");
  }

  const labConsent = data(await call("/clinical-core/consumer/consents/grant", input.consumerIdToken, 201, {
    connectionId: string(claimed.connectionId),
    artifactId: string(labConsentArtifact.artifactId),
    scope: "lab_results_import",
    method: "patient_app",
    representativeAuthority: "self",
  }), ["consentId", "connectionId", "scope", "status", "version", "recordedAt"]);
  if (labConsent.scope !== "lab_results_import" || labConsent.status !== "granted" || labConsent.version !== 1) {
    throw new SyntheticAcceptanceError("workflow_failed");
  }

  const connectionAfterLabConsent = nullableData(await call(
    "/clinical-core/consumer/connection", input.consumerIdToken, 200,
  ));
  if (!connectionAfterLabConsent || connectionAfterLabConsent.labResultsImportConsent !== "granted") {
    throw new SyntheticAcceptanceError("workflow_failed");
  }

  for (const [scope, artifactId] of [
    ["protocols_supplements", input.manifest.fixture.protocolConsentArtifactId],
    ["nutrition", input.manifest.fixture.nutritionConsentArtifactId],
    ["symptoms_adherence", input.manifest.fixture.symptomsConsentArtifactId],
    ["forms_checkins", input.manifest.fixture.formsConsentArtifactId],
  ] as const) {
    const clinicalConsent = data(await call("/clinical-core/consumer/consents/grant", input.consumerIdToken, 201, {
      connectionId: string(claimed.connectionId), artifactId, scope,
      method: "patient_app", representativeAuthority: "self",
    }), ["consentId", "connectionId", "scope", "status", "version", "recordedAt"]);
    if (clinicalConsent.scope !== scope || clinicalConsent.status !== "granted") {
      throw new SyntheticAcceptanceError("workflow_failed");
    }
  }

  const consentHistory = listData(await call(
    `/clinical-core/consumer/privacy/consents?connectionId=${encodeURIComponent(string(claimed.connectionId))}`,
    input.consumerIdToken, 200,
  ));
  if (!consentHistory.some((row) => row.scope === "protocols_supplements" && row.status === "granted")) {
    throw new SyntheticAcceptanceError("workflow_failed");
  }

  const recordKey = `record:acceptance:${Date.now()}`;
  const idempotencyKey = `write:acceptance:${Date.now()}`;
  const stableRecordId = "88888888-8888-4888-8888-888888888888";
  const recordPayload = {
    connectionId: string(claimed.connectionId), stableRecordId, collection: "protocols",
    recordKey, resourceVersion: "acceptance-v1", idempotencyKey,
    payload: {
      id: "synthetic_protocol_acceptance", name: "Synthetic acceptance protocol",
      start_date: new Date().toISOString().slice(0, 10), status: "active", version: 1,
      supplements_json: [], peptides_json: [], lifestyle_tasks_json: [],
    },
  };
  const recorded = data(await call("/clinical-core/consumer/records", input.consumerIdToken, 202, recordPayload),
    ["versionId", "stableRecordId", "recordKey", "resourceVersion", "payload", "payloadSha256", "deleted", "receivedAt", "duplicate"]);
  if (recorded.stableRecordId !== stableRecordId || recorded.duplicate !== false) {
    throw new SyntheticAcceptanceError("workflow_failed");
  }
  const duplicateRecord = data(await call("/clinical-core/consumer/records", input.consumerIdToken, 202, recordPayload),
    ["versionId", "stableRecordId", "recordKey", "resourceVersion", "payload", "payloadSha256", "deleted", "receivedAt", "duplicate"]);
  if (duplicateRecord.versionId !== recorded.versionId || duplicateRecord.duplicate !== true) {
    throw new SyntheticAcceptanceError("workflow_failed");
  }
  const recordsPage = data(await call(
    `/clinical-core/consumer/records?connectionId=${encodeURIComponent(string(claimed.connectionId))}&collection=protocols&limit=100`,
    input.consumerIdToken, 200,
  ), ["items", "nextCursor"]);
  if (!Array.isArray(recordsPage.items)
    || !recordsPage.items.some((row) => record(row) && row.versionId === recorded.versionId)
    || recordsPage.nextCursor !== null) throw new SyntheticAcceptanceError("workflow_failed");

  const intakeTimestamp = new Date().toISOString();
  const intakeRecords = [
    {
      collection: "wellness_profiles", stableRecordId: "81818181-8181-4181-8181-818181818181",
      payload: { id: "synthetic_wellness_profile", height: 68, weight: 150,
        goals: ["synthetic-goal"], onboardingCompleted: true, role: "patient" },
    },
    {
      collection: "lifestyle_profiles", stableRecordId: "82828282-8282-4282-8282-828282828282",
      payload: { id: "synthetic_lifestyle_profile", sleepHours: 7, sleepQuality: "good",
        stressLevel: "moderate", dietType: "balanced", cookingSkill: "intermediate",
        shoppingCadence: "weekly", exerciseFrequency: "3_per_week", exerciseTypes: ["walking"] },
    },
    {
      collection: "contraindications", stableRecordId: "83838383-8383-4383-8383-838383838383",
      payload: { id: "synthetic_contraindications", pregnant: false, pregnancyStatus: "not_pregnant",
        nursing: false, medications: ["synthetic-medication"], allergies: [], conditions: [] },
    },
    {
      collection: "questionnaire_responses", stableRecordId: "84848484-8484-4484-8484-848484848484",
      payload: { id: "synthetic_questionnaire_response", questionId: "synthetic-question",
        categoryId: "synthetic-category", severity: 2, timestamp: intakeTimestamp },
    },
    {
      collection: "clinical_intakes", stableRecordId: "85858585-8585-4585-8585-858585858585",
      payload: { id: "synthetic_clinical_intake", chiefComplaint: "Synthetic acceptance concern",
        associatedSymptoms: ["synthetic fatigue"], energyLevel: 6, sleepQuality: 7,
        digestiveFunction: 6, stressPerception: 4, temperatureSensitivity: "neutral",
        painQuality: "none", createdAt: intakeTimestamp, updatedAt: intakeTimestamp },
    },
  ] as const;
  const intakeWrites: Array<{ request: Record<string, unknown>; versionId: string }> = [];
  for (const [index, intakeRecord] of intakeRecords.entries()) {
    const request = {
      connectionId: string(claimed.connectionId), stableRecordId: intakeRecord.stableRecordId,
      collection: intakeRecord.collection, recordKey: `record:intake:${intakeRecord.collection}`,
      resourceVersion: "acceptance-v1", idempotencyKey: `write:intake:${index}:${Date.now()}`,
      payload: intakeRecord.payload,
    };
    const written = data(await call("/clinical-core/consumer/records", input.consumerIdToken, 202, request),
      ["versionId", "stableRecordId", "recordKey", "resourceVersion", "payload", "payloadSha256", "deleted", "receivedAt", "duplicate"]);
    if (written.stableRecordId !== intakeRecord.stableRecordId || written.duplicate !== false) {
      throw new SyntheticAcceptanceError("workflow_failed");
    }
    intakeWrites.push({ request, versionId: string(written.versionId) });
  }
  const intakeReplay = data(await call(
    "/clinical-core/consumer/records", input.consumerIdToken, 202, intakeWrites[4]!.request,
  ), ["versionId", "stableRecordId", "recordKey", "resourceVersion", "payload", "payloadSha256", "deleted", "receivedAt", "duplicate"]);
  if (intakeReplay.versionId !== intakeWrites[4]!.versionId || intakeReplay.duplicate !== true) {
    throw new SyntheticAcceptanceError("workflow_failed");
  }
  for (const [index, intakeRecord] of intakeRecords.entries()) {
    const page = data(await call(
      `/clinical-core/consumer/records?connectionId=${encodeURIComponent(string(claimed.connectionId))}&collection=${intakeRecord.collection}&limit=100`,
      input.consumerIdToken, 200,
    ), ["items", "nextCursor"]);
    if (!Array.isArray(page.items)
      || !page.items.some((row) => record(row) && row.versionId === intakeWrites[index]!.versionId)) {
      throw new SyntheticAcceptanceError("workflow_failed");
    }
  }

  const privacyRequest = data(await call("/clinical-core/consumer/privacy/requests", input.consumerIdToken, 201, {
    connectionId: string(claimed.connectionId), kind: "export", detail: "Synthetic acceptance export",
  }), ["requestId", "kind", "status", "detail", "submittedAt", "resolvedAt"]);
  if (privacyRequest.kind !== "export" || privacyRequest.status !== "submitted") {
    throw new SyntheticAcceptanceError("workflow_failed");
  }
  const privacyRequests = listData(await call(
    `/clinical-core/consumer/privacy/requests?connectionId=${encodeURIComponent(string(claimed.connectionId))}`,
    input.consumerIdToken, 200,
  ));
  if (!privacyRequests.some((row) => row.requestId === privacyRequest.requestId)) {
    throw new SyntheticAcceptanceError("workflow_failed");
  }
  await call("/clinical-core/consumer/records", input.consumerIdToken, 400, {
    ...recordPayload, idempotencyKey: `write:refused:${Date.now()}`,
    payload: { ...recordPayload.payload, email: "refused@example.test" },
  });

  const syntheticEventId = `acceptance_lab_event_${Date.now()}`;
  const occurredAt = new Date().toISOString();
  const labPayload = {
    schemaVersion: "lab-result/1",
    provider: "alp_patient_sync",
    providerEventId: syntheticEventId,
    connectionId: string(claimed.connectionId),
    resourceVersion: "acceptance-v1",
    occurredAt,
    source: {
      system: "ai_longevity_pro_v2",
      recordType: "lab_panels",
      panelId: syntheticEventId,
      markerId: "synthetic_glucose_marker",
    },
    panel: { name: "Synthetic Metabolic Panel", collectedAt: occurredAt, sourceLabel: "Synthetic acceptance only" },
    result: {
      name: "Synthetic Glucose",
      value: 91,
      unit: "mg/dL",
      sourceStatus: "normal",
      referenceRange: { min: 70, max: 99 },
    },
  };
  const firstImport = data(await call(
    "/clinical-core/consumer/labs/import", input.consumerIdToken, 202, labPayload,
  ), ["eventId", "state", "duplicate"]);
  if (firstImport.state !== "review_pending" || firstImport.duplicate !== false) {
    throw new SyntheticAcceptanceError("workflow_failed");
  }
  const duplicateImport = data(await call(
    "/clinical-core/consumer/labs/import", input.consumerIdToken, 202, labPayload,
  ), ["eventId", "state", "duplicate"]);
  if (duplicateImport.eventId !== firstImport.eventId || duplicateImport.state !== "review_pending"
    || duplicateImport.duplicate !== true) throw new SyntheticAcceptanceError("workflow_failed");

  const pendingImports = listData(await call(
    "/clinical-core/workforce/lab-imports?state=review_pending", input.workforceIdToken, 200,
  ));
  const pending = pendingImports.find((row) => row.event_id === firstImport.eventId);
  if (!pending || pending.patient_record_id !== input.manifest.fixture.patientRecordId
    || pending.marker_name !== "Synthetic Glucose" || pending.state !== "review_pending") {
    throw new SyntheticAcceptanceError("workflow_failed");
  }

  const reviewed = data(await call("/clinical-core/workforce/lab-imports/review", input.workforceIdToken, 200, {
    eventId: string(firstImport.eventId), decision: "accept", note: "Synthetic acceptance only",
  }), ["eventId", "state", "observationId", "duplicate"]);
  if (reviewed.eventId !== firstImport.eventId || reviewed.state !== "accepted"
    || reviewed.duplicate !== false || typeof reviewed.observationId !== "string") {
    throw new SyntheticAcceptanceError("workflow_failed");
  }

  const observations = listData(await call(
    `/clinical-core/consumer/patient-labs?patientRecordId=${encodeURIComponent(input.manifest.fixture.patientRecordId)}`,
    input.consumerIdToken,
    200,
  ));
  const observation = observations.find((row) => row.observation_id === reviewed.observationId);
  if (!observation || observation.marker_name !== "Synthetic Glucose" || observation.review_status !== "unreviewed") {
    throw new SyntheticAcceptanceError("workflow_failed");
  }
  const compatibilityPath = "/clinical-core/workforce/data-compatibility";
  const desktopLabs = listData(await call(compatibilityPath, input.workforceIdToken, 200, {
    kind: "rpc", functionName: "list_patient_lab_observations",
    args: { _organization_id: input.manifest.fixture.organizationId, _patient_id: input.manifest.fixture.patientRecordId },
  }));
  if (!desktopLabs.some((row) => row.id === reviewed.observationId
    && row.canonical_name === "Synthetic Glucose" && row.source === "ai_longevity_pro_v2")) {
    throw new SyntheticAcceptanceError("workflow_failed");
  }
  const desktopPatients = listData(await call(compatibilityPath, input.workforceIdToken, 200, {
    kind: "select", table: "patient_profiles",
    query: new URLSearchParams({
      select: "id,organization_id,mrn,first_name,last_name,date_of_birth,sex,status",
      organization_id: `eq.${input.manifest.fixture.organizationId}`,
      id: `eq.${input.manifest.fixture.patientRecordId}`,
      limit: "1",
    }).toString(),
  }));
  if (desktopPatients.length !== 1 || desktopPatients[0]?.id !== input.manifest.fixture.patientRecordId) {
    throw new SyntheticAcceptanceError("workflow_failed");
  }
  const desktopDocuments = listData(await call(compatibilityPath, input.workforceIdToken, 200, {
    kind: "select", table: "lab_documents",
    query: new URLSearchParams({
      select: "id,file_name,lab_company,panel_name,lab_date,created_at",
      patient_id: `eq.${input.manifest.fixture.patientRecordId}`,
      organization_id: `eq.${input.manifest.fixture.organizationId}`,
      limit: "20",
    }).toString(),
  }));
  if (!desktopDocuments.some((row) => row.panel_name === "Synthetic Metabolic Panel")) {
    throw new SyntheticAcceptanceError("workflow_failed");
  }
  await call(compatibilityPath, input.isolationWorkforceIdToken, 403, {
    kind: "rpc", functionName: "list_patient_lab_observations",
    args: { _organization_id: input.manifest.fixture.organizationId, _patient_id: input.manifest.fixture.patientRecordId },
  });
  return { passed: 46, externalRequests: 46 };
}

function validateConfiguration(input: { apiOrigin: string; workforceIdToken: string; consumerIdToken: string; isolationWorkforceIdToken: string; manifest: SyntheticAcceptanceManifest }) {
  let url: URL;
  try { url = new URL(input.apiOrigin); } catch { throw new SyntheticAcceptanceError("configuration_invalid"); }
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || !/\.execute-api\.[a-z0-9-]+\.amazonaws\.com$/.test(url.hostname)) {
    throw new SyntheticAcceptanceError("configuration_invalid");
  }
  for (const token of [input.workforceIdToken, input.consumerIdToken, input.isolationWorkforceIdToken]) {
    if (!/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new SyntheticAcceptanceError("configuration_invalid");
  }
  if (new Set([input.workforceIdToken, input.consumerIdToken, input.isolationWorkforceIdToken]).size !== 3) {
    throw new SyntheticAcceptanceError("configuration_invalid");
  }
  return url.origin;
}

async function request(fetcher: FetchLike, origin: string, path: string, bearer: string, expected: number | number[], body: Record<string, unknown> | undefined, operationIndex: number) {
  let response: Response;
  try {
    response = await fetcher(`${origin}${path}`, {
      method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${bearer}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new SyntheticAcceptanceError("workflow_failed", operationIndex);
  }
  const statuses = Array.isArray(expected) ? expected : [expected];
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 16_384) throw new SyntheticAcceptanceError("workflow_failed");
  let decoded: unknown;
  try { decoded = JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
  catch { throw new SyntheticAcceptanceError("workflow_failed"); }
  if (!statuses.includes(response.status) || !response.headers.get("content-type")?.startsWith("application/json")) {
    const refusalCategory = record(decoded) && typeof decoded.error === "string" && /^[a-z_]+$/.test(decoded.error)
      ? decoded.error : undefined;
    throw new SyntheticAcceptanceError(response.status === 401 || response.status === 403 ? "boundary_refused" : "workflow_failed", operationIndex, response.status, refusalCategory);
  }
  return decoded;
}

function data(value: unknown, exactKeys: string[]) {
  if (!record(value) || !record(value.data) || Object.keys(value).join("|") !== "data"
    || Object.keys(value.data).sort().join("|") !== [...exactKeys].sort().join("|")) {
    throw new SyntheticAcceptanceError("workflow_failed");
  }
  return value.data;
}

function nullableData(value: unknown): Record<string, unknown> | null {
  if (!record(value) || Object.keys(value).join("|") !== "data"
    || (value.data !== null && !record(value.data))) throw new SyntheticAcceptanceError("workflow_failed");
  return value.data;
}

function listData(value: unknown): Record<string, unknown>[] {
  if (!record(value) || Object.keys(value).join("|") !== "data" || !Array.isArray(value.data)
    || value.data.some((entry) => !record(entry))) throw new SyntheticAcceptanceError("workflow_failed");
  return value.data as Record<string, unknown>[];
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function string(value: unknown) {
  if (typeof value !== "string") throw new SyntheticAcceptanceError("workflow_failed");
  return value;
}
