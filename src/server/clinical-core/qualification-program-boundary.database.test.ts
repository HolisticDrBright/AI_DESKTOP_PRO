import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase } from './database';
import { classifyDatabaseRejection } from './rds-data-database';
import type { ProductionClinicalRequestContext } from './aws-identity-consent';
import { applyProductionClinicalCoreMigrations } from './production-migrations';
import { ProductionProgramAssignmentError } from './production-program-assignments';
import { createProgramAssignments } from './program-assignments';
import { createQualificationProgramAssignments, QUALIFICATION_PROGRAM_BOUNDARY_CANDIDATE_SHA256, QUALIFICATION_PROGRAM_BOUNDARY_ROLLBACK_SHA256,
  QUALIFICATION_PROGRAM_FUNCTIONS, QUALIFICATION_PROGRAM_LEDGER, type QualificationProgramFunctionBinding } from './qualification-program-assignments';
import type { QualificationExecution } from './qualification-execution';
import type { ProgramAssignmentRequest } from '../../contracts/programAssignments';
import type { ProgramBoundCompletionRequest } from '../../contracts/programCompletion';
import { createQualificationProgramHandler, type QualificationProgramBuild } from './qualification-program-api';
import type { ApiGatewayV2Event } from './aws-identity-api';

/**
 * The production program family on the approved 112-migration qualification ledger, opened only by the BLOCKED
 * qualification-program-boundary successor and only for designated fictional subjects, through the API role and the
 * distinct qualification adapter. Both production activation rows stay disabled throughout: that is the point.
 * Fictional clinics, people, subjects, products and addresses only. This is source evidence, not hosted acceptance.
 */
const DIR = 'infra/aws-clinical-core/production-candidates/';
const PARENTS = ['lab-result-transfer-v2.sql', 'lab-observation-attestation.sql', 'production-program-assignments.sql', 'production-program-consumer-boundary.sql'].map(f => DIR + f);
const SUCCESSOR = 'infra/aws-clinical-core/source-candidates/qualification-program-boundary.sql';
const LOGIN = 'infra/aws-clinical-core/source-candidates/qualification-program-api-login.sql';
const LOGIN_ROLLBACK = 'infra/aws-clinical-core/source-candidates/qualification-program-api-login-rollback.sql';
const ROLLBACK = 'infra/aws-clinical-core/source-candidates/qualification-program-boundary-rollback.sql';
const REDEFINED = ['clinical_core.production_program_assignment_request(jsonb)', 'clinical_private.production_program_bounded_complete(jsonb)', 'clinical_core.production_program_bounded_request(jsonb)'];
const OPEN_LINE = '\n  and not clinical_private.program_qualification_open()';
const lf = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
/** prosrc of the last definition of `name` across the files, in apply order: the text between `as $$` and `$$;`. */
function body(name: string, files: readonly string[]): string {
  let found: string | undefined;
  for (const file of files) {
    const text = lf(file);
    for (const m of text.matchAll(new RegExp(`create (?:or replace )?function ${name.replace('.', '\\.')}\\(`, 'g'))) {
      const start = text.indexOf('as $$', m.index!) + 'as $$'.length;
      found = text.slice(start, text.indexOf('$$;', start));
    }
  }
  if (found === undefined) throw new Error('no definition of ' + name);
  return found;
}
const bindings = (files: readonly string[] = [...PARENTS, SUCCESSOR, LOGIN]): QualificationProgramFunctionBinding[] =>
  QUALIFICATION_PROGRAM_FUNCTIONS.map(([name]) => ({ name, bodySha256: sha(body(name, files)) }));

let db: PGlite, org: string, otherOrg: string, staff: string, outsider: string, consumer: string, other: string, patient: string, connection: string,
  program: string, version: string, draft: string, product: string, productVersion: string, batch: string;
const subject = (id: string) => 'fictional-' + id;
const production = (person: string, pool: 'workforce' | 'consumer', organization = org): ProductionClinicalRequestContext => ({
  actorPersonId: person, organizationId: organization, identitySubject: subject(person), identityPool: pool, purpose: 'clinical_data',
  environment: 'production-clinical', dataClassification: 'clinical_phi', productionBound: true, containsPhi: true, realPatientData: true });
const REQUEST_INVALID = /\bprogram_assignment_invalid\b/;
const CONFLICT = /\b(program_assignment_conflict|program_assignment_version_changed|program_assignment_revision_stale|program_review_stale|program_assignment_state_invalid|program_tasks_remaining|program_phase_not_due|program_check_in_required|program_practitioner_review_required|program_clinical_items_held)\b/;
const database: ClinicalCoreDatabase = { transaction: work => db.transaction(async tx => {
  await tx.exec('set local role clinical_program_qualification_api');
  return work({ query: async <Row extends Record<string, unknown>>(sql: string, parameters: readonly unknown[] = []) => {
    try { return await tx.query<Row>(sql, parameters.map(p => p && typeof p === 'object' && 'kind' in p && p.kind === 'uuid' && 'value' in p ? p.value : p)); }
    catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw classifyDatabaseRejection({ name: 'DatabaseErrorException', message }) ?? new ClinicalCoreDatabaseRejection(
        REQUEST_INVALID.test(message) ? 'request_invalid' : CONFLICT.test(message) ? 'conflict' : 'operation_refused');
    }
  } });
}) };
const core = vi.fn<(authorization: string) => Promise<void>>();
let designated: string[] = [];
const policy = (): QualificationExecution => ({ reviewSha256: 'a'.repeat(64), accountId: '588966314750', databaseName: 'clinical_core_qualification', identitySubjects: designated });
const service = (over: Partial<Parameters<typeof createQualificationProgramAssignments>[0]> = {}) =>
  createQualificationProgramAssignments({ database, functions: bindings(), phiAllowed: false, activation: 'blocked', qualification: policy(), verifyConsumerCore: core, ...over });
