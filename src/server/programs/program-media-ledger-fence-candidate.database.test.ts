import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * The BLOCKED fence successor candidate, run on the full synthetic manifest plus the blocked ledger
 * candidate it follows, and nowhere else. It is a review artifact: it proves the successor applies on
 * exactly its stated parents and that the schema itself enforces the fence (one live lease, takeover
 * only after expiry, commit only from the writer's lease, abandonment only with proof or an unresolved
 * flag, sticky unresolved storage) and whole-publication recording. It registers and enables nothing.
 */
const PRIOR = 'infra/aws-clinical-core/source-candidates/program-media-ledger.sql';
const CANDIDATE = 'infra/aws-clinical-core/source-candidates/program-media-ledger-fence.sql';
const PARENTS: Record<string, string> = {
  [PRIOR]: '6dae2f237c13540b13cc3b7ecde877be104c35e59c7fddd9206130a62356a34d',
  'infra/aws-clinical-core/migrations/20260812010000_synthetic_identity_consent.sql': 'c4ca967352bce6c678249336ef410fe7de4216d123a0d3da06a467379780c445',
  'infra/aws-clinical-core/migrations/20260903200000_synthetic_desktop_programs_inbox.sql': '6ba42349af12e2deb2aa163fbca59ea168bababe4017a098ec88314f31a8b26f',
};
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const id = (n: number) => '60000000-0000-4000-8000-' + String(n).padStart(12, '0');
const org = id(1), otherOrg = id(2), staff = id(3), program = id(4);
let db: PGlite;
const fails = async (sql: string, args: unknown[] = []) => { try { await db.query(sql, args); } catch (error) { return (error as Error).message; } return 'none'; };
const key = (artifactId: string, hash: string) => `program-media/${org}/${program}/${artifactId}/${hash}.png`;
async function reserve(artifactId: string, hash: string) {
  await db.query(`insert into clinical_core.program_media_artifacts(id,organization_id,program_id,command_id,created_by,kind,content_type,bytes,sha256,object_key,accept_before)
    values($1,$2,$3,$4,$5,'image','image/png',10,$6,$7,clock_timestamp()+interval '15 minutes')`, [artifactId, org, program, artifactId, staff, hash, key(artifactId, hash)]);
}
const lease = (artifactId: string, holder: string, token: string, version: number, until = "clock_timestamp()+interval '90 seconds'") =>
  db.query(`update clinical_core.program_media_artifacts set state=$2,lease_holder=$2::text,lease_token=$3,lease_until=${until},version=$4 where id=$1`
    .replace("state=$2,lease_holder=$2::text", `state='${holder === 'writer' ? 'writing' : 'cleaning'}',lease_holder=$2`), [artifactId, holder, token, version]);
const token = (n: number) => 'fictional-lease-token-' + String(n).padStart(4, '0');

beforeAll(async () => {
  for (const [path, digest] of Object.entries(PARENTS)) expect(sha(path), path).toBe(digest);
  const candidate = readFileSync(CANDIDATE, 'utf8');
  for (const digest of Object.values(PARENTS)) expect(candidate).toContain(digest);
  expect(candidate).toContain('BLOCKED source candidate, successor to program-media-ledger.sql');
  const manifest = JSON.parse(readFileSync('infra/aws-clinical-core/migrations/manifest.json', 'utf8')) as { migrations: { file: string }[] };
  expect(manifest.migrations.some(m => /program[-_]media/.test(m.file))).toBe(false);
  db = new PGlite({ extensions: { pgcrypto } });
  for (const { file } of manifest.migrations) await db.exec(readFileSync('infra/aws-clinical-core/migrations/' + file, 'utf8'));
  await db.exec(readFileSync(PRIOR, 'utf8'));
  await db.exec(candidate);
  for (const [o, label] of [[org, 'Fictional A'], [otherOrg, 'Fictional B']]) await db.query('insert into clinical_core.organizations(id,synthetic_label) values($1,$2)', [o, label]);
  await db.query('insert into clinical_core.persons(id,synthetic_subject_key) values($1,$2)', [staff, 'syn_' + staff.replaceAll('-', '')]);
  await db.query("insert into clinical_core.synthetic_desktop_programs(id,organization_id,name,status,created_by_person_id) values($1,$2,'Fictional program','draft',$3)", [program, org, staff]);
}, 120_000);
afterAll(async () => { await db?.close(); });

