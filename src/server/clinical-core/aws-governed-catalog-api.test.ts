import { describe, expect, test, vi } from "vitest";
import { createAwsGovernedCatalogApiHandler, type CatalogApiEvent } from "./aws-governed-catalog-api";
import type { AwsGovernedCatalogReader } from "./aws-governed-catalog-reader";

const configuration = {
  environment: "production-clinical" as const,
  workforceIssuer: "https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Workforce",
  workforceAudience: "workforceclient1234567890",
  consumerIssuer: "https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Consumer",
  consumerAudience: "consumerclient12345678901",
};

function event(routeKey: string, pool: "workforce" | "consumer", query?: Record<string, string>): CatalogApiEvent {
  return {
    routeKey,
    queryStringParameters: query,
    requestContext: { authorizer: { jwt: { claims: {
      iss: pool === "workforce" ? configuration.workforceIssuer : configuration.consumerIssuer,
      aud: pool === "workforce" ? configuration.workforceAudience : configuration.consumerAudience,
      token_use: "id",
      sub: `${pool}:synthetic-subject`,
      "custom:person_id": "11111111-1111-4111-8111-111111111111",
      "custom:organization_id": "22222222-2222-4222-8222-222222222222",
      "custom:synthetic_attested": "false",
    } } } },
  };
}

function reader(): AwsGovernedCatalogReader {
  return {
    listProducts: vi.fn(async () => ({ products: [], commercial: { offers: [] } })),
    listProtocolTemplates: vi.fn(async () => ({ protocolTemplates: [] })),
  };
}

describe("AWS governed catalog API", () => {
  test("serves the authenticated consumer catalog without enabling PHI", async () => {
    const value = reader();
    const response = await createAwsGovernedCatalogApiHandler({ reader: value, configuration })(event(
      "GET /clinical-core/consumer/catalog/products", "consumer",
    ));
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      contractVersion: "governed-catalog-api/1",
      environment: "production-clinical",
      dataClassification: "reference_only",
      phiAllowed: false,
      realPatientDataAllowed: false,
      data: { products: [], commercial: { offers: [] } },
    });
    expect(value.listProducts).toHaveBeenCalledWith({ limit: 50 });
  });

  test("allows protocol templates only on the workforce route", async () => {
    const value = reader();
    const handler = createAwsGovernedCatalogApiHandler({ reader: value, configuration });
    const workforce = await handler(event(
      "GET /clinical-core/workforce/catalog/protocol-templates", "workforce", { limit: "10" },
    ));
    expect(workforce.statusCode).toBe(200);
    const consumer = await handler(event(
      "GET /clinical-core/consumer/catalog/protocol-templates", "consumer",
    ));
    expect(consumer.statusCode).toBe(404);
  });

  test("refuses issuer, audience, or synthetic-attestation drift", async () => {
    const value = event("GET /clinical-core/consumer/catalog/products", "consumer");
    value.requestContext!.authorizer!.jwt!.claims!["custom:synthetic_attested"] = "true";
    const response = await createAwsGovernedCatalogApiHandler({ reader: reader(), configuration })(value);
    expect(response).toMatchObject({ statusCode: 403 });
    expect(JSON.parse(response.body)).toEqual({ error: "identity_refused" });
  });

  test("bounds pagination and rejects unexpected query keys", async () => {
    const handler = createAwsGovernedCatalogApiHandler({ reader: reader(), configuration });
    const tooLarge = await handler(event(
      "GET /clinical-core/workforce/catalog/products", "workforce", { limit: "101" },
    ));
    expect(tooLarge.statusCode).toBe(400);
    const unexpected = await handler(event(
      "GET /clinical-core/workforce/catalog/products", "workforce", { patientId: "x" },
    ));
    expect(unexpected.statusCode).toBe(400);
  });
});
