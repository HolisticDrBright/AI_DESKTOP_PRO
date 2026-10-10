import { createHash } from 'node:crypto';
const sha = value => createHash('sha256').update(value).digest('hex');
export const TELEHEALTH_CONSENT_COPY_PARENT = Object.freeze({ count: 111,
  ledger: '98ef31a24baeafb83bfd65a7832b1e4e02dbe1c71b6e78f8efdad4e0b0e62d4c',
  assembly: '658fd3697bff08d7d16afba2033e6aaca439e77266aff6369730089c0b18fd7a' });
export const TELEHEALTH_CONSENT_COPY_SQL_SHA256 = '5d4b361c4849b900c4c6e4f95686cf77c28797584bc9e9ec1136f38bdc325e0e';
const ledger = a => sha(a.manifest.migrations.map(m => m.version + ':' + sha(a.files[m.file])).join('\n'));
const assembly = a => sha(a.manifest.migrations.map(m => m.version + ':' + m.file + ':' + sha(a.files[m.file])).join('\n'));
/** Source-release pin, not review evidence. Parent files are copied unchanged. */
export function telehealthConsentCopyCandidate(parent, source) {
  const refuse = () => { throw Error('telehealth_consent_copy_artifact_refused'); };
  const p = TELEHEALTH_CONSENT_COPY_PARENT;
  if (!parent || !Array.isArray(parent.manifest?.migrations) || parent.manifest.migrations.length !== p.count
    || !parent.files || parent.candidate?.contract !== 'fullscript-candidate/1'
    || parent.candidate.activation !== 'blocked' || parent.candidate.phiAllowed !== false
    || parent.candidate.deployment !== 'not_deployed' || parent.candidate.migrationCount !== p.count
    || parent.candidate.migrationReleaseSha256 !== p.ledger) refuse();
  const rows = parent.manifest.migrations;
  if (rows.some((m, i) => !/^\d{14}$/.test(m.version) || !/^\d{14}_[a-z0-9_]+\.sql$/.test(m.file)
    || m.file.slice(0, 14) !== m.version || typeof parent.files[m.file] !== 'string'
    || parent.files[m.file].includes('\r') || i > 0 && m.version <= rows[i - 1].version)
    || Object.keys(parent.files).sort().join('\n') !== rows.map(m => m.file).sort().join('\n')) refuse();
  if (ledger(parent) !== p.ledger || assembly(parent) !== p.assembly || parent.releaseHash !== p.assembly
    || typeof source !== 'string') refuse();
  const sql = source.replace(/\r\n?/g, '\n');
  if (sha(sql) !== TELEHEALTH_CONSENT_COPY_SQL_SHA256) refuse();
  const file = '20261010100000_production_telehealth_consent_copy.sql';
  const manifest = { ...parent.manifest, migrations: [...rows, { version: '20261010100000', file }] };
  const files = { ...parent.files, [file]: sql }, artifact = { manifest, files };
  return { ...artifact, releaseHash: assembly(artifact), candidate: {
    contract: 'telehealth-consent-copy-candidate/1', parentMigrationCount: p.count, parentMigrationReleaseSha256: p.ledger,
    parentArtifactSha256: p.assembly, migrationCount: 112, migrationReleaseSha256: ledger(artifact),
    extensionSha256: sha(sql), deployment: 'not_deployed', activation: 'blocked', phiAllowed: false,
    seededApprovals: false, seededConsents: false,
  } };
}
