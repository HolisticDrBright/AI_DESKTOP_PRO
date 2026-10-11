/** Exact blocked source successor. No runtime/managed admission or approvals. */
import { createHash } from 'node:crypto';
import { assertClinicSourceArtifact, CLINIC_SOURCE_IDENTITY } from './compile-clinic-schema-source.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
export const TELEHEALTH_AUTHORITY_FILE = '20261011020000_production_telehealth_transfer_authority.sql';
export const TELEHEALTH_AUTHORITY_SQL_SHA256 = 'ff464b6e216939cc606ebcc96b3d817beddc03927e2c1494c50012152e57c9cc';
export function telehealthTransferAuthorityCandidate(parent, source) {
  const refuse = () => { throw Error('telehealth_authority_artifact_refused'); };
  try { assertClinicSourceArtifact(parent); } catch { refuse(); }
  if (typeof source !== 'string') refuse();
  const sql = source.replace(/\r\n?/g, '\n');
  if (sha(sql) !== TELEHEALTH_AUTHORITY_SQL_SHA256
    || TELEHEALTH_AUTHORITY_FILE.slice(0, 14) <= parent.manifest.migrations.at(-1).version) refuse();
  const manifest = { ...parent.manifest, migrations: [...parent.manifest.migrations.map(r => ({ ...r })),
    { version: TELEHEALTH_AUTHORITY_FILE.slice(0, 14), file: TELEHEALTH_AUTHORITY_FILE }] };
  const files = { ...parent.files, [TELEHEALTH_AUTHORITY_FILE]: sql };
  const migrationReleaseSha256 = sha(manifest.migrations.map(r => r.version + ':' + sha(files[r.file])).join('\n'));
  const releaseHash = sha(manifest.migrations.map(r => r.version + ':' + r.file + ':' + sha(files[r.file])).join('\n'));
  return { manifest, files, releaseHash, candidate: {
    contract: 'telehealth-transfer-authority-candidate/2', parentContract: parent.candidate.contract,
    parentMigrationCount: CLINIC_SOURCE_IDENTITY.count, parentMigrationReleaseSha256: CLINIC_SOURCE_IDENTITY.ledger,
    parentArtifactSha256: CLINIC_SOURCE_IDENTITY.assembly, migrationCount: 117, migrationReleaseSha256,
    extensionSha256: sha(sql), deployment: 'not_deployed', activation: 'blocked', phiAllowed: false,
    seededApprovals: false, seededConsents: false, seededAdmissionKeys: false, seededTransfers: false,
    managedRoleSemanticsVerified: false, runtimeAdmission: false,
  } };
}
