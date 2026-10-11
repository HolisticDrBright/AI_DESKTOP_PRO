/** Empty local source only. This cannot admit an existing AWS target or
 * authorize migrations, providers, records, consent or production activation. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compileTelehealthSchemaRestrictedOwnerSource } from './compile-telehealth-schema-source.mjs';
import { assertRestrictedSourceOwnerIdentity, RESTRICTED_SOURCE_OWNER_IDENTITY_SQL } from './telehealth-restricted-source-owner.mjs';
import { projectTelehealthSchema, TELEHEALTH_SCHEMA_PROJECTION } from './telehealth-schema-projection.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = value => Object.keys(value).sort().join(',');
export const CLINIC_SOURCE_IDENTITY = Object.freeze({ count: 116,
  ledger: '3d6858c8c5ce16e9b903a75e9e890bca7ec3e5052e4cd53bcf011f307d59ab4d',
  assembly: '631615dd75b3c909c56997df36b53e1f43c8324b53a745eb55dd13369dee7fdc',
  extension: 'c326461d26c0b2c4e93083f84e4b75cced0c72d6457be16634e2df9a5852714f' });
const candidate = Object.freeze({ contract: 'clinic-record-privacy-candidate/4', parentMigrationCount: 115,
  parentMigrationReleaseSha256: 'cf9e9a80ec6e2973cf53ce1718ce1b48b48e6c62c90af360fb33bb45d6635119',
  parentArtifactSha256: '3172e6b60c62edbb9e9cec10fbc74fe908eb7c41bad562e499b08620d5d670a9',
  migrationCount: CLINIC_SOURCE_IDENTITY.count, migrationReleaseSha256: CLINIC_SOURCE_IDENTITY.ledger,
  extensionSha256: CLINIC_SOURCE_IDENTITY.extension, deployment: 'not_deployed', activation: 'blocked', phiAllowed: false,
  seededApprovals: false, seededConsents: false, seededTransfers: false, seededAdmissionKeys: false,
  seededDisclosureReleases: false, seededRequests: false });
const ledger = (a, count) => sha(a.manifest.migrations.slice(0, count).map(r => r.version + ':' + sha(a.files[r.file])).join('\n'));
const assembly = (a, count) => sha(a.manifest.migrations.slice(0, count).map(r => r.version + ':' + r.file + ':' + sha(a.files[r.file])).join('\n'));

export function assertClinicSourceArtifact(a) {
  const refuse = () => { throw Error('clinic_source_artifact_refused'); };
  if (!record(a) || keys(a) !== 'candidate,files,manifest,releaseHash' || !record(a.manifest)
    || keys(a.manifest) !== 'contract_version,migrations' || a.manifest.contract_version !== 'clinical-core-migrations/1'
    || !Array.isArray(a.manifest.migrations) || a.manifest.migrations.length !== 116 || !record(a.files)
    || !record(a.candidate) || keys(a.candidate) !== keys(candidate)
    || Object.entries(candidate).some(([key, value]) => a.candidate[key] !== value)) refuse();
  const rows = a.manifest.migrations;
  if (rows.some((r, i) => !record(r) || keys(r) !== 'file,version' || !/^\d{14}$/.test(r.version ?? '')
    || !/^\d{14}_[a-z0-9_]+\.sql$/.test(r.file ?? '') || r.file.slice(0, 14) !== r.version
    || typeof a.files[r.file] !== 'string' || a.files[r.file].includes('\r') || i > 0 && r.version <= rows[i - 1].version)
    || keys(a.files) !== rows.map(r => r.file).sort().join(',')
    || ledger(a, 116) !== CLINIC_SOURCE_IDENTITY.ledger || assembly(a, 116) !== CLINIC_SOURCE_IDENTITY.assembly
    || a.releaseHash !== CLINIC_SOURCE_IDENTITY.assembly || sha(a.files[rows.at(-1).file]) !== CLINIC_SOURCE_IDENTITY.extension
    || ledger(a, 115) !== candidate.parentMigrationReleaseSha256 || assembly(a, 115) !== candidate.parentArtifactSha256) refuse();
  return a;
}

async function assertLedger(db, a, count) {
  const observed = (await db.query('select version,name,sha256 from clinical_core.schema_migrations order by version collate "C"')).rows;
  const expected = a.manifest.migrations.slice(0, count).map(r => ({ version: r.version, name: r.file.slice(15, -4), sha256: sha(a.files[r.file]) }));
  if (!Array.isArray(observed) || observed.length !== expected.length
    || observed.some((r, i) => !record(r) || keys(r) !== 'name,sha256,version'
      || Object.entries(expected[i]).some(([key, value]) => r[key] !== value))) throw Error('clinic_source_prefix_ledger_refused');
}

export async function compileClinicSchemaRestrictedOwnerSource(db) {
  // Identity and emptiness are checked before loading any migration installer.
  const ownerProfile = assertRestrictedSourceOwnerIdentity((await db.query(RESTRICTED_SOURCE_OWNER_IDENTITY_SQL)).rows);
  const existing = (await db.query(`select
    (select count(*) from pg_namespace where nspname like 'clinical\\_%' escape '\\' or nspname in('commercial_reference','fullscript_delivery'))::int namespaces,
    (select count(*) from pg_roles where (rolname like 'clinical\\_%' escape '\\' or rolname like 'fullscript\\_%' escape '\\') and rolname<>'clinical_admin')::int roles,
    (select count(*) from pg_auth_members where member=(select oid from pg_roles where rolname=current_user))::int memberships,
    (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in('r','p','f','v','m','S'))::int public_relations`)).rows;
  if (!Array.isArray(existing) || existing.length !== 1 || !record(existing[0])
    || keys(existing[0]) !== 'memberships,namespaces,public_relations,roles' || Object.values(existing[0]).some(v => v !== 0))
    throw Error('clinic_source_not_empty');
  const a = assertClinicSourceArtifact(JSON.parse(execFileSync(process.execPath, ['scripts/build-clinic-record-privacy-candidate.mjs', '--json'],
    { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60_000, windowsHide: true })));
  // Preserve the separate compiler and contract for historical 112/113/114.
  const parent = await compileTelehealthSchemaRestrictedOwnerSource(db);
  const last = parent.snapshots.at(-1);
  if (parent.contract !== 'telehealth-restricted-owner-source/1' || parent.postgresVersion !== '17.7'
    || parent.snapshots.map(s => s.migrationCount).join(',') !== '112,113,114'
    || last.migrationReleaseSha256 !== ledger(a, 114) || last.assemblySha256 !== assembly(a, 114))
    throw Error('clinic_source_parent_refused');
  await assertLedger(db, a, 114);
  const snapshots = [...parent.snapshots];
  for (const count of [115, 116]) {
    const row = a.manifest.migrations[count - 1];
    const snapshot = await db.transaction(async tx => {
      assertRestrictedSourceOwnerIdentity((await tx.query(RESTRICTED_SOURCE_OWNER_IDENTITY_SQL)).rows);
      await assertLedger(tx, a, count - 1);
      await tx.exec(a.files[row.file]);
      await tx.query('insert into clinical_core.schema_migrations(version,name,sha256) values($1,$2,$3)', [row.version, row.file.slice(15, -4), sha(a.files[row.file])]);
      await assertLedger(tx, a, count);
      const projection = await projectTelehealthSchema((sql, args) => tx.query(sql, [...args]));
      return { migrationCount: count, migrationReleaseSha256: ledger(a, count), assemblySha256: assembly(a, count),
        schemaSha256: sha(JSON.stringify(projection)), projection };
    });
    snapshots.push(snapshot);
  }
  assertRestrictedSourceOwnerIdentity((await db.query(RESTRICTED_SOURCE_OWNER_IDENTITY_SQL)).rows);
  await assertLedger(db, a, 116);
  return { contract: 'clinic-restricted-owner-source/1', sourceOnly: true, activation: 'blocked', phiAllowed: false,
    runtimeAdmission: false, managedRoleSemanticsVerified: false, providerAuthorized: false, upgradeAuthorized: false,
    postgresVersion: '17.7', ownerProfile, installerBundleSha256: parent.installerBundleSha256,
    projectionSqlSha256: sha(TELEHEALTH_SCHEMA_PROJECTION), snapshots };
}
