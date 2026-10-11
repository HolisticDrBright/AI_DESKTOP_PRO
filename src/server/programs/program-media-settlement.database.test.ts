import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import type { ClinicalCoreDatabase } from '@/server/clinical-core/database';
import type { ClinicalRequestContext } from '@/server/clinical-core/aws-identity-consent';
import { createProgramMediaSettlementSource } from './program-media-settlement';

const base = 'infra/aws-clinical-core/source-candidates/program-media-ledger.sql';
const candidate = 'infra/aws-clinical-core/source-candidates/program-media-settlement.sql';
const id = (n: number) => '61000000-0000-4000-8000-' + String(n).padStart(12, '0');
const org = id(1), actor = id(2), program = id(3), foreign = id(4);
const context = { actorPersonId: actor, organizationId: org, identityPool: 'workforce', identitySubject: 'syn_educator',
  purpose: 'clinical_data', environment: 'synthetic-staging', dataClassification: 'synthetic_only', containsPhi: false, realPatientData: false } as ClinicalRequestContext;
let db: PGlite, source: ReturnType<typeof createProgramMediaSettlementSource>;
const hash = (a: string) => createHash('sha256').update('fictional-media-bytes-' + a).digest('hex');
const key = (a: string) => `program-media/${org}/${program}/${a}/${hash(a)}.png`;
async function reserve(expired = true) {
  const a = randomUUID();
  await db.query(`insert into clinical_core.program_media_artifacts(id,organization_id,program_id,command_id,created_by,kind,content_type,bytes,sha256,object_key,created_at,accept_before)
    values($1,$2,$3,$1,$4,'image','image/png',10,$5,$6,clock_timestamp()-interval '1 hour',clock_timestamp()+$7::interval)`,
  [a, org, program, actor, hash(a), key(a), expired ? '-1 minute' : '15 minutes']);
  return a;
}
const state = async (a: string) => (await db.query<{ state: string }>('select state from clinical_core.program_media_artifacts where id=$1', [a])).rows[0].state;
const proof = (a: string, c: string) => ({ artifactId: a, claimId: c, objectKey: key(a), checkedAt: new Date().toISOString(), complete: true as const, remainingVersions: 0 as const, removedVersions: ['fictional-v1'] });
beforeAll(async () => {
  expect(createHash('sha256').update(readFileSync(base)).digest('hex')).toBe('6dae2f237c13540b13cc3b7ecde877be104c35e59c7fddd9206130a62356a34d');
  const manifest = JSON.parse(readFileSync('infra/aws-clinical-core/migrations/manifest.json', 'utf8')) as { migrations: { file: string }[] };
  expect(manifest.migrations.some(m => /program[-_]media/.test(m.file))).toBe(false);
  db = new PGlite({ extensions: { pgcrypto } });
  for (const m of manifest.migrations) await db.exec(readFileSync('infra/aws-clinical-core/migrations/' + m.file, 'utf8'));
  await db.exec(readFileSync(base, 'utf8')); await db.exec(readFileSync(candidate, 'utf8'));
  await db.query('insert into clinical_core.organizations(id,synthetic_label) values($1,$2),($3,$4)', [org, 'Fictional education', foreign, 'Fictional unrelated clinic']);
  await db.query('insert into clinical_core.persons(id,synthetic_subject_key) values($1,$2)', [actor, 'syn_' + actor.replaceAll('-', '')]);
  await db.query("insert into clinical_core.synthetic_desktop_programs(id,organization_id,name,status,created_by_person_id) values($1,$2,'Fictional media lesson','draft',$3)", [program, org, actor]);
  const database: ClinicalCoreDatabase = { transaction: work => db.transaction(tx => work({ query: async (sql, parameters) => {
    const result = await tx.query(sql, parameters ? [...parameters] : []);
    return result as never;
  } })) };
  source = createProgramMediaSettlementSource(database);
}, 120_000);
afterAll(async () => { await db?.close(); });