const call = (input: ProgramAssignmentRequest | ProgramBoundCompletionRequest, context: ProductionClinicalRequestContext = production(consumer, 'consumer')) =>
  service()(context, input, 'Bearer fictional-token');
async function refusal(input: ProgramAssignmentRequest | ProgramBoundCompletionRequest, context: ProductionClinicalRequestContext = production(consumer, 'consumer')) {
  try { await call(input, context); } catch (error) { if (error instanceof ProductionProgramAssignmentError) return error; throw error; }
  throw new Error('expected a refusal');
}
/** The database's own answer to a designated or undesignated caller, past the adapter: the message it raises, or 'served'. */
async function direct(person: string, pool: 'workforce' | 'consumer', request: unknown, organization = org): Promise<string> {
  try {
    await db.transaction(async tx => {
      await tx.exec('set local role clinical_program_qualification_api');
      await tx.query('select clinical_program_qualification.set_request_context($1,$2,$3,$4,$5,$6,$7)', [person, organization, pool, subject(person), 'clinical_data', 'production-clinical', 'clinical_phi']);
      await tx.query('select clinical_program_qualification.bounded_request($1::jsonb)', [JSON.stringify(request)]);
    });
    return 'served';
  } catch (error) { return (error as Error).message; }
}
const lesson = (suffix: string) => ({ id: 'lesson-' + suffix, title: 'Fictional lesson ' + suffix, kind: 'lesson', instructions: 'Read the fictional lesson.', released: true, authorship: 'practitioner_authored' });
const supplement = (purchaseUrl: string | null = null) => ({ id: 'supp-1', title: 'Fictional supplement step', kind: 'supplement', instructions: 'Fictional instruction.', released: true,
  product: { id: 'product-fictional-1', ingredientKeys: ['fictional_other_mineral'], dose: '100 mg', purchaseUrl, catalog: { stableId: 'prd_fictional_magnesium', version: 1, target: 'production-clinical' } } });
const phases = (items: unknown[] = [lesson('a')]) => [{ id: 'phase-1', title: 'Phase one', days: 1, transition: 'scheduled', items }, { id: 'phase-2', title: 'Phase two', days: 1, transition: 'scheduled', items: [lesson('b')] }];
async function publish(content: unknown, versionId = version) {
  await db.query(`update clinical_core.program_versions set content=$2::jsonb,content_sha256=encode(public.digest(convert_to(($2::jsonb)::text,'UTF8'),'sha256'),'hex') where id=$1`,
    [versionId, JSON.stringify({ title: 'Fictional', modules: [], consumerProgram: { title: 'Fictional thyroid guide', phases: content } })]);
}
async function qualificationRow(enabled: boolean, databaseName: string | null = enabled ? 'postgres' : null) {
  await db.query(`update clinical_core.program_qualification_boundary set enabled=$1,database_name=$2,review_sha256=case when $1 then repeat('c',64) else null end,
    reviewed_by=case when $1 then 'FICTIONAL QUALIFICATION REVIEW FIXTURE' else null end,reviewed_at=case when $1 then now() else null end`, [enabled, databaseName]);
}
async function designate(...people: string[]) {
  for (const person of people) await db.query('insert into clinical_core.program_qualification_subjects(identity_subject) values($1) on conflict do nothing', [subject(person)]);
  designated = [...new Set([...designated, ...people.map(subject)])];
}
async function productionRow(table: 'production_program_activation' | 'program_consumer_boundary_activation', enabled: boolean) {
  await db.query(`update clinical_core.${table} set enabled=$1,evidence_sha256=case when $1 then repeat('e',64) else null end,reviewed_by=case when $1 then 'FICTIONAL' else null end,reviewed_at=case when $1 then now() else null end`, [enabled]);
}
const definitions = async () => Object.fromEntries(await Promise.all([...REDEFINED, 'clinical_private.production_program_review(jsonb,jsonb,jsonb)', 'clinical_private.production_program_lab_holds(jsonb,jsonb)']
  .map(async signature => [signature, (await db.query<{ def: string }>('select pg_get_functiondef($1::regprocedure) as def', [signature])).rows[0]!.def])));
async function assign(versionId = version, actor = staff, organization = org) {
  const result = await call({ action: 'assign', connectionId: connection, programVersionId: versionId }, production(actor, 'workforce', organization));
  if (result.action !== 'assign') throw new Error('bad'); return result;
}
async function read(enrollmentId: string, actor = consumer) { const r = await call({ action: 'read', enrollmentId }, production(actor, 'consumer')); if (r.action !== 'read') throw new Error('bad'); return r; }

