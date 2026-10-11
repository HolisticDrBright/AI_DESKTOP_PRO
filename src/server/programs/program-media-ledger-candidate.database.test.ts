import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * The BLOCKED program-media ledger candidate, run against the full synthetic manifest and nowhere
 * else. It is a review artifact: this proves the candidate applies on top of exactly its stated
 * parents and that every invariant the design names is enforced by the schema, so Codex reviews
 * a thing that holds rather than a sketch. It registers nothing and enables nothing.
 */
const CANDIDATE = 'infra/aws-clinical-core/source-candidates/program-media-ledger.sql';
const PARENTS: Record<string, string> = {
  'infra/aws-clinical-core/migrations/20260812010000_synthetic_identity_consent.sql': 'c4ca967352bce6c678249336ef410fe7de4216d123a0d3da06a467379780c445',
  'infra/aws-clinical-core/migrations/20260903200000_synthetic_desktop_programs_inbox.sql': '6ba42349af12e2deb2aa163fbca59ea168bababe4017a098ec88314f31a8b26f',
};
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const id = (n: number) => '50000000-0000-4000-8000-' + String(n).padStart(12, '0');
const org = id(1), otherOrg = id(2), staff = id(3), program = id(4), otherProgram = id(5);
const bytesSha = 'a'.repeat(64);
let db: PGlite;
const fails = async (sql: string, args: unknown[] = []) => { try { await db.query(sql, args); } catch (error) { return (error as Error).message; } return 'none'; };
const key = (artifactId: string, programId = program, hash = bytesSha, ext = 'png') => `program-media/${org}/${programId}/${artifactId}/${hash}.${ext}`;
async function reserve(artifactId: string, over: Record<string, unknown> = {}) {
  const row = { kind: 'image', content_type: 'image/png', bytes: 10, sha256: bytesSha, program_id: program, command_id: artifactId, object_key: key(artifactId, (over.program_id as string) ?? program, (over.sha256 as string) ?? bytesSha, (over.ext as string) ?? 'png'), ...over };
  return db.query(`insert into clinical_core.program_media_artifacts(id,organization_id,program_id,command_id,created_by,kind,content_type,bytes,sha256,object_key,accept_before)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,clock_timestamp()+interval '15 minutes')`,
    [artifactId, org, row.program_id, row.command_id, staff, row.kind, row.content_type, row.bytes, row.sha256, row.object_key]);
}
const commit = (artifactId: string, version = 2) => db.query(`update clinical_core.program_media_artifacts set state='ready',object_version='v1',committed_at=clock_timestamp(),version=$2 where id=$1`, [artifactId, version]);

beforeAll(async () => {
  for (const [path, digest] of Object.entries(PARENTS)) expect(sha(path), path).toBe(digest);
  const candidate = readFileSync(CANDIDATE, 'utf8');
  for (const digest of Object.values(PARENTS)) expect(candidate).toContain(digest);
  expect(candidate).toContain('BLOCKED source candidate');
  const manifest = JSON.parse(readFileSync('infra/aws-clinical-core/migrations/manifest.json', 'utf8')) as { migrations: { file: string }[] };
  expect(manifest.migrations.some(m => /program[-_]media/.test(m.file))).toBe(false);
  db = new PGlite({ extensions: { pgcrypto } });
  for (const { file } of manifest.migrations) await db.exec(readFileSync('infra/aws-clinical-core/migrations/' + file, 'utf8'));
  await db.exec(candidate);
  for (const [o, label] of [[org, 'Fictional A'], [otherOrg, 'Fictional B']]) await db.query('insert into clinical_core.organizations(id,synthetic_label) values($1,$2)', [o, label]);
  await db.query('insert into clinical_core.persons(id,synthetic_subject_key) values($1,$2)', [staff, 'syn_' + staff.replaceAll('-', '')]);
  for (const [p, o] of [[program, org], [otherProgram, otherOrg]]) {
    await db.query("insert into clinical_core.synthetic_desktop_programs(id,organization_id,name,status,created_by_person_id) values($1,$2,'Fictional program','draft',$3)", [p, o, staff]);
  }
}, 120_000);
afterAll(async () => { await db?.close(); });

