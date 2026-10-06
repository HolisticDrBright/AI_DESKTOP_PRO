import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { clinicalUuid, ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase, type ClinicalCoreTransaction } from './database';
import type { ProductionClinicalRequestContext } from './aws-identity-consent';
import { createProductionCareConnections } from './production-care-connections';
import { parseCareConnectionResponse, type CareConnectionRequest } from '../../contracts/careConnections';
import { createProductionCareMessaging } from './production-care-messaging';

// Real 104 production migrations plus the unreleased port; fictional data only.
// PGlite serializes transactions. These are not multi-session AWS race tests.
let db: PGlite;
let org: string, foreignOrg: string, owner: string, other: string, staff: string, outsider: string, patient: string;
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const subject = (id: string) => 'subject-' + id;
const copy = 'I agree to share FICTIONAL TEST messages with this FICTIONAL clinic. No real personal or health data.';
const context = (person: string, pool: 'consumer' | 'workforce', purpose: ProductionClinicalRequestContext['purpose'], organization = org): ProductionClinicalRequestContext => ({
  actorPersonId: person, identityPool: pool, identitySubject: subject(person), organizationId: organization, purpose,
  environment: 'production-clinical', dataClassification: 'clinical_phi', containsPhi: true, realPatientData: true, productionBound: true,
});
const database: ClinicalCoreDatabase = { transaction: work => db.transaction(async tx => {
  await tx.exec('set local role clinical_core_api');
  const query: ClinicalCoreTransaction['query'] = async (sql, args = []) => {
    try { return await tx.query(sql, args.map(v => v && typeof v === 'object' && 'kind' in v && v.kind === 'uuid' && 'value' in v ? v.value : v)); }
    catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (/care_connection_invalid/.test(message)) throw new ClinicalCoreDatabaseRejection('request_invalid');
      if (/care_connection_conflict/.test(message)) throw new ClinicalCoreDatabaseRejection('conflict');
      if (/care_connection_approved_copy_required/.test(message)) throw new ClinicalCoreDatabaseRejection('consent_required');
      if (/owned_account_deletion_write_blocked/.test(message)) throw new ClinicalCoreDatabaseRejection('account_deletion_write_blocked');
      if (/care_connection_refused|request_context_refused|care_message_refused/.test(message)) throw new ClinicalCoreDatabaseRejection('identity_refused');
      if (/care_message_consent_required/.test(message)) throw new ClinicalCoreDatabaseRejection('consent_required');
      throw error;
    }
  };
  return work({ query });
}) };
const operations = createProductionCareConnections(database);
const call = (request: CareConnectionRequest, person = owner, organization = org) => operations(context(person,
  request.action === 'issue' ? 'workforce' : 'consumer', request.action === 'issue' ? 'clinical_data'
    : request.action === 'claim' ? 'identity_link' : 'consent_management', organization), request);
