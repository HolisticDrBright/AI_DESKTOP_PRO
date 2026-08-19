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
    | "get_connection" | "import_lab" | "list_lab_imports" | "review_lab" | "list_labs";
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
  "POST /clinical-core/consumer/labs/import": { pool: "consumer", purpose: "clinical_data", operation: "import_lab" },
  "GET /clinical-core/consumer/connection": { pool: "consumer", purpose: "clinical_data", operation: "get_connection" },
  "GET /clinical-core/workforce/lab-imports": { pool: "workforce", purpose: "clinical_data", operation: "list_lab_imports" },
  "POST /clinical-core/workforce/lab-imports/review": { pool: "workforce", purpose: "clinical_data", operation: "review_lab" },
  "GET /clinical-core/workforce/patient-labs": { pool: "workforce", purpose: "clinical_data", operation: "list_labs" },
  "GET /clinical-core/consumer/patient-labs": { pool: "consumer", purpose: "clinical_data", operation: "list_labs" },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUBJECT = /^[A-Za-z0-9:_-]{8,128}$/;
const IDEMPOTENCY = /^[A-Za-z0-9:_-]{8,128}$/;
const MAX_BODY_BYTES = 8_192;

export function createAwsIdentityApiHandler(input: {
  database?: ClinicalCoreDatabase;
  adapter?: AwsSyntheticIdentityConsentAdapter;
  clinicalStateAdapter?: AwsSyntheticClinicalStateAdapter;
  configuration: IdentityApiConfiguration;
}) {
  const adapter = input.adapter ?? (input.database ? createAwsSyntheticIdentityConsentAdapter(input.database) : undefined);
  const clinicalStateAdapter = input.clinicalStateAdapter
    ?? (input.database ? createAwsSyntheticClinicalStateAdapter(input.database) : undefined);
  if (!adapter) throw new Error("identity_api_adapter_required");
  validateConfiguration(input.configuration);

  return async (event: ApiGatewayV2Event): Promise<ApiGatewayV2Response> => {
    try {
      const route = event.routeKey ? ROUTES[event.routeKey] : undefined;
      if (!route) return response(404, { error: "route_not_found" });
      const context = contextFromClaims(event, route, input.configuration);
      if (["get_connection", "import_lab", "list_lab_imports", "review_lab", "list_labs"].includes(route.operation)
        && !clinicalStateAdapter) throw new Error("clinical_state_api_adapter_required");
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
      return response(503, { error: "service_unavailable" });
    }
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
