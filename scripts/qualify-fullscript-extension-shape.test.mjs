import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const root=fileURLToPath(new URL('../',import.meta.url));
const script='scripts/qualify-fullscript-extension-shape.mjs';
for(const args of [[],['--help'],['--profile','ai-synthetic-member'],['--database-url','postgres://fictional'],
  ['--binary-directory','.','--driver-directory','.'],
  ['--binary-directory','C:/fictional','--driver-directory','C:/fictional','--approve']]){
  test('shape diagnostic refuses cloud, existing DB, approval or malformed arguments '+JSON.stringify(args),()=>{
    const run=spawnSync(process.execPath,[script,...args],{cwd:root,encoding:'utf8',timeout:10000,windowsHide:true,
      env:{...process.env,AWS_PROFILE:'MUST_NOT_BE_USED',PGHOST:'MUST_NOT_BE_USED'}});
    assert.equal(run.status,1);assert.match(run.stderr,/fullscript_native_owner_arguments_refused/);assert.equal(run.stdout,'');
  });
}
test('native shape comparison keeps production checks whole and proves negative cases',()=>{
  const source=readFileSync(new URL('./qualify-fullscript-extension-shape.mjs',import.meta.url),'utf8');
  assert.match(source,/managedObservedValuesUsed:false/);
  assert.match(source,/extraNotNullRows!==77/);
  assert.match(source,/alter column state drop not null/);
  assert.match(source,/shape_negative_not_refused/);
  assert.match(source,/shutdown_unconfirmed/);
  assert.doesNotMatch(source,/create role rds_superuser|from ['"]@aws-sdk|aws\.exe/);
});
