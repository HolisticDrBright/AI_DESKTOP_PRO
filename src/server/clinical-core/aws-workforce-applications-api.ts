if (typeof window !== 'undefined') {
  throw new Error('clinical-core/aws-workforce-applications-api is server-only.');
}

import { createHash } from 'node:crypto';
import type { ApiGatewayV2Event, ApiGatewayV2Response } from './aws-identity-api';
import type { ClinicalCoreDatabase } from './database';

/** Source-only candidate: no Lambda entrypoint or deployed API imports it. */
export const WORKFORCE_APPLICATION_API_RELEASE = 'blocked' as const;

const POOL = 'us-east-2_ueGlFRbNB';
const CLIENT = '4s7jgr4o8sqdq7cvo9gmq96e2h';
const ACCOUNT = '588966314750';
const ISSUER = `https://cognito-idp.us-east-2.amazonaws.com/${POOL}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_BODY_BYTES = 2048;
const ROUTES = new Set([
  'GET /clinical-core/workforce/applications',
  'POST /clinical-core/workforce/applications',
  'POST /clinical-core/workforce/applications/withdraw',
]);

export type WorkforceApplicant = {
  subject: string;
  email: string;
  emailVerified: boolean;
  enabled: boolean;
  /** From Cognito's current UserMFASettingList, not applicant input or an old token. */
  mfaMethods: readonly string[];
};

/** Must read Cognito's current account, not only the possibly stale ID token. */
export type CurrentWorkforceApplicant = (subject: string) => Promise<WorkforceApplicant | null>;
export type WorkforceApplicationStore = {
  submit(input: { requestId: string; subject: string; emailSha256: string;
    kind: 'join' | 'create_clinic'; organizationId: string | null; proposedLabel: string | null }): Promise<string>;
  list(subject: string): Promise<unknown>;
  withdraw(requestId: string, subject: string): Promise<void>;
};

/** The database connection for this store must use only clinical_workforce_application. */
export function createWorkforceApplicationDatabaseStore(database: ClinicalCoreDatabase): WorkforceApplicationStore {
  return {
    submit: (input) => database.transaction(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        'select clinical_private.submit_workforce_access_request($1,$2,$3,$4,$5,$6) as id',
        [input.requestId,input.subject,input.emailSha256,input.kind,input.organizationId,input.proposedLabel],
      );
      if (!rows[0]?.id) throw new Error('workforce_application_receipt_missing');
      return rows[0].id;
    }),
    list: (subject) => database.transaction(async (tx) => {
      const { rows } = await tx.query<{ state: unknown }>(
        'select clinical_private.workforce_access_status_for_subject($1) as state', [subject],
      );
      return rows[0]?.state ?? [];
    }),
    withdraw: (requestId, subject) => database.transaction(async (tx) => {
      await tx.query('select clinical_private.withdraw_workforce_access_request($1,$2)',
        [requestId,subject]);
    }),
  };
}

export function createWorkforceApplicationsCandidate(input: {
  configuration: { activation: 'blocked' | 'qualification'; phiAllowed: false;
    accountId: string; issuer: string; audience: string; reviewEvidenceSha256?: string };
  currentApplicant: CurrentWorkforceApplicant;
  store: WorkforceApplicationStore;
}) {
  const config = input.configuration;
  if (config.phiAllowed !== false || config.accountId !== ACCOUNT
    || config.issuer !== ISSUER || config.audience !== CLIENT
    || !['blocked','qualification'].includes(config.activation)
    || (config.activation === 'qualification'
      && !/^[0-9a-f]{64}$/.test(config.reviewEvidenceSha256 ?? ''))) {
    throw new Error('workforce_application_configuration_invalid');
  }
  return async (event: ApiGatewayV2Event): Promise<ApiGatewayV2Response> => {
    if (config.activation !== 'qualification') return reply(503, { error: 'workforce_application_not_released' });
    if (!ROUTES.has(event.routeKey ?? '')) return reply(404, { error: 'route_not_found' });
    const claims = event.requestContext?.authorizer?.jwt?.claims;
    const claim = (name: string) => typeof claims?.[name] === 'string' ? claims[name] as string : '';
    const subject = claim('sub');
    const tokenEmail = normalizeEmail(claim('email'));
    if (event.requestContext?.accountId !== ACCOUNT || claim('iss') !== ISSUER
      || claim('aud') !== CLIENT || claim('token_use') !== 'id'
      || !UUID.test(subject) || !tokenEmail || claim('email_verified') !== 'true'
      || claim('custom:synthetic_attested') !== 'true'
      || claim('custom:production_bound') === 'true'
      || claim('custom:person_id') || claim('custom:organization_id')) {
      return reply(403, { error: 'workforce_applicant_refused' });
    }
    let current: WorkforceApplicant | null;
    try { current = await input.currentApplicant(subject); }
    catch { return reply(503, { error: 'identity_unavailable' }); }
    if (!current || current.subject !== subject || !current.enabled
      || !current.emailVerified || normalizeEmail(current.email) !== tokenEmail
      || !Array.isArray(current.mfaMethods)
      || !current.mfaMethods.some(method => method === 'SOFTWARE_TOKEN_MFA'
        || method === 'SMS_MFA' || method === 'EMAIL_OTP')) {
      return reply(403, { error: 'workforce_applicant_refused' });
    }
    try {
      if (event.routeKey === 'GET /clinical-core/workforce/applications') {
        if (event.body || Object.keys(event.queryStringParameters ?? {}).length) return invalid();
        return reply(200, { data: await input.store.list(subject) });
      }
      const body = parseBody(event);
      if (event.routeKey === 'POST /clinical-core/workforce/applications/withdraw') {
        if (!exactKeys(body,['requestId']) || !UUID.test(body.requestId as string)) return invalid();
        await input.store.withdraw(body.requestId as string,subject);
        return reply(200, { data: { withdrawn: true } });
      }
      if (body.kind === 'join') {
        if (!exactKeys(body,['requestId','kind','organizationId'])
          || !UUID.test(body.requestId as string) || !UUID.test(body.organizationId as string)) return invalid();
        const id = await input.store.submit({ requestId: body.requestId as string,subject,
          emailSha256: sha256(tokenEmail),kind: 'join',organizationId: body.organizationId as string,
          proposedLabel: null });
        return reply(202, { data: { requestId: id, status: 'pending' } });
      }
      if (body.kind === 'create_clinic') {
        if (!exactKeys(body,['requestId','kind','proposedLabel'])
          || !UUID.test(body.requestId as string) || typeof body.proposedLabel !== 'string'
          || body.proposedLabel.trim().length < 3 || body.proposedLabel.trim().length > 120
          || /[\u0000-\u001f\u007f]/.test(body.proposedLabel)) return invalid();
        const id = await input.store.submit({ requestId: body.requestId as string,subject,
          emailSha256: sha256(tokenEmail),kind: 'create_clinic',organizationId: null,
          proposedLabel: body.proposedLabel.trim() });
        return reply(202, { data: { requestId: id, status: 'pending' } });
      }
      return invalid();
    } catch (error) {
      if (error instanceof InvalidBody) return invalid();
      // Neither SQL text nor clinic-existence details reach an applicant.
      return reply(503, { error: 'workforce_application_unavailable' });
    }
  };
}

class InvalidBody extends Error {}
function parseBody(event: ApiGatewayV2Event): Record<string, unknown> {
  const header = (name: string) => Object.entries(event.headers ?? {})
    .find(([key]) => key.toLowerCase() === name)?.[1];
  if (event.isBase64Encoded || header('content-encoding')
    || !/^application\/json(?:\s*;|$)/i.test(header('content-type') ?? '')
    || typeof event.body !== 'string') throw new InvalidBody();
  if (event.body.length > MAX_BODY_BYTES) throw new InvalidBody();
  const bytes = Buffer.from(event.body,'utf8');
  if (bytes.length < 2 || bytes.length > MAX_BODY_BYTES) throw new InvalidBody();
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidBody();
    return value as Record<string, unknown>;
  } catch { throw new InvalidBody(); }
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}
function normalizeEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  return email.length <= 320 && EMAIL.test(email) ? email : null;
}
function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function invalid(): ApiGatewayV2Response { return reply(400, { error: 'request_invalid' }); }
function reply(statusCode: number,payload: Record<string, unknown>): ApiGatewayV2Response {
  return { statusCode,headers: { 'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store','x-content-type-options': 'nosniff' },body: JSON.stringify(payload) };
}