let parentDefinitions: Record<string, string>, ledgerBefore: string;
beforeAll(async () => {
  const successor = JSON.parse(execFileSync(process.execPath, ['scripts/build-telehealth-consent-copy-candidate.mjs', '--json'], { encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 }));
  expect(successor.candidate).toMatchObject({ migrationCount: QUALIFICATION_PROGRAM_LEDGER.migrationCount, migrationReleaseSha256: QUALIFICATION_PROGRAM_LEDGER.migrationReleaseSha256 });
  db = new PGlite({ extensions: { pgcrypto } });
  const migrations = successor.manifest.migrations.map((entry: { version: string; file: string }) => ({ version: entry.version, name: entry.file.slice(15, -4), sql: successor.files[entry.file], sha256: sha(successor.files[entry.file]) }));
  const admin: ClinicalCoreDatabase = { transaction: work => db.transaction(tx => work({ query: (sql, parameters = []) => tx.query(sql, [...parameters]) as never })) };
  await applyProductionClinicalCoreMigrations(admin, migrations.slice(0, 106));
  // The approved 107->111->112 upgrades as ledger facts in memory only: a forward rehearsal, not a deployed upgrade.
  for (const entry of migrations.slice(106)) {
    await db.exec(entry.sql);
    await db.query('insert into clinical_core.schema_migrations(version,name,sha256) values($1,$2,$3)', [entry.version, entry.name, entry.sha256]);
  }
  for (const parent of PARENTS) await db.exec(lf(parent));
  parentDefinitions = await definitions();
  ledgerBefore = JSON.stringify((await db.query('select version,name,sha256 from clinical_core.schema_migrations order by version')).rows);
  await db.exec(lf(SUCCESSOR));
  const testDatabase = (await db.query<{ name: string }>('select current_database() as name')).rows[0]!.name;
  await db.exec(lf(LOGIN).replace("current_database() <> 'clinical_core_qualification'", `current_database() <> '${testDatabase}'`));
  for (const scope of ['protocols_supplements', 'lab_history']) await db.query(`insert into clinical_private.consumer_storage_consent_releases(scope,version,content,content_sha256,approved_by,approved_at)
    values($1,'program-fixture','FICTIONAL ONLY',encode(public.digest('FICTIONAL ONLY','sha256'),'hex'),'FIXTURE NOT APPROVAL',now()-interval '1 day')`, [scope]);
}, 240_000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  core.mockReset(); core.mockResolvedValue(undefined);
  [org, otherOrg, staff, outsider, consumer, other, patient, connection, program, version, draft, productVersion, batch] = Array.from({ length: 13 }, () => randomUUID());
  product = 'prd_fixture_' + randomUUID().replaceAll('-', '');
  await db.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL CLINIC A'),($2,'FICTIONAL CLINIC B')", [org, otherOrg]);
  for (const [person, pool] of [[staff, 'workforce'], [outsider, 'workforce'], [consumer, 'consumer'], [other, 'consumer']] as const) {
    await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [person, 'subject_' + person.replaceAll('-', '')]);
    await db.query('insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,$2,$3,true)', [person, pool, subject(person)]);
  }
  await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner'),($3,$4,'practitioner')", [org, staff, otherOrg, outsider]);
  for (const owner of [consumer, other]) await db.query("insert into clinical_core.consumer_storage_consents(owner_id,scope,revision,status,release_version) values($1,'protocols_supplements',1,'granted','program-fixture')", [owner]);
  await db.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'FICTIONAL','TEST')", [patient, org, 'patient_fixture_' + patient.replaceAll('-', '')]);
  await db.query("insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at) values($1,$2,$3,$4,'verified',now())", [connection, org, patient, consumer]);
  await db.query(`insert into clinical_reference.catalog_import_batches(id,contract_version,source_package_id,source_package_version,manifest_sha256,environment,status)
    values($1,'FICTIONAL/1',$2,'FICTIONAL/1',$3,'production-clinical','succeeded')`, [batch, 'fixture-' + batch, batch.replaceAll('-', '').repeat(2)]);
  await db.query("insert into clinical_reference.catalog_products(stable_id,review_status,active_version,environment) values($1,'approved',1,'production-clinical')", [product]);
  await db.query(`insert into clinical_reference.catalog_product_versions(id,product_stable_id,version,display_name,product_type,access_tier,direct_order_allowed,label_sha256,content_sha256,clinical_payload,source_refs,review_status,import_batch_id)
    values($1,$2,1,'FICTIONAL magnesium','supplement','open',true,$3,$4,'{}','["fictional-source"]','approved',$5)`, [productVersion, product, 'b'.repeat(64), 'a'.repeat(64), batch]);
  await db.query("insert into clinical_core.programs(id,organization_id,name,status,created_by_person_id) values($1,$2,'FICTIONAL program','active',$3)", [program, org, staff]);
  await db.query(`insert into clinical_core.program_versions(id,organization_id,program_id,version,status,created_by_person_id,approved_by_person_id,approved_at,published_at)
    values($1,$2,$3,1,'published',$4,$4,clock_timestamp(),clock_timestamp()),($5,$2,$3,2,'draft',$4,null,null,null)`, [version, org, program, staff, draft]);
  await publish(phases());
  await productionRow('production_program_activation', false); await productionRow('program_consumer_boundary_activation', false);
  // Each case designates its own fictional people; the Lambda policy admits at most sixteen subjects.
  designated = [];
  await qualificationRow(true); await designate(staff, outsider, consumer, other);
});


