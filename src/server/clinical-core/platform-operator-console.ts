if (typeof window !== 'undefined') throw new Error('platform-operator-console is server-only');
import { z } from 'zod';
import type { ApiGatewayV2Event, ApiGatewayV2Response } from './aws-identity-api';
import { ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase } from './database';
import { PlatformOperatorSignInError } from './platform-operator-authenticator';
import { ClinicProposalReviewError, createClinicProposalReview } from './workforce-clinic-proposal-review';
import { ClinicBootstrapSuspensionError, createClinicBootstrapSuspension } from './workforce-clinic-bootstrap';
import { WorkforceIdentityRevocationError, type createWorkforceIdentityRevocation } from './workforce-identity-revocation';
import { bootstrappedClinic, bootstrappedClinicSuspensionRequest, identityRevocationDecisionRequest, identityRevocationRequest,
  operatorProposalDecisionRequest, type BootstrappedClinic, type PlatformOperatorRefusal } from '../../contracts/platformOperatorConsole';

/**
 * The platform operator's console API (platform-operator-console/1): proposal review, the bootstrapped-clinic list and
 * suspension, for the platform operator only. Source only and BLOCKED at every layer:
 * - `PLATFORM_OPERATOR_CONSOLE_RELEASE` is `blocked`, so every route refuses before it reads a header;
 * - the operator sign-in (platform-operator-authenticator.ts) holds its own release, and no operator pool exists;
 * - proposal review and suspension each hold their own release (WORKFORCE_CLINIC_PROPOSAL_REVIEW_RELEASE,
 *   WORKFORCE_CLINIC_BOOTSTRAP_RELEASE), and the listing SQL candidate is unregistered;
 * - no Lambda entrypoint, route host or operator account exists.
 *
 * The operator is verified once per request, from the `Authorization` header alone, by the separate MFA-protected
 * sign-in: an operator-pool ID token signed within 15 minutes, TOTP preferred, pool MFA on. A workforce or patient
 * token is refused there by issuer and client. No request names a clinic selection, and none is read. The connection
 * must run as `clinical_workforce_operator`; whether the subject is an ACTIVE registered operator is decided inside each
 * SQL function against the registry no API role can write.
 */
export const PLATFORM_OPERATOR_CONSOLE_RELEASE: 'blocked' | 'qualification' = 'blocked';
export const BOOTSTRAP_OPERATOR_LISTING_CANDIDATE_SHA256 = '5a7af23d78387eab099e2c749b87edc52234b61eca8893cc54bf37d38639351b';
export const BOOTSTRAP_OPERATOR_LISTING_ROLLBACK_SHA256 = '65bf4f9406dbad117df779653cdf29c5c01c181a8bfd96cd752356aff407c164';

export const PLATFORM_OPERATOR_ROUTES = [
  'GET /clinical-core/platform-operator/clinic-proposals',
  'POST /clinical-core/platform-operator/clinic-proposals/decision',
  'GET /clinical-core/platform-operator/bootstrapped-clinics',
  'POST /clinical-core/platform-operator/bootstrapped-clinics/suspension',
  'GET /clinical-core/platform-operator/identity-revocations',
  'POST /clinical-core/platform-operator/identity-revocations',
  'POST /clinical-core/platform-operator/identity-revocations/decision',
] as const;
const PROPOSAL_DECISION = 'POST /clinical-core/platform-operator/clinic-proposals/decision';
const REVOCATIONS = '/clinical-core/platform-operator/identity-revocations';
const ROUTES = new Set<string>(PLATFORM_OPERATOR_ROUTES);
const SUBJECT = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const parse = (value: unknown) => { if (typeof value !== 'string') return value; try { return JSON.parse(value); } catch { return null; } };

export class BootstrappedClinicListingError extends Error {
  constructor(readonly code: 'operator_refused' | 'service_unavailable') { super(code); }
}
/** The operator's read of bootstrapped clinics and their recorded decisions (the BLOCKED listing candidate). */
export function createBootstrappedClinicListing(database: ClinicalCoreDatabase) {
  return async (operator: string): Promise<BootstrappedClinic[]> => {
    if (!SUBJECT.test(operator)) throw new BootstrappedClinicListingError('operator_refused');
    try {
      return await database.transaction(async tx => {
        const { rows } = await tx.query<{ data: unknown }>('select clinical_private.list_bootstrapped_workforce_clinics($1) as data', [operator]);
        return z.array(bootstrappedClinic).max(50).parse(parse(rows[0]?.data));
      });
    } catch (error) {
      if (error instanceof ClinicalCoreDatabaseRejection && (error.reason === 'workforce_operator_refused' || error.category === 'identity_refused')) {
        throw new BootstrappedClinicListingError('operator_refused');
      }
      throw new BootstrappedClinicListingError('service_unavailable');
    }
  };
}

const REPLIES: Readonly<Record<string, [number, PlatformOperatorRefusal]>> = {
  not_released: [503, 'platform_operator_not_released'],
  operator_refused: [403, 'platform_operator_refused'],
  request_invalid: [400, 'request_invalid'],
  not_found: [404, 'not_found'],
  conflict: [409, 'conflict'],
  self_approval_refused: [403, 'operator_self_approval_refused'],
  independent_operator_required: [403, 'operator_independent_approval_required'],
  fence_required: [503, 'platform_operator_unavailable'],
  service_unavailable: [503, 'platform_operator_unavailable'],
};
function reply(statusCode: number, payload: Record<string, unknown>): ApiGatewayV2Response {
  return { statusCode, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
    body: JSON.stringify(payload) };
}
const refuse = (code: string) => { const [status, error] = REPLIES[code] ?? REPLIES.service_unavailable!; return reply(status, { error }); };

