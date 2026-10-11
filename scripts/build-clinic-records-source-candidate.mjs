/** Local source artifact only. No handler registration, template, AWS call, release or activation. */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
if (process.argv.length !== 2) throw new Error('clinic_records_source_argument_invalid');
const out = 'dist/aws-clinical-core/clinic-records-source';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const candidate = JSON.parse(execFileSync(process.execPath, ['scripts/build-clinic-record-privacy-candidate.mjs', '--json'], {
  encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024,
}));
if (candidate.candidate.contract !== 'clinic-record-privacy-candidate/4' || candidate.manifest.migrations.length !== 116) throw new Error('clinic_records_candidate_changed');
const schema = candidate.files[candidate.manifest.migrations[115].file];
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const sourceDirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--',
  'src', 'scripts', 'infra', 'package.json', 'package-lock.json', '.gitattributes', '.github'], { encoding: 'utf8' }).trim().length !== 0;
mkdirSync(out, { recursive: true });
await build({ entryPoints: ['src/server/clinical-core/production-clinic-records-api.ts'], outfile: out + '/candidate-library.cjs',
  platform: 'node', target: 'node22', format: 'cjs', bundle: true, minify: true, legalComments: 'none' });
writeFileSync(out + '/clinic-record-privacy.sql', schema);
const manifest = {
  contract: 'clinic-records-source-candidate/1', status: 'unreleased', deployable: false,
  sourceCommit, sourceDirty,
  parentMigrationCount: candidate.candidate.parentMigrationCount, parentMigrationReleaseSha256: candidate.candidate.parentMigrationReleaseSha256,
  migrationCount: 116, migrationReleaseSha256: candidate.candidate.migrationReleaseSha256, migrationAssemblySha256: candidate.releaseHash,
  migrationFile: candidate.manifest.migrations[115].file, schemaSha256: sha(schema), librarySha256: sha(readFileSync(out + '/candidate-library.cjs')),
  proposedRoutes: ['POST /clinical-core/consumer/clinic-records', 'POST /clinical-core/workforce/clinic-records'],
  routeAuthorizers: { 'POST /clinical-core/consumer/clinic-records': 'ConsumerJwtAuthorizer', 'POST /clinical-core/workforce/clinic-records': 'WorkforceJwtAuthorizer' },
  newTables: ['clinical_core.clinic_record_requests', 'clinical_core.clinic_record_request_events', 'clinical_core.clinic_record_copies',
    'clinical_core.clinic_record_copy_items', 'clinical_private.clinic_disclosure_releases'],
  newFunctions: ['clinical_core.clinic_record_request(jsonb)'],
  configuration: {
    // Every serving deployment must carry independent reviews; none exist, so the handler refuses to serve.
    disclosureReviewSha256: null, retentionReviewSha256: null, mfaReviewSha256: null, activation: 'blocked', phiAllowed: false,
    freshSignInWindows: { consumerActionsMs: 15 * 60000, copyReadMs: 5 * 60000 },
  },
  privacyCoverage: 'clinic-held signed notes with addenda, telehealth visit records through chart-transfer receipts and accepted lab observations, '
    + 'as a snapshot copy per fulfilled request; correspondence stays with the care-message export; not whole-account export, not erasure',
  remaining: ['owner review and registration of clinic disclosure releases (clinical_private.clinic_disclosure_releases is empty)',
    'registration of migration 116 after the chart-lifecycle successor is settled', 'route registration and deployment (Codex)',
    'hosted qualification: two clinics, two patients, both pools, lock-wait races', 'reviewed retention posture for fulfilled copies (no expiry is invented)'],
};
writeFileSync(out + '/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ status: manifest.status, deployable: false, sourceCommit, sourceDirty, migrationReleaseSha256: manifest.migrationReleaseSha256,
  migrationAssemblySha256: manifest.migrationAssemblySha256, schemaSha256: manifest.schemaSha256, librarySha256: manifest.librarySha256 }));
