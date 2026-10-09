import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import type { ClinicalCoreDatabase, ClinicalCoreTransaction } from './database';
import type { ClinicalCoreMigration } from './migrations';
import { applyProductionClinicalCoreMigrations } from './production-migrations';
import { CARE_CLAIM_RECOVERY_UPGRADE } from './care-claim-recovery-schema-upgrade';
import type { QualificationUpgradeConfiguration } from './qualification-schema-upgrade';
import { parseCareConsentCopy, runCareConsentCopyRegistration, type CareConsentCopy, type CareConsentCopyMode } from './care-consent-copy-registration';

// Canonical SQL, triggers, privileges and rollback run in real embedded Postgres.
// Only current_database() is substituted. This is not concurrent or hosted evidence.
let pg: PGlite, migrations: ClinicalCoreMigration[], copy: CareConsentCopy, staff: string;
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const text = 'FICTIONAL consent only. No real personal or health data.\nExact copy — reviewed elsewhere.';
const configuration: QualificationUpgradeConfiguration = { expectedAccountId: '588966314750', region: 'us-east-2', phiAllowed: false,
  activation: 'blocked', clusterArn: 'arn:aws:rds:us-east-2:588966314750:cluster:synthetic-test',
  secretArn: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:synthetic-test',
  qualificationDatabaseName: 'clinical_core_qualification', stagingDatabaseName: 'clinical_core',
  fromReleaseSha256: CARE_CLAIM_RECOVERY_UPGRADE.from, toReleaseSha256: CARE_CLAIM_RECOVERY_UPGRADE.to };
type Intercept = (sql: string, tx: { query: (sql: string, args?: unknown[]) => Promise<unknown> }) => Promise<void>;
const database = (intercept?: Intercept, name = 'clinical_core_qualification'): ClinicalCoreDatabase => ({
  transaction: work => pg.transaction(async tx => work({ query: async (sql: string, args: readonly unknown[] = []) => {
    if (intercept) await intercept(sql, tx);
    if (sql === 'select current_database() as name') return { rows: [{ name }] };
    return tx.query(sql, args.map(v => v && typeof v === 'object' && 'kind' in v && v.kind === 'uuid' && 'value' in v ? v.value : v));
  } } as ClinicalCoreTransaction)),
});
const run = (mode: CareConsentCopyMode = 'register', db = database(), value: unknown = copy) =>
  runCareConsentCopyRegistration(db, migrations, configuration, mode, mode === 'inventory' ? undefined : value);
const countCopy = async () => (await pg.query<{ n: number }>('select count(*)::int n from clinical_core.care_consent_texts where artifact_id=$1', [copy.artifactId])).rows[0].n;
async function approved(overrides: { id?: string; version?: string; content?: string; status?: string; time?: string; person?: string } = {}) {
  await pg.query(`insert into clinical_core.consent_artifacts(id,organization_id,scope,artifact_version,content_sha256,jurisdiction,
    status,approved_at,approved_by_person_id) values($1,$2,'messaging',$3,$4,'TEST',$5,
    case when $5='draft' then null else clock_timestamp()+($6::interval) end,
    case when $5='draft' then null else $7::uuid end)`,
  [overrides.id ?? copy.artifactId, copy.organizationId, overrides.version ?? copy.artifactVersion, sha(overrides.content ?? copy.content),
    overrides.status ?? 'approved', overrides.time ?? '-1 second', overrides.person ?? staff]);
}
const atAdmission = (sql: string) => database(async (statement, tx) => {
  if (statement === 'select current_database() as name') await tx.query(sql);
});
beforeAll(async () => {
  const artifact = JSON.parse(execFileSync(process.execPath, ['scripts/build-aws-production-clinical-core.mjs', '--json'],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 10000 }));
  migrations = artifact.manifest.migrations.map((m: { version: string; file: string }) => ({ version: m.version, name: m.file.slice(15, -4),
    sql: artifact.files[m.file], sha256: sha(artifact.files[m.file]) }));
  pg = new PGlite({ extensions: { pgcrypto } });
  expect((await applyProductionClinicalCoreMigrations(database(), migrations)).tableCount).toBe(130);
  expect(await run('inventory')).toMatchObject({ inventory: { approvedArtifacts: 0, registeredCopies: 0 } });
}, 60000);
beforeEach(async () => {
  staff = randomUUID();
  copy = { contract: 'care-consent-copy/1', artifactId: randomUUID(), organizationId: randomUUID(), scope: 'messaging',
    artifactVersion: 'FICTIONAL-test/1', content: text, contentSha256: sha(text) };
  await pg.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL consent test')", [copy.organizationId]);
  await pg.query("insert into clinical_core.persons(id,subject_key) values($1,$2)", [staff, 'subject_fictional_' + staff.replaceAll('-', '')]);
  await pg.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'workforce',$2,true)", [staff, 'fictional-' + staff]);
  await pg.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner')", [copy.organizationId, staff]);
});
afterAll(async () => { await pg?.close(); });

