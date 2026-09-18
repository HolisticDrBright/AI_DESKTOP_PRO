import { describe, expect, it, vi } from 'vitest';
import { deterministicUuid, publicPublication, publicationEnvelope, publishLabResult, resultDigest, type PublishableLabJob } from './owned-lab-publication';
import { OwnedStorageError } from './owned-consumer-records';
import { validateOwnedPayload, ownedPayloadLimit } from './owned-lab-observations';
import type { LabAuthorization } from './owned-lab-authorization';

const uuid = '11111111-1111-4111-8111-111111111111';
const jobId = '22222222-2222-4222-8222-222222222222';
const now = () => Date.parse('2026-09-18T12:00:00Z');
const authorization: LabAuthorization = { version: 'owned-lab/1', personId: uuid, organizationId: uuid, identitySubject: 'owned-consumer-a',
  consents: { ai_context: { revision: 3, releaseVersion: 'r/1', contentSha256: 'a'.repeat(64) }, lab_history: { revision: 5, releaseVersion: 'r/1', contentSha256: 'a'.repeat(64) } } };
const result = { analysisId: uuid, reviewState: 'consumer_education', summary: 'Fictional summary', biomarkers: [{ canonicalName: 'Ferritin', value: 12 }] };
const job = (patch: Partial<PublishableLabJob> = {}): PublishableLabJob => ({ pk: `job#${jobId}`, ownerSub: 'owned-consumer-a', organizationId: uuid, personId: uuid, state: 'completed', authorization, result, updatedAt: '2026-09-18T11:59:00.000Z', ...patch });
function adapter(behaviour: { write?: (input: Record<string, unknown>) => Promise<unknown>; get?: () => Promise<unknown> } = {}) {
  const write = vi.fn(async (_c: unknown, input: Record<string, unknown>) => behaviour.write ? behaviour.write(input) : { recordId: input.recordId, revision: 1, duplicate: false, receivedAt: '2026-09-18T12:00:00.000Z' });
  const get = vi.fn(async () => behaviour.get ? behaviour.get() : null);
  return { write, get, factory: () => ({ write, get }) as never };
}

