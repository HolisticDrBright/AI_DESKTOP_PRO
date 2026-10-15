if (typeof window !== "undefined") {
  throw new Error("clinical-core/aws-production-clinical-api is server-only.");
}

import {
  validateDesktopCompatibilityRequest,
  type DesktopCompatibilityRequest,
} from "./aws-desktop-compatibility";
import {
  ProductionDesktopError,
  type AwsProductionDesktopAdapter,
  type ProductionRequestContext,
} from "./aws-production-desktop";
import type { ApiGatewayV2Event, ApiGatewayV2Response } from "./aws-identity-api";
import {
  isProductionPilotDesktopRequestAllowed,
  isProductionPilotScope,
  type ProductionPilotScope,
} from "./production-pilot-policy";

export type ProductionClinicalApiConfiguration = {
  workforceIssuer: string;
  workforceAudience: string;
  phiAllowed: boolean;
  activationState: "blocked" | "approved";
  activationEvidenceSha256?: string;
  pilotScope: ProductionPilotScope;
  pilotOrganizationId?: string;
  /** Legacy is the existing pilot. The database-current successor has no deployed release row. */
  authorityMode?: "legacy_claims" | "database_current";
};

const ROUTE = "POST /clinical-core/workforce/data-compatibility";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUBJECT = /^[A-Za-z0-9:_-]{8,128}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_BODY_BYTES = 20_480;
const CURRENT_AUTHORITY_ISSUER = "https://cognito-idp.us-east-2.amazonaws.com/us-east-2_AZMa5gxSZ";
const CURRENT_AUTHORITY_AUDIENCE = "67moqjql53ms7247tphe5ftpd8";
const PRODUCTION_ACCOUNT = "173535830222";

export function createAwsProductionClinicalApiHandler(input: {
  adapter: AwsProductionDesktopAdapter;
  configuration: ProductionClinicalApiConfiguration;
}) {
  validateConfiguration(input.configuration);
  const activated = input.configuration.phiAllowed === true
    && input.configuration.activationState === "approved"
    && SHA256.test(input.configuration.activationEvidenceSha256 ?? "");

  return async (event: ApiGatewayV2Event): Promise<ApiGatewayV2Response> => {
    if (!activated) return response(503, { error: "production_not_activated", phiAllowed: false });
    if (event.routeKey !== ROUTE) return response(404, { error: "route_not_found" });
    try {
      if (input.configuration.authorityMode === "database_current") {
        const principal = databaseCurrentPrincipal(event, input.configuration);
        const request = validateDesktopCompatibilityRequest(
          { organizationId: principal.selectedOrganizationId }, parseBody(event));
        if (!isProductionPilotDesktopRequestAllowed(request)) {
          return response(403, { error: "pilot_scope_refused" });
        }
        if (!input.adapter.executeWithCurrentMembership) {
          return response(503, { error: "membership_authority_not_configured" });
        }
        const data = await input.adapter.executeWithCurrentMembership(principal, request);
        return response(200, { data });
      }
      const context = productionContext(event, input.configuration);
      const request = validateDesktopCompatibilityRequest(context, parseBody(event));
      if (!isProductionPilotDesktopRequestAllowed(request)) {
        return response(403, { error: "pilot_scope_refused" });
      }
      const data = await input.adapter.execute(context, request as DesktopCompatibilityRequest);
      return response(200, { data });
    } catch (error) {
      if (error instanceof ProductionApiError) return response(error.category === "identity_refused" ? 403 : 400, { error: error.category });
      if (error instanceof ProductionDesktopError) {
        if (error.category === "request_invalid") return response(400, { error: "request_invalid" });
        if (error.category === "identity_refused") return response(403, { error: "identity_refused" });
        if (error.category === "operation_refused") return response(403, { error: "operation_refused" });
      }
      return response(503, { error: "database_unavailable" });
    }
  };
}

