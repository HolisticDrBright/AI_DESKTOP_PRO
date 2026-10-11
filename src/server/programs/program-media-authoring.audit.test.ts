import { createHash, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ClinicalRequestContext, SyntheticRequestContext } from '@/server/clinical-core/aws-identity-consent';
import type { ProgramMediaStorage } from '@/contracts/programMedia';
import { createProgramMediaAuthoring, ProgramMediaError, type ProgramMediaAuthoring, type ProgramMediaObjectStore } from './program-media-authoring';
import { createFictionalProgramMediaLedger, createFictionalProgramMediaStore } from './program-media-fictional';

/**
 * The four negative reproductions from Codex's independent recheck of e3f39a6, written here from the
 * handoff's descriptions so they stand on their own in this repository. Each one is a fact about the
 * runtime, not about the fictional store: the store is wrapped only to make the race or the no-op
 * observable, never to make it behave better than a real store could.
 *
 *   1. A caller's plausible reference (altered delivery address, altered origin program) must not be
 *      reported as a current publication; only the recorded publication is.
 *   2. A successful delete call is not absence proof; a receipt may say "removed" only once the exact
 *      version is proven absent.
 *   3. Cleanup and reconciliation race: reconciliation commits between cleanup's reads; the committed
 *      object's bytes must survive, in both orders, and the receipt must say what happened.
 *   4. An object written before expiry must stay discoverable after an expired retry: expiry stops new
 *      writes, it does not hide existing bytes.
 */
const KMS = 'arn:aws:kms:us-east-2:588966314750:key/c13ec29d-0e47-4c02-9136-f371bcbb7900';
const storage: ProgramMediaStorage = {
  purpose: 'educational_media', phiAllowed: false, dedicated: true, bucket: 'alp-fictional-program-media', expectedBucketOwner: '588966314750',
  region: 'us-east-2', kmsKeyArn: KMS, maxImageBytes: 1024, maxVideoBytes: 4096, publicOrigin: 'https://media.fictional.example/',
};
const clinic = '40000000-0000-4000-8000-000000000001';
const program = '40000000-0000-4000-8000-000000000010', otherProgram = '40000000-0000-4000-8000-000000000011';
const staff = '40000000-0000-4000-8000-000000000100';
const context = (over: Partial<SyntheticRequestContext> = {}): ClinicalRequestContext => ({
  actorPersonId: staff, organizationId: clinic, identityPool: 'workforce', identitySubject: 'syn_fictional_staff_1', purpose: 'clinical_data',
  environment: 'synthetic-staging', dataClassification: 'synthetic_only', containsPhi: false, realPatientData: false, ...over,
} as ClinicalRequestContext);
const image = new TextEncoder().encode('fictional png bytes');
const sha = createHash('sha256').update(image).digest('hex');
const prepare = (over: Record<string, unknown> = {}) => ({ commandId: randomUUID(), programId: program, kind: 'image', contentType: 'image/png', bytes: image.byteLength, sha256: sha, fileName: 'fictional-lesson.png', ...over });
const admitRequest = (artifactId: string) => ({ artifactId, sha256: sha, bytes: image.byteLength });
const code = async (work: Promise<unknown>) => { try { await work; } catch (error) { return error instanceof ProgramMediaError ? error.code : 'other:' + String(error); } return 'none'; };

let clock: Date;
let store: ReturnType<typeof createFictionalProgramMediaStore>;
let ledger: ReturnType<typeof createFictionalProgramMediaLedger>;
const authoringOver = (over: Partial<ProgramMediaObjectStore>): ProgramMediaAuthoring =>
  createProgramMediaAuthoring({ ledger, store: { ...store, ...over }, storage, activation: { enabled: true, reason: 'fictional store under audit' }, now: () => clock });
beforeEach(() => {
  clock = new Date('2026-10-11T12:00:00Z');
  store = createFictionalProgramMediaStore({ kmsKeyArn: KMS, now: () => clock });
  ledger = createFictionalProgramMediaLedger({ authorized: (c, p) => c.organizationId === clinic && (p === program || p === otherProgram), now: () => clock });
});
/** A reservation whose object was written but whose outcome was lost before commit: the store holds the bytes, the ledger says error. */
async function writtenButUncommitted(authoring: ProgramMediaAuthoring) {
  const reservation = await authoring.prepare(context(), prepare());
  store.inject('lose_put_response'); store.before('put', async () => store.inject('fail_head'));
  expect(await code(authoring.admit(context(), admitRequest(reservation.artifactId), image))).toBe('service_unavailable');
  expect(store.versionsOf(reservation.objectKey)).toHaveLength(1);
  expect((await ledger.artifact(context(), reservation.artifactId))?.state).toBe('error');
  return reservation;
}

