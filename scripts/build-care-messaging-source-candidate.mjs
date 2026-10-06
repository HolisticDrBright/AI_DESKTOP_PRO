/** Local source artifact only. No handler, template, AWS call or activation. */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
if (process.argv.length !== 2) throw new Error('care_message_source_argument_invalid');
const out = 'dist/aws-clinical-core/care-messaging-source';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const schema = readFileSync('infra/aws-clinical-core/production-candidates/care-messaging.sql', 'utf8').replace(/\r\n?/g, '\n');
const baseline = JSON.parse(execFileSync(process.execPath, ['scripts/build-aws-production-clinical-core.mjs', '--json'], {
  encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024,
}));
// Preserve the currently qualified release; this overlay must not silently enter it.
// The database ledger hash uses version:SQL-digest. The assembler's hash also
// includes filenames; they are different identities and must never be confused.
const ledgerReleaseSha256 = sha(baseline.manifest.migrations.map(m => `${m.version}:${sha(baseline.files[m.file])}`).join('\n'));
if (baseline.manifest.migrations.length !== 103 || ledgerReleaseSha256 !== '9bc30d04930816a523a7dc67b95944fba1d294dad4d71cf7585158fbc3a874aa') throw new Error('care_message_baseline_changed');
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const sourceDirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--',
  'src', 'scripts', 'infra', 'package.json', 'package-lock.json', '.gitattributes', '.github'], { encoding: 'utf8' }).trim().length !== 0;
mkdirSync(out, { recursive: true });
await build({ entryPoints: ['src/server/clinical-core/production-care-messaging-api.ts'], outfile: out + '/candidate-library.cjs',
  platform: 'node', target: 'node22', format: 'cjs', bundle: true, minify: true, legalComments: 'none' });
writeFileSync(out + '/care-messaging.sql', schema);
const manifest = {
  contract: 'care-messaging-source-candidate/1', status: 'unreleased', deployable: false,
  sourceCommit, sourceDirty, baselineMigrationCount: 103, baselineLedgerReleaseSha256: ledgerReleaseSha256, baselineAssemblySha256: baseline.releaseHash,
  schemaSha256: sha(schema), librarySha256: sha(readFileSync(out + '/candidate-library.cjs')),
  proposedRoutes: ['POST /clinical-core/consumer/messages', 'POST /clinical-core/workforce/messages', 'POST /clinical-core/consumer/messages/export'],
  newTables: ['clinical_core.care_message_thread_links', 'clinical_core.care_message_receipts', 'clinical_core.care_message_cancellations', 'clinical_audit.care_message_access_events'],
  privacyCoverage: 'retained in-app correspondence and cancellation receipts, live owner-scoped pages; not whole-account export or erasure',
  remaining: ['canonical ordered migration and coverage mapping', 'reviewed upgrade and rollback operator', 'deployment template and artifact-bound Lambda handler',
    'V2 production provider wiring', 'clinic hold-aware lifecycle and amendment mapping', 'synthetic hosted concurrency and device acceptance', 'independent activation reviews'],
};
writeFileSync(out + '/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ status: manifest.status, deployable: false, sourceCommit, sourceDirty,
  baselineLedgerReleaseSha256: ledgerReleaseSha256, baselineAssemblySha256: baseline.releaseHash, schemaSha256: manifest.schemaSha256, librarySha256: manifest.librarySha256 }));