describe('activation', () => {
  it('is disabled, names no store, and the API role can neither read nor flip it', async () => {
    const row = await db.query<{ enabled: boolean; storage_bucket: string | null; public_origin: string | null }>('select enabled,storage_bucket,public_origin from clinical_core.program_media_activation');
    expect(row.rows[0]).toEqual({ enabled: false, storage_bucket: null, public_origin: null });
    expect(await fails("update clinical_core.program_media_activation set enabled=true")).toMatch(/violates check constraint/);
    expect(await fails("update clinical_core.program_media_activation set storage_bucket='alp-qualification-recordings-588966314750-us-east-2'")).toMatch(/violates check constraint/);
    expect(await fails("update clinical_core.program_media_activation set public_origin='https://alp.s3.amazonaws.com/'")).toMatch(/violates check constraint/);
    expect(await fails('delete from clinical_core.program_media_activation')).toContain('append_only_record');
    await expect(db.transaction(async tx => { await tx.exec('set local role clinical_core_api'); await tx.exec('select * from clinical_core.program_media_activation'); })).rejects.toThrow(/permission denied/);
    await expect(db.transaction(async tx => { await tx.exec('set local role clinical_core_api'); await tx.exec('select * from clinical_core.program_media_artifacts'); })).rejects.toThrow(/permission denied/);
  });
});