describe('distinct blocked durable media settlement candidate', () => {
  it('keeps activation off, API grants absent and the old source identity intact', async () => {
    expect((await db.query('select enabled,storage_bucket,public_origin from clinical_core.program_media_activation')).rows)
      .toEqual([{ enabled: false, storage_bucket: null, public_origin: null }]);
    await expect(db.transaction(async tx => { await tx.exec('set local role clinical_core_api'); await tx.query('select clinical_private.program_media_begin_work($1,$2,$3,$4,$5)', [org, actor, randomUUID(), randomUUID(), 'admit']); })).rejects.toThrow(/permission denied/);
    await expect(db.transaction(async tx => { await tx.exec('set local role clinical_core_api'); await tx.exec('select * from clinical_private.program_media_work'); })).rejects.toThrow(/permission denied/);
  });
  it('does not admit a new expired writer but permits an admitted recovery of existing bytes', async () => {
    const a = await reserve(), w = randomUUID();
    expect(await source.beginWriter(context, a, randomUUID(), 'admit', '')).toBe(false);
    expect(await source.beginWriter(context, a, w, 'reconcile', '')).toBe(true);
    await source.commitWork(context, a, w, 'fictional-v1'); await source.finishWriter(context, a, w, 'settled');
    expect(await state(a)).toBe('ready');
    expect(await source.beginCleanup(context, a, randomUUID(), '')).toBe(false);
  });
  it('writer first: cleanup and raw expiry are refused until work settles', async () => {
    const a = await reserve(), w = randomUUID();
    expect(await source.beginWriter(context, a, w, 'reconcile', '')).toBe(true);
    expect(await source.beginCleanup(context, a, randomUUID(), '')).toBe(false);
    await expect(db.query("update clinical_core.program_media_artifacts set state='abandoned',version=version+1 where id=$1", [a])).rejects.toThrow('program_media_writer_pending');
    await source.commitWork(context, a, w, 'fictional-v1'); await source.finishWriter(context, a, w, 'settled');
    expect(await state(a)).toBe('ready');
  });
  it('cleanup first: the permanent seal refuses late commits and new writer claims', async () => {
    const a = await reserve(), c = randomUUID();
    expect(await source.beginCleanup(context, a, c, '')).toBe(true);
    expect(await source.beginWriter(context, a, randomUUID(), 'reconcile', '')).toBe(false);
    await expect(source.commitWork(context, a, randomUUID(), 'late-version')).rejects.toThrow('service_unavailable');
    await expect(db.query("update clinical_core.program_media_artifacts set state='ready',object_version='late-version',committed_at=clock_timestamp(),version=version+1 where id=$1", [a])).rejects.toThrow('program_media_commit_not_admitted');
    await source.certifyCleanup(context, a, c, proof(a, c));
    expect(await state(a)).toBe('abandoned');
    expect(await source.beginWriter(context, a, randomUUID(), 'reconcile', '')).toBe(false);
  });
  it('uncertain writers never expire or become settled by an ordinary retry', async () => {
    const a = await reserve(), w = randomUUID();
    expect(await source.beginWriter(context, a, w, 'reconcile', '')).toBe(true);
    await source.finishWriter(context, a, w, 'uncertain');
    await expect(db.query("update clinical_private.program_media_work set kind='cleanup' where claim_id=$1", [w])).rejects.toThrow('program_media_work_immutable');
    await expect(source.finishWriter(context, a, w, 'settled')).rejects.toThrow('service_unavailable');
    expect(await source.beginCleanup(context, a, randomUUID(), '')).toBe(false);
    expect(await state(a)).toBe('reserved');
  });
  it('settled writers release cleanup, while every separate unsettled writer still blocks it', async () => {
    const a = await reserve(), w1 = randomUUID(), w2 = randomUUID();
    expect(await source.beginWriter(context, a, w1, 'reconcile', '')).toBe(true);
    expect(await source.beginWriter(context, a, w2, 'reconcile', '')).toBe(true);
    await source.finishWriter(context, a, w1, 'settled');
    expect(await source.beginCleanup(context, a, randomUUID(), '')).toBe(false);
    await source.finishWriter(context, a, w2, 'settled');
    expect(await source.beginCleanup(context, a, randomUUID(), '')).toBe(true);
  });
  it('binds work to the actor and clinic, refuses claim reuse, and masks raw DB errors', async () => {
    const a = await reserve(), w = randomUUID();
    expect(await source.beginWriter({ ...context, organizationId: foreign }, a, w, 'reconcile', '')).toBe(false);
    expect(await source.beginWriter(context, a, w, 'reconcile', '')).toBe(true);
    await expect(source.finishWriter({ ...context, actorPersonId: foreign }, a, w, 'settled')).rejects.toThrow('service_unavailable');
    const b = await reserve();
    await expect(source.beginWriter(context, b, w, 'reconcile', '')).rejects.toThrow('service_unavailable');
    await source.finishWriter(context, a, w, 'settled');
  });
  it.each(['complete', 'remainingVersions', 'objectKey', 'claimId', 'artifactId'] as const)('refuses a substituted %s absence proof', async field => {
    const a = await reserve(), c = randomUUID();
    expect(await source.beginCleanup(context, a, c, '')).toBe(true);
    const value = { ...proof(a, c), [field]: field === 'complete' ? false : field === 'remainingVersions' ? 1 : 'wrong' };
    await expect(source.certifyCleanup(context, a, c, value as never)).rejects.toThrow('service_unavailable');
    expect(await state(a)).toBe('reserved');
    expect((await db.query('select proof from clinical_private.program_media_cleanup_seals where artifact_id=$1', [a])).rows[0]).toEqual({ proof: null });
  });
  it('records a checksum-bound absence proof, refuses re-certification and preserves an abandoned orphan for cleanup', async () => {
    const a = await reserve(), c = randomUUID();
    await db.query("update clinical_core.program_media_artifacts set state='abandoned',version=version+1 where id=$1", [a]);
    expect(await source.beginCleanup(context, a, c, '')).toBe(true);
    const p = proof(a, c); await source.certifyCleanup(context, a, c, p);
    const receipt = (await db.query<{ proof: unknown; proof_sha256: string }>('select proof,proof_sha256 from clinical_private.program_media_cleanup_seals where artifact_id=$1', [a])).rows[0];
    expect(receipt.proof).toEqual(p); expect(receipt.proof_sha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(db.query("update clinical_private.program_media_cleanup_seals set proof='{}'::jsonb where artifact_id=$1", [a])).rejects.toThrow('program_media_cleanup_proof_immutable');
    await expect(source.certifyCleanup(context, a, c, p)).rejects.toThrow('service_unavailable');
  });
  it('stores and validates the complete publication snapshot including supplied text and timestamp', async () => {
    const a = await reserve(false), w = randomUUID();
    expect(await source.beginWriter(context, a, w, 'admit', '')).toBe(true);
    await source.commitWork(context, a, w, 'fictional-v1'); await source.finishWriter(context, a, w, 'settled');
    await db.query("update clinical_core.program_media_activation set public_origin='https://media.fictional.example/'");
    const reference = { contractVersion: 'program-media-reference/1', artifactId: a, version: 2, sha256: hash(a), kind: 'image', contentType: 'image/png', bytes: 10,
      origin: { clinic: org, programId: program }, url: 'https://media.fictional.example/' + key(a), publishedAt: new Date().toISOString(), caption: null, transcript: null };
    const publish = (r: unknown) => db.query('insert into clinical_core.program_media_publications(artifact_id,organization_id,version,sha256,url,published_by,published_at,reference) values($1,$2,2,$3,$4,$5,$6::timestamptz,$7::jsonb)',
      [a, org, hash(a), reference.url, actor, reference.publishedAt, JSON.stringify(r)]);
    for (const changed of [{ origin: { clinic: org, programId: foreign } }, { bytes: 11 }, { kind: 'video' }, { contentType: 'image/jpeg' },
      { url: 'https://other-fictional.example/wrong' }, { publishedAt: '2020-01-01T00:00:00Z' }, { caption: { source: 'supplied_by_author', sha256: 'b'.repeat(64) } }]) {
      await expect(publish({ ...reference, ...changed })).rejects.toThrow('program_media_publication_refused');
    }
    await publish(reference);
    expect((await db.query('select reference from clinical_core.program_media_publications where artifact_id=$1', [a])).rows[0]).toEqual({ reference });
    await expect(db.query('update clinical_core.program_media_publications set reference=$2::jsonb where artifact_id=$1', [a, '{}'])).rejects.toThrow('append_only_record');
  });
});