describe('Codex independent negative audit of e3f39a6', () => {
  it('1. a substituted delivery address or origin program is never reported as a current publication', async () => {
    const authoring = authoringOver({});
    const reservation = await authoring.prepare(context(), prepare());
    const artifact = await authoring.admit(context(), admitRequest(reservation.artifactId), image);
    const reference = await authoring.publish(context(), { artifactId: artifact.artifactId, expectedVersion: 1 });
    expect(await authoring.describeReference(context(), reference)).toMatchObject({ current: true, historical: false });
    const alteredUrl = { ...reference, url: 'https://media.fictional.example/program-media/elsewhere/' + reference.sha256 + '.png' };
    const alteredOrigin = { ...reference, origin: { ...reference.origin, programId: otherProgram } };
    const alteredText = { ...reference, caption: { source: 'supplied_by_author', sha256: 'c'.repeat(64) } };
    for (const altered of [alteredUrl, alteredOrigin, alteredText]) {
      let outcome: unknown;
      try { outcome = await authoring.describeReference(context(), altered); } catch (error) { outcome = error instanceof ProgramMediaError ? error.code : 'other'; }
      expect(outcome, JSON.stringify(altered)).not.toMatchObject({ current: true });
      expect(outcome).toBe('not_found');
    }
  });

  it('2. a delete call that is acknowledged but changes nothing is not a removal; the receipt must not say removed while the version remains', async () => {
    const authoring = authoringOver({ remove: async () => undefined });
    const orphan = await writtenButUncommitted(authoring);
    clock = new Date('2026-10-11T12:30:00Z');
    const receipt = await authoring.cleanupOrphans(context(), { programId: program });
    const action = receipt.actions.find(a => a.artifactId === orphan.artifactId);
    expect(store.versionsOf(orphan.objectKey)).toHaveLength(1);
    expect(action?.outcome).not.toBe('abandoned_object_removed');
    expect((await ledger.reservation(context(), orphan.artifactId))?.state).not.toBe('abandoned');
  });

  it('3a-i. cleanup holds the lease when reconciliation arrives between its reads: reconciliation is refused, the bytes survive, and a later reconciliation recovers them', async () => {
    const plain = authoringOver({});
    const orphan = await writtenButUncommitted(plain);
    clock = new Date('2026-10-11T12:30:00Z');
    let fired = false, interleaved: unknown = null;
    const racing = authoringOver({
      head: async (reservation, version, signal) => {
        if (!fired && reservation.artifactId === orphan.artifactId) {
          fired = true;
          interleaved = await code(plain.reconcile(context(), { artifactId: orphan.artifactId }));
          // Reconciliation did not get the object: the store still holds the bytes and the fence refused the second party.
          expect(store.versionsOf(orphan.objectKey)).toHaveLength(1);
        }
        return store.head(reservation, version, signal);
      },
    });
    const receipt = await racing.cleanupOrphans(context(), { programId: program });
    expect(fired).toBe(true);
    expect(interleaved).toBe('conflict');
    const action = receipt.actions.find(a => a.artifactId === orphan.artifactId);
    // Cleanup held the lease throughout, so it was the one party allowed to act, and it certified only what it read back.
    expect(action?.outcome).toBe('abandoned_object_removed');
    expect(store.versionsOf(orphan.objectKey)).toHaveLength(0);
    expect(await code(plain.reconcile(context(), { artifactId: orphan.artifactId }))).toBe('none');
    expect((await ledger.artifact(context(), orphan.artifactId))?.state).not.toBe('ready');
  });

  it('3a-ii. reconciliation holds the lease when cleanup arrives: cleanup is refused, reconciliation commits, and the committed bytes survive', async () => {
    const plain = authoringOver({});
    const orphan = await writtenButUncommitted(plain);
    clock = new Date('2026-10-11T12:30:00Z');
    let fired = false, receipt: Awaited<ReturnType<typeof plain.cleanupOrphans>> | null = null;
    const racing = authoringOver({
      head: async (reservation, version, signal) => {
        if (!fired && reservation.artifactId === orphan.artifactId) { fired = true; receipt = await plain.cleanupOrphans(context(), { programId: program }); }
        return store.head(reservation, version, signal);
      },
    });
    const recovered = await racing.reconcile(context(), { artifactId: orphan.artifactId });
    expect(fired).toBe(true);
    expect(recovered).toMatchObject({ state: 'ready', objectVersion: 'fv1' });
    expect(store.versionsOf(orphan.objectKey)).toEqual(['fv1']);
    expect(receipt!.actions.find(a => a.artifactId === orphan.artifactId)).toMatchObject({ outcome: 'claim_refused', proof: null });
    expect(store.log.filter(l => l.op === 'remove')).toEqual([]);
    // Once committed, a later cleanup pass has nothing to list for this artifact.
    expect((await plain.cleanupOrphans(context(), { programId: program })).actions.find(a => a.artifactId === orphan.artifactId)).toBeUndefined();
  });

  it('3a-iii. a writer whose lease is lost before its commit marks the storage unresolved rather than losing the bytes', async () => {
    const plain = authoringOver({});
    const reservation = await plain.prepare(context(), prepare());
    // The writer's proof read is delayed past its lease; cleanup is not involved, the lease simply expires mid-flight.
    store.before('head', async () => undefined);
    store.before('head', async () => { clock = new Date('2026-10-11T12:02:00Z'); });
    expect(await code(plain.admit(context(), admitRequest(reservation.artifactId), image))).toBe('conflict');
    expect(store.versionsOf(reservation.objectKey)).toHaveLength(1);
    const after = await ledger.reservation(context(), reservation.artifactId);
    expect(after).toMatchObject({ unresolvedStorage: true });
    expect((await ledger.artifact(context(), reservation.artifactId))?.state).not.toBe('ready');
    // The bytes stay discoverable: a reconciliation under a fresh lease recovers them.
    expect(await plain.reconcile(context(), { artifactId: reservation.artifactId })).toMatchObject({ state: 'ready', objectVersion: 'fv1' });
  });

  it('3b. cleanup proves and removes the orphan first: reconciliation afterwards does not report a recovery of bytes that are gone', async () => {
    const plain = authoringOver({});
    const orphan = await writtenButUncommitted(plain);
    clock = new Date('2026-10-11T12:30:00Z');
    const receipt = await plain.cleanupOrphans(context(), { programId: program });
    expect(receipt.actions.find(a => a.artifactId === orphan.artifactId)?.outcome).toBe('abandoned_object_removed');
    expect(store.versionsOf(orphan.objectKey)).toHaveLength(0);
    let outcome: unknown;
    try { outcome = await plain.reconcile(context(), { artifactId: orphan.artifactId }); } catch (error) { outcome = error instanceof ProgramMediaError ? error.code : 'other'; }
    expect(outcome).not.toMatchObject({ state: 'ready' });
    expect((await ledger.artifact(context(), orphan.artifactId))?.state).not.toBe('ready');
  });

  it('4. an expired retry must inspect the written object instead of hiding it: the bytes stay discoverable until absence or recovery is proven', async () => {
    const authoring = authoringOver({});
    const orphan = await writtenButUncommitted(authoring);
    clock = new Date('2026-10-11T12:20:00Z');
    const retry = await code(authoring.admit(context(), admitRequest(orphan.artifactId), image));
    expect(store.versionsOf(orphan.objectKey)).toHaveLength(1);
    expect(store.log.filter(l => l.op === 'put')).toHaveLength(1);
    const reservation = await ledger.reservation(context(), orphan.artifactId);
    // Either the object was recovered into a ready artifact, or the reservation is still discoverable to cleanup. Never silently abandoned.
    const artifact = await ledger.artifact(context(), orphan.artifactId);
    if (retry === 'none') expect(artifact?.state).toBe('ready');
    if (artifact?.state !== 'ready') {
      const discoverable = await ledger.unresolvedReservations(context(), program, clock.toISOString());
      expect(discoverable.map(r => r.artifactId), `reservation state ${reservation?.state}`).toContain(orphan.artifactId);
    }
  });
});
