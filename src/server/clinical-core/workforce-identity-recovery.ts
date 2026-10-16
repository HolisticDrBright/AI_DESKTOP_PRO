if (typeof window !== 'undefined') throw new Error('workforce-identity-recovery is server-only');
import type { AdminGetUserCommandOutput } from '@aws-sdk/client-cognito-identity-provider';

/**
 * The lawful recovery routes after an emergency login revocation (workforce-identity-recovery/1): a replacement
 * credential for a revoked practitioner identity, and custodial read-only access to one named patient's file. Source
 * only and BLOCKED: the SQL candidate is unregistered, no Desktop or operator route calls it, and even applied it runs
 * nothing until the table owner records the release decisions below. Brandon approved the principle only; none of
 * these is decided, and nothing here chooses one.
 */
export const WORKFORCE_IDENTITY_RECOVERY_RELEASE: 'blocked' = 'blocked';
export const WORKFORCE_IDENTITY_RECOVERY_SHA256 = '30cadec0250283229a005176f08175eb0f7bd3fd79979be6b55196ba2bc86fa8';
export const WORKFORCE_IDENTITY_RECOVERY_ROLLBACK_SHA256 = '5d73c082cc3b11e1ad044bced9434893b983f7505d99fa35035fe794b26571b9';
export const WORKFORCE_IDENTITY_RECOVERY_RELEASE_DECISIONS = [
  'the identity-verification method a recovery must state (the release row\'s verification_method)',
  'the approver roster (clinical_private.workforce_identity_recovery_approvers, empty)',
  'the retention policy for recovery and custodial-access records (retention_policy)',
  'the longest custodial grant, in hours (custodial_max_hours, at most 168)',
  'whether a custodial read may cover more of the chart than the patient record itself',
] as const;

/**
 * The replacement account's assurance, read from the identity provider (AdminGetUser on the workforce pool), never from
 * the browser: enabled, confirmed, the subject the proposal names, and TOTP enrolled as the preferred MFA. Anything else
 * is no assurance, and the SQL refuses a recovery without it.
 */
export function replacementAssurance(user: Pick<AdminGetUserCommandOutput, 'Enabled' | 'UserStatus' | 'UserMFASettingList' | 'PreferredMfaSetting' | 'UserAttributes'>,
  subject: string): 'mfa_totp_enrolled' | null {
  const sub = user.UserAttributes?.find(attribute => attribute.Name === 'sub')?.Value;
  return user.Enabled === true && user.UserStatus === 'CONFIRMED' && sub === subject
    && (user.UserMFASettingList ?? []).includes('SOFTWARE_TOKEN_MFA') && user.PreferredMfaSetting === 'SOFTWARE_TOKEN_MFA'
    ? 'mfa_totp_enrolled' : null;
}
