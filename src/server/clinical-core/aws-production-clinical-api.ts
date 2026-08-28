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
};

const ROUTE = "POST /clinical-core/workforce/data-compatibility";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUBJECT = /^[A-Za-z0-9:_-]{8,128}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_BODY_BYTES = 20_480;

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
        if (error.category === "operation_refused") return response(403, { error: "operation_refused" });
      }
      return response(503, { error: "database_unavailable" });
    }
  };
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
