import { createHash } from 'node:crypto';
const sha = value => createHash('sha256').update(value).digest('hex');
/** Exact source-only successor of lifecycle/4, host/1 and key-fence/1. Never widened by count. */
export const CLINIC_RECORD_PRIVACY_PARENT = Object.freeze({ count: 115,
  ledger: 'cf9e9a80ec6e2973cf53ce1718ce1b48b48e6c62c90af360fb33bb45d6635119',
  assembly: '3172e6b60c62edbb9e9cec10fbc74fe908eb7c41bad562e499b08620d5d670a9' });
export const CLINIC_RECORD_PRIVACY_SQL_SHA256 = 'c326461d26c0b2c4e93083f84e4b75cced0c72d6457be16634e2df9a5852714f';
export const CLINIC_RECORD_PRIVACY_FILE = '20261011000000_production_clinic_record_privacy.sql';
const expectedParent = Object.freeze({ contract: 'telehealth-transfer-key-fence-candidate/1',
  parentMigrationCount: 114, parentMigrationReleaseSha256: '7c09615ba12bd1122d34d459c57e1c88c42f1c51d598f4f71183e472b15d802c',
  parentArtifactSha256: '8e4fc72b54015f1f0b183fa308aeba8ff3db886e6e4c236fad88bf53f7820f3e',
  migrationCount: CLINIC_RECORD_PRIVACY_PARENT.count, migrationReleaseSha256: CLINIC_RECORD_PRIVACY_PARENT.ledger,
  extensionSha256: '813d2adebd908050f9307871b0ac0476a249d7c5abf45710c1ea4d5f851ba456',
  deployment: 'not_deployed', activation: 'blocked', phiAllowed: false,
  seededApprovals: false, seededConsents: false, seededTransfers: false, seededAdmissionKeys: false });
const ledger = a => sha(a.manifest.migrations.map(m => m.version + ':' + sha(a.files[m.file])).join('\n'));
const assembly = a => sha(a.manifest.migrations.map(m => m.version + ':' + m.file + ':' + sha(a.files[m.file])).join('\n'));
/**
 * Source-release pin, not review evidence. Every parent file is copied
 * unchanged; the parent must be the exact 115 key-fence/1 candidate (its
 * own contract, blocked activation, PHI off, not deployed, nothing seeded) and
 * this extension must be the exact reviewed bytes. Anything else refuses.
 */
export function clinicRecordPrivacyCandidate(parent, source) {
  const refuse = () => { throw Error('clinic_record_privacy_artifact_refused'); };
  const p = CLINIC_RECORD_PRIVACY_PARENT;
  if (!parent || !Array.isArray(parent.manifest?.migrations) || parent.manifest.migrations.length !== p.count
    || !parent.files || !parent.candidate
    || Object.keys(parent.candidate).sort().join(',') !== Object.keys(expectedParent).sort().join(',')
    || Object.entries(expectedParent).some(([key, value]) => parent.candidate[key] !== value)) refuse();
  const rows = parent.manifest.migrations;
  if (rows.some((m, i) => !/^\d{14}$/.test(m.version) || !/^\d{14}_[a-z0-9_]+\.sql$/.test(m.file)
    || m.file.slice(0, 14) !== m.version || typeof parent.files[m.file] !== 'string'
    || parent.files[m.file].includes('\r') || i > 0 && m.version <= rows[i - 1].version)
    || Object.keys(parent.files).sort().join('\n') !== rows.map(m => m.file).sort().join('\n')) refuse();
  if (ledger(parent) !== p.ledger || assembly(parent) !== p.assembly || parent.releaseHash !== p.assembly
    || typeof source !== 'string') refuse();
  const sql = source.replace(/\r\n?/g, '\n');
  if (sha(sql) !== CLINIC_RECORD_PRIVACY_SQL_SHA256) refuse();
  const file = CLINIC_RECORD_PRIVACY_FILE;
  if (file.slice(0, 14) <= rows[rows.length - 1].version) refuse();
  const manifest = { ...parent.manifest, migrations: [...rows, { version: file.slice(0, 14), file }] };
  const files = { ...parent.files, [file]: sql }, artifact = { manifest, files };
  return { ...artifact, releaseHash: assembly(artifact), candidate: {
    contract: 'clinic-record-privacy-candidate/4', parentMigrationCount: p.count, parentMigrationReleaseSha256: p.ledger,
    parentArtifactSha256: p.assembly, migrationCount: 116, migrationReleaseSha256: ledger(artifact),
    extensionSha256: sha(sql), deployment: 'not_deployed', activation: 'blocked', phiAllowed: false,
    seededApprovals: false, seededConsents: false, seededTransfers: false, seededAdmissionKeys: false,
    seededDisclosureReleases: false, seededRequests: false,
  } };
}
