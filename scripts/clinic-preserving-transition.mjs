/** Exact SOURCE transition data for a preserving operator, not that operator's
 * admission, custody, rollback or managed-runtime acceptance. */
import { createHash } from 'node:crypto';
import { assertClinicSourceArtifact } from './compile-clinic-schema-source.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
export const CLINIC_NATIVE_SOURCE_RECEIPT_SHA256 = 'c9e718b8b782803b0ba5a05230df12e459e339c384b5e2e0873be50992100dc6';
const schemas = [
  'ee570c4f14e36f94552a7267a28c47486260fd0acd2793fc4043d53b2903f640',
  '0271c62d9f0846c19843401b00b9b310867ddf850f92fda4deef132b00f7375d',
  '8bb707f52e9ca2049ea6d6154836c5658a27a463eb5ea7f1757c9783bf6b5c8d',
  'b4f1b20842e45b02823f39638b491565a558a4aa2f74149021555a541ada6721',
  'fe46eccd49db188f6c1e5dfe8e544506e2484fe3a11e6fe5528a7cca57529855',
];
const expectedNewTables = [
  ['clinical_core.telehealth_note_transfers', 'clinical_private.telehealth_admission_keys'],
  ['clinical_telehealth.zoom_host_releases', 'clinical_telehealth.zoom_host_revocations',
    'clinical_telehealth.zoom_visit_host_bindings', 'clinical_telehealth.host_authority_events'],
  [],
  ['clinical_core.clinic_record_requests', 'clinical_core.clinic_record_request_events',
    'clinical_core.clinic_record_copies', 'clinical_core.clinic_record_copy_items', 'clinical_private.clinic_disclosure_releases'],
];
const refuse = () => { throw Error('clinic_preserving_transition_source_refused'); };
const names = sql => [...sql.matchAll(/create table(?: if not exists)?\s+([a-z_]+\.[a-z_]+)/gi)].map(m => m[1]);
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}'
    : JSON.stringify(value);

