import { describe, expect, test, vi } from "vitest";
import { ClinicalCoreAdapterError, type AwsSyntheticIdentityConsentAdapter } from "./aws-identity-consent";
import { createAwsIdentityApiHandler, type ApiGatewayV2Event } from "./aws-identity-api";

const PERSON = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const PATIENT = "33333333-3333-4333-8333-333333333333";
const CONNECTION = "44444444-4444-4444-8444-444444444444";
const ARTIFACT = "55555555-5555-4555-8555-555555555555";
const WORKFORCE_ISSUER = "https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Workforce";
const CONSUMER_ISSUER = "https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Consumer";
const WORKFORCE_AUD = "workforceclient000000000000";
const CONSUMER_AUD = "consumerclient0000000000000";

function adapter(): AwsSyntheticIdentityConsentAdapter {
  return {
    getCurrentConsentArtifact: vi.fn(async (input) => ({
      artifactId: ARTIFACT,
      scope: input.scope,
      artifactVersion: "synthetic-lab-import/1",
      contentSha256: "a".repeat(64),
      jurisdiction: "US",
      approvedAt: "2026-08-12T12:00:00Z",
    })),
    issueInvitation: vi.fn(async () => ({ invitationId: ARTIFACT, connectionId: CONNECTION, expiresAt: "2026-08-12T12:00:00Z", token: "ABCDEFGHJKMNP" })),
    claimInvitation: vi.fn(async () => ({ connectionId: CONNECTION, patientRecordId: PATIENT, consumerPersonId: PERSON, state: "verified" as const, verifiedAt: "2026-08-12T12:00:00Z" })),
    recordConsent: vi.fn(async (input) => ({ consentId: ARTIFACT, connectionId: input.connectionId, scope: input.scope, status: "granted" as const, version: 1, recordedAt: "2026-08-12T12:00:00Z" })),
    revokeConsent: vi.fn(async (input) => ({ consentId: ARTIFACT, connectionId: input.connectionId, scope: input.scope, status: "revoked" as const, version: 2, recordedAt: "2026-08-12T12:00:00Z" })),
  };
}

function event(routeKey: string, pool: "workforce" | "consumer", body: Record<string, unknown>, claimOverrides: Record<string, unknown> = {}): ApiGatewayV2Event {
  const issuer = pool === "workforce" ? WORKFORCE_ISSUER : CONSUMER_ISSUER;
  const audience = pool === "workforce" ? WORKFORCE_AUD : CONSUMER_AUD;
  return {
    routeKey,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    requestContext: { authorizer: { jwt: { claims: {
      iss: issuer, aud: audience, token_use: "id", sub: "synthetic-subject-001",
      "custom:person_id": PERSON, "custom:organization_id": ORG, "custom:synthetic_attested": "true",
      ...claimOverrides,
    } } } },
  };
}

function handler(service = adapter()) {
  return {
    service,
    run: createAwsIdentityApiHandler({
      adapter: service,
      configuration: {
        workforceIssuer: WORKFORCE_ISSUER, workforceAudience: WORKFORCE_AUD,
        consumerIssuer: CONSUMER_ISSUER, consumerAudience: CONSUMER_AUD,
      },
    }),
  };
}

