import { describe, expect, test, vi } from "vitest";
import { createAwsGovernedCatalogApiHandler, type CatalogApiEvent } from "./aws-governed-catalog-api";
import type { AwsGovernedCatalogReader } from "./aws-governed-catalog-reader";
import { GovernedCatalogReadError } from "./aws-governed-catalog-reader";

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
    ...(pool === "workforce" ? { headers: { "x-alp-selected-organization-id": "22222222-2222-4222-8222-222222222222" } } : {}),
    requestContext: { accountId: "173535830222", authorizer: { jwt: { claims: {
      iss: pool === "workforce" ? configuration.workforceIssuer : configuration.consumerIssuer,
      aud: pool === "workforce" ? configuration.workforceAudience : configuration.consumerAudience,
      token_use: "id",
      sub: pool === "workforce" ? "33333333-3333-4333-8333-333333333333" : "consumer:synthetic-subject",
      email_verified: "true",
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
  test("versioned production reference uses only the selected current workforce clinic", async () => {
    const referenceReader = { list: vi.fn(async () => ({
      contractVersion: "production-catalog-reference/1" as const, audience: "workforce" as const,
      products: [], nextCursor: null,
    })) };
    const request = event("GET /clinical-core/workforce/catalog/reference", "workforce", { limit: "10" });
    request.requestContext!.authorizer!.jwt!.claims!["custom:person_id"] = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const response = await createAwsGovernedCatalogApiHandler({ reader: reader(), referenceReader, configuration })(request);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      contractVersion: "production-catalog-reference-api/1", phiAllowed: false,
      data: { contractVersion: "production-catalog-reference/1", products: [] },
    });
    expect(referenceReader.list).toHaveBeenCalledWith({ limit: 10, currentWorkforce: {
      subject: "33333333-3333-4333-8333-333333333333",
      selectedOrganizationId: "22222222-2222-4222-8222-222222222222",
    } });
    expect(response.headers?.["cache-control"]).toBe("no-store");
  });

  test("reference refuses missing implementation, consumer access and synthetic runtime", async () => {
    const missing = await createAwsGovernedCatalogApiHandler({ reader: reader(), configuration })(
      event("GET /clinical-core/workforce/catalog/reference", "workforce"),
    );
    expect(missing.statusCode).toBe(503);
    const consumer = await createAwsGovernedCatalogApiHandler({ reader: reader(), configuration })(
      event("GET /clinical-core/workforce/catalog/reference", "consumer"),
    );
    expect(consumer.statusCode).toBe(403);
    const syntheticRequest = event("GET /clinical-core/workforce/catalog/reference", "workforce");
    syntheticRequest.requestContext!.authorizer!.jwt!.claims!["custom:synthetic_attested"] = "true";
    const synthetic = await createAwsGovernedCatalogApiHandler({ reader: reader(), configuration: {
      ...configuration, environment: "synthetic-staging",
    } })(syntheticRequest);
    expect(synthetic.statusCode).toBe(404);
  });

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
    expect(value.listProducts).toHaveBeenCalledWith({ limit: 50, audience: "consumer" });
  });

  test("withholds production consumer offer destinations while preserving workforce reference", async () => {
    const product = {
      stableId: "prd_fictional_omega", version: 1, displayName: "Fictional omega",
      productType: "supplement" as const, accessTier: "open" as const,
      declaredRestricted: false, directOrderAllowed: true, clinical: {},
      sourceRefs: ["fictional:source"], reviewStatus: "approved" as const,
    };
    const offer = {
      stableId: "off_fictional_omega", version: 1, productStableId: product.stableId,
      destinationUrl: "https://shop.example.invalid/omega", trackingMetadata: {},
      reviewStatus: "approved" as const,
    };
    const value = reader();
    vi.mocked(value.listProducts).mockResolvedValue({ products: [product], commercial: { offers: [offer] } });
    const handler = createAwsGovernedCatalogApiHandler({ reader: value, configuration });
    const consumer = await handler(event("GET /clinical-core/consumer/catalog/products", "consumer"));
    expect(consumer.statusCode).toBe(200);
    expect(JSON.parse(consumer.body).data).toMatchObject({
      products: [{ stableId: product.stableId, directOrderAllowed: false }],
      commercial: { offers: [] },
    });
    expect(consumer.body).not.toContain(offer.destinationUrl);
    const workforce = await handler(event("GET /clinical-core/workforce/catalog/products", "workforce"));
    expect(JSON.parse(workforce.body).data).toMatchObject({
      products: [{ stableId: product.stableId, directOrderAllowed: true }],
      commercial: { offers: [offer] },
    });
    const syntheticEvent = event("GET /clinical-core/consumer/catalog/products", "consumer");
    syntheticEvent.requestContext!.authorizer!.jwt!.claims!["custom:synthetic_attested"] = "true";
    const synthetic = await createAwsGovernedCatalogApiHandler({
      reader: value, configuration: { ...configuration, environment: "synthetic-staging" },
    })(syntheticEvent);
    expect(JSON.parse(synthetic.body).data).toMatchObject({
      products: [{ stableId: product.stableId, directOrderAllowed: true }],
      commercial: { offers: [offer] },
    });
  });

  test("a production consumer page carries no product-page link in its label or clinical payloads (fails before: the label source and official product pages were returned)", async () => {
    const product = {
      stableId: "prd_fictional_glutaryl", version: 1, displayName: "Fictional glutaryl",
      productType: "supplement" as const, accessTier: "open" as const,
      declaredRestricted: false, directOrderAllowed: true,
      clinical: { brand: "Fictional brand", normalizations: ["destination normalized from 'www.fictional-brand.example' to 'https://www.fictional-brand.example'"] },
      sourceRefs: ["fictional:source"], reviewStatus: "approved" as const,
      label: {
        stableId: "lbl_fictional_glutaryl", version: 1, reviewStatus: "approved" as const,
        label: { servingSize: "1 capsule", labelSourceUrl: "https://fictional-brand.example/products/glutaryl",
          phase9f: { officialProductUrl: "https://fictional-brand.example/products/glutaryl?size=60", warnings: ["See http://fictional-brand.example/recall for details."] } },
        crosscheck: { sources: [{ url: "https://fullscript.example.invalid/catalog/products/fictional-glutaryl", agrees: true }] },
      },
    };
    const value = reader();
    vi.mocked(value.listProducts).mockResolvedValue({ products: [product], commercial: { offers: [] } });
    const consumer = await createAwsGovernedCatalogApiHandler({ reader: value, configuration })(event("GET /clinical-core/consumer/catalog/products", "consumer"));
    expect(consumer.statusCode).toBe(200);
    expect(consumer.body).not.toMatch(/https?:\/\/|www\./i);
    const [served] = JSON.parse(consumer.body).data.products;
    // What a person reads about the bottle stays; only the links go.
    expect(served.label.label.servingSize).toBe("1 capsule");
    expect(served.label.label).not.toHaveProperty("labelSourceUrl");
    expect(served.label.label.phase9f).not.toHaveProperty("officialProductUrl");
    expect(served.label.label.phase9f.warnings).toEqual(["See [link withheld] for details."]);
    expect(served.clinical.brand).toBe("Fictional brand");
    // Workforce reference and synthetic qualification keep the evidence links.
    const workforce = await createAwsGovernedCatalogApiHandler({ reader: value, configuration })(event("GET /clinical-core/workforce/catalog/products", "workforce"));
    expect(JSON.parse(workforce.body).data.products[0].label.label.labelSourceUrl).toBe(product.label.label.labelSourceUrl);
    const syntheticEvent = event("GET /clinical-core/consumer/catalog/products", "consumer");
    syntheticEvent.requestContext!.authorizer!.jwt!.claims!["custom:synthetic_attested"] = "true";
    const synthetic = await createAwsGovernedCatalogApiHandler({ reader: value, configuration: { ...configuration, environment: "synthetic-staging" } })(syntheticEvent);
    expect(JSON.parse(synthetic.body).data.products[0].label.label.labelSourceUrl).toBe(product.label.label.labelSourceUrl);
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

  test("production workforce catalog binds the current subject and selected clinic, not stale person or clinic claims", async () => {
    const value = reader();
    const request = event("GET /clinical-core/workforce/catalog/products", "workforce");
    request.requestContext!.authorizer!.jwt!.claims!["custom:person_id"] = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    request.requestContext!.authorizer!.jwt!.claims!["custom:organization_id"] = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const response = await createAwsGovernedCatalogApiHandler({ reader: value, configuration })(request);
    expect(response.statusCode).toBe(200);
    expect(response.headers?.["cache-control"]).toBe("no-store");
    expect(value.listProducts).toHaveBeenCalledWith({
      limit: 50,
      currentWorkforce: {
        subject: "33333333-3333-4333-8333-333333333333",
        selectedOrganizationId: "22222222-2222-4222-8222-222222222222",
      },
    });
  });

  test("production workforce catalog refuses absent, duplicate, or invalid selected clinic and account drift", async () => {
    const value = reader();
    const handler = createAwsGovernedCatalogApiHandler({ reader: value, configuration });
    const missing = event("GET /clinical-core/workforce/catalog/products", "workforce");
    delete missing.headers;
    const duplicate = event("GET /clinical-core/workforce/catalog/products", "workforce");
    duplicate.headers!["X-ALP-SELECTED-ORGANIZATION-ID"] = "44444444-4444-4444-8444-444444444444";
    const wrongAccount = event("GET /clinical-core/workforce/catalog/products", "workforce");
    wrongAccount.requestContext!.accountId = "588966314750";
    const unverified = event("GET /clinical-core/workforce/catalog/products", "workforce");
    unverified.requestContext!.authorizer!.jwt!.claims!.email_verified = "false";
    for (const request of [missing, duplicate, wrongAccount, unverified]) {
      expect((await handler(request)).statusCode).toBe(403);
    }
    expect(value.listProducts).not.toHaveBeenCalled();
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
  test("never caches a transient catalog outage or a refused identity", async () => {
    const value = reader();
    vi.mocked(value.listProducts).mockRejectedValue(new GovernedCatalogReadError("catalog_unavailable"));
    const handler = createAwsGovernedCatalogApiHandler({ reader: value, configuration });
    const unavailable = await handler(event("GET /clinical-core/consumer/catalog/products", "consumer"));
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.headers?.["cache-control"]).toBe("no-store");
    const refused = await handler(event("GET /clinical-core/consumer/catalog/products", "workforce"));
    expect(refused.statusCode).toBe(403);
    expect(refused.headers?.["cache-control"]).toBe("no-store");
  });
});
