if (typeof window !== 'undefined') throw new Error('workforce-identity-revocation is server-only');
import { AdminDisableUserCommand, AdminUserGlobalSignOutCommand, type CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase } from './database';

/**
 * The emergency revocation of one practitioner's LOGIN (workforce-identity-emergency-revocation/1), for a suspected
 * compromise. Source only and BLOCKED at every layer:
 * - `WORKFORCE_IDENTITY_REVOCATION_RELEASE` is `blocked`, so every call refuses before it reads the database;
 * - the SQL candidate is unregistered, and even applied it refuses until its release row names an approval mode;
 * - the platform-operator console and sign-in hold their own releases, and no operator account exists;
 * - no IAM grant, Lambda or route host exists for the provider calls.
 *
 * Order, and why. The database decides the refusal; the identity provider only stops new tokens:
 *   1. if the membership fence is configured, begin it for the subject (the BLOCKED fence guard refuses an identity
 *      change without its acknowledgement);
 *   2. one operator transaction records the reasoned decision and, when the approval mode lets it take effect,
 *      disables the workforce identity. It holds the identity row FOR UPDATE, so every request already admitted
 *      finishes first and every later request is refused, in every clinic, whatever token it carries;
 *   3. only after that commit, AdminDisableUser and then AdminUserGlobalSignOut on the workforce pool. Each attempt is
 *      recorded by its own idempotency key; a failure stays an actionable pending item and is never a receipt.
 * A provider outage therefore never delays the refusal, and a database refusal never depends on the provider.
 *
 * Nothing here logs, stores or returns a token, a password, an email or a patient datum. The provider username is the
 * workforce subject (an identifier), and provider errors are reduced to a closed code.
 */
export const WORKFORCE_IDENTITY_REVOCATION_RELEASE: 'blocked' | 'qualification' = 'blocked';
export const WORKFORCE_IDENTITY_EMERGENCY_REVOCATION_SHA256 = '8d059be1483e9ff5337fd7799b28208901088cab4bc940a1de1d03bc50db9d88';
export const WORKFORCE_IDENTITY_EMERGENCY_REVOCATION_ROLLBACK_SHA256 = 'cf4c40020aeaf746cfa155ad633bf87cbd7b823e360b5bd2cb56fad4d13804a4';
export const WORKFORCE_IDENTITY_EMERGENCY_REVOCATION_SUCCESSOR_PROSRC_SHA256 = '3ee98d29830ee366a1c670c236cbf018b710eb7dbbc48d3ee090e7d66c36097b';

export const REVOCATION_REASONS = ['suspected_compromise', 'credential_exposed', 'device_lost_or_stolen', 'practitioner_request', 'security_review'] as const;
export const REVOCATION_DECISIONS = ['approve', 'decline', 'confirm', 'dispute'] as const;
export const PROVIDER_STEPS = ['disable_user', 'global_sign_out'] as const;
export const PROVIDER_FAILURES = ['not_found', 'throttled', 'unavailable', 'access_denied', 'timeout', 'unknown'] as const;
export type ProviderStep = typeof PROVIDER_STEPS[number];
export type ProviderFailure = typeof PROVIDER_FAILURES[number];

const OPERATOR = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const USERNAME = /^[A-Za-z0-9:_-]{8,128}$/;
const POOL = /^[a-z]{2}-[a-z]+-\d_[A-Za-z0-9]{1,55}$/;

export const revocationRequest = z.object({
  requestId: z.string().uuid(),
  identitySubject: z.string().regex(USERNAME),
  reason: z.enum(REVOCATION_REASONS),
}).strict();
export const revocationDecisionRequest = z.object({
  proposalId: z.string().uuid(),
  decision: z.enum(REVOCATION_DECISIONS),
}).strict();
export const revocationSummary = z.object({
  proposalId: z.string().uuid(),
  requestId: z.string().uuid(),
  reason: z.enum(REVOCATION_REASONS),
  approvalMode: z.enum(['second_operator_before', 'independent_review_after']),
  proposedAt: z.string(),
  state: z.enum(['awaiting_approval', 'declined', 'revoked']),
  review: z.enum(['awaiting_independent_approval', 'awaiting_independent_review', 'approved', 'declined', 'confirmed', 'disputed']),
  revocationId: z.string().uuid().nullable(),
  effect: z.enum(['disabled', 'already_disabled']).nullable(),
  revokedAt: z.string().nullable(),
  provider: z.enum(['not_started', 'pending', 'failed', 'complete']),
  duplicate: z.boolean().optional(),
  providerUsername: z.string().regex(USERNAME).nullable().optional(),
}).strict();
export type RevocationSummary = z.infer<typeof revocationSummary>;

export class WorkforceProviderFailure extends Error {
  constructor(readonly code: ProviderFailure) { super(code); this.name = 'WorkforceProviderFailure'; }
}
/** The workforce identity provider, one step at a time. A step that cannot be confirmed throws WorkforceProviderFailure. */
export interface WorkforceIdentityProvider { revoke(step: ProviderStep, username: string): Promise<void> }

