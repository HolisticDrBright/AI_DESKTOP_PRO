import { createHash } from 'node:crypto';

// Exact source identity, not an approval, runtime release or superset rule.
export const SUCCESSOR_QUALIFICATION_RELEASE = Object.freeze({
  qualificationProfile: 'clinical-successor-qualification/1', migrationCount: 117,
  migrationReleaseSha256: '34037e1ff05d583868c9a3796f673937777f88bcf4cebc2d589c6604626e9364',
  migrationAssemblySha256: 'd73f67f2197886cf24360f773018a72c92d666789891e679e151ae2c65bd796a',
});
const parent = Object.freeze({ count: 116,
  ledger: '3d6858c8c5ce16e9b903a75e9e890bca7ec3e5052e4cd53bcf011f307d59ab4d',
  assembly: '631615dd75b3c909c56997df36b53e1f43c8324b53a745eb55dd13369dee7fdc' });
const candidate = Object.freeze({ contract: 'telehealth-transfer-authority-candidate/4',
  parentContract: 'clinic-record-privacy-candidate/4', parentMigrationCount: parent.count,
  parentMigrationReleaseSha256: parent.ledger, parentArtifactSha256: parent.assembly,
  migrationCount: SUCCESSOR_QUALIFICATION_RELEASE.migrationCount,
  migrationReleaseSha256: SUCCESSOR_QUALIFICATION_RELEASE.migrationReleaseSha256,
  extensionSha256: '85990f316594c71aa054a5cdc449e75da3ac6bc04f744a30b7802f72a68d583e',
  deployment: 'not_deployed', activation: 'blocked', phiAllowed: false,
  seededApprovals: false, seededConsents: false, seededAdmissionKeys: false, seededTransfers: false,
  managedRoleSemanticsVerified: false, runtimeAdmission: false });
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = v => Object.keys(v).sort().join(',');
const sha = v => createHash('sha256').update(v).digest('hex');
const refuse = () => { throw Error('successor_release_artifact_refused'); };
const ledger = rows => sha(rows.map(r => `${r.version}:${r.sha256}`).join('\n'));
const assembly = rows => sha(rows.map(r => `${r.version}:${r.version}_${r.name}.sql:${r.sha256}`).join('\n'));

/** Full ordered ledger AND filenames. No prefix, arbitrary count or caller pin
 * can certify this successor. Returned rows are copied and frozen. */
export function assertSuccessorQualificationRows(input) {
  if (!Array.isArray(input) || input.length !== 117 || input.some((r, i) => !record(r)
    || keys(r) !== 'name,sha256,version' || typeof r.version !== 'string' || !/^\d{14}$/.test(r.version)
    || typeof r.name !== 'string' || !/^[a-z0-9_]+$/.test(r.name) || r.name.length > 180
    || typeof r.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(r.sha256)
    || i > 0 && input[i - 1].version >= r.version)) refuse();
  if (ledger(input) !== SUCCESSOR_QUALIFICATION_RELEASE.migrationReleaseSha256
    || assembly(input) !== SUCCESSOR_QUALIFICATION_RELEASE.migrationAssemblySha256
    || ledger(input.slice(0, 116)) !== parent.ledger || assembly(input.slice(0, 116)) !== parent.assembly
    || input[116].version !== '20261011040000' || input[116].name !== 'production_telehealth_transfer_authority'
    || input[116].sha256 !== candidate.extensionSha256) refuse();
  return Object.freeze(input.map(r => Object.freeze({ version: r.version, name: r.name, sha256: r.sha256 })));
}

/** Binds every actual SQL byte to the blocked source candidate. Still grants
 * no runtime admission, migration/apply authority or managed qualification. */
export function successorQualificationReleaseArtifact(a) {
  if (!record(a) || keys(a) !== 'candidate,files,manifest,releaseHash' || !record(a.manifest)
    || keys(a.manifest) !== 'contract_version,migrations' || a.manifest.contract_version !== 'clinical-core-migrations/1'
    || !Array.isArray(a.manifest.migrations) || a.manifest.migrations.length !== 117 || !record(a.files)
    || !record(a.candidate) || keys(a.candidate) !== keys(candidate)
    || Object.entries(candidate).some(([k, v]) => a.candidate[k] !== v)
    || a.releaseHash !== SUCCESSOR_QUALIFICATION_RELEASE.migrationAssemblySha256) refuse();
  const manifest = a.manifest.migrations;
  if (manifest.some(r => !record(r) || keys(r) !== 'file,version' || typeof r.version !== 'string'
    || typeof r.file !== 'string' || !/^\d{14}_[a-z0-9_]+\.sql$/.test(r.file) || r.file.slice(0, 14) !== r.version
    || typeof a.files[r.file] !== 'string' || a.files[r.file].includes('\r'))
    || keys(a.files) !== manifest.map(r => r.file).sort().join(',')) refuse();
  const rows = assertSuccessorQualificationRows(manifest.map(r => ({
    version: r.version, name: r.file.slice(15, -4), sha256: sha(a.files[r.file]),
  })));
  return Object.freeze({ contract: 'successor-qualification-release-artifact/1', ...SUCCESSOR_QUALIFICATION_RELEASE,
    rows, executionAllowed: false, managedQualified: false, deploymentPerformed: false, phiAllowed: false });
}
