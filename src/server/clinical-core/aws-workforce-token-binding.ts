/**
 * Source-only candidate for a Cognito V1 pre-token-generation trigger.
 * No Lambda entrypoint or deployed pool trigger imports this module.
 *
 * An applicant can own an email-verified Cognito account without clinical
 * authority. Only a reviewed, current database binding may populate the
 * three legacy ID-token claims that existing clinical services require.
 */
export const WORKFORCE_TOKEN_BINDING_RELEASE = "blocked" as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const CLINICAL_CLAIMS = [
  "custom:person_id",
  "custom:organization_id",
  "custom:production_bound",
] as const;
const TRIGGERS = new Set([
  "TokenGeneration_Authentication",
  "TokenGeneration_HostedAuth",
  "TokenGeneration_NewPasswordChallenge",
  "TokenGeneration_AuthenticateDevice",
  "TokenGeneration_RefreshTokens",
]);

export type WorkforceTokenBinding = {
  subject: string;
  identityPool: "workforce";
  personId: string;
  organizationId: string;
  identityStatus: "active" | "disabled";
  personStatus: "active" | "disabled";
  organizationStatus: "active" | "suspended" | "archived";
  membershipStatus: "active" | "suspended";
  /** More than one approved clinic requires a separately reviewed selection contract. */
  activeMembershipCount: number;
  productionBound: boolean;
};

export type WorkforcePreTokenEvent = {
  version?: unknown;
  triggerSource?: unknown;
  region?: unknown;
  userPoolId?: unknown;
  callerContext?: { clientId?: unknown };
  request?: { userAttributes?: Record<string, unknown> };
  response?: Record<string, unknown>;
};

type BindingLookup = (subject: string) => Promise<WorkforceTokenBinding | null>;
type BindingConfiguration = {
  userPoolId: string;
  clientId: string;
  activation: "blocked" | "approved";
  phiAllowed: boolean;
  activationEvidenceSha256?: string;
};

export function createWorkforcePreTokenCandidate(input: {
  configuration: BindingConfiguration;
  lookup: BindingLookup;
}) {
  const { configuration } = input;
  if (!/^[a-z0-9-]+_[A-Za-z0-9]+$/.test(configuration.userPoolId)
    || !/^[A-Za-z0-9]{20,128}$/.test(configuration.clientId)
    || !["blocked", "approved"].includes(configuration.activation)
    || (configuration.activation === "approved" && (!configuration.phiAllowed
      || !SHA256.test(configuration.activationEvidenceSha256 ?? "")))) {
    throw new Error("workforce_token_binding_configuration_invalid");
  }

  return async (event: WorkforcePreTokenEvent): Promise<WorkforcePreTokenEvent> => {
    const subject = event.request?.userAttributes?.sub;
    if (event.version !== "1" || !TRIGGERS.has(String(event.triggerSource))
      || event.userPoolId !== configuration.userPoolId
      || event.region !== configuration.userPoolId.split("_")[0]
      || event.callerContext?.clientId !== configuration.clientId
      || typeof subject !== "string" || !UUID.test(subject)) {
      throw new Error("workforce_token_binding_event_invalid");
    }

    // Always replace the response. Never let raw, possibly stale Cognito
    // attributes or a supplied response act as clinical authorization.
    const withoutClinicalClaims = (): WorkforcePreTokenEvent => ({
      ...event,
      response: { claimsOverrideDetails: { claimsToSuppress: [...CLINICAL_CLAIMS] } },
    });
    if (configuration.activation !== "approved"
      || event.request?.userAttributes?.email_verified !== "true") {
      return withoutClinicalClaims();
    }

    let binding: WorkforceTokenBinding | null;
    try {
      binding = await input.lookup(subject);
    } catch {
      // A lookup outage is not evidence that an existing clinic claim is safe.
      // Abort token issuance rather than mint a token from stale attributes.
      throw new Error("workforce_token_binding_lookup_unavailable");
    }
    if (!binding) return withoutClinicalClaims();
    if (binding.subject !== subject || binding.identityPool !== "workforce") {
      throw new Error("workforce_token_binding_identity_mismatch");
    }
    if (binding.identityStatus !== "active" || binding.personStatus !== "active"
      || binding.organizationStatus !== "active" || binding.membershipStatus !== "active"
      || binding.activeMembershipCount !== 1 || binding.productionBound !== true) {
      return withoutClinicalClaims();
    }
    if (!UUID.test(binding.personId) || !UUID.test(binding.organizationId)) {
      throw new Error("workforce_token_binding_record_invalid");
    }
    return {
      ...event,
      response: {
        claimsOverrideDetails: {
          claimsToAddOrOverride: {
            "custom:person_id": binding.personId,
            "custom:organization_id": binding.organizationId,
            "custom:production_bound": "true",
          },
        },
      },
    };
  };
}
