import { describe, it, expect, vi } from "vitest";
import { createRecordingAuthorityApi, RECORDING_AUTHORITY_ROUTE, type RecordingAuthorityConfiguration } from "./recording-authority-api";
import { RecordingAuthorityError } from "./encounter-recording-operations";
import type { ApiGatewayV2Event } from "./aws-identity-api";

const id = "11111111-1111-4111-8111-111111111111", now = Date.now(), seconds = Math.floor(now / 1000);
const config: RecordingAuthorityConfiguration = { workforceIssuer: "https://cognito-idp.us-east-2.amazonaws.com/workforce",
  workforceAudience: "12345678901234567890", organizationId: id, phiAllowed: true, activation: "approved",
  activationEvidenceSha256: "a".repeat(64), mfaReviewSha256: "b".repeat(64), databaseReviewSha256: "c".repeat(64) };
const request = { action: "workspace", encounterId: id, locale: "en", jurisdiction: "FICTIONAL" };
const event = (patch: Record<string, unknown> = {}): ApiGatewayV2Event => ({
  routeKey: RECORDING_AUTHORITY_ROUTE, headers: { "content-type": "application/json" }, body: JSON.stringify(request),
  requestContext: { authorizer: { jwt: { claims: { iss: config.workforceIssuer, aud: config.workforceAudience,
    sub: "FICTIONAL-workforce-subject", token_use: "id", "custom:person_id": id, "custom:organization_id": id,
    "custom:production_bound": "true", email_verified: "true", exp: seconds + 600, iat: seconds, auth_time: seconds, ...patch } } } },
});

describe("recording authority workforce API", () => {
  it("refuses blocked activation before constructing a database service", async () => {
    const operations = vi.fn();
    const handler = createRecordingAuthorityApi({ configuration: { ...config, phiAllowed: false, activation: "blocked" }, operations });
    expect(JSON.parse((await handler(event())).body)).toEqual({ error: "production_not_activated", phiAllowed: false });
    expect(operations).not.toHaveBeenCalled();
    for (const key of ["activationEvidenceSha256", "mfaReviewSha256", "databaseReviewSha256"])
      expect(() => createRecordingAuthorityApi({ configuration: { ...config, [key]: "" }, operations })).toThrow("recording_api_activation_invalid");
  });
  it.each([{ iss: "https://cognito-idp.us-east-2.amazonaws.com/consumer" }, { aud: "other" }, { token_use: "access" },
    { email_verified: false }, { "custom:production_bound": "false" }, { "custom:synthetic_attested": "true" },
    { "custom:person_id": "bad" }, { "custom:organization_id": "22222222-2222-4222-8222-222222222222" }, { sub: "" },
    { exp: seconds - 1 }, { exp: null }, { iat: seconds + 120 }, { auth_time: seconds - 901 }, { auth_time: undefined },
    { auth_time: seconds + 1 }, { exp: "NaN" }, { exp: true }])("refuses invalid workforce claims %j without database access", async patch => {
    const operations = vi.fn();
    expect((await createRecordingAuthorityApi({ configuration: config, operations, now: () => now })(event(patch))).statusCode).toBe(401);
    expect(operations).not.toHaveBeenCalled();
  });
  it("uses only gateway-verified claims and server-owned purpose; capture stays unavailable", async () => {
    const call = vi.fn().mockResolvedValue({ participants: [] }), operations = vi.fn(() => call);
    const handler = createRecordingAuthorityApi({ configuration: config, operations, now: () => now });
    const response = await handler(event());
    expect(response.statusCode).toBe(200); expect(response.headers["cache-control"]).toBe("no-store");
    expect(JSON.parse(response.body).capabilities).toEqual({ consentManagement: true, audioCapture: false, reason: "audio_transport_not_configured" });
    expect(call).toHaveBeenCalledWith(expect.objectContaining({ actorPersonId: id, organizationId: id, identityPool: "workforce", purpose: "clinical_data" }), request);
    expect((await handler({ ...event(), requestContext: undefined, headers: { "content-type": "application/json", authorization: "Bearer unverified-header" } })).statusCode).toBe(401);
    expect(call).toHaveBeenCalledOnce();
  });
  it("refuses audio actions, identity overrides, free-text representative authority and malformed payloads", async () => {
    const operations = vi.fn(); const handler = createRecordingAuthorityApi({ configuration: config, operations, now: () => now });
    for (const payload of [{ ...request, actorPersonId: id }, { ...request, provider: "other" }, { ...request, action: "beginCapture" },
      { action: "addParticipant", encounterId: id, kind: "patient", displayName: "Fictional", canSelfConsent: true },
      { action: "grantConsent", participantId: id, releaseId: id, commandId: id, method: "written", acknowledgment: "test", representative: { authority: "I say so" } }])
      expect((await handler({ ...event(), body: JSON.stringify(payload) })).statusCode).toBe(400);
    for (const bad of [{ ...event(), queryStringParameters: { organizationId: id } }, { ...event(), body: "x".repeat(16001) },
      { ...event(), body: "[]" }, { ...event(), body: "{bad" }, { ...event(), headers: { "content-type": "application/json-evil" } },
      { ...event(), isBase64Encoded: true, body: "!!!" + Buffer.from(JSON.stringify(request)).toString("base64") },
      { ...event(), isBase64Encoded: true, body: Buffer.from([255, 254]).toString("base64") }])
      expect((await handler(bad)).statusCode).toBe(400);
    expect((await handler({ ...event(), routeKey: "POST /clinical-core/consumer/encounter-recording/authority" })).statusCode).toBe(404);
    expect(operations).not.toHaveBeenCalled();
  });
  it("accepts canonical base64 but never exposes raw database details", async () => {
    const call = vi.fn().mockResolvedValue({ participantId: id });
    const handler = createRecordingAuthorityApi({ configuration: config, operations: () => call, now: () => now });
    const encoded = { ...event(), isBase64Encoded: true, body: Buffer.from(JSON.stringify(request)).toString("base64") };
    expect((await handler(encoded)).statusCode).toBe(200);
    call.mockRejectedValue(new Error("patient name and SQL secrets"));
    expect(JSON.parse((await handler(event())).body)).toEqual({ error: "service_unavailable" });
    for (const [code, status] of [["recording_access_refused", 403], ["recording_consent_required", 403], ["conflict", 409]] as const) {
      call.mockRejectedValue(new RecordingAuthorityError(code));
      expect((await handler(event())).statusCode).toBe(status);
    }
  });
});
