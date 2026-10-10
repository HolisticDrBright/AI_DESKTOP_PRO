import { createHash } from 'node:crypto';
const sha = value => createHash('sha256').update(value).digest('hex');
/** The exact 113-migration telehealth chart-lifecycle/3 candidate this one succeeds. Never widened by count. If Codex's /4 replaces 113, re-pin here. */
export const CLINIC_RECORD_PRIVACY_PARENT = Object.freeze({ count: 113,
  ledger: '0abad35bcaa986799597f4e29525374175b218eb3ea5a9559426252d113a0fab',
  assembly: '2cb4ca8cdfaef25cd2ddfbd12eb1b6bfa6de4e985bfc4bcb22e53f5a01f55ba1' });
export const CLINIC_RECORD_PRIVACY_SQL_SHA256 = 'f60756739ba91c12c411aa7a43639bb9d98c06b5c0e9e298f06b6e3c6143d714';
export const CLINIC_RECORD_PRIVACY_FILE = '20261010210000_production_clinic_record_privacy.sql';
const ledger = a => sha(a.manifest.migrations.map(m => m.version + ':' + sha(a.files[m.file])).join('\n'));
const assembly = a => sha(a.manifest.migrations.map(m => m.version + ':' + m.file + ':' + sha(a.files[m.file])).join('\n'));
/**
 * Source-release pin, not review evidence. Every parent file is copied
 * unchanged; the parent must be the exact 113 chart-lifecycle/3 candidate (its
 * own contract, blocked activation, PHI off, not deployed, nothing seeded) and
 * this extension must be the exact reviewed bytes. Anything else refuses.
 */
export function clinicRecordPrivacyCandidate(parent, source) {
  const refuse = () => { throw Error('clinic_record_privacy_artifact_refused'); };
  const p = CLINIC_RECORD_PRIVACY_PARENT;
  if (!parent || !Array.isArray(parent.manifest?.migrations) || parent.manifest.migrations.length !== p.count
    || !parent.files || parent.candidate?.contract !== 'telehealth-chart-lifecycle-candidate/3'
    || parent.candidate.activation !== 'blocked' || parent.candidate.phiAllowed !== false
    || parent.candidate.deployment !== 'not_deployed' || parent.candidate.migrationCount !== p.count
    || parent.candidate.migrationReleaseSha256 !== p.ledger || parent.candidate.seededApprovals !== false
    || parent.candidate.seededConsents !== false || parent.candidate.seededTransfers !== false
    || parent.candidate.seededAdmissionKeys !== false) refuse();
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
    contract: 'clinic-record-privacy-candidate/1', parentMigrationCount: p.count, parentMigrationReleaseSha256: p.ledger,
    parentArtifactSha256: p.assembly, migrationCount: 114, migrationReleaseSha256: ledger(artifact),
    extensionSha256: sha(sql), deployment: 'not_deployed', activation: 'blocked', phiAllowed: false,
    seededApprovals: false, seededConsents: false, seededTransfers: false, seededAdmissionKeys: false,
    seededDisclosureReleases: false, seededRequests: false,
  } };
}
