import { createHash } from 'node:crypto';
import { canonicalJson } from './aws-consumer-clinical-records';
import { OwnedStorageError, type createOwnedConsumerRecordsAdapter } from './owned-consumer-records';
import type { ProductionClinicalRequestContext } from './aws-identity-consent';
import type { LabAuthorization } from './owned-lab-authorization';
import { PERSONAL_LAB_ANALYSIS_MAX_BYTES, PERSONAL_LAB_ANALYSIS_VERSION, type PersonalLabAnalysisEnvelope } from '@/contracts/personalLabAnalysis';

/** Durable cloud publication of a completed lab result.
 *
 * Writes one owner-scoped `lab_analyses` record per completed job into
 * personal storage. The record and request identities derive from the job and
 * result hash, so a retried publication after a lost response replays the same
 * command instead of creating a second copy. Consent withdrawal or account
 * closure refuse; storage outages stay pending for a later retry. Publication
 * never changes the job's result, delivery claim or plan state. */
export const LAB_PUBLICATION_VERSION = 'lab-publication/1';
export type LabPublication = {
  version: typeof LAB_PUBLICATION_VERSION;
  status: 'published' | 'pending' | 'refused';
  resultSha256: string;
  at: string;
  recordId?: string;
  revision?: number;
  reason?: 'lab_consent_required' | 'account_deletion_write_blocked' | 'storage_unavailable' | 'result_too_large' | 'result_missing' | 'authorization_missing' | 'record_conflict';
};
export type PublishableLabJob = {
  pk: string; ownerSub: string; organizationId: string; personId: string; state: string;
  authorization?: LabAuthorization; result?: unknown; sourcePanel?: unknown; updatedAt?: string;
};
type Adapter = Pick<ReturnType<typeof createOwnedConsumerRecordsAdapter>, 'write' | 'get'>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** RFC 4122 shaped identifier derived from a stable name; never random. */
export function deterministicUuid(name: string): string {
  const hex = createHash('sha256').update(name).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export const resultDigest = (result: Record<string, unknown>) => createHash('sha256').update(canonicalJson(result)).digest('hex');

export function publicationEnvelope(job: PublishableLabJob, now: () => number): PersonalLabAnalysisEnvelope | null {
  if (!job.result || typeof job.result !== 'object' || Array.isArray(job.result)) return null;
  const jobId = job.pk.slice(4).toLowerCase();
  if (!UUID.test(jobId)) return null;
  const result = job.result as Record<string, unknown>;
  const completedAt = typeof job.updatedAt === 'string' && Number.isFinite(Date.parse(job.updatedAt)) && Date.parse(job.updatedAt) <= now() ? new Date(job.updatedAt).toISOString() : new Date(now()).toISOString();
  return { id: deterministicUuid(`personal-lab-analysis:${jobId}`), version: PERSONAL_LAB_ANALYSIS_VERSION, jobId, kind: job.sourcePanel ? 'saved' : 'documents',
    completedAt, resultSha256: resultDigest(result), sourceStatus: 'consumer_lab_analysis_unreviewed', result };
}

export async function publishLabResult(input: { job: PublishableLabJob; adapter: () => Adapter; now?: () => number }): Promise<LabPublication> {
  const now = input.now ?? (() => Date.now());
  const at = new Date(now()).toISOString();
  const a = input.job.authorization;
  const envelope = publicationEnvelope(input.job, now);
  if (!envelope || input.job.state !== 'completed') return { version: LAB_PUBLICATION_VERSION, status: 'refused', resultSha256: envelope?.resultSha256 ?? '0'.repeat(64), at, reason: 'result_missing' };
  const base = { version: LAB_PUBLICATION_VERSION as typeof LAB_PUBLICATION_VERSION, resultSha256: envelope.resultSha256, at };
  if (!a || a.version !== 'owned-lab/1' || a.personId !== input.job.personId || a.organizationId !== input.job.organizationId || a.identitySubject !== input.job.ownerSub
    || !Number.isSafeInteger(a.consents?.lab_history?.revision)) return { ...base, status: 'refused', reason: 'authorization_missing' };
  if (Buffer.byteLength(canonicalJson(envelope), 'utf8') > PERSONAL_LAB_ANALYSIS_MAX_BYTES) return { ...base, status: 'refused', reason: 'result_too_large' };
  const context: ProductionClinicalRequestContext = { actorPersonId: a.personId, organizationId: a.organizationId, identitySubject: a.identitySubject, identityPool: 'consumer',
    purpose: 'clinical_data', environment: 'production-clinical', dataClassification: 'clinical_phi', containsPhi: true, realPatientData: true, productionBound: true };
  const requestId = deterministicUuid(`personal-lab-analysis-publish:${envelope.jobId}:${envelope.resultSha256}`);
  try {
    const saved = await input.adapter().write(context, { collection: 'lab_analyses', recordId: envelope.id, requestId, expectedRevision: 0,
      consentRevision: a.consents.lab_history.revision, deleted: false, payload: envelope as unknown as Record<string, unknown> });
    return { ...base, status: 'published', recordId: saved.recordId, revision: saved.revision };
  } catch (error) {
    if (error instanceof OwnedStorageError) {
      if (error.code === 'conflict') {
        // A prior publication exists (revision > 0 or a different command with the same
        // request id). The stored copy is authoritative only if it carries this result.
        try {
          const current = await input.adapter().get(context, { collection: 'lab_analyses', recordId: envelope.id });
          if (current && !current.deleted && current.payload.resultSha256 === envelope.resultSha256) return { ...base, status: 'published', recordId: current.recordId, revision: current.revision };
        } catch { /* fall through to conflict */ }
        return { ...base, status: 'refused', reason: 'record_conflict' };
      }
      if (error.code === 'consent_required' || error.code === 'owner_required') return { ...base, status: 'refused', reason: 'lab_consent_required' };
      if (error.code === 'account_deletion_write_blocked') return { ...base, status: 'refused', reason: 'account_deletion_write_blocked' };
    }
    return { ...base, status: 'pending', reason: 'storage_unavailable' };
  }
}

/** Outcome of removing the personal-storage copy when its job is deleted.
 * `retracted` means a tombstone revision now supersedes the copy; `retained`
 * means the copy stays because the owner's consent or account state refuses a
 * new revision (it remains reachable through personal storage or a privacy
 * request); `not_published` means no live copy exists. A storage outage throws
 * so the caller can refuse the deletion instead of orphaning the copy. */
export type LabRetraction = {
  version: typeof LAB_PUBLICATION_VERSION;
  status: 'retracted' | 'retained' | 'not_published';
  at: string;
  recordId?: string;
  revision?: number;
  reason?: 'lab_consent_required' | 'account_deletion_write_blocked' | 'authorization_missing' | 'record_conflict';
};
export async function retractLabPublication(input: { job: PublishableLabJob & { publication?: unknown }; adapter: () => Adapter; now?: () => number }): Promise<LabRetraction> {
  const now = input.now ?? (() => Date.now());
  const at = new Date(now()).toISOString();
  const base = { version: LAB_PUBLICATION_VERSION as typeof LAB_PUBLICATION_VERSION, at };
  const jobId = input.job.pk.slice(4).toLowerCase();
  if (!UUID.test(jobId)) return { ...base, status: 'not_published' };
  const a = input.job.authorization;
  if (!a || a.version !== 'owned-lab/1' || a.personId !== input.job.personId || a.organizationId !== input.job.organizationId || a.identitySubject !== input.job.ownerSub
    || !Number.isSafeInteger(a.consents?.lab_history?.revision)) {
    // Without a consent binding no revision can be written. A never-published job has nothing to retract.
    return publicPublication(input.job.publication)?.status === 'published' ? { ...base, status: 'retained', reason: 'authorization_missing' } : { ...base, status: 'not_published' };
  }
  const context: ProductionClinicalRequestContext = { actorPersonId: a.personId, organizationId: a.organizationId, identitySubject: a.identitySubject, identityPool: 'consumer',
    purpose: 'clinical_data', environment: 'production-clinical', dataClassification: 'clinical_phi', containsPhi: true, realPatientData: true, productionBound: true };
  const recordId = deterministicUuid(`personal-lab-analysis:${jobId}`);
  // The store, not the receipt, decides: a pending receipt may hide a copy the
  // server wrote before its response was lost.
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await input.adapter().get(context, { collection: 'lab_analyses', recordId });
    if (!current) return { ...base, status: 'not_published' };
    if (current.deleted) return { ...base, status: 'retracted', recordId, revision: current.revision };
    try {
      const saved = await input.adapter().write(context, { collection: 'lab_analyses', recordId, requestId: deterministicUuid(`personal-lab-analysis-retract:${jobId}:${current.revision}`),
        expectedRevision: current.revision, consentRevision: a.consents.lab_history.revision, deleted: true, payload: {} });
      return { ...base, status: 'retracted', recordId, revision: saved.revision };
    } catch (error) {
      if (error instanceof OwnedStorageError) {
        if (error.code === 'conflict') continue;
        if (error.code === 'consent_required' || error.code === 'owner_required') return { ...base, status: 'retained', recordId, revision: current.revision, reason: 'lab_consent_required' };
        if (error.code === 'account_deletion_write_blocked') return { ...base, status: 'retained', recordId, revision: current.revision, reason: 'account_deletion_write_blocked' };
      }
      throw new OwnedStorageError('storage_unavailable');
    }
  }
  return { ...base, status: 'retained', recordId, reason: 'record_conflict' };
}

/** Client-facing projection: never the stored result, only the receipt. */
export function publicPublication(value: unknown): LabPublication | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const p = value as Record<string, unknown>;
  if (p.version !== LAB_PUBLICATION_VERSION || !['published', 'pending', 'refused'].includes(String(p.status)) || !/^[a-f0-9]{64}$/.test(String(p.resultSha256)) || typeof p.at !== 'string') return null;
  return { version: LAB_PUBLICATION_VERSION, status: p.status as LabPublication['status'], resultSha256: String(p.resultSha256), at: p.at,
    ...(typeof p.recordId === 'string' ? { recordId: p.recordId } : {}), ...(typeof p.revision === 'number' ? { revision: p.revision } : {}), ...(typeof p.reason === 'string' ? { reason: p.reason as LabPublication['reason'] } : {}) };
}