describe('the artifact row', () => {
  it('reserves with a key that is a function of clinic, program, artifact and bytes, and refuses any other key', async () => {
    await reserve(id(10));
    expect(await fails(`insert into clinical_core.program_media_artifacts(id,organization_id,program_id,command_id,created_by,kind,content_type,bytes,sha256,object_key,accept_before)
      values($1,$2,$3,$4,$5,'image','image/png',10,$6,$7,clock_timestamp()+interval '1 minute')`, [id(11), org, program, id(11), staff, bytesSha, key(id(11), otherProgram)])).toMatch(/object_key|check/);
    expect(await fails(`insert into clinical_core.program_media_artifacts(id,organization_id,program_id,command_id,created_by,kind,content_type,bytes,sha256,object_key,accept_before)
      values($1,$2,$3,$4,$5,'image','image/png',10,$6,$7,clock_timestamp()+interval '1 minute')`, [id(11), org, program, id(11), staff, bytesSha, key(id(11), program, bytesSha, 'jpg')])).toMatch(/check/);
  });
  it('refuses a program of another clinic, a repeated command, a mismatched kind, an oversized image and a PHI-looking column', async () => {
    expect(await fails(`insert into clinical_core.program_media_artifacts(id,organization_id,program_id,command_id,created_by,kind,content_type,bytes,sha256,object_key,accept_before)
      values($1,$2,$3,$4,$5,'image','image/png',10,$6,$7,clock_timestamp()+interval '1 minute')`, [id(12), org, otherProgram, id(12), staff, bytesSha, key(id(12), otherProgram)])).toMatch(/foreign key|check/);
    expect(await fails(`insert into clinical_core.program_media_artifacts(id,organization_id,program_id,command_id,created_by,kind,content_type,bytes,sha256,object_key,accept_before)
      values($1,$2,$3,$4,$5,'image','image/png',10,$6,$7,clock_timestamp()+interval '1 minute')`, [id(13), org, program, id(10), staff, bytesSha, key(id(13))])).toMatch(/unique/);
    expect(await fails(`insert into clinical_core.program_media_artifacts(id,organization_id,program_id,command_id,created_by,kind,content_type,bytes,sha256,object_key,accept_before)
      values($1,$2,$3,$4,$5,'video','image/png',10,$6,$7,clock_timestamp()+interval '1 minute')`, [id(14), org, program, id(14), staff, bytesSha, key(id(14))])).toMatch(/check/);
    expect(await fails(`insert into clinical_core.program_media_artifacts(id,organization_id,program_id,command_id,created_by,kind,content_type,bytes,sha256,object_key,accept_before)
      values($1,$2,$3,$4,$5,'image','image/png',16777217,$6,$7,clock_timestamp()+interval '1 minute')`, [id(15), org, program, id(15), staff, bytesSha, key(id(15))])).toMatch(/check/);
    const columns = await db.query<{ column_name: string }>("select column_name from information_schema.columns where table_schema='clinical_core' and table_name like 'program_media_%'");
    expect(columns.rows.map(c => c.column_name).filter(c => /patient|consumer|connection|encounter/.test(c))).toEqual([]);
  });
  it('ready requires a proven object and a raised version; identity is immutable; terminal states stay terminal', async () => {
    expect(await fails(`update clinical_core.program_media_artifacts set state='ready',version=2 where id=$1`, [id(10)])).toMatch(/check/);
    expect(await fails(`update clinical_core.program_media_artifacts set state='ready',object_version='v1',committed_at=clock_timestamp() where id=$1`, [id(10)])).toContain('program_media_version_must_increase');
    expect(await fails(`update clinical_core.program_media_artifacts set sha256=$2,version=2 where id=$1`, [id(10), 'b'.repeat(64)])).toMatch(/program_media_identity_immutable|check/);
    await commit(id(10));
    expect(await fails(`update clinical_core.program_media_artifacts set state='reserved',object_version=null,committed_at=null,version=3 where id=$1`, [id(10)])).toContain('program_media_transition_refused');
    expect(await fails(`update clinical_core.program_media_artifacts set object_version='v2',version=3 where id=$1`, [id(10)])).toContain('program_media_commit_immutable');
    expect(await fails(`update clinical_core.program_media_artifacts set state='retired',version=3 where id=$1`, [id(10)])).toMatch(/check/);
    await db.query(`update clinical_core.program_media_artifacts set caption_text='Fictional caption',caption_source='supplied_by_author',caption_format='plain',caption_sha256=$2,version=3 where id=$1`, [id(10), 'c'.repeat(64)]);
    await db.query(`update clinical_core.program_media_artifacts set state='retired',retired_at=clock_timestamp(),version=4 where id=$1`, [id(10)]);
    expect(await fails(`update clinical_core.program_media_artifacts set caption_text='changed',version=5 where id=$1`, [id(10)])).toContain('program_media_terminal');
    expect(await fails(`delete from clinical_core.program_media_artifacts where id=$1`, [id(10)])).toContain('append_only_record');
    await reserve(id(16), { command_id: id(16), sha256: '1'.repeat(64) });
    await db.query(`update clinical_core.program_media_artifacts set state='held',failure='storage_unverified',version=2 where id=$1`, [id(16)]);
    expect(await fails(`update clinical_core.program_media_artifacts set state='ready',object_version='v1',committed_at=clock_timestamp(),version=3 where id=$1`, [id(16)])).toContain('program_media_terminal');
    await reserve(id(17), { command_id: id(17), sha256: '2'.repeat(64) });
    await db.query(`update clinical_core.program_media_artifacts set state='error',failure='store_write_failed',version=2 where id=$1`, [id(17)]);
    await commit(id(17), 3);
  });
  it('allows one committed artifact per clinic, program and bytes', async () => {
    await reserve(id(18), { command_id: id(18) });
    expect(await fails(`update clinical_core.program_media_artifacts set state='ready',object_version='v9',committed_at=clock_timestamp(),version=2 where id=$1`, [id(18)])).toMatch(/unique|duplicate key/);
    await db.query(`update clinical_core.program_media_artifacts set state='abandoned',failure='reservation_expired',version=2 where id=$1`, [id(18)]);
  });
  it('text is supplied material only, follows the kind, and needs a committed artifact', async () => {
    await reserve(id(19), { command_id: id(19), sha256: 'd'.repeat(64) });
    expect(await fails(`update clinical_core.program_media_artifacts set caption_text='x',caption_source='supplied_by_author',caption_format='plain',caption_sha256=$2,version=2 where id=$1`, [id(19), 'e'.repeat(64)])).toMatch(/check/);
    await commit(id(19));
    expect(await fails(`update clinical_core.program_media_artifacts set caption_text='x',caption_source='generated',caption_format='plain',caption_sha256=$2,version=3 where id=$1`, [id(19), 'e'.repeat(64)])).toMatch(/check/);
    expect(await fails(`update clinical_core.program_media_artifacts set caption_text='x',caption_source='supplied_by_author',caption_format='vtt',caption_sha256=$2,version=3 where id=$1`, [id(19), 'e'.repeat(64)])).toMatch(/check/);
    expect(await fails(`update clinical_core.program_media_artifacts set transcript_text='x',transcript_source='supplied_by_author',transcript_format='plain',transcript_sha256=$2,version=3 where id=$1`, [id(19), 'e'.repeat(64)])).toMatch(/check/);
    expect(await fails(`update clinical_core.program_media_artifacts set caption_text='x',version=3 where id=$1`, [id(19)])).toMatch(/check/);
  });
});

