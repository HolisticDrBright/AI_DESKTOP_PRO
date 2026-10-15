if (typeof window !== 'undefined') {
  throw new Error('clinical-core/aws-workforce-applications-api is server-only.');
}

import { createHash } from 'node:crypto';
import type { ApiGatewayV2Event, ApiGatewayV2Response } from './aws-identity-api';
import type { ClinicalCoreDatabase } from './database';
import { normalizeApplicationRows } from '../../contracts/workforceApplication';
import { abuseKey, INACTIVE_ABUSE_BOUNDARY, type AbuseSurface, type PublicAbuseBoundary } from '../public-abuse-boundary';

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
  /** The shared abuse boundary (src/server/public-abuse-boundary.ts). Inactive unless a reviewed service is supplied. */
  abuse?: PublicAbuseBoundary;
}) {
  const abuse = input.abuse ?? INACTIVE_ABUSE_BOUNDARY;
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
    const surface: AbuseSurface = event.routeKey === 'GET /clinical-core/workforce/applications' ? 'workforce_application_status'
      : event.routeKey === 'POST /clinical-core/workforce/applications/withdraw' ? 'workforce_application_withdraw' : 'workforce_application_submit';
    const sourceIp = (event.requestContext as { http?: { sourceIp?: unknown } } | undefined)?.http?.sourceIp;
    const admitted = await abuse.decide(surface, { subject: abuseKey('subject', subject),
      ...(typeof sourceIp === 'string' && sourceIp ? { client: abuseKey('client', sourceIp) } : {}) });
    if (admitted === 'limited') return reply(429, { error: 'workforce_application_rate_limited' });
    if (admitted !== 'admitted') return reply(503, { error: 'workforce_application_unavailable' });
    let current: WorkforceApplicant | null;
    try { current = await input.currentApplicant(subject); }
    catch { return reply(503, { error: 'identity_unavailable' }); }
    // A changed or disabled account is refused without saying which: that is about the account, not its owner's next
    // step. An unverified address and a missing MFA method are the owner's own next step, so they are named.
    if (!current || current.subject !== subject || !current.enabled
      || normalizeEmail(current.email) !== tokenEmail || !Array.isArray(current.mfaMethods)) {
      return reply(403, { error: 'workforce_applicant_refused' });
    }
    if (!current.emailVerified) return reply(403, { error: 'workforce_applicant_email_unverified' });
    if (!current.mfaMethods.some(method => method === 'SOFTWARE_TOKEN_MFA'
        || method === 'SMS_MFA' || method === 'EMAIL_OTP')) {
      return reply(403, { error: 'workforce_applicant_mfa_required' });
    }
    try {
      if (event.routeKey === 'GET /clinical-core/workforce/applications') {
        if (event.body || Object.keys(event.queryStringParameters ?? {}).length) return invalid();
        return reply(200, { data: normalizeApplicationRows(await input.store.list(subject)) });
      }
      const body = parseBody(event);
      // The body is validated in full before anything is read. Then the applicant's own requests are read, so a retry,
      // a second request and a decided one each get their own answer; the database still decides each write under its
      // subject lock, and a change between the read and the write answers 503 rather than a guess.
      if (event.routeKey === 'POST /clinical-core/workforce/applications/withdraw') {
        if (!exactKeys(body,['requestId']) || !UUID.test(body.requestId as string)) return invalid();
        const own = normalizeApplicationRows(await input.store.list(subject));
        const target = own.find(entry => entry.id === (body.requestId as string).toLowerCase());
        if (!target) return reply(404, { error: 'workforce_application_not_found' });
        if (target.status === 'withdrawn') return reply(200, { data: { withdrawn: true, duplicate: true } });
        if (target.status !== 'pending') return reply(409, { error: 'workforce_application_already_decided' });
        await input.store.withdraw(body.requestId as string,subject);
        return reply(200, { data: { withdrawn: true, duplicate: false } });
      }
      let submission: Parameters<WorkforceApplicationStore['submit']>[0];
      if (body.kind === 'join') {
        if (!exactKeys(body,['requestId','kind','organizationId'])
          || !UUID.test(body.requestId as string) || !UUID.test(body.organizationId as string)) return invalid();
        submission = { requestId: body.requestId as string,subject,emailSha256: sha256(tokenEmail),kind: 'join',
          organizationId: body.organizationId as string,proposedLabel: null };
      } else if (body.kind === 'create_clinic') {
        if (!exactKeys(body,['requestId','kind','proposedLabel'])
          || !UUID.test(body.requestId as string) || typeof body.proposedLabel !== 'string'
          || body.proposedLabel.trim().length < 3 || body.proposedLabel.trim().length > 120
          || /[\u0000-\u001f\u007f]/.test(body.proposedLabel)) return invalid();
        submission = { requestId: body.requestId as string,subject,emailSha256: sha256(tokenEmail),kind: 'create_clinic',
          organizationId: null,proposedLabel: body.proposedLabel.trim() };
      } else return invalid();
      const pending = normalizeApplicationRows(await input.store.list(subject)).find(entry => entry.status === 'pending');
      // A lost reply is retried with the same request id and converges on the same request; another id is a second one.
      if (pending && pending.id !== submission.requestId.toLowerCase()) {
        return reply(409, { error: 'workforce_application_already_pending', requestId: pending.id });
      }
      const id = await input.store.submit(submission);
      return reply(202, { data: { requestId: id, status: 'pending' } });
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