/** The Cognito adapter, scoped to the ONE workforce pool it was built for: the pool never comes from a caller. It refuses
 * to be built for a pool it is told belongs to someone else (the operator pool, the consumer pool). Both calls are
 * idempotent at Cognito, so a retry after a lost answer is safe. */
export function createCognitoWorkforceIdentityProvider(input: {
  client: Pick<CognitoIdentityProviderClient, 'send'>; workforcePoolId: string; otherPoolIds: readonly string[];
}): WorkforceIdentityProvider {
  if (!POOL.test(input.workforcePoolId) || input.otherPoolIds.some(pool => pool === input.workforcePoolId)) {
    throw new Error('workforce_identity_provider_configuration_invalid');
  }
  const send = (command: unknown) => (input.client.send as (c: unknown, o?: unknown) => Promise<unknown>)(command, { abortSignal: AbortSignal.timeout(8000) });
  return {
    async revoke(step, username) {
      if (!USERNAME.test(username)) throw new WorkforceProviderFailure('unknown');
      const command = step === 'disable_user'
        ? new AdminDisableUserCommand({ UserPoolId: input.workforcePoolId, Username: username })
        : new AdminUserGlobalSignOutCommand({ UserPoolId: input.workforcePoolId, Username: username });
      try { await send(command); } catch (error) { throw new WorkforceProviderFailure(providerFailure(error)); }
    },
  };
}
/** A provider error, reduced to a closed code. The message is never read. */
export function providerFailure(error: unknown): ProviderFailure {
  const name = String((error as { name?: unknown })?.name ?? '');
  if (name === 'UserNotFoundException' || name === 'ResourceNotFoundException') return 'not_found';
  if (name === 'TooManyRequestsException' || name === 'LimitExceededException' || name === 'ThrottlingException') return 'throttled';
  if (name === 'NotAuthorizedException' || name === 'AccessDeniedException' || name === 'UnrecognizedClientException') return 'access_denied';
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  if (name === 'InternalErrorException' || name === 'ServiceUnavailableException') return 'unavailable';
  return 'unknown';
}

/** The membership fence (membership-fence/1) for one subject: begun before the identity change, settled after it. */
export interface RevocationFence {
  begin(subject: string): Promise<{ acknowledgement: string; settle(): Promise<void> }>;
}

export type RevocationRefusal = 'not_released' | 'operator_refused' | 'request_invalid' | 'not_found' | 'conflict' | 'self_approval_refused'
  | 'independent_operator_required' | 'fence_required' | 'service_unavailable';
export class WorkforceIdentityRevocationError extends Error {
  constructor(readonly code: RevocationRefusal) { super(code); this.name = 'WorkforceIdentityRevocationError'; }
}
const REFUSAL_BY_REASON: Readonly<Record<string, RevocationRefusal>> = {
  workforce_identity_revocation_not_released: 'not_released', workforce_operator_refused: 'operator_refused',
  workforce_identity_revocation_invalid: 'request_invalid', workforce_identity_not_found: 'not_found',
  workforce_identity_revocation_not_found: 'not_found', workforce_identity_revocation_conflict: 'conflict',
  workforce_self_approval_refused: 'self_approval_refused', workforce_independent_operator_required: 'independent_operator_required',
  membership_fence_required: 'fence_required',
};
function refusal(error: unknown): WorkforceIdentityRevocationError {
  if (error instanceof WorkforceIdentityRevocationError) return error;
  if (error instanceof ClinicalCoreDatabaseRejection) {
    const named = error.reason ? REFUSAL_BY_REASON[error.reason] : undefined;
    if (named) return new WorkforceIdentityRevocationError(named);
  }
  return new WorkforceIdentityRevocationError('service_unavailable');
}
const parse = (value: unknown) => { if (typeof value !== 'string') return value; try { return JSON.parse(value); } catch { return null; } };

export type RevocationOutcome = { summary: RevocationSummary; provider: Array<{ step: ProviderStep; outcome: 'succeeded' | 'failed'; failure?: ProviderFailure }> };