export function createPlatformOperatorConsoleApi(input: {
  /** The separate operator sign-in (createPlatformOperatorAuthenticator): the operator subject for this header, or a throw. */
  verifiedOperatorSubject: (authorization: string) => Promise<string>;
  /** The operator connection (`clinical_workforce_operator`). */
  database: ClinicalCoreDatabase;
  release?: 'blocked' | 'qualification';
  proposalReviewRelease?: 'blocked' | 'qualification';
  suspensionRelease?: 'blocked' | 'qualification';
  /** The emergency login revocation (workforce-identity-revocation.ts), with its own release, provider and fence. Absent,
   * its routes answer not released. */
  identityRevocation?: Pick<ReturnType<typeof createWorkforceIdentityRevocation>, 'propose' | 'decide' | 'list'>;
}) {
  const release = input.release ?? PLATFORM_OPERATOR_CONSOLE_RELEASE;
  const listing = createBootstrappedClinicListing(input.database);
  return async (event: ApiGatewayV2Event): Promise<ApiGatewayV2Response> => {
    if (release !== 'qualification') return reply(503, { error: 'platform_operator_not_released' });
    const route = event.routeKey ?? '';
    if (!ROUTES.has(route)) return reply(404, { error: 'route_not_found' });
    const headers = Object.fromEntries(Object.entries(event.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
    // An operator acts on the platform, never inside a selected clinic: a selection on the request is refused.
    if (Object.keys(headers).some(key => key === 'x-alp-selected-organization-id') || Object.keys(event.queryStringParameters ?? {}).length) {
      return reply(400, { error: 'request_invalid' });
    }
    const authorization = headers.authorization;
    if (typeof authorization !== 'string' || !authorization) return reply(401, { error: 'operator_sign_in_required' });
    let body: unknown = undefined;
    if (route.startsWith('POST ')) {
      try {
        const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : event.body ?? '';
        if (!raw || Buffer.byteLength(raw) > 1024) throw new Error('invalid');
        body = JSON.parse(raw);
      } catch { return reply(400, { error: 'request_invalid' }); }
    } else if (event.body) return reply(400, { error: 'request_invalid' });
    // Validate the body before anyone is asked about the operator, so a malformed request reads nothing.
    const decision = route === PROPOSAL_DECISION ? operatorProposalDecisionRequest.safeParse(body) : null;
    const suspension = route.endsWith('/suspension') ? bootstrappedClinicSuspensionRequest.safeParse(body) : null;
    const revocation = route === `POST ${REVOCATIONS}` ? identityRevocationRequest.safeParse(body) : null;
    const revocationDecision = route === `POST ${REVOCATIONS}/decision` ? identityRevocationDecisionRequest.safeParse(body) : null;
    if ((decision && !decision.success) || (suspension && !suspension.success) || (revocation && !revocation.success)
      || (revocationDecision && !revocationDecision.success)) return reply(400, { error: 'request_invalid' });

    let operator: string;
    try {
      operator = await input.verifiedOperatorSubject(authorization);
      if (typeof operator !== 'string' || !SUBJECT.test(operator)) throw new PlatformOperatorSignInError('operator_refused');
    } catch (error) {
      if (error instanceof PlatformOperatorSignInError && error.code === 'not_released') return reply(503, { error: 'platform_operator_sign_in_not_released' });
      return reply(403, { error: 'platform_operator_refused' });
    }
    // The services take the subject verified above; they never see the header.
    const verified = async () => operator;
    try {
      if (route.includes(REVOCATIONS)) {
        const revocations = input.identityRevocation;
        if (!revocations) return refuse('not_released');
        if (route === `GET ${REVOCATIONS}`) return reply(200, { data: { revocations: await revocations.list(operator) } });
        if (revocation) return reply(200, { data: await revocations.propose(operator, revocation.data) });
        return reply(200, { data: await revocations.decide(operator, revocationDecision!.data) });
      }
      if (route === 'GET /clinical-core/platform-operator/bootstrapped-clinics') {
        return reply(200, { data: { clinics: await listing(operator) } });
      }
      if (route === 'POST /clinical-core/platform-operator/bootstrapped-clinics/suspension') {
        const suspend = createClinicBootstrapSuspension({ database: input.database, verifiedOperatorSubject: verified, release: input.suspensionRelease });
        return reply(200, { data: await suspend('verified', suspension!.data) });
      }
      const review = createClinicProposalReview({ database: input.database, verifiedOperatorSubject: verified, release: input.proposalReviewRelease });
      if (route === 'GET /clinical-core/platform-operator/clinic-proposals') {
        const answer = await review('verified', { action: 'list' });
        return reply(200, { data: { proposals: answer.action === 'list' ? answer.proposals : [] } });
      }
      return reply(200, { data: await review('verified', decision!.data) });
    } catch (error) {
      if (error instanceof ClinicProposalReviewError || error instanceof ClinicBootstrapSuspensionError || error instanceof BootstrappedClinicListingError
        || error instanceof WorkforceIdentityRevocationError) {
        return refuse(error.code);
      }
      return refuse('service_unavailable');
    }
  };
}
