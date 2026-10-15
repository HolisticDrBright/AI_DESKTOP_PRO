import { describe, expect, it, vi } from "vitest";
import { createAwsProductionClinicalApiHandler, type ProductionClinicalApiConfiguration } from "./aws-production-clinical-api";
import type { AwsProductionDesktopAdapter } from "./aws-production-desktop";
import {
  createAwsProductionIdentityApiHandler,
  type ApiGatewayV2Event,
  type ProductionIdentityApiConfiguration,
} from "./aws-identity-api";
import type { AwsIdentityConsentAdapter, ProductionClinicalRequestContext } from "./aws-identity-consent";
import type { AwsClinicalStateAdapter } from "./aws-clinical-state";
import type { AwsClinicalRecordsAdapter } from "./aws-consumer-clinical-records";

const PERSON = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const ISSUER = "https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Production";
const AUDIENCE = "productionclient00000000000";
const EVIDENCE = "a".repeat(64);
const CONSUMER_ISSUER = "https://cognito-idp.us-east-2.amazonaws.com/us-east-2_ConsumerProduction";
const CONSUMER_AUDIENCE = "consumerclient000000000000";

const approved: ProductionClinicalApiConfiguration = {
  workforceIssuer: ISSUER,
  workforceAudience: AUDIENCE,
  phiAllowed: true,
  activationState: "approved",
  activationEvidenceSha256: EVIDENCE,
  pilotScope: "lab_intake_only",
  pilotOrganizationId: ORG,
};

function event(overrides: Record<string, unknown> = {}): ApiGatewayV2Event {
  return {
    routeKey: "POST /clinical-core/workforce/data-compatibility",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "rpc",
      functionName: "list_patient_lab_observations",
      args: { _organization_id: ORG, _patient_id: "33333333-3333-4333-8333-333333333333" },
    }),
    requestContext: { authorizer: { jwt: { claims: {
      iss: ISSUER,
      aud: AUDIENCE,
      token_use: "id",
      sub: "production-subject-001",
      "custom:person_id": PERSON,
      "custom:organization_id": ORG,
      "custom:production_bound": "true",
      ...overrides,
    } } } },
  };
}

function adapter(): AwsProductionDesktopAdapter {
  return { execute: vi.fn(async () => [{ observation_id: "44444444-4444-4444-8444-444444444444" }]) };
}

function fullProductionInput(configurationOverrides: Partial<ProductionIdentityApiConfiguration> = {}) {
  const connection = vi.fn(async () => ({
    connectionId: "33333333-3333-4333-8333-333333333333",
    patientRecordId: "44444444-4444-4444-8444-444444444444",
    state: "verified" as const,
    verifiedAt: "2026-08-20T00:00:00.000Z",
    labResultsImportConsent: "granted" as const,
  }));
  return {
    adapter: {} as AwsIdentityConsentAdapter<ProductionClinicalRequestContext>,
    clinicalStateAdapter: { getConsumerConnection: connection } as unknown as AwsClinicalStateAdapter<ProductionClinicalRequestContext>,
    clinicalRecordsAdapter: {} as AwsClinicalRecordsAdapter<ProductionClinicalRequestContext>,
    desktopCompatibilityAdapter: adapter() as AwsProductionDesktopAdapter,
    configuration: {
      workforceIssuer: ISSUER,
      workforceAudience: AUDIENCE,
      consumerIssuer: CONSUMER_ISSUER,
      consumerAudience: CONSUMER_AUDIENCE,
      phiAllowed: true,
      activationState: "approved" as const,
      activationEvidenceSha256: EVIDENCE,
      pilotScope: "lab_intake_only" as const,
      pilotOrganizationId: ORG,
      ...configurationOverrides,
    },
    connection,
  };
}