export function createWorkforceIdentityRevocation(input: {
  /** The operator connection (`clinical_workforce_operator`). */
  database: ClinicalCoreDatabase;
  provider: WorkforceIdentityProvider;
  /** Present exactly when the membership fence is in force for this deployment. */
  fence?: RevocationFence;
  release?: 'blocked' | 'qualification';
  newId?: () => string;
}) {
  const release = input.release ?? WORKFORCE_IDENTITY_REVOCATION_RELEASE;
  const newId = input.newId ?? randomUUID;
  const held = (operator: string) => {
    if (release !== 'qualification') throw new WorkforceIdentityRevocationError('not_released');
    if (!OPERATOR.test(operator)) throw new WorkforceIdentityRevocationError('operator_refused');
  };
  const call = async (sql: string, parameters: unknown[], acknowledgement?: string) => {
    try {
      return await input.database.transaction(async tx => {
        if (acknowledgement) await tx.query("select set_config('clinical.membership_fence_ack',$1,true)", [acknowledgement]);
        const { rows } = await tx.query<{ r: unknown }>(sql, parameters);
        return revocationSummary.parse(parse(rows[0]?.r));
      });
    } catch (error) { throw refusal(error); }
  };
  /** Both provider steps, each recorded by its own key. Recording after a provider success may itself fail: the item then
   * stays pending in the work list, and the retry is idempotent at the provider. */
  const signOut = async (operator: string, revocationId: string, username: string, before: RevocationSummary): Promise<RevocationOutcome> => {
    const attempts: RevocationOutcome['provider'] = [];
    let summary = before;
    for (const step of PROVIDER_STEPS) {
      let failure: ProviderFailure | undefined;
      try { await input.provider.revoke(step, username); } catch (error) {
        failure = error instanceof WorkforceProviderFailure ? error.code : 'unknown';
      }
      attempts.push(failure ? { step, outcome: 'failed', failure } : { step, outcome: 'succeeded' });
      try {
        const recorded = await call('select clinical_private.record_workforce_identity_provider_action($1,$2,$3,$4,$5,$6) as r',
          [operator, newId(), revocationId, step, failure ? 'failed' : 'succeeded', failure ?? null]);
        const { duplicate: _duplicate, ...current } = recorded;
        summary = { ...current, ...(before.duplicate === undefined ? {} : { duplicate: before.duplicate }) };
      } catch { /* left pending: the work list shows it until a later attempt is recorded */ }
    }
    return { summary, provider: attempts };
  };
  const fenced = async <T>(subject: string, work: (acknowledgement?: string) => Promise<T>): Promise<T> => {
    if (!input.fence) return work();
    let begun: Awaited<ReturnType<RevocationFence['begin']>>;
    try { begun = await input.fence.begin(subject); } catch { throw new WorkforceIdentityRevocationError('service_unavailable'); }
    // Settled whether or not the change committed: a refused change leaves nothing for the fence to hold.
    try { return await work(begun.acknowledgement); } finally { await begun.settle().catch(() => undefined); }
  };
  const current = async (operator: string, proposalId: string) => {
    const work = await list(operator);
    return work.find(item => item.proposalId === proposalId);
  };
  async function list(operator: string): Promise<RevocationSummary[]> {
    held(operator);
    try {
      return await input.database.transaction(async tx => {
        const { rows } = await tx.query<{ r: unknown }>('select clinical_private.list_workforce_identity_revocation_work($1) as r', [operator]);
        return z.array(revocationSummary).max(200).parse(parse(rows[0]?.r));
      });
    } catch (error) { throw refusal(error); }
  }

  return {
    /** Record the decision; disable the login when the approval mode lets it take effect; then the provider steps. */
    async propose(operator: string, body: unknown): Promise<RevocationOutcome> {
      held(operator);
      const request = revocationRequest.safeParse(body);
      if (!request.success) throw new WorkforceIdentityRevocationError('request_invalid');
      const { requestId, identitySubject, reason } = request.data;
      const summary = await fenced(identitySubject, acknowledgement => call(
        'select clinical_private.propose_workforce_identity_revocation($1,$2,$3,$4) as r', [operator, requestId, identitySubject, reason], acknowledgement));
      if (summary.state !== 'revoked' || !summary.revocationId || summary.provider === 'complete') return { summary, provider: [] };
      return signOut(operator, summary.revocationId, identitySubject, summary);
    },
    /** The independent operator's approval, decline, confirmation or dispute. A dispute never restores the login. */
    async decide(operator: string, body: unknown): Promise<RevocationOutcome> {
      held(operator);
      const request = revocationDecisionRequest.safeParse(body);
      if (!request.success) throw new WorkforceIdentityRevocationError('request_invalid');
      const pending = request.data.decision === 'approve' ? await current(operator, request.data.proposalId) : undefined;
      const run = (acknowledgement?: string) => call('select clinical_private.decide_workforce_identity_revocation($1,$2,$3) as r',
        [operator, request.data.proposalId, request.data.decision], acknowledgement);
      // An approval disables the identity, so it is fenced like the proposal; the subject comes from the work list.
      const subject = pending?.providerUsername ?? null;
      const summary = request.data.decision === 'approve' && subject ? await fenced(subject, run) : await run();
      if (summary.state !== 'revoked' || !summary.revocationId || summary.provider === 'complete') return { summary, provider: [] };
      const username = subject ?? (await current(operator, summary.proposalId))?.providerUsername;
      if (!username) return { summary, provider: [] };
      return signOut(operator, summary.revocationId, username, summary);
    },
    /** Retry the provider side of every revocation that is not complete. Nothing is deleted; a failure stays pending. */
    async reconcile(operator: string): Promise<Array<RevocationOutcome & { proposalId: string }>> {
      const work = await list(operator);
      const results: Array<RevocationOutcome & { proposalId: string }> = [];
      for (const item of work) {
        if (item.state !== 'revoked' || !item.revocationId || !item.providerUsername || item.provider === 'complete') continue;
        results.push({ proposalId: item.proposalId, ...await signOut(operator, item.revocationId, item.providerUsername, item) });
      }
      return results;
    },
    list,
  };
}
