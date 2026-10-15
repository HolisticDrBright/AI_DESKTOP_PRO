if (typeof window !== 'undefined') throw new Error('clinical-core/aws-workforce-applicant-identity is server-only.');

import { AdminGetUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import type { CurrentWorkforceApplicant, WorkforceApplicant } from './aws-workforce-applications-api';

/** Source-only reader for the blocked fictional workforce-application candidate. No deployed Lambda imports it. */
const POOL = 'us-east-2_ueGlFRbNB';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MFA = new Set(['SOFTWARE_TOKEN_MFA','SMS_MFA','EMAIL_OTP']);

export type CognitoApplicantReader = {
  send(command: AdminGetUserCommand, options: { abortSignal: AbortSignal }): Promise<unknown>;
};

/** Read the current account by immutable subject. Missing or malformed identity refuses; outages propagate to 503. */
export function createCognitoCurrentWorkforceApplicant(client: CognitoApplicantReader): CurrentWorkforceApplicant {
  return async (subject): Promise<WorkforceApplicant | null> => {
    if (!UUID.test(subject)) return null;
    let raw: unknown;
    try {
      raw = await client.send(new AdminGetUserCommand({ UserPoolId: POOL, Username: subject }),
        { abortSignal: AbortSignal.timeout(10_000) });
    } catch (error) {
      if (error instanceof Error && error.name === 'UserNotFoundException') return null;
      throw error;
    }
    if (!raw || typeof raw !== 'object') return null;
    const user = raw as Record<string, unknown>;
    if (user.Enabled !== true || user.UserStatus !== 'CONFIRMED' || !Array.isArray(user.UserAttributes)) return null;
    const attrs = new Map<string, string>();
    for (const entry of user.UserAttributes) {
      if (!entry || typeof entry !== 'object') return null;
      const { Name, Value } = entry as Record<string, unknown>;
      if (typeof Name !== 'string' || typeof Value !== 'string' || attrs.has(Name)) return null;
      attrs.set(Name, Value);
    }
    const email = attrs.get('email')?.trim().toLowerCase();
    const methods = user.UserMFASettingList;
    if (attrs.get('sub') !== subject || attrs.get('email_verified') !== 'true'
      || !email || email.length > 320 || !EMAIL.test(email)
      || !Array.isArray(methods) || methods.length === 0 || methods.length > 3
      || methods.some(method => typeof method !== 'string' || !MFA.has(method))
      || new Set(methods).size !== methods.length) return null;
    return { subject,email,emailVerified: true,enabled: true,mfaMethods: methods };
  };
}
