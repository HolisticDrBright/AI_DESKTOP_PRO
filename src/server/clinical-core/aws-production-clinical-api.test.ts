import { describe, expect, it, vi } from "vitest";
import { createAwsProductionClinicalApiHandler, type ProductionClinicalApiConfiguration } from "./aws-production-clinical-api";
import type { AwsProductionDesktopAdapter } from "./aws-production-desktop";
import type { ApiGatewayV2Event } from "./aws-identity-api";

const PERSON = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const ISSUER = "https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Production";
const AUDIENCE = "productionclient00000000000";
const EVIDENCE = "a".repeat(64);

const approved: ProductionClinicalApiConfiguration = {
  workforceIssuer: ISSUER,
  workforceAudience: AUDIENCE,
  phiAllowed: true,
  activationState: "approved",
  activationEvidenceSha256: EVIDENCE,
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

describe("AWS production clinical API", () => {
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