describe('publications and events', () => {
  it('a publication names a ready artifact at its current version, its bytes and the activation origin; it is append-only; a retired artifact is not newly published', async () => {
    await reserve(id(20), { command_id: id(20), sha256: 'f'.repeat(64) });
    const url = (k: string) => 'https://media.fictional.example/' + k;
    expect(await fails(`insert into clinical_core.program_media_publications(artifact_id,organization_id,version,sha256,url,published_by) values($1,$2,1,$3,$4,$5)`,
      [id(20), org, 'f'.repeat(64), url(key(id(20), program, 'f'.repeat(64))), staff])).toContain('program_media_not_ready');
    await commit(id(20));
    expect(await fails(`insert into clinical_core.program_media_publications(artifact_id,organization_id,version,sha256,url,published_by) values($1,$2,1,$3,$4,$5)`,
      [id(20), org, 'f'.repeat(64), url(key(id(20), program, 'f'.repeat(64))), staff])).toContain('program_media_version_stale');
    // With the activation row carrying no public origin, no url can match it: nothing is publishable before activation is reviewed.
    expect(await fails(`insert into clinical_core.program_media_publications(artifact_id,organization_id,version,sha256,url,published_by) values($1,$2,2,$3,$4,$5)`,
      [id(20), org, 'f'.repeat(64), url(key(id(20), program, 'f'.repeat(64))), staff])).toContain('program_media_url_mismatch');
    await db.query(`update clinical_core.program_media_activation set public_origin='https://media.fictional.example/'`);
    expect(await fails(`insert into clinical_core.program_media_publications(artifact_id,organization_id,version,sha256,url,published_by) values($1,$2,2,$3,$4,$5)`,
      [id(20), otherOrg, 'f'.repeat(64), url(key(id(20), program, 'f'.repeat(64))), staff])).toContain('program_media_publication_refused');
    expect(await fails(`insert into clinical_core.program_media_publications(artifact_id,organization_id,version,sha256,url,published_by) values($1,$2,2,$3,$4,$5)`,
      [id(20), org, 'f'.repeat(64), 'https://alp-fictional.s3.amazonaws.com/' + key(id(20), program, 'f'.repeat(64)), staff])).toMatch(/check|program_media_url_mismatch/);
    await db.query(`insert into clinical_core.program_media_publications(artifact_id,organization_id,version,sha256,url,published_by) values($1,$2,2,$3,$4,$5)`,
      [id(20), org, 'f'.repeat(64), url(key(id(20), program, 'f'.repeat(64))), staff]);
    expect(await fails(`delete from clinical_core.program_media_publications where artifact_id=$1`, [id(20)])).toContain('append_only_record');
    expect(await fails(`update clinical_core.program_media_publications set version=3 where artifact_id=$1`, [id(20)])).toContain('append_only_record');
    await db.query(`update clinical_core.program_media_artifacts set state='retired',retired_at=clock_timestamp(),version=3 where id=$1`, [id(20)]);
    expect(await fails(`insert into clinical_core.program_media_publications(artifact_id,organization_id,version,sha256,url,published_by) values($1,$2,3,$3,$4,$5)`,
      [id(20), org, 'f'.repeat(64), url(key(id(20), program, 'f'.repeat(64))), staff])).toContain('program_media_not_ready');
    const kept = await db.query<{ version: number }>(`select version::int from clinical_core.program_media_publications where artifact_id=$1`, [id(20)]);
    expect(kept.rows).toEqual([{ version: 2 }]);
    await db.query(`update clinical_core.program_media_activation set public_origin=null`);
  });
  it('events are append-only and name a known event', async () => {
    await db.query(`insert into clinical_core.program_media_events(artifact_id,organization_id,actor_id,event,detail) values($1,$2,$3,'committed','v1')`, [id(20), org, staff]);
    expect(await fails(`insert into clinical_core.program_media_events(artifact_id,organization_id,actor_id,event) values($1,$2,$3,'generated_caption')`, [id(20), org, staff])).toMatch(/check/);
    expect(await fails(`delete from clinical_core.program_media_events where artifact_id=$1`, [id(20)])).toContain('append_only_record');
  });
});