describe('the successor preserves its parents and the 112 ledger', () => {
  it('adds no ledger row, changes no other family function, and each redefined function differs from its parent only by the qualification check', async () => {
    expect(JSON.stringify((await db.query('select version,name,sha256 from clinical_core.schema_migrations order by version')).rows)).toBe(ledgerBefore);
    expect((await db.query<{ n: number }>('select count(*)::int n from clinical_core.schema_migrations')).rows[0]!.n).toBe(112);
    const now = await definitions();
    for (const signature of REDEFINED) {
      expect(now[signature]).not.toBe(parentDefinitions[signature]);
      expect(now[signature]!.split(OPEN_LINE).join('')).toBe(parentDefinitions[signature]);
      expect(now[signature]!.split(OPEN_LINE)).toHaveLength(2);
    }
    for (const signature of ['clinical_private.production_program_review(jsonb,jsonb,jsonb)', 'clinical_private.production_program_lab_holds(jsonb,jsonb)'])
      expect(now[signature]).toBe(parentDefinitions[signature]);
  });
  it('ships closed: the qualification row disabled, no designated subject, and both production rows disabled', async () => {
    const fresh = new PGlite({ extensions: { pgcrypto } });
    try {
      // The candidate's own inserted state, read from its text: one disabled row and no subjects.
      expect(lf(SUCCESSOR)).toContain('insert into clinical_core.program_qualification_boundary(singleton,enabled) values(true,false);');
      expect(lf(SUCCESSOR)).not.toMatch(/insert into clinical_core\.program_qualification_subjects/);
      expect(lf(SUCCESSOR)).not.toMatch(/update clinical_core\.(production_program_activation|program_consumer_boundary_activation)/);
    } finally { await fresh.close(); }
    await qualificationRow(false);
    expect(await direct(consumer, 'consumer', { action: 'list' })).toBe('program_boundary_disabled');
  });
  it('is pinned: the reviewed bytes, built on the exact parent candidates', () => {
    expect(sha(lf(SUCCESSOR))).toBe(QUALIFICATION_PROGRAM_BOUNDARY_CANDIDATE_SHA256);
    expect(sha(lf(ROLLBACK))).toBe(QUALIFICATION_PROGRAM_BOUNDARY_ROLLBACK_SHA256);
    for (const parent of PARENTS.slice(2)) expect(lf(SUCCESSOR)).toContain(sha(lf(parent)));
    // The candidate metadata is the same facts, so an operator reading it reads what the tests proved.
    const meta = JSON.parse(lf('infra/aws-clinical-core/source-candidates/qualification-program-boundary.json'));
    expect(meta).toMatchObject({ status: 'BLOCKED', deployment: 'not_deployed', activation: 'blocked', phiAllowed: false, seededSubjects: false, enabledRow: false,
      ledger: { migrationCount: 112, migrationReleaseSha256: QUALIFICATION_PROGRAM_LEDGER.migrationReleaseSha256 },
      successor: { sha256: QUALIFICATION_PROGRAM_BOUNDARY_CANDIDATE_SHA256 }, rollback: { sha256: QUALIFICATION_PROGRAM_BOUNDARY_ROLLBACK_SHA256 } });
    expect(meta.parents.map((p: { file: string; sha256: string }) => [p.file, p.sha256])).toEqual(PARENTS.map(f => [f, sha(lf(f))]));
    expect(meta.functions.map((f: { name: string; bodySha256: string }) => ({ name: f.name, bodySha256: f.bodySha256 })))
      .toEqual(bindings().slice(0, meta.functions.length));
    expect(meta.runtime.environment).toMatchObject({ PHI_ALLOWED: 'false', PROGRAM_ACTIVATION: 'blocked', QUALIFICATION_PROGRAM_BOUNDARY_SHA256: QUALIFICATION_PROGRAM_BOUNDARY_CANDIDATE_SHA256 });
  });
});

