import { createHash } from 'node:crypto';
const sha = value => createHash('sha256').update(value).digest('hex');
/** The exact 112-migration telehealth consent-copy release this candidate succeeds. Never widened by count. */
export const TELEHEALTH_CHART_LIFECYCLE_PARENT = Object.freeze({ count: 112,
  ledger: '45aec4369ec94bf6339a17e47eadba7b81e7b5195fd5be46c2903e587b709fb4',
  assembly: '6cc191355442ae2c2349cab50466979eaab0e45961a4e1547f34785294dce4b9' });
export const TELEHEALTH_CHART_LIFECYCLE_SQL_SHA256 = 'afeb523f3f96c9e7285d498a2a6f1293b51493a487e69cc5486b5d0e49c61938';
export const TELEHEALTH_CHART_LIFECYCLE_FILE = '20261010110000_production_telehealth_chart_lifecycle.sql';
const ledger = a => sha(a.manifest.migrations.map(m => m.version + ':' + sha(a.files[m.file])).join('\n'));
const assembly = a => sha(a.manifest.migrations.map(m => m.version + ':' + m.file + ':' + sha(a.files[m.file])).join('\n'));
/**
 * Source-release pin, not review evidence. Every parent file is copied
 * unchanged; the parent must be the exact 112 consent-copy candidate (its own
 * contract, blocked activation, PHI off, not deployed) and this extension must
 * be the exact reviewed bytes. Anything else refuses rather than re-pins.
 */
export function telehealthChartLifecycleCandidate(parent, source) {
  const refuse = () => { throw Error('telehealth_chart_lifecycle_artifact_refused'); };
  const p = TELEHEALTH_CHART_LIFECYCLE_PARENT;
  if (!parent || !Array.isArray(parent.manifest?.migrations) || parent.manifest.migrations.length !== p.count
    || !parent.files || parent.candidate?.contract !== 'telehealth-consent-copy-candidate/1'
    || parent.candidate.activation !== 'blocked' || parent.candidate.phiAllowed !== false
    || parent.candidate.deployment !== 'not_deployed' || parent.candidate.migrationCount !== p.count
    || parent.candidate.migrationReleaseSha256 !== p.ledger || parent.candidate.seededApprovals !== false
    || parent.candidate.seededConsents !== false) refuse();
  const rows = parent.manifest.migrations;
  if (rows.some((m, i) => !/^\d{14}$/.test(m.version) || !/^\d{14}_[a-z0-9_]+\.sql$/.test(m.file)
    || m.file.slice(0, 14) !== m.version || typeof parent.files[m.file] !== 'string'
    || parent.files[m.file].includes('\r') || i > 0 && m.version <= rows[i - 1].version)
    || Object.keys(parent.files).sort().join('\n') !== rows.map(m => m.file).sort().join('\n')) refuse();
  if (ledger(parent) !== p.ledger || assembly(parent) !== p.assembly || parent.releaseHash !== p.assembly
    || typeof source !== 'string') refuse();
  const sql = source.replace(/\r\n?/g, '\n');
  if (sha(sql) !== TELEHEALTH_CHART_LIFECYCLE_SQL_SHA256) refuse();
  const file = TELEHEALTH_CHART_LIFECYCLE_FILE;
  if (file.slice(0, 14) <= rows[rows.length - 1].version) refuse();
  const manifest = { ...parent.manifest, migrations: [...rows, { version: file.slice(0, 14), file }] };
  const files = { ...parent.files, [file]: sql }, artifact = { manifest, files };
  return { ...artifact, releaseHash: assembly(artifact), candidate: {
    contract: 'telehealth-chart-lifecycle-candidate/1', parentMigrationCount: p.count, parentMigrationReleaseSha256: p.ledger,
    parentArtifactSha256: p.assembly, migrationCount: 113, migrationReleaseSha256: ledger(artifact),
    extensionSha256: sha(sql), deployment: 'not_deployed', activation: 'blocked', phiAllowed: false,
    seededApprovals: false, seededConsents: false, seededTransfers: false,
  } };
}