describe("AWS production clinical API", () => {
  it("keeps the DB-current successor separate from legacy token-claim authority", async () => {
    const actualIssuer = "https://cognito-idp.us-east-2.amazonaws.com/us-east-2_AZMa5gxSZ";
    const actualAudience = "67moqjql53ms7247tphe5ftpd8";
    const subject = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const service: AwsProductionDesktopAdapter = {
      execute: vi.fn(async () => { throw new Error("legacy path must not run"); }),
      executeWithCurrentMembership: vi.fn(async () => [{ observation_id: PERSON }]),
    };
    const request = event({ iss: actualIssuer,aud: actualAudience,sub: subject,
      email_verified: "true","custom:person_id": "","custom:organization_id": "",
      "custom:production_bound": "" });
    request.requestContext!.accountId = "173535830222";
    request.headers!["x-alp-selected-organization-id"] = ORG;
    const configuration: ProductionClinicalApiConfiguration = {
      ...approved,workforceIssuer: actualIssuer,workforceAudience: actualAudience,
      authorityMode: "database_current",
    };
    const response = await createAwsProductionClinicalApiHandler({ adapter: service,configuration })(request);
    expect(response.statusCode).toBe(200);
    expect(service.execute).not.toHaveBeenCalled();
    expect(service.executeWithCurrentMembership).toHaveBeenCalledWith(
      { subject,selectedOrganizationId: ORG },
      expect.objectContaining({ functionName: "list_patient_lab_observations" }),
    );
    request.headers!["x-alp-selected-organization-id"] = PERSON;
    expect((await createAwsProductionClinicalApiHandler({ adapter: service,configuration })(request)).statusCode).toBe(403);
    expect(service.executeWithCurrentMembership).toHaveBeenCalledTimes(1);
  });

  it("refuses the successor when its current-membership adapter is absent", async () => {
    const request = event({
      iss: "https://cognito-idp.us-east-2.amazonaws.com/us-east-2_AZMa5gxSZ",
      aud: "67moqjql53ms7247tphe5ftpd8",sub: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      email_verified: "true",
    });
    request.requestContext!.accountId = "173535830222";
    request.headers!["x-alp-selected-organization-id"] = ORG;
    const response = await createAwsProductionClinicalApiHandler({ adapter: adapter(),
      configuration: { ...approved,workforceIssuer: "https://cognito-idp.us-east-2.amazonaws.com/us-east-2_AZMa5gxSZ",
        workforceAudience: "67moqjql53ms7247tphe5ftpd8",authorityMode: "database_current" },
    })(request);
    expect(response.statusCode).toBe(503);
    expect(response.body).toBe('{"error":"membership_authority_not_configured"}');
  });

  it("categorically refuses before identity or body processing while activation is blocked", async () => {
    const service = adapter();
    const handler = createAwsProductionClinicalApiHandler({
      adapter: service,
      configuration: { ...approved, phiAllowed: false, activationState: "blocked", activationEvidenceSha256: undefined },
    });
    const result = await handler({});
    expect(result.statusCode).toBe(503);
    expect(JSON.parse(result.body)).toEqual({ error: "production_not_activated", phiAllowed: false });
    expect(service.execute).not.toHaveBeenCalled();
  });

  it("accepts an approved, evidence-bound production workforce request", async () => {
    const service = adapter();
    const result = await createAwsProductionClinicalApiHandler({ adapter: service, configuration: approved })(event());
    expect(result.statusCode).toBe(200);
    expect(service.execute).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: ORG,
      environment: "production-clinical",
      dataClassification: "clinical_phi",
      containsPhi: true,
      productionBound: true,
    }), expect.objectContaining({ functionName: "list_patient_lab_observations" }));
  });

  it("limits an approved pilot to its named organization", async () => {
    const service = adapter();
    const result = await createAwsProductionClinicalApiHandler({ adapter: service, configuration: approved })(event({
      "custom:organization_id": "55555555-5555-4555-8555-555555555555",
    }));
    expect(result.statusCode).toBe(403);
    expect(result.body).toBe('{"error":"identity_refused"}');
    expect(service.execute).not.toHaveBeenCalled();
  });

  it("refuses Desktop operations outside the lab and intake pilot", async () => {
    const service = adapter();
    const request = event();
    request.body = JSON.stringify({ kind: "rpc", functionName: "book_appointment", args: { _organization_id: ORG } });
    const result = await createAwsProductionClinicalApiHandler({ adapter: service, configuration: approved })(request);
    expect(result.statusCode).toBe(403);
    expect(result.body).toBe('{"error":"pilot_scope_refused"}');
    expect(service.execute).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong issuer", { iss: "https://example.invalid" }],
    ["wrong audience", { aud: "otherclient0000000000000" }],
    ["access token", { token_use: "access" }],
    ["not production bound", { "custom:production_bound": "false" }],
    ["missing person", { "custom:person_id": "" }],
  ])("refuses %s", async (_label, overrides) => {
    const service = adapter();
    const result = await createAwsProductionClinicalApiHandler({ adapter: service, configuration: approved })(event(overrides));
    expect(result.statusCode).toBe(403);
    expect(result.body).toBe('{"error":"identity_refused"}');
    expect(service.execute).not.toHaveBeenCalled();
  });

  it("refuses a PHI-enabled configuration without a 64-character approval evidence hash", () => {
    expect(() => createAwsProductionClinicalApiHandler({
      adapter: adapter(),
      configuration: { ...approved, activationEvidenceSha256: "missing" },
    })).toThrow("production_api_configuration_invalid");
  });

  it("never returns raw adapter errors", async () => {
    const service = adapter();
    vi.mocked(service.execute).mockRejectedValue(new Error("secret raw database detail"));
    const result = await createAwsProductionClinicalApiHandler({ adapter: service, configuration: approved })(event());
    expect(result.statusCode).toBe(503);
    expect(result.body).toBe('{"error":"database_unavailable"}');
  });
});