describe('qualification opens the family only for designated subjects, with production off', () => {
  it('a designated clinician assigns, the designated owner reads, accepts once, replays as duplicate and completes a lesson against the review shown', async () => {
    const offered = await assign();
    expect(offered).toMatchObject({ state: 'offered', revision: '1', duplicate: false });
    expect(await assign()).toMatchObject({ enrollmentId: offered.enrollmentId, duplicate: true });
    const current = await read(offered.enrollmentId);
    const accepted = await call({ action: 'accept', enrollmentId: offered.enrollmentId, sourceDigest: current.assignment.sourceDigest, expectedRevision: current.assignment.revision, planRevision: current.review.planRevision });
    expect(accepted).toMatchObject({ action: 'accept', state: 'active', revision: '2', duplicate: false });
    const after = await read(offered.enrollmentId);
    expect(await call({ action: 'accept', enrollmentId: offered.enrollmentId, sourceDigest: after.assignment.sourceDigest, expectedRevision: '2', planRevision: after.review.planRevision }))
      .toMatchObject({ duplicate: true, revision: '2' });
    expect(await call({ action: 'complete', enrollmentId: offered.enrollmentId, sourceDigest: after.assignment.sourceDigest, expectedRevision: after.assignment.revision, itemId: 'lesson-a', planRevision: after.review.planRevision }))
      .toMatchObject({ action: 'complete', itemId: 'lesson-a' });
    expect(core).toHaveBeenCalled();
    // Both production rows are still off: this was qualification, not production activation.
    expect((await db.query<{ n: number }>('select count(*)::int n from clinical_core.production_program_activation where enabled')).rows[0]!.n).toBe(0);
    expect((await db.query<{ n: number }>('select count(*)::int n from clinical_core.program_consumer_boundary_activation where enabled')).rows[0]!.n).toBe(0);
  });
  it('an identity that is not designated is refused at both locks: by the adapter before the database, and by the database itself', async () => {
    const offered = await assign();
    const stranger = randomUUID();
    await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [stranger, 'subject_' + stranger.replaceAll('-', '')]);
    await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'consumer',$2,true)", [stranger, subject(stranger)]);
    const spy: ClinicalCoreDatabase = { transaction: vi.fn() };
    await expect(createQualificationProgramAssignments({ database: spy, functions: bindings(), phiAllowed: false, activation: 'blocked', qualification: policy(), verifyConsumerCore: core })(
      production(stranger, 'consumer'), { action: 'list' }, 'Bearer x')).rejects.toMatchObject({ category: 'activation_refused' });
    expect(spy.transaction).not.toHaveBeenCalled();
    // Admitted by a misconfigured Lambda, the database still refuses a subject it was not given.
    expect(await direct(stranger, 'consumer', { action: 'read', enrollmentId: offered.enrollmentId })).toBe('program_boundary_disabled');
  });
  it('qualification and production never coexist: either production row enabled closes qualification', async () => {
    await productionRow('production_program_activation', true);
    expect(await direct(consumer, 'consumer', { action: 'list' })).toBe('program_boundary_disabled');
    await productionRow('production_program_activation', false); await productionRow('program_consumer_boundary_activation', true);
    expect(await direct(consumer, 'consumer', { action: 'list' })).toBe('production_program_disabled');
  });
  it('a qualification row naming another database, or a disabled one, opens nothing', async () => {
    await qualificationRow(true, 'clinical_core_other');
    expect(await direct(consumer, 'consumer', { action: 'list' })).toBe('program_boundary_disabled');
    await qualificationRow(false);
    expect(await direct(consumer, 'consumer', { action: 'list' })).toBe('program_boundary_disabled');
    await qualificationRow(true);
    expect(await direct(consumer, 'consumer', { action: 'list' })).toBe('served');
  });
  it('the program-only role can execute only its two reviewed entry points in the schemas it can use', async () => {
    const { rows } = await db.query<{ signature: string }>(`select p.oid::regprocedure::text as signature
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname in ('clinical_core','clinical_private','clinical_program_qualification')
        and has_schema_privilege('clinical_program_qualification_api',n.oid,'USAGE')
        and has_function_privilege('clinical_program_qualification_api',p.oid,'EXECUTE')
      order by 1`);
    const allowed = new Set([
      'clinical_program_qualification.set_request_context(uuid,uuid,text,text,text,text,text)',
      'clinical_program_qualification.bounded_request(jsonb)',
    ]);
    expect(rows.filter(row => !allowed.has(row.signature)).slice(0, 20)).toEqual([]);
    expect(rows).toHaveLength(allowed.size);
  });
  it('the API role can neither read nor change the qualification row or the subject list, nor call the open check', async () => {
    for (const sql of ['select * from clinical_core.program_qualification_boundary', "update clinical_core.program_qualification_boundary set enabled=true",
      "insert into clinical_core.program_qualification_subjects(identity_subject) values('fictional-intruder-0001')", 'select clinical_private.program_qualification_open()',
      'select clinical_core.production_program_assignment_request($1::jsonb)']) {
      await expect(db.transaction(async tx => { await tx.exec('set local role clinical_core_api'); await tx.query(sql, sql.includes('$1') ? ['{"action":"list"}'] : []); }), sql)
        .rejects.toThrow(/permission denied/);
    }
  });
});

