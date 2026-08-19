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
}): Promise<{ passed: 31; externalRequests: 31 }> {
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
  return { passed: 31, externalRequests: 31 };
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
