import { describe, expect, test, vi } from "vitest";
import { createConsumerAccountApiHandler, type ConsumerAccountProvider } from "./aws-consumer-account";
import type { ClinicalCoreDatabase } from "./database";
const person = "22222222-2222-4222-8222-222222222222";
const org = "33333333-3333-4333-8333-333333333333";
const subject = "44444444-4444-4444-8444-444444444444";
const issuer = "https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Test";
const audience = "a".repeat(26);
function setup(activationState: "approved" | "blocked" = "approved") {
  const query = vi.fn(async () => ({ rows: [] }));
  const database: ClinicalCoreDatabase = { transaction: async work => work({ query }) };
  const provider: ConsumerAccountProvider = {
    register: vi.fn(), confirm: vi.fn(), resendConfirmation: vi.fn(), requestPasswordReset: vi.fn(), confirmPasswordReset: vi.fn(),
    getConfirmedIdentity: vi.fn(async () => ({ subject, personId: person, organizationId: org })),
  };
  return { query, provider, handler: createConsumerAccountApiHandler({ database, provider,
    configuration: { boundary: "production", activationState, consumerIssuer: issuer, consumerAudience: audience, termsVersion: "terms-1", privacyVersion: "privacy-1" } }) };
}
function event(patch: Record<string, unknown> = {}, body = "{}") {
  return { routeKey: "POST /clinical-core/consumer/account/bootstrap", body,
    requestContext: { authorizer: { jwt: { claims: { iss: issuer, aud: audience, sub: subject, token_use: "id", email_verified: true,
      "custom:person_id": person, "custom:organization_id": org, "custom:production_bound": "true", ...patch } } } } };
}
describe("authenticated consumer bootstrap", () => {
  test("repairs registration from the current verified account without granting clinical access", async () => {
    const t = setup(); const result = await t.handler(event());
    expect(result.statusCode).toBe(200); expect(JSON.parse(result.body)).toEqual({ state: "ready", contractVersion: "consumer-account/1", clinicalAccessGranted: false });
    expect(t.provider.getConfirmedIdentity).toHaveBeenCalledWith(subject); expect(t.query).toHaveBeenCalledOnce();
    expect(result.body).not.toContain(subject);
  });
  test("fails closed before identity/database calls while production registration is blocked", async () => {
    const t = setup("blocked"); expect((await t.handler(event())).statusCode).toBe(503);
    expect(t.provider.getConfirmedIdentity).not.toHaveBeenCalled(); expect(t.query).not.toHaveBeenCalled();
  });
  test.each([{ iss: "wrong" }, { aud: "wrong" }, { token_use: "access" }, { email_verified: false },
    { "custom:synthetic_attested": "true" }, { "custom:production_bound": "false" }])("refuses wrong claims %o", async patch => {
    const t = setup(); expect((await t.handler(event(patch))).statusCode).toBe(403); expect(t.query).not.toHaveBeenCalled();
  });
  test("checks current server-owned binding and rejects body account overrides", async () => {
    const t = setup(); expect((await t.handler(event({ "custom:person_id": org }))).statusCode).toBe(403);
    expect((await t.handler(event({}, JSON.stringify({ personId: person })))).statusCode).toBe(403); expect(t.query).not.toHaveBeenCalled();
  });
  test("rejects health payloads and role overrides on public registration", async () => {
    const t = setup(); const result = await t.handler({ routeKey: "POST /clinical-core/public/consumer/register", body: JSON.stringify({
      email: "synthetic@example.invalid", password: "NotARealSecret!1", acceptsTerms: true, acceptsPrivacy: true,
      termsVersion: "terms-1", privacyVersion: "privacy-1", role: "practitioner", labs: [],
    }) });
    expect(result.statusCode).toBe(400); expect(t.provider.register).not.toHaveBeenCalled();
  });
  test("database failure is retryable with a fresh authenticated request", async () => {
    const t = setup(); t.query.mockRejectedValueOnce(new Error("private database details"));
    expect((await t.handler(event())).statusCode).toBe(503); expect((await t.handler(event())).statusCode).toBe(200);
  });
});