describe('every authority the parents check runs unchanged under qualification', () => {
  it('cross-owner and cross-clinic: another owner cannot read the enrollment, another clinic\'s clinician cannot assign here', async () => {
    const offered = await assign();
    expect((await refusal({ action: 'read', enrollmentId: offered.enrollmentId }, production(other, 'consumer'))).category).toBe('identity_refused');
    expect((await refusal({ action: 'assign', connectionId: connection, programVersionId: version }, production(outsider, 'workforce', otherOrg))).category).toBe('identity_refused');
    expect((await refusal({ action: 'assign', connectionId: connection, programVersionId: version }, production(outsider, 'workforce', org))).category).toBe('identity_refused');
  });
  it('an absent or revoked membership refuses the clinician; a revoked connection or consent refuses the owner', async () => {
    const offered = await assign();
    await db.query("update clinical_core.organization_memberships set status='suspended' where organization_id=$1 and person_id=$2", [org, staff]);
    expect((await refusal({ action: 'status' }, production(staff, 'workforce'))).category).toBe('identity_refused');
    const none = randomUUID();
    await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [none, 'subject_' + none.replaceAll('-', '')]);
    await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'workforce',$2,true)", [none, subject(none)]);
    await designate(none);
    expect((await refusal({ action: 'status' }, production(none, 'workforce'))).category).toBe('identity_refused');
    await db.query("update clinical_core.patient_connections set state='revoked',revoked_at=now() where id=$1", [connection]);
    expect((await refusal({ action: 'read', enrollmentId: offered.enrollmentId })).category).toBe('identity_refused');
    await db.query("update clinical_core.patient_connections set state='verified',revoked_at=null where id=$1", [connection]);
    await db.query("insert into clinical_core.consumer_storage_consents(owner_id,scope,revision,status,release_version) values($1,'protocols_supplements',2,'revoked','program-fixture')", [consumer]);
    expect((await refusal({ action: 'read', enrollmentId: offered.enrollmentId })).category).toBe('consent_refused');
  });
  it('stale binding: a changed published artifact refuses the next assignment, and a stale revision refuses the accept', async () => {
    const offered = await assign();
    const current = await read(offered.enrollmentId);
    await publish(phases([lesson('changed')]));
    expect((await refusal({ action: 'assign', connectionId: connection, programVersionId: version }, production(staff, 'workforce'))).category).toBe('conflict');
    expect(await refusal({ action: 'accept', enrollmentId: offered.enrollmentId, sourceDigest: current.assignment.sourceDigest, expectedRevision: '9', planRevision: current.review.planRevision }))
      .toMatchObject({ category: 'conflict' });
  });
  it('without a governed catalog answer for the owner\'s plan, every supplement step is held and cannot be completed', async () => {
    await publish(phases([lesson('a'), supplement()]));
    const offered = await assign();
    const current = await read(offered.enrollmentId);
    expect(current.review).toMatchObject({ inventoryComplete: false });
    expect(current.review.held).toContain('supp-1');
    expect(current.review.add).not.toContain('supp-1');
    await call({ action: 'accept', enrollmentId: offered.enrollmentId, sourceDigest: current.assignment.sourceDigest, expectedRevision: current.assignment.revision, planRevision: current.review.planRevision });
    const accepted = await read(offered.enrollmentId);
    await call({ action: 'complete', enrollmentId: offered.enrollmentId, sourceDigest: accepted.assignment.sourceDigest, expectedRevision: accepted.assignment.revision, itemId: 'lesson-a', planRevision: accepted.review.planRevision });
    const after = await read(offered.enrollmentId);
    // The parent's contract, unchanged: a held step is not the owner's to complete, and its phase never advances.
    expect((await refusal({ action: 'complete', enrollmentId: offered.enrollmentId, sourceDigest: after.assignment.sourceDigest, expectedRevision: after.assignment.revision, itemId: 'supp-1', planRevision: after.review.planRevision })).category)
      .toBe('identity_refused');
    await db.query("update clinical_core.program_assignments set phase_started_at=now()-interval '2 days',revision=revision+1 where id=$1", [offered.enrollmentId]);
    const due = await read(offered.enrollmentId);
    expect(await refusal({ action: 'advance', enrollmentId: offered.enrollmentId, sourceDigest: due.assignment.sourceDigest, expectedRevision: due.assignment.revision }))
      .toMatchObject({ category: 'conflict', reason: 'program_clinical_items_held' });
  });
  it('a stored purchase destination never leaves, in the owner\'s read or the clinic\'s preview', async () => {
    await publish(phases([supplement('https://fictional-dispensary.example/p/qualification')]));
    const offered = await assign();
    expect(JSON.stringify(await read(offered.enrollmentId))).not.toContain('fictional-dispensary');
    expect(JSON.stringify(await call({ action: 'preview', programVersionId: version }, production(staff, 'workforce')))).not.toContain('fictional-dispensary');
  });
  it('a consumer without current Core is refused before the database is reached', async () => {
    core.mockRejectedValue(new Error('expired'));
    expect((await refusal({ action: 'list' })).category).toBe('entitlement_refused');
  });
});

describe('the qualification adapter is built only for qualification, against the reviewed functions', () => {
  it('refuses PHI, an approved activation, a missing policy, the production account and a malformed binding at construction', () => {
    const base = { database, functions: bindings(), phiAllowed: false, activation: 'blocked', qualification: policy(), verifyConsumerCore: core };
    for (const over of [{ phiAllowed: true }, { activation: 'approved' }, { qualification: undefined }, { qualification: { ...policy(), accountId: '173535830222' } },
      { qualification: { ...policy(), databaseName: 'clinical_core' } }, { qualification: { ...policy(), identitySubjects: [] } }])
      expect(() => createQualificationProgramAssignments({ ...base, ...over } as never), JSON.stringify(over)).toThrow('qualification_program_configuration_invalid');
    expect(() => createQualificationProgramAssignments({ ...base, functions: bindings().slice(1) })).toThrow('qualification_program_binding_invalid');
  });
  it('the binding names the bodies on disk, and a function that differs from the reviewed body refuses every request as unavailable', async () => {
    expect(await call({ action: 'list' })).toMatchObject({ action: 'list' });
    // A Lambda built for another schema identity: it names the parent's entry point, not the successor's.
    const entry = 'clinical_core.production_program_bounded_request';
    const stale = bindings().map(b => b.name === entry ? { ...b, bodySha256: sha(body(entry, PARENTS)) } : b);
    expect(stale.find(b => b.name === entry)!.bodySha256).not.toBe(bindings().find(b => b.name === entry)!.bodySha256);
    await expect(createQualificationProgramAssignments({ database, functions: stale, phiAllowed: false, activation: 'blocked', qualification: policy(), verifyConsumerCore: core })(
      production(consumer, 'consumer'), { action: 'list' }, 'Bearer x')).rejects.toMatchObject({ category: 'service_unavailable' });
    // A database whose function was changed after review: the right binding now refuses too, until it is restored.
    const projection = (await db.query<{ def: string }>("select pg_get_functiondef('clinical_private.production_program_without_destinations(jsonb)'::regprocedure) as def")).rows[0]!.def;
    await db.exec(projection.replace(/\bbegin\b/, 'begin\n -- changed after review'));
    try { expect((await refusal({ action: 'list' })).category).toBe('service_unavailable'); }
    finally { await db.exec(projection); }
    expect(await call({ action: 'list' })).toMatchObject({ action: 'list' });
  });
});