describe("AWS production App and Desktop API", () => {
  it("routes the actual identity Lambda's DB-current compatibility request without legacy clinical claims", async () => {
    const actualIssuer = "https://cognito-idp.us-east-2.amazonaws.com/us-east-2_AZMa5gxSZ";
    const actualAudience = "67moqjql53ms7247tphe5ftpd8";
    const subject = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const input = fullProductionInput({ workforceIssuer: actualIssuer,
      workforceAudience: actualAudience,authorityMode: "database_current" });
    const execute = vi.fn(async () => { throw new Error("legacy path must not run"); });
    const current = vi.fn(async () => [{ observation_id: PERSON }]);
    input.desktopCompatibilityAdapter = { execute,executeWithCurrentMembership: current };
    const request = event({ iss: actualIssuer,aud: actualAudience,sub: subject,
      email_verified: "true","custom:person_id": "","custom:organization_id": "",
      "custom:production_bound": "" });
    request.requestContext!.accountId = "173535830222";
    request.headers!["x-alp-selected-organization-id"] = ORG;
    const handler = createAwsProductionIdentityApiHandler(input);
    const accepted = await handler(request);
    expect(accepted.statusCode).toBe(200);
    expect(current).toHaveBeenCalledWith({ subject,selectedOrganizationId: ORG },
      expect.objectContaining({ functionName: "list_patient_lab_observations" }));
    expect(execute).not.toHaveBeenCalled();
    request.headers!["x-alp-selected-organization-id"] = PERSON;
    expect((await handler(request)).statusCode).toBe(403);
    expect(current).toHaveBeenCalledTimes(1);
  });

  it("refuses other workforce routes rather than falling back to legacy claims", async () => {
    const input = fullProductionInput({
      workforceIssuer: "https://cognito-idp.us-east-2.amazonaws.com/us-east-2_AZMa5gxSZ",
      workforceAudience: "67moqjql53ms7247tphe5ftpd8",
      authorityMode: "database_current",
    });
    const legacy = vi.fn(async () => []);
    input.desktopCompatibilityAdapter = { execute: legacy };
    const request = event({
      iss: input.configuration.workforceIssuer,
      aud: input.configuration.workforceAudience,
      sub: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "custom:person_id": PERSON,
      "custom:organization_id": ORG,
      "custom:production_bound": "true",
    });
    request.routeKey = "GET /clinical-core/workforce/posture";
    const result = await createAwsProductionIdentityApiHandler(input)(request);
    expect(result.statusCode).toBe(503);
    expect(result.body).toBe('{"error":"membership_authority_not_configured"}');
    expect(legacy).not.toHaveBeenCalled();
  });

  it("blocks every workforce and consumer route before activation", async () => {
    const input = fullProductionInput({ phiAllowed: false, activationState: "blocked", activationEvidenceSha256: undefined });
    const result = await createAwsProductionIdentityApiHandler(input)({ routeKey: "GET /clinical-core/consumer/connection" });
    expect(result.statusCode).toBe(503);
    expect(JSON.parse(result.body)).toEqual({ error: "production_not_activated", phiAllowed: false });
    expect(input.connection).not.toHaveBeenCalled();
  });

  it("accepts a production-bound consumer token and creates a PHI-aware database context", async () => {
    const input = fullProductionInput();
    const result = await createAwsProductionIdentityApiHandler(input)({
      routeKey: "GET /clinical-core/consumer/connection",
      requestContext: { authorizer: { jwt: { claims: {
        iss: CONSUMER_ISSUER, aud: CONSUMER_AUDIENCE, token_use: "id",
        sub: "production-consumer-001", "custom:person_id": PERSON,
        "custom:organization_id": ORG, "custom:production_bound": "true",
      } } } },
    });
    expect(result.statusCode).toBe(200);
    expect(input.connection).toHaveBeenCalledWith(expect.objectContaining({
      environment: "production-clinical", dataClassification: "clinical_phi",
      containsPhi: true, realPatientData: true, productionBound: true,
      identityPool: "consumer",
    }));
  });

  it("refuses a production token carrying the synthetic attestation", async () => {
    const input = fullProductionInput();
    const result = await createAwsProductionIdentityApiHandler(input)({
      routeKey: "GET /clinical-core/consumer/connection",
      requestContext: { authorizer: { jwt: { claims: {
        iss: CONSUMER_ISSUER, aud: CONSUMER_AUDIENCE, token_use: "id",
        sub: "production-consumer-001", "custom:person_id": PERSON,
        "custom:organization_id": ORG, "custom:production_bound": "true",
        "custom:synthetic_attested": "true",
      } } } },
    });
    expect(result.statusCode).toBe(403);
    expect(input.connection).not.toHaveBeenCalled();
  });

  it("refuses a PHI-enabled App/Desktop configuration without signed evidence", () => {
    const input = fullProductionInput({ activationEvidenceSha256: "missing" });
    expect(() => createAwsProductionIdentityApiHandler(input)).toThrow("production_api_configuration_invalid");
  });

  it("refuses a production consumer from an organization outside the pilot", async () => {
    const input = fullProductionInput();
    const result = await createAwsProductionIdentityApiHandler(input)({
      routeKey: "GET /clinical-core/consumer/connection",
      requestContext: { authorizer: { jwt: { claims: {
        iss: CONSUMER_ISSUER, aud: CONSUMER_AUDIENCE, token_use: "id",
        sub: "production-consumer-001", "custom:person_id": PERSON,
        "custom:organization_id": "55555555-5555-4555-8555-555555555555",
        "custom:production_bound": "true",
      } } } },
    });
    expect(result.statusCode).toBe(403);
    expect(input.connection).not.toHaveBeenCalled();
  });

  it("refuses non-pilot Desktop functionality even after production activation", async () => {
    const input = fullProductionInput();
    const result = await createAwsProductionIdentityApiHandler(input)({
      routeKey: "POST /clinical-core/workforce/data-compatibility",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "rpc", functionName: "book_appointment", args: { _organization_id: ORG } }),
      requestContext: { authorizer: { jwt: { claims: {
        iss: ISSUER, aud: AUDIENCE, token_use: "id", sub: "production-subject-001",
        "custom:person_id": PERSON, "custom:organization_id": ORG, "custom:production_bound": "true",
      } } } },
    });
    expect(result.statusCode).toBe(403);
    expect(result.body).toBe('{"error":"pilot_scope_refused"}');
  });
});
