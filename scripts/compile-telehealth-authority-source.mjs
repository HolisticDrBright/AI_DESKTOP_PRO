/** Fresh restricted local source only. Cannot admit an existing/managed target. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compileClinicSchemaRestrictedOwnerSource, CLINIC_SOURCE_IDENTITY } from './compile-clinic-schema-source.mjs';
import { assertRestrictedSourceOwnerIdentity, RESTRICTED_SOURCE_OWNER_IDENTITY_SQL } from './telehealth-restricted-source-owner.mjs';
import { projectTelehealthSchema } from './telehealth-schema-projection.mjs';
import { TELEHEALTH_AUTHORITY_FILE, TELEHEALTH_AUTHORITY_SQL_SHA256 } from './telehealth-transfer-authority-candidate.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}' : JSON.stringify(value);
export async function compileTelehealthAuthorityRestrictedOwnerSource(db) {
  // The existing source compiler refuses nonempty databases, role substitution
  // and nonlocal names before loading installers. Preserve all 112..116 bytes.
  const parent = await compileClinicSchemaRestrictedOwnerSource(db);
  const a = JSON.parse(execFileSync(process.execPath, ['scripts/build-telehealth-transfer-authority-candidate.mjs', '--json'],
    { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000, windowsHide: true }));
  const ledger = count => sha(a.manifest.migrations.slice(0, count).map(r => r.version + ':' + sha(a.files[r.file])).join('\n'));
  const assembly = count => sha(a.manifest.migrations.slice(0, count).map(r => r.version + ':' + r.file + ':' + sha(a.files[r.file])).join('\n'));
  if (a.candidate.contract !== 'telehealth-transfer-authority-candidate/2' || a.candidate.activation !== 'blocked'
    || a.candidate.phiAllowed !== false || a.candidate.runtimeAdmission !== false || a.manifest.migrations.length !== 117
    || ledger(116) !== CLINIC_SOURCE_IDENTITY.ledger || assembly(116) !== CLINIC_SOURCE_IDENTITY.assembly
    || a.manifest.migrations[116].file !== TELEHEALTH_AUTHORITY_FILE || sha(a.files[TELEHEALTH_AUTHORITY_FILE]) !== TELEHEALTH_AUTHORITY_SQL_SHA256
    || ledger(117) !== a.candidate.migrationReleaseSha256 || assembly(117) !== a.releaseHash) throw Error('telehealth_authority_source_artifact_refused');
  const assertLedger = async (tx, count) => {
    const rows = (await tx.query('select version,name,sha256 from clinical_core.schema_migrations order by version collate "C"')).rows;
    const expected = a.manifest.migrations.slice(0, count).map(r => ({ version: r.version, name: r.file.slice(15, -4), sha256: sha(a.files[r.file]) }));
    if (canonical(rows) !== canonical(expected)) throw Error('telehealth_authority_source_ledger_refused');
  };
  const snapshot = await db.transaction(async tx => {
    assertRestrictedSourceOwnerIdentity((await tx.query(RESTRICTED_SOURCE_OWNER_IDENTITY_SQL)).rows);
    await assertLedger(tx, 116);
    const row = a.manifest.migrations[116];
    await tx.exec(a.files[row.file]);
    await tx.query('insert into clinical_core.schema_migrations(version,name,sha256) values($1,$2,$3)', [row.version, row.file.slice(15, -4), sha(a.files[row.file])]);
    await assertLedger(tx, 117);
    const projection = await projectTelehealthSchema((sql, args) => tx.query(sql, [...args]));
    return { migrationCount: 117, migrationReleaseSha256: ledger(117), assemblySha256: assembly(117), schemaSha256: sha(JSON.stringify(projection)), projection };
  });
  assertRestrictedSourceOwnerIdentity((await db.query(RESTRICTED_SOURCE_OWNER_IDENTITY_SQL)).rows);
  return { ...parent, contract: 'telehealth-authority-restricted-owner-source/1', snapshots: [...parent.snapshots, snapshot],
    sourceOnly: true, runtimeAdmission: false, managedRoleSemanticsVerified: false, upgradeAuthorized: false, providerAuthorized: false, phiAllowed: false, activation: 'blocked' };
}
