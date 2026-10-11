import { createHash } from 'node:crypto';

const sha = value => createHash('sha256').update(value).digest('hex');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const ledger = a => sha(a.manifest.migrations.map(m => m.version + ':' + sha(a.files[m.file])).join('\n'));
const assembly = a => sha(a.manifest.migrations.map(m => m.version + ':' + m.file + ':' + sha(a.files[m.file])).join('\n'));

// Source identities, NOT security/provider reviews or permission to apply SQL.
export const ZOOM_HOST_AUTHORITY_PARENT = Object.freeze({ count: 113,
  ledger: 'c980ff93f46b4e4fe36360a0f39288a2fb604a87c522ee88d4421f35f6035384',
  assembly: 'f940e0aacbf8a8899ea21fbb027f6132044608492baf1a9286502637b57d3ce2' });
export const ZOOM_HOST_AUTHORITY_FILE = '20261010200000_production_zoom_host_authority.sql';
export const ZOOM_HOST_AUTHORITY_SQL_SHA256 = '7cddacc6aa38a4abb3bf55a5548eac48717ea420d8f811870502c9a9d19764fe';
const parentCandidate = Object.freeze({
  contract: 'telehealth-chart-lifecycle-candidate/4', parentMigrationCount: 112,
  parentMigrationReleaseSha256: '45aec4369ec94bf6339a17e47eadba7b81e7b5195fd5be46c2903e587b709fb4',
  parentArtifactSha256: '6cc191355442ae2c2349cab50466979eaab0e45961a4e1547f34785294dce4b9',
  migrationCount: 113, migrationReleaseSha256: ZOOM_HOST_AUTHORITY_PARENT.ledger,
  extensionSha256: '78f03a282b3f5ba97af2f50683aeab0fc1e20d19d77ec7111fc28116ede7bab7',
  deployment: 'not_deployed', activation: 'blocked', phiAllowed: false,
  seededApprovals: false, seededConsents: false, seededTransfers: false, seededAdmissionKeys: false,
});
const functionNames = Object.freeze([
  'clinical_telehealth.valid_host_configuration', 'clinical_telehealth.active_workforce',
  'clinical_telehealth.guard_host_release', 'clinical_telehealth.guard_host_revocation',
  'clinical_telehealth.audit_host_release', 'clinical_telehealth.require_actor',
  'clinical_telehealth.current_host_release', 'clinical_telehealth.binding_metadata',
  'clinical_telehealth.bind_visit_host', 'clinical_telehealth.read_visit_host_binding',
  'clinical_private.claim', 'clinical_private.actor_person_id', 'clinical_private.organization_id',
  'clinical_private.set_request_context', 'clinical_private.block_update_delete',
]);

/** Exact forward assembly only. Never registers a schema, release, review or key.
 * Pins are extracted from the validated immutable source, not a responding DB. */
export function zoomHostAuthorityCandidate(parent, source) {
  const refuse = () => { throw Error('zoom_host_authority_artifact_refused'); };
  const p = ZOOM_HOST_AUTHORITY_PARENT;
  if (!record(parent) || !record(parent.manifest) || !Array.isArray(parent.manifest.migrations)
    || Object.keys(parent.manifest).length !== 2 || parent.manifest.contract_version !== 'clinical-core-migrations/1'
    || parent.manifest.migrations.length !== p.count || !record(parent.files) || !record(parent.candidate)
    || Object.keys(parent.candidate).length !== Object.keys(parentCandidate).length
    || Object.entries(parentCandidate).some(([key, value]) => parent.candidate[key] !== value)
    || typeof source !== 'string') refuse();
  const rows = parent.manifest.migrations;
  if (rows.some((m, i) => !record(m) || Object.keys(m).length !== 2
    || typeof m.version !== 'string' || !/^\d{14}$/.test(m.version)
    || typeof m.file !== 'string' || !/^\d{14}_[a-z0-9_]+\.sql$/.test(m.file)
    || m.file.slice(0, 14) !== m.version || typeof parent.files[m.file] !== 'string'
    || parent.files[m.file].includes('\r') || i > 0 && m.version <= rows[i - 1].version)
    || Object.keys(parent.files).sort().join('\n') !== rows.map(m => m.file).sort().join('\n')) refuse();
  if (ledger(parent) !== p.ledger || assembly(parent) !== p.assembly || parent.releaseHash !== p.assembly) refuse();
  const sql = source.replace(/\r\n?/g, '\n');
  if (sha(sql) !== ZOOM_HOST_AUTHORITY_SQL_SHA256 || ZOOM_HOST_AUTHORITY_FILE.slice(0, 14) <= rows.at(-1).version) refuse();
  const manifest = { ...parent.manifest, migrations: [...rows.map(m => ({ ...m })),
    { version: ZOOM_HOST_AUTHORITY_FILE.slice(0, 14), file: ZOOM_HOST_AUTHORITY_FILE }] };
  const files = { ...parent.files, [ZOOM_HOST_AUTHORITY_FILE]: sql }, artifact = { manifest, files };
  const bodies = new Map();
  for (const row of manifest.migrations) {
    for (const [, name, body] of files[row.file].matchAll(/create(?: or replace)? function (clinical_(?:private|telehealth)\.[a-z_]+)\([^]*?as \$\$([^]*?)\$\$/g)) {
      if (functionNames.includes(name)) bodies.set(name, body);
    }
  }
  if (bodies.size !== functionNames.length) refuse();
  const functionPins = functionNames.map(name => ({ name, bodySha256: sha(bodies.get(name)) }));
  return { ...artifact, releaseHash: assembly(artifact), functionPins, candidate: {
    contract: 'zoom-host-authority-candidate/1', parentContract: parentCandidate.contract,
    parentMigrationCount: p.count, parentMigrationReleaseSha256: p.ledger, parentArtifactSha256: p.assembly,
    migrationCount: 114, migrationReleaseSha256: ledger(artifact), extensionSha256: sha(sql),
    functionPinsSha256: sha(JSON.stringify(functionPins)), deployment: 'not_deployed', activation: 'blocked', phiAllowed: false,
    seededApprovals: false, seededConsents: false, seededAdmissionKeys: false,
    seededHostReleases: false, seededHostBindings: false, seededIdentities: false,
  } };
}