async function issue(person = staff) {
  const request = { action: 'issue' as const, patientRecordId: patient };
  return parseCareConnectionResponse(request, await call(request, person)) as { token: string; connectionId: string; invitationId: string };
}
async function connected() {
  const invitation = await issue(); await call({ action: 'claim', token: invitation.token }); return invitation.connectionId;
}
async function artifact(version = 'FICTIONAL-test/1', text = copy, withText = true) {
  const id = randomUUID();
  await db.query(`insert into clinical_core.consent_artifacts(id,organization_id,scope,artifact_version,content_sha256,jurisdiction,
    status,approved_at,approved_by_person_id) values($1,$2,'messaging',$3,$4,'TEST','approved',clock_timestamp(),$5)`, [id, org, version, sha(text), staff]);
  if (withText) await db.query('insert into clinical_core.care_consent_texts(artifact_id,organization_id,content,content_sha256) values($1,$2,$3,$4)', [id, org, text, sha(text)]);
  return id;
}
const grant = (connectionId: string, artifactId: string, expectedVersion = 0, text = copy): CareConnectionRequest => ({
  action: 'grant', connectionId, scope: 'messaging', artifactId, contentSha256: sha(text), expectedVersion,
});
const review = (connectionId: string): CareConnectionRequest => ({ action: 'consent', connectionId, scope: 'messaging' });
const withdraw = (connectionId: string, expectedVersion: number): CareConnectionRequest => ({ action: 'withdraw', connectionId, scope: 'messaging', expectedVersion });
beforeAll(async () => {
  const { manifest, files } = JSON.parse(execFileSync(process.execPath, ['scripts/build-aws-production-clinical-core.mjs', '--json'],
    { encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024 }));
  expect(manifest.migrations).toHaveLength(104); // Historical release unchanged by this candidate.
  db = new PGlite({ extensions: { pgcrypto } });
  for (const migration of manifest.migrations) await db.exec(files[migration.file]);
  await db.exec(readFileSync('infra/aws-clinical-core/production-candidates/care-connections.sql', 'utf8'));
}, 60000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  [org, foreignOrg, owner, other, staff, outsider, patient] = Array.from({ length: 7 }, () => randomUUID());
  for (const id of [org, foreignOrg]) await db.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL TEST CLINIC')", [id]);
  for (const [id, pool] of [[owner, 'consumer'], [other, 'consumer'], [staff, 'workforce'], [outsider, 'workforce']]) {
    await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [id, 'subject_' + id.replaceAll('-', '')]);
    await db.query('insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,$2,$3,true)', [id, pool, subject(id)]);
  }
  await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner')", [org, staff]);
  await db.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'FICTIONAL','TEST')", [patient, org, 'patient_' + patient.replaceAll('-', '')]);
});

