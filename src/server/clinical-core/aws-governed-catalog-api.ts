if (typeof window !== "undefined") {
  throw new Error("clinical-core/aws-governed-catalog-api is server-only.");
}

import {
  createAwsGovernedCatalogReader,
  GovernedCatalogReadError,
  type AwsGovernedCatalogReader,
  type CatalogEnvironment,
} from "./aws-governed-catalog-reader";
import type { ClinicalCoreDatabase } from "./database";
import type { ApiGatewayV2Response, IdentityApiConfiguration } from "./aws-identity-api";

export type CatalogApiEvent = {
  routeKey?: string;
  headers?: Record<string, string | undefined>;
  body?: string | null;
  queryStringParameters?: Record<string, string | undefined> | null;
  requestContext?: {
    authorizer?: { jwt?: { claims?: Record<string, string | number | boolean | undefined> } };
  };
};

type Pool = "workforce" | "consumer";
type Operation = "products" | "templates";
export type CatalogApiConfiguration = IdentityApiConfiguration & { environment: CatalogEnvironment };

const ROUTES: Readonly<Record<string, { pool: Pool; operation: Operation }>> = {
  "GET /clinical-core/workforce/catalog/products": { pool: "workforce", operation: "products" },
  "GET /clinical-core/consumer/catalog/products": { pool: "consumer", operation: "products" },
  "GET /clinical-core/workforce/catalog/protocol-templates": { pool: "workforce", operation: "templates" },
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUBJECT = /^[A-Za-z0-9:_-]{8,128}$/;
const CURSOR = /^(prd|tpl)_[a-z0-9][a-z0-9_-]{2,95}$/;

export function createAwsGovernedCatalogApiHandler(input: {
  database?: ClinicalCoreDatabase;
  reader?: AwsGovernedCatalogReader;
  configuration: CatalogApiConfiguration;
}) {
  const reader = input.reader ?? (input.database
    ? createAwsGovernedCatalogReader(input.database, input.configuration.environment)
    : undefined);
  if (!reader) throw new Error("catalog_api_reader_required");
  validateConfiguration(input.configuration);

  return async (event: CatalogApiEvent): Promise<ApiGatewayV2Response> => {
    try {
      const route = event.routeKey ? ROUTES[event.routeKey] : undefined;
      if (!route) return response(404, { error: "route_not_found" });
      authenticate(event, route.pool, input.configuration);
      if (event.body) throw new CatalogApiError("request_invalid");
      const page = parsePage(event.queryStringParameters);
      const data = route.operation === "products"
        ? await reader.listProducts(page)
        : await reader.listProtocolTemplates(page);
      return response(200, {
        contractVersion: "governed-catalog-api/1",
        environment: input.configuration.environment,
        dataClassification: "reference_only",
        phiAllowed: false,
        realPatientDataAllowed: false,
        data,
      });
    } catch (error) {
      if (error instanceof CatalogApiError) {
        return response(error.category === "identity_refused" ? 403 : 400, { error: error.category });
      }
      if (error instanceof GovernedCatalogReadError) {
        const status = error.category === "request_invalid" ? 400 : 503;
        return response(status, { error: error.category });
      }
      return response(503, { error: "service_unavailable" });
    }
  };
}

class CatalogApiError extends Error {
  constructor(readonly category: "identity_refused" | "request_invalid") {
    super(category);
    this.name = "CatalogApiError";
  }
}

function authenticate(event: CatalogApiEvent, pool: Pool, configuration: CatalogApiConfiguration) {
  const claims = event.requestContext?.authorizer?.jwt?.claims;
  if (!claims) throw new CatalogApiError("identity_refused");
  const issuer = pool === "workforce" ? configuration.workforceIssuer : configuration.consumerIssuer;
  const audience = pool === "workforce" ? configuration.workforceAudience : configuration.consumerAudience;
  if (
    claim(claims, "iss") !== issuer
    || claim(claims, "aud") !== audience
    || claim(claims, "token_use") !== "id"
    || claim(claims, "custom:synthetic_attested") !== (configuration.environment === "synthetic-staging" ? "true" : "false")
    || !UUID.test(claim(claims, "custom:person_id"))
    || !UUID.test(claim(claims, "custom:organization_id"))
    || !SUBJECT.test(claim(claims, "sub"))
  ) throw new CatalogApiError("identity_refused");
}

function parsePage(query: CatalogApiEvent["queryStringParameters"]): { limit: number; cursor?: string } {
  const allowed = new Set(["limit", "cursor"]);
  if (Object.keys(query ?? {}).some((key) => !allowed.has(key))) throw new CatalogApiError("request_invalid");
  const limitText = query?.limit;
  const limit = limitText === undefined ? 50 : Number(limitText);
  const cursor = query?.cursor;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (cursor !== undefined && !CURSOR.test(cursor))) {
    throw new CatalogApiError("request_invalid");
  }
  return { limit, ...(cursor ? { cursor } : {}) };
}

function claim(claims: Record<string, string | number | boolean | undefined>, key: string): string {
  const value = claims[key];
  return typeof value === "string" ? value : "";
}

function validateConfiguration(configuration: CatalogApiConfiguration) {
  if (!["synthetic-staging", "production-clinical"].includes(configuration.environment)) {
    throw new Error("catalog_api_configuration_invalid");
  }
  for (const issuer of [configuration.workforceIssuer, configuration.consumerIssuer]) {
    if (!/^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com\/[A-Za-z0-9_-]+$/.test(issuer)) {
      throw new Error("catalog_api_configuration_invalid");
    }
  }
  for (const audience of [configuration.workforceAudience, configuration.consumerAudience]) {
    if (!/^[A-Za-z0-9]{20,128}$/.test(audience)) throw new Error("catalog_api_configuration_invalid");
  }
}

function response(statusCode: number, payload: Record<string, unknown>): ApiGatewayV2Response {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, max-age=60",
      "x-content-type-options": "nosniff",
    },
    body: JSON.stringify(payload),
  };
}
