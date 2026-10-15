import { describe, expect, test, vi } from "vitest";
import {
  WORKFORCE_TOKEN_BINDING_RELEASE,
  createWorkforcePreTokenCandidate,
  type WorkforcePreTokenEvent,
  type WorkforceTokenBinding,
} from "./aws-workforce-token-binding";

const SUBJECT = "11111111-1111-4111-8111-111111111111";
const PERSON = "22222222-2222-4222-8222-222222222222";
const ORGANIZATION = "33333333-3333-4333-8333-333333333333";
const CONFIGURATION = {
  userPoolId: "us-east-2_AZMa5gxSZ",
  clientId: "67moqjql53ms7247tphe5ftpd8",
  activation: "approved" as const,
  phiAllowed: true,
  activationEvidenceSha256: "a".repeat(64),
};
const QUALIFICATION_CONFIGURATION = {
  userPoolId: "us-east-2_ueGlFRbNB",
  clientId: "4s7jgr4o8sqdq7cvo9gmq96e2h",
  activation: "qualification" as const,
  phiAllowed: false,
  activationEvidenceSha256: "b".repeat(64),
  qualificationAccountId: "588966314750",
  qualificationIdentitySubjects: [SUBJECT],
};

function event(attributes: Record<string, unknown> = {}): WorkforcePreTokenEvent {
  return {
    version: "1",
    triggerSource: "TokenGeneration_Authentication",
    region: "us-east-2",
    userPoolId: CONFIGURATION.userPoolId,
    callerContext: { clientId: CONFIGURATION.clientId },
    request: { userAttributes: {
      sub: SUBJECT,
      email_verified: "true",
      "custom:person_id": "44444444-4444-4444-8444-444444444444",
      "custom:organization_id": "55555555-5555-4555-8555-555555555555",
      "custom:production_bound": "true",
      ...attributes,
    } },
    response: { claimsOverrideDetails: { claimsToAddOrOverride: { attacker: "yes" } } },
  };
}

function binding(overrides: Partial<WorkforceTokenBinding> = {}): WorkforceTokenBinding {
  return {
    subject: SUBJECT,
    identityPool: "workforce",
    personId: PERSON,
    organizationId: ORGANIZATION,
    identityStatus: "active",
    personStatus: "active",
    organizationStatus: "active",
    membershipStatus: "active",
    activeMembershipCount: 1,
    productionBound: true,
    ...overrides,
  };
}

function claims(output: WorkforcePreTokenEvent) {
  return (output.response?.claimsOverrideDetails ?? {}) as {
    claimsToAddOrOverride?: Record<string, string>;
    claimsToSuppress?: string[];
  };
}

