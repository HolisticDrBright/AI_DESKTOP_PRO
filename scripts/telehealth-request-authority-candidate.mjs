/** Distinct blocked 118 source only. Existing 117 execution pins are unchanged. */
import { createHash } from 'node:crypto';
import { assertSuccessorQualificationRows, successorQualificationReleaseArtifact } from './successor-qualification-release.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const refuse = () => { throw Error('telehealth_request_authority_artifact_refused'); };
export const TELEHEALTH_REQUEST_AUTHORITY_FILE = '20261011180000_production_telehealth_request_authority.sql';
export const TELEHEALTH_REQUEST_AUTHORITY_SQL_SHA256 = '1ae4fd954760af204be732313730174a845c0558f24a5a84703d9ee548078e86';
export const TELEHEALTH_REQUEST_AUTHORITY_BODY_SHA256 = '7004b97b7fdcf849308856bbe304df068100a41d0f62e29c42b420d35ed8ca86';

/** Validate the WHOLE exact 118 release, not a compatible prefix/superset. */
export function assertTelehealthRequestAuthorityRows(input) {
  if (!Array.isArray(input) || input.length !== 118) refuse();
  let parent;
  try { parent = assertSuccessorQualificationRows(input.slice(0, 117)); } catch { refuse(); }
  const last = input[117];
  if (!last || typeof last !== 'object' || Array.isArray(last)
    || Object.keys(last).sort().join(',') !== 'name,sha256,version'
    || last.version !== '20261011180000' || last.name !== 'production_telehealth_request_authority'
    || last.sha256 !== TELEHEALTH_REQUEST_AUTHORITY_SQL_SHA256) refuse();
  return Object.freeze([...parent, Object.freeze({ version: last.version, name: last.name, sha256: last.sha256 })]);
}

export function telehealthRequestAuthorityCandidate(parent, source) {
  let p;
  try { p = successorQualificationReleaseArtifact(parent); } catch { refuse(); }
  if (typeof source !== 'string') refuse();
  const sql = source.replace(/\r\n?/g, '\n');
  if (sha(sql) !== TELEHEALTH_REQUEST_AUTHORITY_SQL_SHA256
    || sha(/as \$\$([^]*?)\$\$;/.exec(sql)?.[1] ?? '') !== TELEHEALTH_REQUEST_AUTHORITY_BODY_SHA256) refuse();
  const manifest = { ...parent.manifest, migrations: [...parent.manifest.migrations.map(r => ({ ...r })),
    { version: '20261011180000', file: TELEHEALTH_REQUEST_AUTHORITY_FILE }] };
  const files = { ...parent.files, [TELEHEALTH_REQUEST_AUTHORITY_FILE]: sql };
  const rows = assertTelehealthRequestAuthorityRows(manifest.migrations.map(r => ({
    version: r.version, name: r.file.slice(15, -4), sha256: sha(files[r.file]),
  })));
  const migrationReleaseSha256 = sha(rows.map(r => r.version + ':' + r.sha256).join('\n'));
  const releaseHash = sha(manifest.migrations.map(r => r.version + ':' + r.file + ':' + sha(files[r.file])).join('\n'));
  return { manifest, files, releaseHash, candidate: {
    contract: 'telehealth-request-authority-candidate/1', parentMigrationCount: 117,
    parentMigrationReleaseSha256: p.migrationReleaseSha256, parentArtifactSha256: p.migrationAssemblySha256,
    migrationCount: 118, migrationReleaseSha256, extensionSha256: sha(sql),
    deployment: 'not_deployed', activation: 'blocked', phiAllowed: false,
    seededApprovals: false, seededConsents: false, seededIdentities: false,
    managedRoleSemanticsVerified: false, runtimeAdmission: false,
  } };
}