describe("authenticated synthetic identity API", () => {
  test("returns the current approved consent artifact without its document body", async () => {
    const api = handler();
    const request = event("GET /clinical-core/consumer/consent-artifact", "consumer", {});
    request.body = undefined;
    request.queryStringParameters = { scope: "lab_results_import" };
    const response = await api.run(request);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).data).toMatchObject({
      artifactId: ARTIFACT,
      scope: "lab_results_import",
      artifactVersion: "synthetic-lab-import/1",
    });
  });

  test.each(["workforce", "consumer"] as const)("reports authenticated %s synthetic posture without a body", async (pool) => {
    const api = handler();
    const request = event(`GET /clinical-core/${pool}/posture`, pool, {});
    request.body = null;
    const result = await api.run(request);
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({
      data: {
        contractVersion: "clinical-core/1",
        environment: "synthetic-staging",
        dataClassification: "synthetic_only",
        identityPool: pool,
        authenticated: true,
        phiAllowed: false,
        realPatientDataAllowed: false,
      },
    });
    expect(api.service.issueInvitation).not.toHaveBeenCalled();
  });

  test("issues an invitation from a correctly bound workforce identity", async () => {
    const api = handler();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const result = await api.run(event("POST /clinical-core/workforce/invitations", "workforce", {
      patientRecordId: PATIENT, expiresAt, idempotencyKey: "invite:synthetic:001",
    }));
    expect(result.statusCode).toBe(201);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(api.service.issueInvitation).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({ actorPersonId: PERSON, organizationId: ORG, identityPool: "workforce", containsPhi: false }),
      patientRecordId: PATIENT,
    }));
  });

  test("claims an invitation only through the consumer route and pool", async () => {
    const api = handler();
    const result = await api.run(event("POST /clinical-core/consumer/invitations/claim", "consumer", { token: "abcd-efgh-jkmnp" }));
    expect(result.statusCode).toBe(200);
    expect(api.service.claimInvitation).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({ identityPool: "consumer", purpose: "identity_link" }),
      token: "ABCDEFGHJKMNP",
    }));
  });

  test.each([
    ["missing authorizer", undefined],
    ["wrong issuer", { iss: CONSUMER_ISSUER }],
    ["wrong audience", { aud: CONSUMER_AUD }],
    ["access token", { token_use: "access" }],
    ["not attested", { "custom:synthetic_attested": "false" }],
    ["missing person", { "custom:person_id": "" }],
    ["missing organization", { "custom:organization_id": "" }],
  ])("refuses %s before calling the adapter", async (_name, overrides) => {
    const api = handler();
    const request = event("POST /clinical-core/workforce/invitations", "workforce", { patientRecordId: PATIENT, expiresAt: new Date(Date.now() + 60_000).toISOString() }, overrides ?? {});
    if (!overrides) request.requestContext = {};
    const result = await api.run(request);
    expect(result).toMatchObject({ statusCode: 403 });
    expect(JSON.parse(result.body)).toEqual({ error: "identity_refused" });
    expect(api.service.issueInvitation).not.toHaveBeenCalled();
  });

  test.each([
    ["unexpected contact field", { patientRecordId: PATIENT, expiresAt: "2026-08-12T12:00:00Z", email: "person@example.test" }],
    ["invalid opaque patient id", { patientRecordId: "patient-name", expiresAt: "2026-08-12T12:00:00Z" }],
  ])("refuses %s", async (_name, body) => {
    const api = handler();
    const result = await api.run(event("POST /clinical-core/workforce/invitations", "workforce", body));
    expect(result.statusCode).toBe(400);
    expect(api.service.issueInvitation).not.toHaveBeenCalled();
  });

  test("refuses non-JSON and oversized bodies", async () => {
    const api = handler();
    const badType = event("POST /clinical-core/workforce/invitations", "workforce", {});
    badType.headers = { "content-type": "text/plain" };
    expect((await api.run(badType)).statusCode).toBe(400);
    const huge = event("POST /clinical-core/workforce/invitations", "workforce", {});
    huge.body = JSON.stringify({ padding: "x".repeat(9_000) });
    expect((await api.run(huge)).statusCode).toBe(400);
  });

  test("records and revokes consent without adding a clinical side effect", async () => {
    const api = handler();
    const grant = await api.run(event("POST /clinical-core/consumer/consents/grant", "consumer", {
      connectionId: CONNECTION, artifactId: ARTIFACT, scope: "nutrition", method: "patient_app", representativeAuthority: "self",
    }));
    const revoke = await api.run(event("POST /clinical-core/consumer/consents/revoke", "consumer", {
      connectionId: CONNECTION, scope: "nutrition", reasonCode: "patient_request",
    }));
    expect(grant.statusCode).toBe(201);
    expect(revoke.statusCode).toBe(201);
    expect(api.service.recordConsent).toHaveBeenCalledTimes(1);
    expect(api.service.revokeConsent).toHaveBeenCalledTimes(1);
  });

  test("maps bounded adapter categories and never returns raw failures", async () => {
    const service = adapter();
    vi.mocked(service.issueInvitation).mockRejectedValue(new ClinicalCoreAdapterError("database_unavailable"));
    const api = handler(service);
    const result = await api.run(event("POST /clinical-core/workforce/invitations", "workforce", {
      patientRecordId: PATIENT, expiresAt: "2026-08-12T12:00:00Z",
    }));
    expect(result.statusCode).toBe(503);
    expect(result.body).toBe('{"error":"database_unavailable"}');
  });

  test("unknown routes remain unavailable even with a valid JWT", async () => {
    const api = handler();
    const result = await api.run(event("GET /clinical-core/patients", "workforce", {}));
    expect(result.statusCode).toBe(404);
    expect(api.service.issueInvitation).not.toHaveBeenCalled();
  });
});
