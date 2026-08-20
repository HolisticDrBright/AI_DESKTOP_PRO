if (typeof window !== "undefined") {
  throw new Error("clinical-core/aws-identity-api is server-only.");
}

import {
  ClinicalCoreAdapterError,
  CONSENT_SCOPES,
  createAwsSyntheticIdentityConsentAdapter,
  INVITATION_CODE_PATTERN,
  normalizeInvitationCode,
  type AwsSyntheticIdentityConsentAdapter,
  type ConsentMethod,
  type IdentityPool,
  type RepresentativeAuthority,
  type SyntheticRequestContext,
} from "./aws-identity-consent";
import type { ClinicalCoreDatabase } from "./database";
import {
  ClinicalStateError,
  createAwsSyntheticClinicalStateAdapter,
  type AwsSyntheticClinicalStateAdapter,
  type LabResultImport,
} from "./aws-clinical-state";
import {
  CONSUMER_CLINICAL_COLLECTIONS,
  ConsumerClinicalError,
  createAwsConsumerClinicalRecordsAdapter,
  type AwsConsumerClinicalRecordsAdapter,
  type ConsumerClinicalCollection,
  type PrivacyRequestKind,
} from "./aws-consumer-clinical-records";
import {
  createAwsDesktopCompatibilityAdapter,
  DesktopCompatibilityError,
  validateDesktopCompatibilityRequest,
  type DesktopCompatibilityAdapter,
} from "./aws-desktop-compatibility";

export type ApiGatewayV2Event = {
  routeKey?: string;
  headers?: Record<string, string | undefined>;
  body?: string | null;
  isBase64Encoded?: boolean;
  queryStringParameters?: Record<string, string | undefined> | null;
  requestContext?: {
    authorizer?: { jwt?: { claims?: Record<string, string | number | boolean | undefined> } };
  };
};

export type ApiGatewayV2Response = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
};

export type IdentityApiConfiguration = {
  workforceIssuer: string;
  workforceAudience: string;
  consumerIssuer: string;
  consumerAudience: string;
};

type RouteDefinition = {
  pool: IdentityPool;
  purpose: SyntheticRequestContext["purpose"];
  operation: "posture" | "issue" | "claim" | "grant" | "revoke"
    | "get_consent_artifact"
    | "get_connection" | "import_lab" | "list_lab_imports" | "review_lab" | "list_labs"
    | "record_clinical" | "list_clinical" | "list_consent_history"
    | "submit_privacy_request" | "list_privacy_requests" | "desktop_compatibility";
};