describe('the route and the database function agree on one context and one contract', () => {
  const COMMIT = 'c'.repeat(40);
  const env = (over: Record<string, string | undefined> = {}) => ({
    SOURCE_COMMIT: COMMIT, MIGRATION_RELEASE_SHA256: QUALIFICATION_PROGRAM_LEDGER.migrationReleaseSha256, QUALIFICATION_PROGRAM_BOUNDARY_SHA256: QUALIFICATION_PROGRAM_BOUNDARY_CANDIDATE_SHA256,
    AWS_REGION: 'us-east-2', PHI_ALLOWED: 'false', PROGRAM_ACTIVATION: 'blocked', DEPLOYMENT_ACCOUNT_ID: '588966314750',
    CONSUMER_ISSUER: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_fictionalConsumer', CONSUMER_AUDIENCE: 'fictionalconsumerclient000000',
    WORKFORCE_ISSUER: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_fictionalWorkforce', WORKFORCE_AUDIENCE: 'fictionalworkforceclient00000',
    QUALIFICATION_PROGRAM_ORGANIZATION_ID: org, QUALIFICATION_EXECUTION: 'enabled', QUALIFICATION_REVIEW_SHA256: 'a'.repeat(64), QUALIFICATION_ACCOUNT_ID: '588966314750',
    CLINICAL_DATABASE_NAME: 'clinical_core_qualification', CLINICAL_DATABASE_CLUSTER_ARN: 'arn:aws:rds:us-east-2:588966314750:cluster:fictional-qualification',
    CLINICAL_DATABASE_SECRET_ARN: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:alp-qualification-program-api-db-fictional', QUALIFICATION_IDENTITY_SUBJECTS: designated.join(','), ...over });
  const build = (over: Partial<QualificationProgramBuild> = {}): QualificationProgramBuild => ({ sourceCommit: COMMIT, sourceClean: true, migrationCount: 112,
    migrationReleaseSha256: QUALIFICATION_PROGRAM_LEDGER.migrationReleaseSha256, boundaryCandidateSha256: QUALIFICATION_PROGRAM_BOUNDARY_CANDIDATE_SHA256, functions: bindings(), ...over });
  const factory = vi.fn(() => database);
  const handler = (e = env(), b = build()) => createQualificationProgramHandler(e, b, { databaseFactory: factory, verifyConsumerCore: core });
  const seconds = () => Math.floor(Date.now() / 1000);
  const consumerEvent = (person: string, body: unknown, over: Record<string, unknown> = {}): ApiGatewayV2Event => ({ routeKey: 'POST /clinical-core/consumer/programs',
    headers: { 'content-type': 'application/json', authorization: 'Bearer fictional-consumer-token' }, body: JSON.stringify(body),
    requestContext: { authorizer: { jwt: { claims: { iss: env().CONSUMER_ISSUER, aud: env().CONSUMER_AUDIENCE, token_use: 'id', email_verified: 'true', 'custom:production_bound': 'true',
      sub: subject(person), 'custom:person_id': person, 'custom:organization_id': org, iat: seconds() - 10, exp: seconds() + 600, ...over } } } } } as never);
  const workforceEvent = (person: string, body: unknown): ApiGatewayV2Event => ({ routeKey: 'POST /clinical-core/workforce/programs',
    headers: { 'content-type': 'application/json', authorization: 'Bearer fictional-workforce-token' }, body: JSON.stringify(body),
    requestContext: { authorizer: { jwt: { claims: { iss: env().WORKFORCE_ISSUER, aud: env().WORKFORCE_AUDIENCE, token_use: 'id', email_verified: 'true', 'custom:production_bound': 'true',
      sub: subject(person), 'custom:person_id': person, 'custom:organization_id': org, iat: seconds() - 10, exp: seconds() + 600, auth_time: seconds() - 20 } } } } } as never);
  beforeEach(() => { factory.mockClear(); });

  it('a designated clinician assigns and the designated owner lists, through the routes, with every answer marked as qualification', async () => {
    const assigned = await handler()(workforceEvent(staff, { action: 'assign', connectionId: connection, programVersionId: version }));
    expect(assigned.statusCode, assigned.body).toBe(200);
    expect(assigned.headers?.['x-clinical-execution']).toBe('qualification');
    const listed = await handler()(consumerEvent(consumer, { action: 'list' }));
    expect(listed.statusCode, listed.body).toBe(200);
    expect(JSON.parse(listed.body!).data.assignments).toHaveLength(1);
    expect(core).toHaveBeenCalledWith('Bearer fictional-consumer-token');
  });
  it('an undesignated subject, a synthetic-attested token, an unknown route and a query string are refused without the family answering', async () => {
    const stranger = randomUUID();
    expect(JSON.parse((await handler()(consumerEvent(stranger, { action: 'list' }))).body!)).toEqual({ error: 'production_not_activated', phiAllowed: false });
    expect((await handler()(consumerEvent(consumer, { action: 'list' }, { 'custom:synthetic_attested': 'true' }))).statusCode).toBe(401);
    expect((await handler()({ ...consumerEvent(consumer, { action: 'list' }), routeKey: 'POST /clinical-core/consumer/program-step-purchase' } as never)).statusCode).toBe(404);
    expect((await handler()({ ...consumerEvent(consumer, { action: 'list' }), queryStringParameters: { connectionId: connection } } as never)).statusCode).toBe(400);
  });
  it('a deployment that is not exactly qualification answers 503 to everything and never creates a data client', async () => {
    const bad: Array<[string, Record<string, string | undefined>, Partial<QualificationProgramBuild>]> = [
      ['PHI allowed', { PHI_ALLOWED: 'true' }, {}], ['program activation approved', { PROGRAM_ACTIVATION: 'approved' }, {}],
      ['qualification execution off', { QUALIFICATION_EXECUTION: 'disabled' }, {}], ['the production account', { DEPLOYMENT_ACCOUNT_ID: '173535830222', QUALIFICATION_ACCOUNT_ID: '173535830222' }, {}],
      ['a non-qualification database', { CLINICAL_DATABASE_NAME: 'clinical_core' }, {}], ['another ledger release', { MIGRATION_RELEASE_SHA256: 'f'.repeat(64) }, {}],
      ['the 106 ledger', {}, { migrationCount: 106 }], ['another boundary candidate', {}, { boundaryCandidateSha256: 'f'.repeat(64) }],
      ['a dirty build', {}, { sourceClean: false }], ['another source commit', { SOURCE_COMMIT: 'd'.repeat(40) }, {}],
      ['no designated subject', { QUALIFICATION_IDENTITY_SUBJECTS: '' }, {}], ['a malformed function binding', {}, { functions: bindings().slice(1) }],
      ['the managed master credential', { CLINICAL_DATABASE_SECRET_ARN: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:rds!cluster-fictional' }, {}],
    ];
    for (const [label, envOver, buildOver] of bad) {
      const answer = await handler(env(envOver), build(buildOver))(consumerEvent(consumer, { action: 'list' }));
      expect(answer.statusCode, label).toBe(503);
      expect(JSON.parse(answer.body!), label).toEqual({ error: 'service_unavailable' });
      expect(answer.headers?.['x-clinical-execution'], label).toBeUndefined();
    }
    expect(factory).not.toHaveBeenCalled();
  });
});

describe('the rollback', () => {
  it('restores the three parent definitions exactly, removes only what the successor created, and closes qualification', async () => {
    const offered = await assign();
    await db.exec(lf(ROLLBACK));
    const now = await definitions();
    for (const signature of REDEFINED) expect(now[signature]).toBe(parentDefinitions[signature]);
    expect((await db.query("select to_regclass('clinical_core.program_qualification_boundary')::text t, to_regclass('clinical_core.program_qualification_subjects')::text s, to_regprocedure('clinical_private.program_qualification_open()')::text f")).rows[0])
      .toEqual({ t: null, s: null, f: null });
    expect(await direct(consumer, 'consumer', { action: 'read', enrollmentId: offered.enrollmentId })).toBe('program_boundary_disabled');
    // The enrollment the successor's journey wrote is still there: a rollback removes access, never records.
    expect((await db.query<{ n: number }>('select count(*)::int n from clinical_core.program_assignments where id=$1', [offered.enrollmentId])).rows[0]!.n).toBe(1);
    expect(JSON.stringify((await db.query('select version,name,sha256 from clinical_core.schema_migrations order by version')).rows)).toBe(ledgerBefore);
    // The mismatch this successor closes, on the same 112 ledger (the failing-before evidence): the projected candidate's
    // synthetic adapter refuses the production-shaped context, and a synthetic one is refused by the production database
    // itself, which has no synthetic family to reach in any case.
    await expect(createProgramAssignments(database)(production(consumer, 'consumer'), { action: 'list' })).rejects.toMatchObject({ category: 'identity_refused' });
    await expect(createProgramAssignments(database)({ actorPersonId: consumer, organizationId: org, identitySubject: subject(consumer), identityPool: 'consumer', purpose: 'clinical_data',
      environment: 'synthetic-staging', dataClassification: 'synthetic_only', containsPhi: false, realPatientData: false }, { action: 'list' })).rejects.toMatchObject({ category: 'identity_refused' });
    expect((await db.query("select to_regprocedure('clinical_core.program_assignment_request(jsonb)')::text f, to_regclass('clinical_core.synthetic_desktop_program_versions')::text t")).rows[0]).toEqual({ f: null, t: null });
    await db.exec(lf(SUCCESSOR));
  });
  it('removes the inactive proxy credential candidate without changing the 112 ledger or clinical records', async () => {
    const databaseName = (await db.query<{ name: string }>('select current_database() as name')).rows[0]!.name;
    const recordsBefore = (await db.query<{ count: number }>('select count(*)::int as count from clinical_core.program_assignments')).rows[0]!.count;
    const ledger = JSON.stringify((await db.query('select version,name,sha256 from clinical_core.schema_migrations order by version')).rows);
    const original = (await db.query<{ definition: string }>(`select pg_get_functiondef(
      'clinical_private.set_request_context(uuid,uuid,text,text,text,text,text)'::regprocedure) as definition`)).rows[0]!.definition;
    await db.exec(lf(LOGIN_ROLLBACK).replace("current_database() <> 'clinical_core_qualification'", `current_database() <> '${databaseName}'`));
    expect((await db.query("select count(*)::int as count from pg_roles where rolname like 'clinical_program_qualification_%'")).rows[0]).toEqual({ count: 0 });
    expect((await db.query("select count(*)::int as count from pg_namespace where nspname='clinical_program_qualification'")).rows[0]).toEqual({ count: 0 });
    expect((await db.query<{ count: number }>('select count(*)::int as count from clinical_core.program_assignments')).rows[0]!.count).toBe(recordsBefore);
    expect(JSON.stringify((await db.query('select version,name,sha256 from clinical_core.schema_migrations order by version')).rows)).toBe(ledger);
    expect((await db.query<{ definition: string }>(`select pg_get_functiondef(
      'clinical_private.set_request_context(uuid,uuid,text,text,text,text,text)'::regprocedure) as definition`)).rows[0]!.definition).toBe(original);
  });
});
