// Build only: no AWS request or database write.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';

if (process.argv.length !== 2) throw Error('qualification_program_build_argument_refused');
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
const clean = !execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--',
  'src', 'scripts', 'infra', 'package.json', 'package-lock.json', '.gitattributes', '.github'],
{ encoding: 'utf8', windowsHide: true }).trim();
if (!clean) throw Error('qualification_program_build_dirty_source_refused');
const sourceSql = [
  ['infra/aws-clinical-core/production-candidates/lab-result-transfer-v2.sql', 'fa6ee162a03a85ab23543371d9d1dbaf8ee6dd486b4a8cc64b5545fc16be3b94'],
  ['infra/aws-clinical-core/production-candidates/lab-observation-attestation.sql', 'd0423bcec5067a668f3522bbba65d096f642f083c1ef95448da190b38494bb83'],
  ['infra/aws-clinical-core/production-candidates/production-program-assignments.sql', '78bd5b3805d96443829f6e7380deba0d66ad2f03073374bd6681f4f6bc25b4f3'],
  ['infra/aws-clinical-core/production-candidates/production-program-consumer-boundary.sql', 'ca0ce5a62e68638c7c29bd114018344c2755da946d1785f849e11088f8e1122d'],
  ['infra/aws-clinical-core/source-candidates/qualification-program-boundary.sql', '0f07717d240d981b3900f6c2e926aa79025157f916e869c4a74def52214261a6'],
  ['infra/aws-clinical-core/source-candidates/qualification-program-boundary-rollback.sql', 'bfdf50b7bb0676d83fa2bb37fa653b8023e03cce1efa20d5916896a76274da9e'],
];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
for (const [path, digest] of sourceSql) {
  if (sha(readFileSync(path, 'utf8').replace(/\r\n?/g, '\n')) !== digest) throw Error('qualification_program_build_sql_drift_refused');
}
const dir = 'dist/aws-clinical-core/qualification-program-schema-upgrade';
const outfile = `${dir}/index.cjs`;
mkdirSync(dir, { recursive: true });
await build({ entryPoints: ['src/server/clinical-core/qualification-program-schema-upgrade-operator.ts'], outfile,
  bundle: true, platform: 'node', target: 'node22', format: 'cjs', minify: false, sourcemap: false,
  legalComments: 'none', treeShaking: true,
  define: { __QUALIFICATION_PROGRAM_UPGRADE_BUILD__: JSON.stringify({ sourceCommit, clean }) } });
const committed = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
if (committed !== sourceCommit || execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--',
  'src', 'scripts', 'infra', 'package.json', 'package-lock.json', '.gitattributes', '.github'],
{ encoding: 'utf8', windowsHide: true }).trim()) throw Error('qualification_program_build_source_changed');
writeFileSync(`${dir}/artifact-manifest.json`, JSON.stringify({ contract: 'qualification-program-schema-upgrade-build/1',
  sourceCommit, clean, operatorSha256: sha(readFileSync(outfile)), candidateSql: sourceSql,
  database: 'clinical_core_qualification', awsAccountId: '588966314750', execution: 'fictional_only',
  phiAllowed: false, productionActivation: 'blocked', migrationPerformed: false,
  mandatoryRollbackRehearsal: true, automaticWriteRetry: false }, null, 2) + '\n');
console.log(JSON.stringify({ built: true, sourceCommit, clean, migrationPerformed: false, phiAllowed: false }));