describe('unreleased production connection and consent port, actual API role and SQL', () => {
  it('extends the real canonical inventory without seeding copy, approval, identity or grants', async () => {
    // Before this test creates any fixture connection or consent, the candidate
    // itself must have added only the declared table and zero release rows.
    const tables = await db.query<{ name: string }>(`select n.nspname||'.'||c.relname as name
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r'
      and n.nspname in ('clinical_core','clinical_private','clinical_audit','clinical_reference','commercial_reference')
      and not(n.nspname='clinical_core' and c.relname='schema_migrations')`);
    expect(tables.rows).toHaveLength(207);
    expect(tables.rows.filter(t => t.name === 'clinical_core.care_consent_texts')).toHaveLength(1);
    expect((await db.query<{ n: number }>('select count(*)::int n from clinical_core.care_consent_texts')).rows[0].n).toBe(0);
  });
  it.each([
    null, [], { action: null }, { action: 'connection', extra: true },
    { action: 'issue', patientRecordId: null }, { action: 'issue', patientRecordId: 'bad-id' },
    { action: 'claim', token: 123 }, { action: 'claim', token: null },
    { action: 'consent', connectionId: null, scope: 'messaging' },
    { action: 'consent', connectionId: 'bad-id', scope: ['messaging'] },
    { action: 'grant', connectionId: randomUUID(), scope: 'messaging', artifactId: null, contentSha256: null, expectedVersion: 0 },
  ])('refuses malformed raw SQL requests without relying on the TypeScript schema: %j', async request => {
    await expect(database.transaction(async tx => {
      const c = context(owner, 'consumer', request && !Array.isArray(request) && request.action === 'claim' ? 'identity_link' : 'consent_management');
      await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)', [clinicalUuid(owner), clinicalUuid(org), c.identityPool,
        c.identitySubject, c.purpose, c.environment, c.dataClassification]);
      await tx.query('select clinical_core.production_care_connection_request($1::jsonb)', [JSON.stringify(request)]);
    })).rejects.toThrow('request_invalid');
  });
  it('refuses a direct SQL call without verified request context', async () => {
    await expect(database.transaction(tx => tx.query("select clinical_core.production_care_connection_request('{\"action\":\"connection\"}'::jsonb)")))
      .rejects.toThrow('identity_refused');
  });
  it('issues a 13-symbol code, stores only its hash, claims once and discovers only the owner link', async () => {
    expect(await call({ action: 'connection' })).toEqual({ connection: null });
    const invitation = await issue(); expect(invitation.token).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{13}$/);
    const row = (await db.query('select token_hash from clinical_core.connection_invitations where id=$1', [invitation.invitationId])).rows[0];
    expect(row).toEqual({ token_hash: sha(invitation.token) });
    const pretty = invitation.token.slice(0, 4) + '-' + invitation.token.slice(4, 8) + '-' + invitation.token.slice(8);
    expect(await call({ action: 'claim', token: pretty.toLowerCase() })).toMatchObject({ connectionId: invitation.connectionId, state: 'verified', version: 2 });
    expect(await call({ action: 'connection' })).toMatchObject({ connection: { connectionId: invitation.connectionId } });
    expect(await call({ action: 'connection' }, other)).toEqual({ connection: null });
    await expect(call({ action: 'claim', token: invitation.token })).rejects.toThrow('identity_refused');
    const audit = (await db.query('select safe_metadata from clinical_audit.events where resource_id=$1', [invitation.connectionId])).rows;
    expect(audit).toHaveLength(2); expect(JSON.stringify(audit)).not.toContain(invitation.token); expect(JSON.stringify(audit)).not.toContain(sha(invitation.token));
  });
  it('uses the same safer issuance implementation for the existing Desktop contract', async () => {
    const result = await database.transaction(async tx => {
      const c = context(staff, 'workforce', 'clinical_data');
      await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)', [clinicalUuid(staff), clinicalUuid(org), c.identityPool, c.identitySubject, c.purpose, c.environment, c.dataClassification]);
      return (await tx.query<{ data: { token: string } }>('select clinical_core.create_sync_invitation($1,$2) as data', [clinicalUuid(org), clinicalUuid(patient)])).rows[0].data;
    });
    expect(result.token).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{13}$/);
  });
  it('supersedes a previous pending code without creating another live patient link', async () => {
    const first = await issue(), second = await issue();
    expect(second.connectionId).toBe(first.connectionId); expect(second.token).not.toBe(first.token);
    await expect(call({ action: 'claim', token: first.token })).rejects.toThrow('identity_refused');
    await call({ action: 'claim', token: second.token });
    await expect(call({ action: 'claim', token: second.token }, other)).rejects.toThrow('identity_refused');
    await expect(issue()).rejects.toThrow('conflict');
  });
  it.each(['expired', 'revoked', 'foreign-org', 'archived-patient'])('refuses %s invitation claims without binding an owner', async fault => {
    const invitation = await issue();
    if (fault === 'expired') await db.query("update clinical_core.connection_invitations set expires_at=clock_timestamp()-interval '1 second' where id=$1", [invitation.invitationId]);
    if (fault === 'revoked') await db.query("update clinical_core.connection_invitations set status='revoked' where id=$1", [invitation.invitationId]);
    if (fault === 'archived-patient') await db.query("update clinical_core.patient_records set status='archived' where id=$1", [patient]);
    await expect(call({ action: 'claim', token: invitation.token }, owner, fault === 'foreign-org' ? foreignOrg : org)).rejects.toThrow('identity_refused');
    expect((await db.query('select consumer_person_id,state from clinical_core.patient_connections where id=$1', [invitation.connectionId])).rows[0])
      .toEqual({ consumer_person_id: null, state: 'invitation_pending' });
  });
  it('refuses unregistered staff, wrong clinic, suspended membership and the wrong identity pool', async () => {
    await expect(issue(outsider)).rejects.toThrow('identity_refused');
    await expect(call({ action: 'issue', patientRecordId: patient }, staff, foreignOrg)).rejects.toThrow('identity_refused');
    await db.query("update clinical_core.organization_memberships set status='suspended' where person_id=$1", [staff]);
    await expect(issue()).rejects.toThrow('identity_refused');
    await expect(operations(context(owner, 'consumer', 'clinical_data'), { action: 'issue', patientRecordId: patient })).rejects.toThrow('identity_refused');
  });
  it('keeps approved text immutable, verifies bytes, and never substitutes metadata for a copy', async () => {
    const connection = await connected(), id = await artifact();
    expect(await call(review(connection))).toMatchObject({ status: 'not_granted', version: 0, artifact: { artifactId: id, content: copy, contentSha256: sha(copy) } });
    await expect(db.query('update clinical_core.care_consent_texts set content=$1 where artifact_id=$2', ['changed', id])).rejects.toThrow('append_only_record');
    await expect(db.query('update clinical_core.consent_artifacts set content_sha256=$1 where id=$2', ['a'.repeat(64), id])).rejects.toThrow('care_connection_artifact_immutable');
    const newer = await artifact('FICTIONAL-test/2', 'Newer FICTIONAL copy', false);
    expect(newer).not.toBe(id);
    expect(await call(review(connection))).toMatchObject({ artifact: null });
    await expect(call(grant(connection, id))).rejects.toThrow('consent_required');
  });
  it('rejects an unapproved copy or mismatched hash before insertion', async () => {
    const id = await artifact('FICTIONAL-test/1', copy, false);
    await expect(db.query('insert into clinical_core.care_consent_texts(artifact_id,organization_id,content,content_sha256) values($1,$2,$3,$4)', [id, org, 'Different copy', sha('Different copy')]))
      .rejects.toThrow('care_connection_approved_copy_required');
    await db.query("update clinical_core.consent_artifacts set status='retired' where id=$1", [id]);
    await expect(db.query('insert into clinical_core.care_consent_texts(artifact_id,organization_id,content,content_sha256) values($1,$2,$3,$4)', [id, org, copy, sha(copy)]))
      .rejects.toThrow('care_connection_approved_copy_required');
  });
  it('records one self grant, idempotent exact repetition and a withdrawal without resurrecting it on late replay', async () => {
    const connection = await connected(), id = await artifact(), request = grant(connection, id);
    expect(await call(request)).toMatchObject({ status: 'granted', version: 1, alreadyApplied: false });
    expect(await call(request)).toMatchObject({ status: 'granted', version: 1, alreadyApplied: true });
    expect(await call(withdraw(connection, 1))).toMatchObject({ status: 'revoked', version: 2, alreadyApplied: false });
    expect(await call(withdraw(connection, 1))).toMatchObject({ status: 'revoked', version: 2, alreadyApplied: true });
    await expect(call(request)).rejects.toThrow('conflict');
    expect(await call(grant(connection, id, 2))).toMatchObject({ status: 'granted', version: 3 });
    await expect(call(withdraw(connection, 1))).rejects.toThrow('conflict');
    const rows = (await db.query<{ status: string; version: number; method: string; representative_authority: string }>('select status,version,method,representative_authority from clinical_core.consent_grants where connection_id=$1 order by version', [connection])).rows;
    expect(rows.map(r => [r.status, r.version])).toEqual([['granted', 1], ['revoked', 2], ['granted', 3]]);
    expect(rows.every(r => r.method === 'patient_app' && r.representative_authority === 'self')).toBe(true);
  });
  it('requires the current exact approved artifact and displayed content hash', async () => {
    const connection = await connected(), first = await artifact();
    const changed = { ...grant(connection, first), contentSha256: 'a'.repeat(64) };
    await expect(call(changed)).rejects.toThrow('conflict');
    const secondCopy = 'New FICTIONAL terms', second = await artifact('FICTIONAL-test/2', secondCopy);
    await expect(call(grant(connection, first))).rejects.toThrow('conflict');
    expect(await call(grant(connection, second, 0, secondCopy))).toMatchObject({ version: 1 });
    await db.query("update clinical_core.consent_artifacts set status='retired' where id=$1", [second]);
    await expect(db.query("update clinical_core.consent_artifacts set status='approved' where id=$1", [second])).rejects.toThrow('care_connection_artifact_immutable');
  });
  it('denies another owner and another clinic every consent operation', async () => {
    const connection = await connected(), id = await artifact();
    for (const request of [review(connection), grant(connection, id), withdraw(connection, 0)]) {
      await expect(call(request, other)).rejects.toThrow('identity_refused');
      await expect(call(request, owner, foreignOrg)).rejects.toThrow('identity_refused');
    }
    expect((await db.query<{ n: number }>('select count(*)::int n from clinical_core.consent_grants where connection_id=$1', [connection])).rows[0].n).toBe(0);
  });
  it('refuses a paused or revoked link for new grants, retaining withdrawal and status access', async () => {
    const connection = await connected(), id = await artifact(); await call(grant(connection, id));
    await db.query("update clinical_core.patient_connections set state='paused',paused_at=clock_timestamp() where id=$1", [connection]);
    await expect(call(grant(connection, id, 1))).rejects.toThrow('identity_refused');
    expect(await call(withdraw(connection, 1))).toMatchObject({ version: 2 });
    await db.query("update clinical_core.patient_connections set state='revoked',paused_at=null,revoked_at=clock_timestamp() where id=$1", [connection]);
    expect(await call({ action: 'connection' })).toEqual({ connection: null });
    expect(await call(review(connection))).toMatchObject({ status: 'revoked', connectionState: 'revoked' });
  });
  it('fences new grants during account deletion, without blocking withdrawal', async () => {
    const connection = await connected(), id = await artifact(); await call(grant(connection, id));
    await db.query("insert into clinical_private.owned_privacy_requests(owner_id,request_id,kind,status) values($1,$2,'deletion','submitted')", [owner, randomUUID()]);
    await expect(call(grant(connection, id, 1))).rejects.toThrow('account_deletion_write_blocked');
    expect(await call(withdraw(connection, 1))).toMatchObject({ status: 'revoked' });
  });
  it('refuses new consent for an archived chart while keeping withdrawal and history available', async () => {
    const connection = await connected(), id = await artifact(); await call(grant(connection, id));
    await db.query("update clinical_core.patient_records set status='archived' where id=$1", [patient]);
    await expect(call(grant(connection, id, 1))).rejects.toThrow('identity_refused');
    expect(await call(review(connection))).toMatchObject({ status: 'granted' }); // recorded history, not permission to share
    expect(await call(withdraw(connection, 1))).toMatchObject({ status: 'revoked' });
    expect(await call({ action: 'connection' })).toEqual({ connection: null });
  });
  it('connects the actual self grant and withdrawal to the canonical messaging gate', async () => {
    const connection = await connected(), id = await artifact();
    const messages = createProductionCareMessaging(database), who = context(owner, 'consumer', 'clinical_data');
    const send = { action: 'send', connectionId: connection, requestId: randomUUID(), subject: 'FICTIONAL question', body: 'FICTIONAL TEST ONLY', acknowledgement: 'care-messages/1' };
    await expect(messages(who, send)).rejects.toThrow('consent_required');
    await call(grant(connection, id));
    expect(await messages(who, send)).toMatchObject({ status: 'stored' });
    await call(withdraw(connection, 1));
    await expect(messages(who, { ...send, requestId: randomUUID() })).rejects.toThrow('consent_required');
  });
  it('gives the API role no direct copy or approval writes and exposes no private helper', async () => {
    await expect(database.transaction(tx => tx.query('select * from clinical_core.care_consent_texts'))).rejects.toThrow('permission denied');
    await expect(database.transaction(tx => tx.query("select clinical_private.care_connection_actor('consumer','consent_management')"))).rejects.toThrow('permission denied');
    const result = await db.query(`select c.relrowsecurity,c.relforcerowsecurity,
      has_table_privilege('clinical_core_api',c.oid,'SELECT,INSERT,UPDATE,DELETE') as direct
      from pg_class c where c.oid='clinical_core.care_consent_texts'::regclass`);
    expect(result.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true, direct: false });
  });
  it('rechecks disabled identities and refuses unknown/supplied-authority request keys', async () => {
    const connection = await connected(); await db.query("update clinical_core.identities set status='disabled' where person_id=$1", [owner]);
    await expect(call(review(connection))).rejects.toThrow('identity_refused');
    await expect(operations(context(other, 'consumer', 'consent_management'), { action: 'connection', ownerId: owner })).rejects.toThrow('request_invalid');
  });
});