function databaseCurrentPrincipal(
  event: ApiGatewayV2Event,
  configuration: ProductionClinicalApiConfiguration,
): { subject: string; selectedOrganizationId: string } {
  const claims = event.requestContext?.authorizer?.jwt?.claims;
  const get = (key: string) => typeof claims?.[key] === "string" ? claims[key] as string : "";
  const selectedOrganizationId = Object.entries(event.headers ?? {})
    .find(([key]) => key.toLowerCase() === "x-alp-selected-organization-id")?.[1] ?? "";
  if (event.requestContext?.accountId !== PRODUCTION_ACCOUNT
    || get("iss") !== configuration.workforceIssuer
    || get("aud") !== configuration.workforceAudience
    || get("token_use") !== "id" || !UUID.test(get("sub"))
    || get("email_verified") !== "true"
    || get("custom:synthetic_attested") === "true"
    || !UUID.test(selectedOrganizationId)
    || selectedOrganizationId !== configuration.pilotOrganizationId) {
    throw new ProductionApiError("identity_refused");
  }
  return { subject: get("sub"), selectedOrganizationId };
}

function productionContext(
  event: ApiGatewayV2Event,
  configuration: ProductionClinicalApiConfiguration,
): ProductionRequestContext {
  const claims = event.requestContext?.authorizer?.jwt?.claims;
  const get = (key: string) => typeof claims?.[key] === "string" ? claims[key] as string : "";
  const actorPersonId = get("custom:person_id");
  const organizationId = get("custom:organization_id");
  const identitySubject = get("sub");
  if (get("iss") !== configuration.workforceIssuer || get("aud") !== configuration.workforceAudience
    || get("token_use") !== "id" || get("custom:production_bound") !== "true"
    || !UUID.test(actorPersonId) || !UUID.test(organizationId)
    || organizationId !== configuration.pilotOrganizationId || !SUBJECT.test(identitySubject)) {
    throw new ProductionApiError("identity_refused");
  }
  return {
    actorPersonId,
    organizationId,
    identityPool: "workforce",
    identitySubject,
    purpose: "clinical_data",
    environment: "production-clinical",
    dataClassification: "clinical_phi",
    containsPhi: true,
    realPatientData: true,
    productionBound: true,
  };
}

function parseBody(event: ApiGatewayV2Event): Record<string, unknown> {
  const contentType = Object.entries(event.headers ?? {})
    .find(([key]) => key.toLowerCase() === "content-type")?.[1];
  if (!contentType?.toLowerCase().startsWith("application/json") || typeof event.body !== "string") {
    throw new ProductionApiError("request_invalid");
  }
  const bytes = event.isBase64Encoded ? Buffer.from(event.body, "base64") : Buffer.from(event.body, "utf8");
  if (bytes.byteLength < 2 || bytes.byteLength > MAX_BODY_BYTES) throw new ProductionApiError("request_invalid");
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("shape");
    return value as Record<string, unknown>;
  } catch {
    throw new ProductionApiError("request_invalid");
  }
}

function validateConfiguration(configuration: ProductionClinicalApiConfiguration) {
  if (!/^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com\/[A-Za-z0-9_-]+$/.test(configuration.workforceIssuer)
    || !/^[A-Za-z0-9]{20,128}$/.test(configuration.workforceAudience)
    || (configuration.authorityMode !== undefined
      && !["legacy_claims", "database_current"].includes(configuration.authorityMode))
    || (configuration.authorityMode === "database_current"
      && (configuration.workforceIssuer !== CURRENT_AUTHORITY_ISSUER
        || configuration.workforceAudience !== CURRENT_AUTHORITY_AUDIENCE))
    || (configuration.phiAllowed && (configuration.activationState !== "approved"
      || !SHA256.test(configuration.activationEvidenceSha256 ?? "")
      || !isProductionPilotScope(configuration.pilotScope)
      || !UUID.test(configuration.pilotOrganizationId ?? "")
      || configuration.pilotOrganizationId === "00000000-0000-0000-0000-000000000000"))) {
    throw new Error("production_api_configuration_invalid");
  }
}

class ProductionApiError extends Error {
  constructor(readonly category: "identity_refused" | "request_invalid") {
    super(category);
    this.name = "ProductionApiError";
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
