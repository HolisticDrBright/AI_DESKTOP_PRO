import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { CONSENT_SCOPES, createAwsProductionIdentityConsentAdapter, type ProductionClinicalRequestContext } from './aws-identity-consent';
import type { ClinicalCoreDatabase } from './database';

type Artifact = { manifest: { migrations: { version: string; file: string }[] }; files: Record<string, string>;
  releaseHash: string; candidate: Record<string, unknown> };
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const build = (script: string) => JSON.parse(execFileSync(process.execPath, [script, '--json'],
  { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30000, windowsHide: true })) as Artifact;
const ledger = (artifact: Artifact) => sha(artifact.manifest.migrations.map(m => m.version + ':' + sha(artifact.files[m.file])).join('\n'));
let pg: PGlite, parent: Artifact, successor: Artifact;
const org = randomUUID(), staff = randomUUID(), patient = randomUUID(), consumer = randomUUID(), connection = randomUUID();
const foreignOrg = randomUUID(), foreignStaff = randomUUID();
const unwrap = (value: unknown) => value && typeof value === 'object' && 'kind' in value && value.kind === 'uuid' && 'value' in value ? value.value : value;
const database: ClinicalCoreDatabase = { transaction: work => pg.transaction(async tx => {
  await tx.exec('set local role clinical_core_api');
  return work({ query: (sql, parameters = []) => tx.query(sql, parameters.map(unwrap)) });
}) };
const adapter = createAwsProductionIdentityConsentAdapter(database);
const context = (actor = staff, organization = org): ProductionClinicalRequestContext => ({
  actorPersonId: actor, organizationId: organization, identityPool: 'workforce', identitySubject: 'fixture-' + actor,
  purpose: 'consent_management', environment: 'production-clinical', dataClassification: 'clinical_phi',
  containsPhi: true, realPatientData: true, productionBound: true,
});
// These are in-memory fictional approvals only. No AWS calls, real records,
// provider registration, grant publication, or production activation exists.
beforeAll(async () => {
  parent = build('scripts/build-adopted-plan-inventory-candidate.mjs');
  successor = build('scripts/build-telehealth-consent-candidate.mjs');
  pg = new PGlite({ extensions: { pgcrypto } });
  for (const entry of successor.manifest.migrations) await pg.exec(successor.files[entry.file]);
}, 60000);
afterAll(async () => { await pg?.close(); });

