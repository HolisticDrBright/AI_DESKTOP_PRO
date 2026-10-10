import { createHash } from 'node:crypto';

const sha = value => createHash('sha256').update(value).digest('hex');
export const FULLSCRIPT_EXTENSIONS = Object.freeze([
  { version: '20261009110000', name: 'production_fullscript_draft_ledger', source: 'fullscript-draft-ledger', sha256: '9526d365a1b93a45e33f11a47e81d49b2708d2ecb164f86d7994f4bd7cea2e07' },
  { version: '20261009120000', name: 'production_canonical_protocol_carts', source: 'canonical-protocol-carts', sha256: 'e6fc9b0e8ef3eaff4a8087441b13da03c2ccff5abf3c296d497e39327353029f' },
  { version: '20261009130000', name: 'production_fullscript_canonical_authority', source: 'fullscript-canonical-authority', sha256: '878e6a3fe573d9b60e6c0c699cc20f6c67f44c5745a771518508773aec82ca01' },
].map(Object.freeze));
export const FULLSCRIPT_PARENT = Object.freeze({
  count: 108, ledger: '4e8e78f6d9aea14d9e622f07f5523380c17e704730c543230846c0ba5dc8e38b',
  artifact: '4a9e20d7c4fd5e165df97cd9b3bfcdfa47b4377a589a8fdd964cc5304335d156',
});
const refuse = () => { throw Error('fullscript_candidate_artifact_refused'); };
const hashes = (manifest, files) => ({
  ledger: sha(manifest.migrations.map(m => m.version + ':' + sha(files[m.file])).join('\n')),
  artifact: sha(manifest.migrations.map(m => m.version + ':' + m.file + ':' + sha(files[m.file])).join('\n')),
});
/** Pure builder: existing release files are never rewritten. SQL pins are
 * source-reviewed, not recalculated into acceptance when the source changes. */
export function fullscriptCandidate(parent, sources) {
  if (!parent || !Array.isArray(parent.manifest?.migrations) || parent.manifest.migrations.length !== FULLSCRIPT_PARENT.count
    || !parent.files || parent.candidate?.contract !== 'telehealth-consent-candidate/1'
    || parent.candidate.activation !== 'blocked' || parent.candidate.phiAllowed !== false
    || parent.candidate.deployment !== 'not_deployed') refuse();
  const rows = parent.manifest.migrations;
  if (rows.some((m, i) => !/^\d{14}$/.test(m.version) || m.file !== `${m.version}_${m.file.slice(15)}`
    || !/^\d{14}_[a-z0-9_]+\.sql$/.test(m.file) || typeof parent.files[m.file] !== 'string'
    || parent.files[m.file].includes('\r') || (i && m.version <= rows[i - 1].version))
    || Object.keys(parent.files).sort().join('\n') !== rows.map(m => m.file).sort().join('\n')) refuse();
  const h = hashes(parent.manifest, parent.files);
  if (h.ledger !== FULLSCRIPT_PARENT.ledger || h.artifact !== FULLSCRIPT_PARENT.artifact
    || parent.releaseHash !== h.artifact || parent.candidate.migrationReleaseSha256 !== h.ledger
    || parent.candidate.migrationCount !== FULLSCRIPT_PARENT.count) refuse();
  if (!sources || Object.keys(sources).sort().join('\n') !== FULLSCRIPT_EXTENSIONS.map(e => e.source).sort().join('\n')) refuse();
  const files = { ...parent.files }, added = [];
  for (const e of FULLSCRIPT_EXTENSIONS) {
    if (typeof sources[e.source] !== 'string') refuse();
    const sql = sources[e.source].replace(/\r\n?/g, '\n');
    if (sha(sql) !== e.sha256) refuse();
    const file = `${e.version}_${e.name}.sql`;
    files[file] = sql; added.push({ version: e.version, file });
  }
  const manifest = { ...parent.manifest, migrations: [...rows, ...added] };
  const successor = hashes(manifest, files);
  return { manifest, files, releaseHash: successor.artifact, candidate: {
    contract: 'fullscript-candidate/1', parentMigrationCount: FULLSCRIPT_PARENT.count,
    parentMigrationReleaseSha256: FULLSCRIPT_PARENT.ledger, parentArtifactSha256: FULLSCRIPT_PARENT.artifact,
    migrationCount: 111, migrationReleaseSha256: successor.ledger,
    extensions: FULLSCRIPT_EXTENSIONS.map(({ source, ...e }) => ({ ...e, file: `${e.version}_${e.name}.sql` })),
    deployment: 'not_deployed', activation: 'blocked', phiAllowed: false,
  } };
}