export function buildClinicPreservingTransition(artifact, receipt) {
  const a = assertClinicSourceArtifact(artifact), rows = a.manifest.migrations;
  // These bytes are from two matching independent empty native source runs,
  // never from the AWS target being considered for an upgrade.
  if (!receipt || sha(JSON.stringify(receipt) + '\n') !== CLINIC_NATIVE_SOURCE_RECEIPT_SHA256
    || receipt.contract !== 'clinic-restricted-owner-source/1' || receipt.postgresVersion !== '17.7'
    || receipt.phiAllowed !== false || receipt.activation !== 'blocked' || receipt.sourceOnly !== true
    || receipt.runtimeAdmission !== false || receipt.managedRoleSemanticsVerified !== false
    || receipt.upgradeAuthorized !== false || receipt.providerAuthorized !== false
    || receipt.snapshots?.length !== 5) refuse();
  const prefixes = receipt.snapshots;
  for (const [i, prefix] of prefixes.entries()) {
    const count = i + 112;
    if (prefix.migrationCount !== count || prefix.schemaSha256 !== schemas[i]
      || sha(JSON.stringify(prefix.projection)) !== schemas[i]
      || prefix.migrationReleaseSha256 !== sha(rows.slice(0, count).map(r => r.version + ':' + sha(a.files[r.file])).join('\n'))
      || prefix.assemblySha256 !== sha(rows.slice(0, count).map(r => r.version + ':' + r.file + ':' + sha(a.files[r.file])).join('\n'))
      || prefix.projection.some((r, index) => Object.keys(r).sort().join(',') !== 'digest,name'
        || !/^[a-f0-9]{64}$/.test(r.digest) || index > 0 && r.name <= prefix.projection[index - 1].name)) refuse();
  }
  const historical = new Set();
  for (const r of rows.slice(0, 112)) {
    for (const n of names(a.files[r.file])) historical.add(n);
    for (const m of a.files[r.file].matchAll(/drop table(?: if exists)?\s+([a-z_]+\.[a-z_]+)/gi)) historical.delete(m[1]);
  }
  const parentMap = new Map(prefixes[0].projection.map(r => [r.name, r.digest]));
  if (historical.size !== 217 || [...historical].some(n => !parentMap.has('relation:' + n))) refuse();
  const historicalTableNames = [...historical].sort(), transitions = [];
  for (let i = 0; i < 4; i++) {
    const from = prefixes[i], to = prefixes[i + 1], migration = rows[112 + i];
    const old = new Map(from.projection.map(r => [r.name, r.digest]));
    const current = new Map(to.projection.map(r => [r.name, r.digest]));
    const addedTables = names(a.files[migration.file]);
    if (canonical(addedTables) !== canonical(expectedNewTables[i]) || addedTables.some(n => old.has('relation:' + n)
      || !current.has('relation:' + n)) || [...old.keys()].some(n => !current.has(n))) refuse();
    const changed = to.projection.filter(r => old.has(r.name) && old.get(r.name) !== r.digest)
      .map(r => ({ name: r.name, beforeSha256: old.get(r.name), afterSha256: r.digest }));
    const added = to.projection.filter(r => !old.has(r.name)).map(r => ({ ...r }));
    transitions.push({ fromCount: from.migrationCount, toCount: to.migrationCount, file: migration.file,
      sqlSha256: sha(a.files[migration.file]), beforeSchemaSha256: from.schemaSha256, afterSchemaSha256: to.schemaSha256,
      changedObjects: changed, addedObjects: added, removedObjects: [], newTableNames: [...addedTables].sort() });
  }
  const newTables = expectedNewTables.flat().sort();
  return { contract: 'clinic-preserving-transition-source/1', sourceOnly: true, deployment: 'not_deployed',
    phiAllowed: false, activation: 'blocked', runtimeAdmission: false, upgradeAuthorized: false,
    providerAuthorized: false, managedRoleSemanticsVerified: false, operatorAcceptance: false,
    nativeSourceReceiptSha256: CLINIC_NATIVE_SOURCE_RECEIPT_SHA256, fromMigrationCount: 112, toMigrationCount: 116,
    fromReleaseSha256: prefixes[0].migrationReleaseSha256, toReleaseSha256: prefixes[4].migrationReleaseSha256,
    fromAssemblySha256: prefixes[0].assemblySha256, toAssemblySha256: prefixes[4].assemblySha256,
    localOwnerProfile: 'clinical_admin_nosuperuser_nobypassrls_source_only',
    managedRuntimeProfileReviewRequired: true, copyingLocalSchemaPinsToManagedRuntimeForbidden: true,
    preservation: { required: true, historicalTableCount: 217, historicalTableNames,
      historicalTableNamesSha256: sha(historicalTableNames.join('\n')), ledgerTable: 'clinical_core.schema_migrations',
      allHistoricalReceiptColumnsRequired: true, completeRowDigestsRequired: true, rlsFilteredFingerprintForbidden: true,
      newTableCount: 11, newTableNames: newTables, newRowsRequired: 0, singleTransactionRequired: true,
      canonicalSourceAtEveryPrefixRequired: true, rollbackReadbackRequired: true, custodyAndUnknownCommitRecoveryRequired: true },
    proposedCoverage: newTables.map(table => ({ table, status: 'unregistered_unreviewed_source_proposal',
      apiRoleDirectAccessAllowed: false, disposition: table.endsWith('telehealth_admission_keys')
        ? 'private_signing_material_counts_and_digests_only'
        : table.startsWith('clinical_private.') ? 'private_release_authority_not_patient_content'
          : 'governed_clinic_record_or_audit', productionActivationAllowed: false })), transitions };
}

export function assertClinicPreservingTransition(value, artifact, receipt) {
  if (canonical(value) !== canonical(buildClinicPreservingTransition(artifact, receipt)))
    throw Error('clinic_preserving_transition_mismatch');
  return value;
}