describe("source-only workforce pre-token binding candidate", () => {
  test("the real source release stays blocked", () => {
    expect(WORKFORCE_TOKEN_BINDING_RELEASE).toBe("blocked");
  });

  test("fictional qualification may bind only a designated synthetic subject with PHI off", async () => {
    const lookup = vi.fn().mockResolvedValue(binding());
    const handler = createWorkforcePreTokenCandidate({
      configuration: QUALIFICATION_CONFIGURATION,
      lookup,
    });
    const syntheticEvent = {
      ...event(),
      userPoolId: QUALIFICATION_CONFIGURATION.userPoolId,
      callerContext: { clientId: QUALIFICATION_CONFIGURATION.clientId },
      request: { userAttributes: { ...event().request?.userAttributes, "custom:synthetic_attested": "true" } },
    };
    expect(claims(await handler(syntheticEvent)).claimsToAddOrOverride).toEqual({
      "custom:person_id": PERSON,
      "custom:organization_id": ORGANIZATION,
      "custom:production_bound": "false",
    });
    expect(lookup).toHaveBeenCalledExactlyOnceWith(SUBJECT);

    lookup.mockClear();
    const notAttested = {
      ...syntheticEvent,
      request: { userAttributes: { ...syntheticEvent.request.userAttributes, "custom:synthetic_attested": "false" } },
    };
    expect(claims(await handler(notAttested)).claimsToSuppress).toHaveLength(3);
    expect(lookup).not.toHaveBeenCalled();

    const otherSubject = "44444444-4444-4444-8444-444444444444";
    const unlisted = {
      ...syntheticEvent,
      request: { userAttributes: { ...syntheticEvent.request?.userAttributes, sub: otherSubject } },
    };
    expect(claims(await handler(unlisted)).claimsToSuppress).toHaveLength(3);
    expect(lookup).not.toHaveBeenCalled();
  });

  test("fictional qualification cannot target the production pool, permit PHI, or use an unreviewed allowlist", () => {
    const invalid = [
      { userPoolId: CONFIGURATION.userPoolId },
      { clientId: CONFIGURATION.clientId },
      { qualificationAccountId: "173535830222" },
      { phiAllowed: true },
      { activationEvidenceSha256: undefined },
      { qualificationIdentitySubjects: [] },
      { qualificationIdentitySubjects: [SUBJECT, SUBJECT] },
      { qualificationIdentitySubjects: ["not-a-subject"] },
    ];
    for (const change of invalid) {
      expect(() => createWorkforcePreTokenCandidate({
        configuration: { ...QUALIFICATION_CONFIGURATION, ...change },
        lookup: vi.fn(),
      })).toThrow("workforce_token_binding_configuration_invalid");
    }
  });

  test("production approval cannot reuse the fictional qualification pool or subject allowlist", () => {
    for (const change of [
      { userPoolId: QUALIFICATION_CONFIGURATION.userPoolId },
      { clientId: QUALIFICATION_CONFIGURATION.clientId },
      { qualificationAccountId: QUALIFICATION_CONFIGURATION.qualificationAccountId },
      { qualificationIdentitySubjects: [SUBJECT] },
    ]) {
      expect(() => createWorkforcePreTokenCandidate({
        configuration: { ...CONFIGURATION, ...change },
        lookup: vi.fn(),
      })).toThrow("workforce_token_binding_configuration_invalid");
    }
  });

  test("blocked activation strips even pre-existing clinical Cognito attributes without reading membership", async () => {
    const lookup = vi.fn();
    const handler = createWorkforcePreTokenCandidate({
      configuration: { ...CONFIGURATION, activation: "blocked", phiAllowed: false, activationEvidenceSha256: undefined },
      lookup,
    });
    expect(claims(await handler(event()))).toEqual({
      claimsToSuppress: ["custom:person_id", "custom:organization_id", "custom:production_bound"],
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  test("approved current single-clinic binding is the only source of the three claims", async () => {
    const lookup = vi.fn().mockResolvedValue(binding());
    const handler = createWorkforcePreTokenCandidate({ configuration: CONFIGURATION, lookup });
    const output = await handler(event());
    expect(lookup).toHaveBeenCalledWith(SUBJECT);
    expect(claims(output)).toEqual({ claimsToAddOrOverride: {
      "custom:person_id": PERSON,
      "custom:organization_id": ORGANIZATION,
      "custom:production_bound": "true",
    } });
    expect(output.response).not.toHaveProperty("groupOverrideDetails");
  });

  test.each(["TokenGeneration_RefreshTokens", "TokenGeneration_AuthenticateDevice"])(
    "rechecks current membership for %s rather than reusing old token claims",
    async (triggerSource) => {
      const lookup = vi.fn().mockResolvedValue(binding({ membershipStatus: "suspended" }));
      const handler = createWorkforcePreTokenCandidate({ configuration: CONFIGURATION, lookup });
      expect(claims(await handler({ ...event(), triggerSource })).claimsToSuppress).toHaveLength(3);
      expect(lookup).toHaveBeenCalledWith(SUBJECT);
    },
  );

  test("unverified email or no approved binding receives no clinical claims", async () => {
    const lookup = vi.fn().mockResolvedValue(null);
    const handler = createWorkforcePreTokenCandidate({ configuration: CONFIGURATION, lookup });
    expect(claims(await handler(event({ email_verified: "false" }))).claimsToSuppress).toHaveLength(3);
    expect(lookup).not.toHaveBeenCalled();
    expect(claims(await handler(event())).claimsToSuppress).toHaveLength(3);
  });

  test.each<Partial<WorkforceTokenBinding>>([
    { identityStatus: "disabled" },
    { personStatus: "disabled" },
    { organizationStatus: "suspended" },
    { membershipStatus: "suspended" },
    { activeMembershipCount: 0 },
    { activeMembershipCount: 2 },
    { productionBound: false },
  ])("withholds for inactive, unapproved, or ambiguous membership: %o", async (change) => {
    const handler = createWorkforcePreTokenCandidate({
      configuration: CONFIGURATION,
      lookup: vi.fn().mockResolvedValue(binding(change)),
    });
    expect(claims(await handler(event())).claimsToSuppress).toHaveLength(3);
  });

  test("a lookup outage refuses token issuance instead of using stale attributes", async () => {
    const handler = createWorkforcePreTokenCandidate({
      configuration: CONFIGURATION,
      lookup: vi.fn().mockRejectedValue(new Error("database connection detail")),
    });
    await expect(handler(event())).rejects.toThrow("workforce_token_binding_lookup_unavailable");
  });

  test("a cross-subject binding or malformed approved identity refuses issuance", async () => {
    for (const row of [binding({ subject: "44444444-4444-4444-8444-444444444444" }), binding({ personId: "bad" })]) {
      const handler = createWorkforcePreTokenCandidate({
        configuration: CONFIGURATION,
        lookup: vi.fn().mockResolvedValue(row),
      });
      await expect(handler(event())).rejects.toThrow(/workforce_token_binding_(identity_mismatch|record_invalid)/);
    }
  });

  test.each([
    { version: "2" },
    { triggerSource: "PreSignUp_SignUp" },
    { userPoolId: "us-east-2_WRONG" },
    { region: "us-west-2" },
    { callerContext: { clientId: "wrong" } },
    { request: { userAttributes: { sub: "bad", email_verified: "true" } } },
  ])("refuses an unreviewed trigger source or identity: %o", async (change) => {
    const lookup = vi.fn();
    const handler = createWorkforcePreTokenCandidate({ configuration: CONFIGURATION, lookup });
    await expect(handler({ ...event(), ...change })).rejects.toThrow("workforce_token_binding_event_invalid");
    expect(lookup).not.toHaveBeenCalled();
  });

  test("cannot approve release with PHI disabled or without reviewed evidence", () => {
    for (const change of [{ phiAllowed: false }, { activationEvidenceSha256: undefined }]) {
      expect(() => createWorkforcePreTokenCandidate({
        configuration: { ...CONFIGURATION, ...change },
        lookup: vi.fn(),
      })).toThrow("workforce_token_binding_configuration_invalid");
    }
  });
});