describe('the lease', () => {
  it('is whole, matches the state, and the activation row is still disabled with nothing granted to the API role', async () => {
    const row = await db.query<{ enabled: boolean }>('select enabled from clinical_core.program_media_activation');
    expect(row.rows[0]).toEqual({ enabled: false });
    await expect(db.transaction(async tx => { await tx.exec('set local role clinical_core_api'); await tx.exec('select * from clinical_core.program_media_artifacts'); })).rejects.toThrow(/permission denied/);
    await reserve(id(10), 'a'.repeat(64));
    expect(await fails(`update clinical_core.program_media_artifacts set state='writing',version=2 where id=$1`, [id(10)])).toMatch(/lease_state|check/);
    expect(await fails(`update clinical_core.program_media_artifacts set lease_holder='writer',version=2 where id=$1`, [id(10)])).toMatch(/lease_whole|lease_state|check/);
    expect(await fails(`update clinical_core.program_media_artifacts set state='writing',lease_holder='cleanup',lease_token=$2,lease_until=clock_timestamp()+interval '1 minute',version=2 where id=$1`, [id(10), token(1)])).toMatch(/lease_state|check/);
  });
  it('is exclusive while live: a second holder of either kind is refused until the lease expires', async () => {
    await lease(id(10), 'writer', token(1), 2);
    expect(await fails(`update clinical_core.program_media_artifacts set state='cleaning',lease_holder='cleanup',lease_token=$2,lease_until=clock_timestamp()+interval '1 minute',version=3 where id=$1`, [id(10), token(2)])).toContain('program_media_lease_held');
    expect(await fails(`update clinical_core.program_media_artifacts set lease_token=$2,version=3 where id=$1`, [id(10), token(3)])).toContain('program_media_lease_held');
    // The same holder renewing its own token is not a takeover.
    await db.query(`update clinical_core.program_media_artifacts set lease_until=clock_timestamp()+interval '2 minutes',version=3 where id=$1`, [id(10)]);
    // Expire the lease and the other party may take it.
    await db.query(`update clinical_core.program_media_artifacts set lease_until=clock_timestamp()-interval '1 second',version=4 where id=$1`, [id(10)]);
    await db.query(`update clinical_core.program_media_artifacts set state='cleaning',lease_holder='cleanup',lease_token=$2,lease_until=clock_timestamp()+interval '1 minute',version=5 where id=$1`, [id(10), token(2)]);
    // Cleanup cannot commit, and cannot hand the row straight to ready.
    expect(await fails(`update clinical_core.program_media_artifacts set state='ready',object_version='v1',committed_at=clock_timestamp(),lease_holder=null,lease_token=null,lease_until=null,version=6 where id=$1`, [id(10)])).toContain('program_media_transition_refused');
    await db.query(`update clinical_core.program_media_artifacts set state='reserved',lease_holder=null,lease_token=null,lease_until=null,version=6 where id=$1`, [id(10)]);
  });
  it('a commit comes only from the writer lease, and a committed row carries no lease', async () => {
    expect(await fails(`update clinical_core.program_media_artifacts set state='ready',object_version='v1',committed_at=clock_timestamp(),version=7 where id=$1`, [id(10)])).toContain('program_media_transition_refused');
    await lease(id(10), 'writer', token(4), 7);
    expect(await fails(`update clinical_core.program_media_artifacts set state='ready',object_version='v1',committed_at=clock_timestamp(),version=8 where id=$1`, [id(10)])).toMatch(/committed_unleased|check/);
    await db.query(`update clinical_core.program_media_artifacts set state='ready',object_version='v1',committed_at=clock_timestamp(),lease_holder=null,lease_token=null,lease_until=null,version=8 where id=$1`, [id(10)]);
    expect(await fails(`update clinical_core.program_media_artifacts set state='cleaning',lease_holder='cleanup',lease_token=$2,lease_until=clock_timestamp()+interval '1 minute',version=9 where id=$1`, [id(10), token(5)])).toContain('program_media_transition_refused');
  });
});