const ROUTES: Readonly<Record<string, RouteDefinition>> = {
  "GET /clinical-core/workforce/posture": { pool: "workforce", purpose: "identity_link", operation: "posture" },
  "GET /clinical-core/consumer/posture": { pool: "consumer", purpose: "identity_link", operation: "posture" },
  "POST /clinical-core/workforce/invitations": { pool: "workforce", purpose: "identity_link", operation: "issue" },
  "POST /clinical-core/consumer/invitations/claim": { pool: "consumer", purpose: "identity_link", operation: "claim" },
  "POST /clinical-core/workforce/consents/grant": { pool: "workforce", purpose: "consent_management", operation: "grant" },
  "POST /clinical-core/consumer/consents/grant": { pool: "consumer", purpose: "consent_management", operation: "grant" },
  "POST /clinical-core/workforce/consents/revoke": { pool: "workforce", purpose: "consent_management", operation: "revoke" },
  "POST /clinical-core/consumer/consents/revoke": { pool: "consumer", purpose: "consent_management", operation: "revoke" },
  "GET /clinical-core/consumer/consent-artifact": { pool: "consumer", purpose: "consent_management", operation: "get_consent_artifact" },
  "POST /clinical-core/consumer/labs/import": { pool: "consumer", purpose: "clinical_data", operation: "import_lab" },
  "GET /clinical-core/consumer/connection": { pool: "consumer", purpose: "clinical_data", operation: "get_connection" },
  "GET /clinical-core/workforce/lab-imports": { pool: "workforce", purpose: "clinical_data", operation: "list_lab_imports" },
  "POST /clinical-core/workforce/lab-imports/review": { pool: "workforce", purpose: "clinical_data", operation: "review_lab" },
  "GET /clinical-core/workforce/patient-labs": { pool: "workforce", purpose: "clinical_data", operation: "list_labs" },
  "GET /clinical-core/consumer/patient-labs": { pool: "consumer", purpose: "clinical_data", operation: "list_labs" },
  "POST /clinical-core/consumer/records": { pool: "consumer", purpose: "clinical_data", operation: "record_clinical" },
  "GET /clinical-core/consumer/records": { pool: "consumer", purpose: "clinical_data", operation: "list_clinical" },
  "GET /clinical-core/consumer/privacy/consents": { pool: "consumer", purpose: "consent_management", operation: "list_consent_history" },
  "POST /clinical-core/consumer/privacy/requests": { pool: "consumer", purpose: "consent_management", operation: "submit_privacy_request" },
  "GET /clinical-core/consumer/privacy/requests": { pool: "consumer", purpose: "consent_management", operation: "list_privacy_requests" },
  "POST /clinical-core/workforce/data-compatibility": { pool: "workforce", purpose: "clinical_data", operation: "desktop_compatibility" },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUBJECT = /^[A-Za-z0-9:_-]{8,128}$/;
const IDEMPOTENCY = /^[A-Za-z0-9:_-]{8,128}$/;
const MAX_BODY_BYTES = 20_480;

export function createAwsIdentityApiHandler(input: {
  database?: ClinicalCoreDatabase;
  adapter?: AwsSyntheticIdentityConsentAdapter;
  clinicalStateAdapter?: AwsSyntheticClinicalStateAdapter;
  clinicalRecordsAdapter?: AwsConsumerClinicalRecordsAdapter;
  desktopCompatibilityAdapter?: DesktopCompatibilityAdapter;
  configuration: IdentityApiConfiguration;
}) {
  const adapter = input.adapter ?? (input.database ? createAwsSyntheticIdentityConsentAdapter(input.database) : undefined);
  const clinicalStateAdapter = input.clinicalStateAdapter
    ?? (input.database ? createAwsSyntheticClinicalStateAdapter(input.database) : undefined);
  const clinicalRecordsAdapter = input.clinicalRecordsAdapter
    ?? (input.database ? createAwsConsumerClinicalRecordsAdapter(input.database) : undefined);
  const desktopCompatibilityAdapter = input.desktopCompatibilityAdapter
    ?? (input.database ? createAwsDesktopCompatibilityAdapter(input.database) : undefined);
  if (!adapter) throw new Error("identity_api_adapter_required");
  validateConfiguration(input.configuration);

  return async (event: ApiGatewayV2Event): Promise<ApiGatewayV2Response> => {
    try {
      const route = event.routeKey ? ROUTES[event.routeKey] : undefined;
      if (!route) return response(404, { error: "route_not_found" });
      const context = contextFromClaims(event, route, input.configuration);
      if (["get_connection", "import_lab", "list_lab_imports", "review_lab", "list_labs"].includes(route.operation)
        && !clinicalStateAdapter) throw new Error("clinical_state_api_adapter_required");
      if (["record_clinical", "list_clinical", "list_consent_history", "submit_privacy_request", "list_privacy_requests"].includes(route.operation)
        && !clinicalRecordsAdapter) throw new Error("consumer_clinical_api_adapter_required");
      if (route.operation === "desktop_compatibility" && !desktopCompatibilityAdapter) {
        throw new Error("desktop_compatibility_adapter_required");
      }
      if (route.operation === "posture") {
        if (event.body) throw new IdentityApiError("request_invalid");
        return response(200, {
          data: {
            contractVersion: "clinical-core/1",
            environment: context.environment,
            dataClassification: context.dataClassification,
            identityPool: context.identityPool,
            authenticated: true,
            phiAllowed: false,
            realPatientDataAllowed: false,
          },
        });
      }
      if (route.operation === "get_consent_artifact") {
        if (event.body) throw new IdentityApiError("request_invalid");
        const scope = event.queryStringParameters?.scope ?? "";
        if (!CONSENT_SCOPES.includes(scope as (typeof CONSENT_SCOPES)[number])) {
          throw new IdentityApiError("request_invalid");
        }
        return response(200, { data: await adapter.getCurrentConsentArtifact({
          context,
          scope: scope as (typeof CONSENT_SCOPES)[number],
        }) });
      }
      if (route.operation === "list_lab_imports") {
        if (event.body) throw new IdentityApiError("request_invalid");
        const state = event.queryStringParameters?.state ?? "review_pending";
        if (!["review_pending", "conflict", "accepted", "rejected"].includes(state)) {
          throw new IdentityApiError("request_invalid");
        }
        return response(200, { data: await clinicalStateAdapter!.listLabImports(
          context,
          state as "review_pending" | "conflict" | "accepted" | "rejected",
        ) });
      }
      if (route.operation === "get_connection") {
        if (event.body) throw new IdentityApiError("request_invalid");
        return response(200, { data: await clinicalStateAdapter!.getConsumerConnection(context) });
      }
      if (route.operation === "list_labs") {
        if (event.body) throw new IdentityApiError("request_invalid");
        const patientRecordId = event.queryStringParameters?.patientRecordId ?? "";
        if (!UUID.test(patientRecordId)) throw new IdentityApiError("request_invalid");
        return response(200, { data: await clinicalStateAdapter!.listPatientLabObservations(context, patientRecordId) });
      }
      if (route.operation === "list_clinical") {
        if (event.body) throw new IdentityApiError("request_invalid");
        const collection = event.queryStringParameters?.collection ?? "";
        const connectionId = event.queryStringParameters?.connectionId ?? "";
        const limit = Number(event.queryStringParameters?.limit ?? "100");
        const cursor = decodeCursor(event.queryStringParameters?.cursor);
        if (!UUID.test(connectionId) || !CONSUMER_CLINICAL_COLLECTIONS.includes(collection as ConsumerClinicalCollection)
          || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new IdentityApiError("request_invalid");
        const rows = await clinicalRecordsAdapter!.listRecords(context, {
          connectionId, collection: collection as ConsumerClinicalCollection, limit,
          ...(cursor ? { afterReceivedAt: cursor.receivedAt, afterId: cursor.id } : {}),
        });
        const last = rows.length === limit ? rows.at(-1) : undefined;
        return response(200, { data: { items: rows, nextCursor: last ? encodeCursor(last.receivedAt, last.versionId) : null } });
      }
      if (route.operation === "list_consent_history") {
        if (event.body) throw new IdentityApiError("request_invalid");
        const connectionId = event.queryStringParameters?.connectionId ?? "";
        if (!UUID.test(connectionId)) throw new IdentityApiError("request_invalid");
        return response(200, { data: await clinicalRecordsAdapter!.listConsentHistory(context, connectionId) });
      }
      if (route.operation === "list_privacy_requests") {
        if (event.body) throw new IdentityApiError("request_invalid");
        const connectionId = event.queryStringParameters?.connectionId ?? "";
        if (!UUID.test(connectionId)) throw new IdentityApiError("request_invalid");
        return response(200, { data: await clinicalRecordsAdapter!.listPrivacyRequests(context, connectionId) });
      }
      if (route.operation === "desktop_compatibility") {
        const body = parseBody(event);
        const request = validateDesktopCompatibilityRequest(context, body);
        if (request.kind === "rpc" && request.functionName === "list_patient_lab_observations") {
          if (!clinicalStateAdapter) throw new Error("clinical_state_api_adapter_required");
          const patientRecordId = request.args._patient_id;
          if (typeof patientRecordId !== "string" || !UUID.test(patientRecordId)) {
            throw new IdentityApiError("request_invalid");
          }
          const rows = await clinicalStateAdapter.listPatientLabObservations(context, patientRecordId);
          return response(200, { data: rows.map(desktopLabObservation) });
        }
        if (request.kind === "select" && request.table === "patient_profiles") {
          if (!clinicalStateAdapter?.listDesktopPatients) throw new Error("desktop_patient_read_adapter_required");
          const patientRecordId = equalityUuid(new URLSearchParams(request.query).get("id"));
          return response(200, { data: await clinicalStateAdapter.listDesktopPatients(context, patientRecordId) });
        }
        if (request.kind === "select" && request.table === "lab_documents") {
          if (!clinicalStateAdapter?.listDesktopLabDocuments) throw new Error("desktop_lab_document_adapter_required");
          const patientRecordId = equalityUuid(new URLSearchParams(request.query).get("patient_id"), true);
          return response(200, { data: await clinicalStateAdapter.listDesktopLabDocuments(context, patientRecordId!) });
        }
        return response(200, { data: await desktopCompatibilityAdapter!.execute(context, request) });
      }
      const body = parseBody(event);

      switch (route.operation) {
        case "issue": {
          exactKeys(body, ["patientRecordId", "expiresAt", "idempotencyKey"], ["patientRecordId", "expiresAt"]);
          const patientRecordId = requiredString(body, "patientRecordId", UUID);
          const expiresAt = requiredString(body, "expiresAt");
          const idempotencyKey = optionalString(body, "idempotencyKey", IDEMPOTENCY);
          return response(201, { data: await adapter.issueInvitation({ context, patientRecordId, expiresAt, idempotencyKey }) });
        }
        case "claim": {
          exactKeys(body, ["token"], ["token"]);
          const token = normalizeInvitationCode(requiredString(body, "token"));
          if (!INVITATION_CODE_PATTERN.test(token)) throw new IdentityApiError("request_invalid");
          return response(200, { data: await adapter.claimInvitation({ context, token }) });
        }
        case "grant": {
          exactKeys(body, ["connectionId", "artifactId", "scope", "method", "representativeAuthority"],
            ["connectionId", "artifactId", "scope", "method", "representativeAuthority"]);
          const scope = requiredString(body, "scope");
          const method = requiredString(body, "method") as ConsentMethod;
          const representativeAuthority = requiredString(body, "representativeAuthority") as RepresentativeAuthority;
          if (!CONSENT_SCOPES.includes(scope as (typeof CONSENT_SCOPES)[number])
            || !["patient_app", "portal", "in_person", "written"].includes(method)
            || !["self", "guardian", "healthcare_proxy", "legal_representative"].includes(representativeAuthority)) {
            throw new IdentityApiError("request_invalid");
          }
          return response(201, { data: await adapter.recordConsent({
            context,
            connectionId: requiredString(body, "connectionId", UUID),
            artifactId: requiredString(body, "artifactId", UUID),
            scope: scope as (typeof CONSENT_SCOPES)[number],
            method,
            representativeAuthority,
          }) });
        }
        case "revoke": {
          exactKeys(body, ["connectionId", "scope", "reasonCode"], ["connectionId", "scope", "reasonCode"]);
          const scope = requiredString(body, "scope");
          const reasonCode = requiredString(body, "reasonCode");
          if (!CONSENT_SCOPES.includes(scope as (typeof CONSENT_SCOPES)[number])
            || !["patient_request", "scope_changed", "connection_revoked"].includes(reasonCode)) {
            throw new IdentityApiError("request_invalid");
          }
          return response(201, { data: await adapter.revokeConsent({
            context,
            connectionId: requiredString(body, "connectionId", UUID),
            scope: scope as (typeof CONSENT_SCOPES)[number],
            reasonCode: reasonCode as "patient_request" | "scope_changed" | "connection_revoked",
          }) });
        }
        case "import_lab": {
          return response(202, { data: await clinicalStateAdapter!.importLabResult(context, parseLabImport(body)) });
        }
        case "review_lab": {
          exactKeys(body, ["eventId", "decision", "note"], ["eventId", "decision"]);
          const decision = requiredString(body, "decision");
          if (!UUID.test(requiredString(body, "eventId")) || !["accept", "reject"].includes(decision)) {
            throw new IdentityApiError("request_invalid");
          }
          const note = "note" in body ? requiredString(body, "note") : undefined;
          return response(200, { data: await clinicalStateAdapter!.reviewLabResult(context, {
            eventId: requiredString(body, "eventId"),
            decision: decision as "accept" | "reject",
            ...(note ? { note } : {}),
          }) });
        }
        case "record_clinical": {
          exactKeys(body, ["connectionId", "stableRecordId", "collection", "recordKey", "resourceVersion", "idempotencyKey", "payload", "deleted"],
            ["connectionId", "stableRecordId", "collection", "recordKey", "resourceVersion", "idempotencyKey", "payload"]);
          const collection = requiredString(body, "collection");
          if (!CONSUMER_CLINICAL_COLLECTIONS.includes(collection as ConsumerClinicalCollection)) {
            throw new IdentityApiError("request_invalid");
          }
          const payload = requiredObject(body, "payload");
          const deleted = body.deleted === undefined ? false : requiredBoolean(body, "deleted");
          return response(202, { data: await clinicalRecordsAdapter!.recordVersion(context, {
            connectionId: requiredString(body, "connectionId", UUID),
            stableRecordId: requiredString(body, "stableRecordId", UUID),
            collection: collection as ConsumerClinicalCollection,
            recordKey: requiredString(body, "recordKey"),
            resourceVersion: requiredString(body, "resourceVersion"),
            idempotencyKey: requiredString(body, "idempotencyKey", /^[A-Za-z0-9:_-]{8,160}$/),
            payload,
            deleted,
          }) });
        }
        case "submit_privacy_request": {
          exactKeys(body, ["connectionId", "kind", "detail"], ["connectionId", "kind"]);
          const kind = requiredString(body, "kind");
          if (!["export", "correction", "deletion"].includes(kind)) throw new IdentityApiError("request_invalid");
          return response(201, { data: await clinicalRecordsAdapter!.submitPrivacyRequest(context, {
            connectionId: requiredString(body, "connectionId", UUID),
            kind: kind as PrivacyRequestKind,
            ...(body.detail !== undefined && body.detail !== null ? { detail: requiredString(body, "detail") } : {}),
          }) });
        }
      }
    } catch (error) {
      if (error instanceof IdentityApiError) return response(error.category === "identity_refused" ? 403 : 400, { error: error.category });
      if (error instanceof ClinicalCoreAdapterError) {
        const status = error.category === "synthetic_boundary_refused" ? 403
          : error.category === "invitation_invalid_or_expired" ? 404
            : error.category === "consent_precondition_failed" ? 409
              : error.category === "database_unavailable" ? 503 : 400;
        return response(status, { error: error.category });
      }
      if (error instanceof ClinicalStateError) {
        const status = error.category === "clinical_state_refused" ? 403
          : error.category === "database_unavailable" ? 503 : 400;
        return response(status, { error: error.category });
      }
      if (error instanceof ConsumerClinicalError) {
        const status = error.category === "clinical_record_refused" ? 403
          : error.category === "consent_required" || error.category === "conflict" ? 409
            : error.category === "database_unavailable" ? 503 : 400;
        return response(status, { error: error.category });
      }
      if (error instanceof DesktopCompatibilityError) {
        return response(error.category === "operation_refused" ? 403 : 503, { error: error.category });
      }
      return response(503, { error: "service_unavailable" });
    }
  };
}

function equalityUuid(value: string | null, required = false): string | undefined {
  if (value === null && !required) return undefined;
  if (!value?.startsWith("eq.") || !UUID.test(value.slice(3))) throw new IdentityApiError("request_invalid");
  return value.slice(3);
}

function desktopLabObservation(row: Record<string, unknown>): Record<string, unknown> {
  const observedAt = typeof row.observed_at === "string" ? row.observed_at : "";
  const referenceMin = row.reference_min;
  const referenceMax = row.reference_max;
  const reference = referenceMin == null && referenceMax == null
    ? null
    : `${referenceMin ?? ""}–${referenceMax ?? ""}`;
  const provenance = row.provenance && typeof row.provenance === "object"
    ? row.provenance as Record<string, unknown>
    : {};
  return {
    id: row.observation_id,
    biomarker_definition_id: null,
    canonical_name: row.marker_name,
    biological_system: null,
    value_numeric: row.value_numeric,
    value_text: null,
    unit: row.unit,
    status: null,
    original_reference_interval: reference,
    confidence: null,
    provenance: "AI Longevity Pro governed lab import",
    review_status: row.review_status,
    reviewed_at: null,
    observed_at: observedAt,
    ingested_at: observedAt,
    lab_document_id: null,
    source: "ai_longevity_pro_v2",
    document_file_name: null,
    document_lab_company: "AI Longevity Pro",
    source_record_id: provenance.providerEventId ?? null,
  };
}

function parseLabImport(body: Record<string, unknown>): LabResultImport {
  exactKeys(body, ["schemaVersion", "provider", "providerEventId", "connectionId", "resourceVersion",
    "occurredAt", "source", "panel", "result"], ["schemaVersion", "provider", "providerEventId",
    "connectionId", "resourceVersion", "occurredAt", "source", "panel", "result"]);
  const source = requiredObject(body, "source");
  const panel = requiredObject(body, "panel");
  const result = requiredObject(body, "result");
  exactKeys(source, ["system", "recordType", "panelId", "markerId"], ["system", "recordType", "panelId", "markerId"]);
  exactKeys(panel, ["name", "collectedAt", "sourceLabel"], ["name", "collectedAt"]);
  exactKeys(result, ["name", "value", "unit", "sourceStatus", "referenceRange"], ["name", "value"]);
  let referenceRange: { min?: number; max?: number } | undefined;
  if ("referenceRange" in result) {
    const range = requiredObject(result, "referenceRange");
    exactKeys(range, ["min", "max"], []);
    referenceRange = {
      ...(range.min !== undefined ? { min: requiredNumber(range, "min") } : {}),
      ...(range.max !== undefined ? { max: requiredNumber(range, "max") } : {}),
    };
  }
  return {
    schemaVersion: requiredString(body, "schemaVersion") as "lab-result/1",
    provider: requiredString(body, "provider") as "alp_patient_sync",
    providerEventId: requiredString(body, "providerEventId"),
    connectionId: requiredString(body, "connectionId"),
    resourceVersion: requiredString(body, "resourceVersion"),
    occurredAt: requiredString(body, "occurredAt"),
    source: {
      system: requiredString(source, "system") as "ai_longevity_pro_v2",
      recordType: requiredString(source, "recordType") as "lab_panels",
      panelId: requiredString(source, "panelId"), markerId: requiredString(source, "markerId"),
    },
    panel: {
      name: requiredString(panel, "name"), collectedAt: requiredString(panel, "collectedAt"),
      ...("sourceLabel" in panel ? { sourceLabel: requiredString(panel, "sourceLabel") } : {}),
    },
    result: {
      name: requiredString(result, "name"), value: requiredNumber(result, "value"),
      ...("unit" in result ? { unit: requiredString(result, "unit") } : {}),
      ...(result.sourceStatus !== undefined
        ? { sourceStatus: requiredString(result, "sourceStatus") as LabResultImport["result"]["sourceStatus"] }
        : {}),
      ...(referenceRange ? { referenceRange } : {}),
    },
  };
}

class IdentityApiError extends Error {
  constructor(readonly category: "identity_refused" | "request_invalid") {
    super(category);
    this.name = "IdentityApiError";
  }
}

function contextFromClaims(
  event: ApiGatewayV2Event,
  route: RouteDefinition,
  configuration: IdentityApiConfiguration,
): SyntheticRequestContext {
  const claims = event.requestContext?.authorizer?.jwt?.claims;
  if (!claims) throw new IdentityApiError("identity_refused");
  const issuer = route.pool === "workforce" ? configuration.workforceIssuer : configuration.consumerIssuer;
  const audience = route.pool === "workforce" ? configuration.workforceAudience : configuration.consumerAudience;
  const personId = claim(claims, "custom:person_id");
  const organizationId = claim(claims, "custom:organization_id");
  const subject = claim(claims, "sub");
  if (
    claim(claims, "iss") !== issuer
    || claim(claims, "aud") !== audience
    || claim(claims, "token_use") !== "id"
    || claim(claims, "custom:synthetic_attested") !== "true"
    || !UUID.test(personId)
    || !UUID.test(organizationId)
    || !SUBJECT.test(subject)
  ) throw new IdentityApiError("identity_refused");
  return {
    actorPersonId: personId,
    organizationId,
    identityPool: route.pool,
    identitySubject: subject,
    purpose: route.purpose,
    environment: "synthetic-staging",
    dataClassification: "synthetic_only",
    containsPhi: false,
    realPatientData: false,
  };
}

function parseBody(event: ApiGatewayV2Event): Record<string, unknown> {
  const contentType = header(event.headers, "content-type");
  if (!contentType?.toLowerCase().startsWith("application/json") || typeof event.body !== "string") {
    throw new IdentityApiError("request_invalid");
  }
  const bytes = event.isBase64Encoded ? Buffer.from(event.body, "base64") : Buffer.from(event.body, "utf8");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_BODY_BYTES) throw new IdentityApiError("request_invalid");
  try {
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    return parsed as Record<string, unknown>;
  } catch {
    throw new IdentityApiError("request_invalid");
  }
}

function exactKeys(body: Record<string, unknown>, allowed: readonly string[], required: readonly string[]) {
  if (Object.keys(body).some((key) => !allowed.includes(key)) || required.some((key) => !(key in body))) {
    throw new IdentityApiError("request_invalid");
  }
}

function requiredString(body: Record<string, unknown>, key: string, pattern?: RegExp): string {
  const value = body[key];
  if (typeof value !== "string" || value.length > 512 || (pattern && !pattern.test(value))) {
    throw new IdentityApiError("request_invalid");
  }
  return value;
}

function requiredObject(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = body[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new IdentityApiError("request_invalid");
  return value as Record<string, unknown>;
}

function requiredNumber(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new IdentityApiError("request_invalid");
  return value;
}

function requiredBoolean(body: Record<string, unknown>, key: string): boolean {
  const value = body[key];
  if (typeof value !== "boolean") throw new IdentityApiError("request_invalid");
  return value;
}

function encodeCursor(receivedAt: string, id: string): string {
  if (!UUID.test(id) || !Number.isFinite(new Date(receivedAt).getTime())) throw new IdentityApiError("request_invalid");
  return Buffer.from(`${receivedAt}|${id}`, "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined): { receivedAt: string; id: string } | undefined {
  if (!value) return undefined;
  if (!/^[A-Za-z0-9_-]{20,160}$/.test(value)) throw new IdentityApiError("request_invalid");
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const separator = decoded.lastIndexOf("|");
    const receivedAt = decoded.slice(0, separator);
    const id = decoded.slice(separator + 1);
    if (separator < 1 || !UUID.test(id) || !Number.isFinite(new Date(receivedAt).getTime())) throw new Error("shape");
    return { receivedAt: new Date(receivedAt).toISOString(), id };
  } catch {
    throw new IdentityApiError("request_invalid");
  }
}

function optionalString(body: Record<string, unknown>, key: string, pattern: RegExp): string | undefined {
  if (!(key in body)) return undefined;
  return requiredString(body, key, pattern);
}

function claim(claims: Record<string, string | number | boolean | undefined>, key: string): string {
  const value = claims[key];
  return typeof value === "string" ? value : "";
}

function header(headers: Record<string, string | undefined> | undefined, name: string): string | undefined {
  const entry = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name);
  return entry?.[1];
}

function validateConfiguration(configuration: IdentityApiConfiguration) {
  for (const issuer of [configuration.workforceIssuer, configuration.consumerIssuer]) {
    if (!/^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com\/[A-Za-z0-9_-]+$/.test(issuer)) throw new Error("identity_api_configuration_invalid");
  }
  for (const audience of [configuration.workforceAudience, configuration.consumerAudience]) {
    if (!/^[A-Za-z0-9]{20,128}$/.test(audience)) throw new Error("identity_api_configuration_invalid");
  }
}

function response(statusCode: number, payload: Record<string, unknown>): ApiGatewayV2Response {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
    body: JSON.stringify(payload),
  };
}