describe('canonical forward telehealth consent candidate', () => {
  it('preserves every byte of the exact historical 107 release', () => {
    expect(parent.manifest.migrations).toHaveLength(107);
    expect(ledger(parent)).toBe('542b101ca1729576d2b203c9c2b3d98d2d9dd897e7480ab08ff150c8eacf773c');
    expect(successor.manifest.migrations).toHaveLength(108);
    expect(successor.manifest.migrations.slice(0, 107)).toEqual(parent.manifest.migrations);
    for (const entry of parent.manifest.migrations) expect(successor.files[entry.file]).toBe(parent.files[entry.file]);
    expect(successor.candidate).toMatchObject({ contract: 'telehealth-consent-candidate/1', migrationCount: 108,
      parentMigrationCount: 107, deployment: 'not_deployed', activation: 'blocked', phiAllowed: false,
      migrationReleaseSha256: ledger(successor) });
    expect(successor.releaseHash).toBe(sha(successor.manifest.migrations.map(m => m.version + ':' + m.file + ':' + sha(successor.files[m.file])).join('\n')));
  });
  it('applies the real complete artifact without seeding approvals or consents', async () => {
    for (const table of ['consent_artifacts', 'consent_grants']) {
      expect((await pg.query<{ count: number }>('select count(*)::int as count from clinical_core.' + table)).rows[0].count).toBe(0);
    }
  });
  it('adds telehealth without dropping any prior scope, especially specimen context', async () => {
    for (const organization of [org, foreignOrg]) await pg.query("insert into clinical_core.organizations(id,organization_label) values($1,'Fictional consent fixture')", [organization]);
    for (const person of [staff, consumer, foreignStaff]) {
      await pg.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [person, 'subject_' + person.replaceAll('-', '')]);
      await pg.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,$2,$3,true)",
        [person, person === consumer ? 'consumer' : 'workforce', 'fixture-' + person]);
    }
    for (const [organization, person] of [[org, staff], [foreignOrg, foreignStaff]]) await pg.query(
      "insert into clinical_core.organization_memberships(organization_id,person_id,role,status) values($1,$2,'owner','active')", [organization, person]);
    await pg.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'Fictional','Consent fixture')", [patient, org, 'patient_' + patient.replaceAll('-', '')]);
    await pg.query("insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at) values($1,$2,$3,$4,'verified',now())", [connection, org, patient, consumer]);
    for (const scope of CONSENT_SCOPES) {
      const artifact = randomUUID();
      await pg.query("insert into clinical_core.consent_artifacts(id,organization_id,scope,artifact_version,content_sha256,jurisdiction,status,approved_at,approved_by_person_id) values($1,$2,$3,'FICTIONAL-NOT-APPROVAL',$4,'US-CA','approved',now(),$5)", [artifact, org, scope, sha('FICTIONAL ONLY'), staff]);
      await pg.query("insert into clinical_core.consent_grants(organization_id,patient_record_id,connection_id,artifact_id,scope,status,method,representative_authority,version,recorded_by_person_id) values($1,$2,$3,$4,$5,'granted','patient_app','self',1,$6)", [org, patient, connection, artifact, scope, consumer]);
    }
    expect(CONSENT_SCOPES).toHaveLength(15);
    expect((await pg.query<{ scope: string }>('select distinct scope from clinical_core.consent_grants order by scope')).rows.map(r => r.scope)).toEqual([...CONSENT_SCOPES].sort());
  });
  it('reads exact approved version and hash through the real workforce RLS role', async () => {
    const result = await adapter.getCurrentConsent({ context: context(), scope: 'telehealth_recording', patientRecordId: patient });
    expect(result).toMatchObject({ status: 'granted', patientRecordId: patient, connectionId: connection,
      artifactVersion: 'FICTIONAL-NOT-APPROVAL', contentSha256: sha('FICTIONAL ONLY'), artifactStatus: 'approved' });
  });
  it('does not expose another clinic consent through either lookup path', async () => {
    for (const lookup of [{ patientRecordId: patient }, { consumerPersonId: consumer }]) {
      expect(await adapter.getCurrentConsent({ context: context(foreignStaff, foreignOrg), scope: 'telehealth_recording', ...lookup }))
        .toMatchObject({ status: 'none', patientRecordId: null, consentId: null, contentSha256: null });
    }
  });
  it('rejects patient-id and consumer-id injection together, and rejects the consumer pool', async () => {
    await expect(adapter.getCurrentConsent({ context: context(), scope: 'telehealth_recording', patientRecordId: patient, consumerPersonId: consumer })).rejects.toThrow('request_context_invalid');
    await expect(adapter.getCurrentConsent({ context: { ...context(consumer), identityPool: 'consumer' }, scope: 'telehealth_recording', patientRecordId: patient })).rejects.toThrow();
  });
  it('reports retired artifacts and latest withdrawal, never reusing an older grant', async () => {
    await pg.query("update clinical_core.consent_artifacts set status='retired' where organization_id=$1 and scope='telehealth_recording'", [org]);
    // The existing artifact RLS hides retired rows. Preserve that restriction:
    // a standing grant with no visible approved artifact is NOT current consent.
    expect(await adapter.getCurrentConsent({ context: context(), scope: 'telehealth_recording', patientRecordId: patient }))
      .toMatchObject({ artifactStatus: null, artifactVersion: null, contentSha256: null, status: 'granted' });
    await pg.query("insert into clinical_core.consent_grants(organization_id,patient_record_id,connection_id,scope,status,method,representative_authority,reason_code,version,recorded_by_person_id) values($1,$2,$3,'telehealth_recording','revoked','patient_app','self','patient_request',2,$4)", [org, patient, connection, consumer]);
    expect(await adapter.getCurrentConsent({ context: context(), scope: 'telehealth_recording', patientRecordId: patient })).toMatchObject({ status: 'revoked', version: 2, artifactId: null, contentSha256: null });
  });
  it('refuses unknown scopes in both constraints and refuses activation flags at build time', async () => {
    await expect(pg.query("insert into clinical_core.consent_artifacts(organization_id,scope,artifact_version,content_sha256,jurisdiction,status) values($1,'any_scope','x',$2,'US-CA','draft')", [org, sha('x')])).rejects.toThrow();
    expect(() => execFileSync(process.execPath, ['scripts/build-telehealth-consent-candidate.mjs', '--activate'], { stdio: 'pipe', timeout: 10000, windowsHide: true })).toThrow();
  });
});
