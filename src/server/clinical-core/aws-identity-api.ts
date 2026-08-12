if (typeof window !== "undefined") {
  throw new Error("clinical-core/aws-identity-api is server-only.");
}

import {
  ClinicalCoreAdapterError,
  CONSENT_SCOPES,
  createAwsSyntheticIdentityConsentAdapter,
  type AwsSyntheticIdentityConsentAdapter,
  type ConsentMethod,
  type IdentityPool,
  type RepresentativeAuthority,
  type SyntheticRequestContext,
} from "./aws-identity-consent";
import type { ClinicalCoreDatabase } from "./database";

export type ApiGatewayV2Event = {
  routeKey?: string;
  headers?: Record<string, string | undefined>;
  body?: string | null;
  isBase64Encoded?: boolean;
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
  operation: "issue" | "claim" | "grant" | "revoke";
};

const ROUTES: Readonly<Record<string, RouteDefinition>> = {
  "POST /clinical-core/workforce/invitations": { pool: "workforce", purpose: "identity_link", operation: "issue" },
  "POST /clinical-core/consumer/invitations/claim": { pool: "consumer", purpose: "identity_link", operation: "claim" },
  "POST /clinical-core/workforce/consents/grant": { pool: "workforce", purpose: "consent_management", operation: "grant" },
  "POST /clinical-core/consumer/consents/grant": { pool: "consumer", purpose: "consent_management", operation: "grant" },
  "POST /clinical-core/workforce/consents/revoke": { pool: "workforce", purpose: "consent_management", operation: "revoke" },
  "POST /clinical-core/consumer/consents/revoke": { pool: "consumer", purpose: "consent_management", operation: "revoke" },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUBJECT = /^[A-Za-z0-9:_-]{8,128}$/;
const IDEMPOTENCY = /^[A-Za-z0-9:_-]{8,128}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const MAX_BODY_BYTES = 8_192;

export function createAwsIdentityApiHandler(input: {
  database?: ClinicalCoreDatabase;
  adapter?: AwsSyntheticIdentityConsentAdapter;
  configuration: IdentityApiConfiguration;
}) {
  const adapter = input.adapter ?? (input.database ? createAwsSyntheticIdentityConsentAdapter(input.database) : undefined);
  if (!adapter) throw new Error("identity_api_adapter_required");
  validateConfiguration(input.configuration);

  return async (event: ApiGatewayV2Event): Promise<ApiGatewayV2Response> => {
    try {
      const route = event.routeKey ? ROUTES[event.routeKey] : undefined;
      if (!route) return response(404, { error: "route_not_found" });
      const context = contextFromClaims(event, route, input.configuration);
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
          return response(200, { data: await adapter.claimInvitation({ context, token: requiredString(body, "token", TOKEN) }) });
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
      return response(503, { error: "service_unavailable" });
    }
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