describe('absence proof and unresolved storage', () => {
  it('abandonment needs proof made under a lease, or an unresolved flag; proof is never written without a lease', async () => {
    await reserve(id(11), 'b'.repeat(64));
    expect(await fails(`update clinical_core.program_media_artifacts set state='abandoned',version=2 where id=$1`, [id(11)])).toMatch(/abandoned_proof|transition_refused|check/);
    expect(await fails(`update clinical_core.program_media_artifacts set absence_proven_at=clock_timestamp(),version=2 where id=$1`, [id(11)])).toContain('program_media_proof_requires_lease');
    await lease(id(11), 'cleanup', token(6), 2);
    expect(await fails(`update clinical_core.program_media_artifacts set state='abandoned',lease_holder=null,lease_token=null,lease_until=null,version=3 where id=$1`, [id(11)])).toMatch(/abandoned_proof|check/);
    await db.query(`update clinical_core.program_media_artifacts set state='abandoned',absence_proven_at=clock_timestamp(),lease_holder=null,lease_token=null,lease_until=null,version=3 where id=$1`, [id(11)]);
    // Proven absent is final.
    expect(await fails(`update clinical_core.program_media_artifacts set state='writing',lease_holder='writer',lease_token=$2,lease_until=clock_timestamp()+interval '1 minute',version=4 where id=$1`, [id(11), token(7)])).toContain('program_media_terminal');
  });
  it('unresolved storage keeps an abandoned row open to recovery and is cleared only by a commit or a proof', async () => {
    await reserve(id(12), 'c'.repeat(64));
    await lease(id(12), 'writer', token(8), 2);
    await db.query(`update clinical_core.program_media_artifacts set state='error',failure='store_unproven',unresolved_storage=true,lease_holder=null,lease_token=null,lease_until=null,version=3 where id=$1`, [id(12)]);
    expect(await fails(`update clinical_core.program_media_artifacts set unresolved_storage=false,version=4 where id=$1`, [id(12)])).toContain('program_media_unresolved_storage_sticky');
    await lease(id(12), 'cleanup', token(9), 4);
    await db.query(`update clinical_core.program_media_artifacts set state='abandoned',failure='removal_unproven',lease_holder=null,lease_token=null,lease_until=null,version=5 where id=$1`, [id(12)]);
    // Abandoned but unresolved: a writer may still take it and recover the bytes.
    await lease(id(12), 'writer', token(10), 6);
    await db.query(`update clinical_core.program_media_artifacts set state='ready',object_version='v7',committed_at=clock_timestamp(),unresolved_storage=false,lease_holder=null,lease_token=null,lease_until=null,version=7 where id=$1`, [id(12)]);
    const row = await db.query<{ state: string; unresolved_storage: boolean }>('select state,unresolved_storage from clinical_core.program_media_artifacts where id=$1', [id(12)]);
    expect(row.rows[0]).toEqual({ state: 'ready', unresolved_storage: false });
  });
});

describe('whole publications', () => {
  const reference = (over: Record<string, unknown> = {}) => ({
    contractVersion: 'program-media-reference/1', publicationId: id(20), artifactId: id(12), version: 7, sha256: 'c'.repeat(64), kind: 'image', contentType: 'image/png', bytes: 10,
    origin: { clinic: org, programId: program }, url: 'https://media.fictional.example/' + key(id(12), 'c'.repeat(64)), publishedAt: '2026-10-11T12:00:00.000Z', caption: null, transcript: null, ...over,
  });
  const insert = (ref: Record<string, unknown>, over: Record<string, unknown> = {}) => fails(
    `insert into clinical_core.program_media_publications(id,artifact_id,organization_id,origin_program_id,version,sha256,url,published_by,reference) values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
    [(over.id as string) ?? id(20), id(12), (over.organization_id as string) ?? org, (over.origin_program_id as string) ?? program, (over.version as number) ?? 7, 'c'.repeat(64), (over.url as string) ?? ref.url, staff, JSON.stringify(ref)]);
  it('records the reference body with its identity, and refuses a body that disagrees with the row or the artifact', async () => {
    await db.query(`update clinical_core.program_media_activation set public_origin='https://media.fictional.example/'`);
    expect(await insert(reference({ publicationId: id(21) }))).toMatch(/reference_identity|check/);
    expect(await insert(reference({ url: 'https://media.fictional.example/program-media/elsewhere.png' }))).toMatch(/reference_identity|url_mismatch|check/);
    expect(await insert(reference({ origin: { clinic: org, programId: id(5) } }))).toMatch(/reference_identity|check/);
    expect(await insert(reference(), { origin_program_id: id(5) })).toMatch(/reference_identity|publication_refused|check/);
    expect(await insert(reference({ bytes: 11 }))).toContain('program_media_reference_body_mismatch');
    expect(await insert(reference({ caption: { source: 'supplied_by_author', sha256: 'd'.repeat(64) } }))).toContain('program_media_reference_body_mismatch');
    expect(await insert(reference({ kind: 'video', contentType: 'video/mp4' }))).toContain('program_media_reference_body_mismatch');
    expect(await insert(reference())).toBe('none');
    expect(await insert(reference())).toMatch(/duplicate key|unique/);
    expect(await fails(`update clinical_core.program_media_publications set reference=$2::jsonb where id=$1`, [id(20), JSON.stringify(reference({ bytes: 11 }))])).toContain('append_only_record');
    await db.query(`update clinical_core.program_media_activation set public_origin=null`);
  });
});