describe('exact approved-copy parsing', () => {
  it('preserves approved text exactly and normalizes only UUID spelling', () => {
    const input = { ...copy, artifactId: copy.artifactId.toUpperCase(), organizationId: copy.organizationId.toUpperCase() };
    expect(parseCareConsentCopy(input)).toEqual(copy);
  });
  it.each(['', '  ', '\0', '\ud800', '😀'.repeat(4001)])('refuses invalid or over-byte-budget text', content => {
    expect(() => parseCareConsentCopy({ ...copy, content, contentSha256: sha(content) })).toThrow('copy_invalid');
  });
  it.each([{ approved: true }, { signedBy: 'fictional' }, { phiAllowed: true }, { patientFacingEligible: true }])('refuses added approval/activation metadata %j', extra => {
    expect(() => parseCareConsentCopy({ ...copy, ...extra })).toThrow('copy_invalid');
  });
  it('refuses a newline-normalized or trimmed substitute and a wrong digest', () => {
    for (const value of [{ ...copy, content: copy.content.replace('\n', '\r\n') },
      { ...copy, content: ' ' + copy.content }, { ...copy, contentSha256: 'f'.repeat(64) }]) {
      expect(() => parseCareConsentCopy(value)).toThrow('copy_invalid');
    }
  });
});
describe('qualification-only consent-copy registration', () => {
  it('refuses production, staging, changed artifact or invalid copy before opening a transaction', async () => {
    let entered = 0;
    const never: ClinicalCoreDatabase = { transaction: async () => { entered++; throw new Error('must not enter'); } };
    for (const change of [{ phiAllowed: true }, { activation: 'approved' }, { expectedAccountId: '173535830222' }, { region: 'us-west-2' },
      { qualificationDatabaseName: 'clinical_core' }]) {
      await expect(runCareConsentCopyRegistration(never, migrations, { ...configuration, ...change } as QualificationUpgradeConfiguration, 'register', copy)).rejects.toThrow('boundary_refused');
    }
    await expect(runCareConsentCopyRegistration(never, migrations, { ...configuration, toReleaseSha256: 'f'.repeat(64) }, 'register', copy)).rejects.toThrow('artifact_refused');
    for (const altered of [migrations.slice(0, 104), migrations.map((m, i) => i === 104 ? { ...m, sql: m.sql + '\nselect 1;' } : m)]) {
      await expect(runCareConsentCopyRegistration(never, altered, configuration, 'register', copy)).rejects.toThrow('artifact_refused');
    }
    await expect(run('register', never, { ...copy, approved: true })).rejects.toThrow('copy_invalid');
    await expect(runCareConsentCopyRegistration(never, migrations, configuration, 'inventory', copy)).rejects.toThrow('copy_invalid');
    expect(entered).toBe(0);
  });
  it('inventory and inspection execute read-only, and neither inserts a copy', async () => {
    await approved(); const statements: string[] = [];
    const db = database(async sql => { statements.push(sql); });
    expect(await run('inventory', db)).toMatchObject({ copyPresent: null, copyInserted: false, approvalsCreated: false, grantsCreated: false });
    expect(await run('inspect', db)).toMatchObject({ copyPresent: false, copyInserted: false });
    expect(statements[0]).toContain('read only');
    expect(statements.some(s => /^(insert|update|delete|alter|create|lock table)/i.test(s))).toBe(false);
    expect(await countCopy()).toBe(0);
  });
  it.each(['missing', 'draft', 'retired', 'future', 'hash', 'version', 'scope', 'organization'])('refuses missing or mismatched approval: %s', async mode => {
    if (mode !== 'missing') await approved(mode === 'draft' || mode === 'retired' ? { status: mode } : mode === 'future' ? { time: '1 day' }
      : mode === 'hash' ? { content: text + ' altered' } : {});
    const value = mode === 'version' ? { ...copy, artifactVersion: 'wrong' } : mode === 'scope' ? { ...copy, scope: 'wearables' }
      : mode === 'organization' ? { ...copy, organizationId: randomUUID() } : copy;
    await expect(run('register', database(), value)).rejects.toThrow('approval_required');
    expect(await countCopy()).toBe(0);
  });
  it.each([
    "update clinical_core.identities set status='disabled' where person_id=$1",
    "update clinical_core.persons set status='disabled' where id=$1",
    "update clinical_core.organization_memberships set status='suspended' where person_id=$1",
    "update clinical_core.organization_memberships set role='staff' where person_id=$1",
  ])('refuses loss of approver authority: %s', async sql => {
    await approved(); await pg.query(sql, [staff]);
    await expect(run()).rejects.toThrow('approval_required'); expect(await countCopy()).toBe(0);
  });
  it('the real production identity constraint itself refuses an unbound identity', async () => {
    await approved();
    await expect(pg.query('update clinical_core.identities set production_bound=false where person_id=$1', [staff])).rejects.toThrow('identities_production_bound_check');
    expect(await countCopy()).toBe(0);
  });
  it('refuses a suspended organization and a consumer-only approver', async () => {
    await approved(); await pg.query("update clinical_core.organizations set status='suspended' where id=$1", [copy.organizationId]);
    await expect(run()).rejects.toThrow('approval_required');
    await pg.query("update clinical_core.organizations set status='active' where id=$1", [copy.organizationId]);
    await pg.query("update clinical_core.identities set identity_pool='consumer' where person_id=$1", [staff]);
    await expect(run()).rejects.toThrow('approval_required'); expect(await countCopy()).toBe(0);
  });
  it('does not fall back to an older release when a newer approved release lacks copy', async () => {
    await approved(); await approved({ id: randomUUID(), version: 'FICTIONAL-test/2', time: '0 seconds' });
    await expect(run()).rejects.toThrow('approval_required'); expect(await countCopy()).toBe(0);
  });
  it('physically rolls back rehearsal, then registers once and replays without changing identities, approvals or grants', async () => {
    await approved();
    const before = await pg.query(`select (select count(*) from clinical_core.identities)::int identities,
      (select count(*) from clinical_core.consent_artifacts)::int artifacts,(select count(*) from clinical_core.consent_grants)::int grants`);
    expect(await run('rehearse')).toMatchObject({ rolledBack: true, copyPresent: false, copyInserted: false }); expect(await countCopy()).toBe(0);
    const registered = await run(); expect(registered).toMatchObject({ copyInserted: true, copyPresent: true, approvalsCreated: false,
      grantsCreated: false, phiAllowed: false, activation: 'blocked', migrationCount: 106 });
    expect(JSON.stringify(registered)).not.toMatch(/FICTIONAL|Exact copy|secretArn|fictional-/);
    expect(await run()).toMatchObject({ copyPresent: true, copyInserted: false }); expect(await countCopy()).toBe(1);
    expect(await run('rehearse')).toMatchObject({ rolledBack: true, copyPresent: true, copyInserted: false });
    expect((await pg.query(`select (select count(*) from clinical_core.identities)::int identities,
      (select count(*) from clinical_core.consent_artifacts)::int artifacts,(select count(*) from clinical_core.consent_grants)::int grants`)).rows).toEqual(before.rows);
  });
  it('keeps input and configuration fixed despite asynchronous caller mutation', async () => {
    await approved(); const supplied = { ...copy }, settings = { ...configuration }, artifact = migrations.map(m => ({ ...m })); let changed = false;
    const db = database(async () => {
      if (changed) return; changed = true; supplied.content = 'changed'; supplied.contentSha256 = sha('changed');
      settings.qualificationDatabaseName = 'clinical_core'; artifact[104].sql += '\nselect 1;';
    });
    expect(await runCareConsentCopyRegistration(db, artifact, settings, 'register', supplied)).toMatchObject({ copyPresent: true });
    expect((await pg.query<{ content: string }>('select content from clinical_core.care_consent_texts where artifact_id=$1', [copy.artifactId])).rows[0].content).toBe(text);
  });
  it.each([
    "update clinical_core.schema_migrations set sha256=repeat('f',64) where version='20261006020000'",
    "delete from clinical_core.schema_migrations where version='20261006020000'",
    'alter table clinical_core.care_consent_texts no force row level security',
    'grant select(content) on clinical_core.care_consent_texts to clinical_core_api',
    'grant select on clinical_core.care_consent_texts to public',
    'alter table clinical_core.care_consent_texts disable trigger care_consent_texts_approved',
    'alter function clinical_private.care_connection_actor(text,text) volatile',
    "alter function clinical_core.production_care_connection_request(jsonb) set search_path=public",
  ])('refuses actual ledger, privilege or safety drift before insertion: %s', async sql => {
    await approved(); await expect(run('register', atAdmission(sql))).rejects.toThrow(); expect(await countCopy()).toBe(0);
    expect(await run('inspect')).toMatchObject({ copyPresent: false });
  });
  it('refuses an observed staging database even with an otherwise admitted artifact', async () => {
    await approved(); await expect(run('register', database(undefined, 'clinical_core'))).rejects.toThrow('boundary_refused'); expect(await countCopy()).toBe(0);
  });
  it('proves insert verification and transaction errors do not return a successful receipt or retry', async () => {
    await approved(); let attempts = 0;
    const db = database(async sql => {
      if (sql.startsWith('insert into clinical_core.care_consent_texts')) { attempts++; throw new Error('sensitive fictional provider details'); }
    });
    await expect(run('register', db)).rejects.toThrow('operation_failed'); expect(attempts).toBe(1); expect(await countCopy()).toBe(0);
    let transactions = 0;
    const commitFailure: ClinicalCoreDatabase = { transaction: async work => {
      transactions++; await database().transaction(work); throw new Error('lost commit response with sensitive details');
    } };
    await expect(run('register', commitFailure)).rejects.toThrow('operation_failed'); expect(transactions).toBe(1);
    // A committed-but-unacknowledged write is not certified by the failed call.
    expect(await run('inspect')).toMatchObject({ copyPresent: true });
  });
  it('rolls back an inserted copy if final approval verification fails', async () => {
    await approved(); let approvalsRead = 0;
    const db = database(async (sql, tx) => {
      if (sql.startsWith('select a.id') && ++approvalsRead === 2) {
        await tx.query("update clinical_core.consent_artifacts set status='retired' where id=$1", [copy.artifactId]);
      }
    });
    await expect(run('register', db)).rejects.toThrow('approval_required'); expect(await countCopy()).toBe(0);
    expect(await run('inspect')).toMatchObject({ copyPresent: false });
  });
  it('does not certify rehearsal when rollback did not occur', async () => {
    await approved(); let swallowed: unknown;
    const bad: ClinicalCoreDatabase = { transaction: async work => {
      const result = await database().transaction(async tx => {
        try { return await work(tx); } catch (error) { swallowed = error; return undefined as never; }
      });
      if (swallowed) { const error = swallowed; swallowed = undefined; throw error; }
      return result;
    } };
    await expect(run('rehearse', bad)).rejects.toThrow('verification_failed'); expect(await countCopy()).toBe(1);
  });
  it('existing copy cannot be changed, deleted, or written directly by the API role', async () => {
    await approved(); await run();
    for (const sql of ['update clinical_core.care_consent_texts set content=content where artifact_id=$1',
      'delete from clinical_core.care_consent_texts where artifact_id=$1']) {
      await expect(pg.query(sql, [copy.artifactId])).rejects.toThrow();
    }
    await expect(pg.transaction(async tx => {
      await tx.exec('set local role clinical_core_api');
      await tx.query('insert into clinical_core.care_consent_texts(artifact_id,organization_id,content,content_sha256) values($1,$2,$3,$4)',
        [copy.artifactId, copy.organizationId, copy.content, copy.contentSha256]);
    })).rejects.toThrow(/permission denied/);
    expect(await countCopy()).toBe(1);
  });
});