describe('durable lab result publication', () => {
  it('derives a stable envelope and request identity from the job and result, valid for owned storage', async () => {
    const envelope = publicationEnvelope(job(), now)!;
    expect(envelope).toMatchObject({ version: 'personal-lab-analysis/1', jobId, kind: 'documents', completedAt: '2026-09-18T11:59:00.000Z', sourceStatus: 'consumer_lab_analysis_unreviewed', resultSha256: resultDigest(result) });
    expect(envelope.id).toBe(deterministicUuid(`personal-lab-analysis:${jobId}`));
    expect(envelope.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(publicationEnvelope(job({ sourcePanel: { panelId: uuid } }), now)!.kind).toBe('saved');
    expect(() => validateOwnedPayload('lab_analyses', envelope as unknown as Record<string, unknown>)).not.toThrow();
    expect(() => validateOwnedPayload('lab_analyses', { ...envelope, resultSha256: 'b'.repeat(64) } as unknown as Record<string, unknown>)).toThrow('owned_lab_analysis_invalid');
    expect(() => validateOwnedPayload('lab_analyses', { ...envelope, extra: 1 } as unknown as Record<string, unknown>)).toThrow('owned_lab_analysis_invalid');
    expect(ownedPayloadLimit('lab_analyses')).toBe(262_144); expect(ownedPayloadLimit('lab_observations')).toBe(16_384);
  });
  it('publishes once under the bound lab_history consent revision with a deterministic request id', async () => {
    const a = adapter();
    const first = await publishLabResult({ job: job(), adapter: a.factory, now });
    expect(first).toMatchObject({ status: 'published', revision: 1, resultSha256: resultDigest(result) });
    const call = a.write.mock.calls[0]!;
    expect(call[0]).toMatchObject({ actorPersonId: uuid, organizationId: uuid, identitySubject: 'owned-consumer-a', purpose: 'clinical_data', identityPool: 'consumer' });
    expect(call[1]).toMatchObject({ collection: 'lab_analyses', expectedRevision: 0, consentRevision: 5, deleted: false, requestId: deterministicUuid(`personal-lab-analysis-publish:${jobId}:${resultDigest(result)}`) });
    const second = await publishLabResult({ job: job(), adapter: a.factory, now });
    expect(a.write.mock.calls[1]![1]).toEqual(call[1]);
    expect(second.status).toBe('published');
  });
  it('treats an existing identical copy as published and a different copy as a conflict', async () => {
    const existing = adapter({ write: async () => { throw new OwnedStorageError('conflict'); }, get: async () => ({ recordId: deterministicUuid(`personal-lab-analysis:${jobId}`), revision: 2, deleted: false, payload: { resultSha256: resultDigest(result) }, receivedAt: 'x' }) });
    expect(await publishLabResult({ job: job(), adapter: existing.factory, now })).toMatchObject({ status: 'published', revision: 2 });
    const different = adapter({ write: async () => { throw new OwnedStorageError('conflict'); }, get: async () => ({ recordId: 'r', revision: 2, deleted: false, payload: { resultSha256: 'c'.repeat(64) }, receivedAt: 'x' }) });
    expect(await publishLabResult({ job: job(), adapter: different.factory, now })).toMatchObject({ status: 'refused', reason: 'record_conflict' });
  });
  it('refuses on withdrawn consent or account closure, stays pending on outages, and never publishes incomplete or unauthorized jobs', async () => {
    for (const [code, reason] of [['consent_required', 'lab_consent_required'], ['owner_required', 'lab_consent_required'], ['account_deletion_write_blocked', 'account_deletion_write_blocked']] as const) {
      const a = adapter({ write: async () => { throw new OwnedStorageError(code); } });
      expect(await publishLabResult({ job: job(), adapter: a.factory, now })).toMatchObject({ status: 'refused', reason });
    }
    const outage = adapter({ write: async () => { throw new Error('network'); } });
    expect(await publishLabResult({ job: job(), adapter: outage.factory, now })).toMatchObject({ status: 'pending', reason: 'storage_unavailable' });
    const untouched = adapter();
    expect(await publishLabResult({ job: job({ state: 'queued' }), adapter: untouched.factory, now })).toMatchObject({ status: 'refused', reason: 'result_missing' });
    expect(await publishLabResult({ job: job({ result: undefined }), adapter: untouched.factory, now })).toMatchObject({ status: 'refused', reason: 'result_missing' });
    expect(await publishLabResult({ job: job({ authorization: undefined }), adapter: untouched.factory, now })).toMatchObject({ status: 'refused', reason: 'authorization_missing' });
    expect(await publishLabResult({ job: job({ ownerSub: 'someone-else' }), adapter: untouched.factory, now })).toMatchObject({ status: 'refused', reason: 'authorization_missing' });
    expect(await publishLabResult({ job: job({ result: { ...result, summary: 'x'.repeat(270_000) } }), adapter: untouched.factory, now })).toMatchObject({ status: 'refused', reason: 'result_too_large' });
    expect(untouched.write).not.toHaveBeenCalled();
  });
  it('projects only the receipt to clients', () => {
    expect(publicPublication({ version: 'lab-publication/1', status: 'published', resultSha256: 'a'.repeat(64), at: '2026-09-18T12:00:00.000Z', recordId: uuid, revision: 1, secret: 'x' })).toEqual({ version: 'lab-publication/1', status: 'published', resultSha256: 'a'.repeat(64), at: '2026-09-18T12:00:00.000Z', recordId: uuid, revision: 1 });
    expect(publicPublication({ version: 'other' })).toBeNull(); expect(publicPublication(null)).toBeNull();
  });
});
