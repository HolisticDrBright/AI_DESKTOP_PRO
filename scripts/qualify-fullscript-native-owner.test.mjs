import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const root=fileURLToPath(new URL('../',import.meta.url));
const script='scripts/qualify-fullscript-native-owner.mjs';
const cases=[[],['--help'],['--database-url','postgres://fictional'],['--profile','ai-synthetic-member'],
  ['--binary-directory','.','--driver-directory','.'],
  ['--driver-directory','C:/fictional','--binary-directory','C:/fictional'],
  ['--binary-directory','C:/fictional','--driver-directory','C:/fictional','--approve'],
  ['--binary-directory','C:/fictional','--driver-directory','relative'],
  ['--binary-directory','relative','--driver-directory','C:/fictional'],
  ['--binary-directory','C:/fictional','--binary-directory','C:/fictional']];
for(const args of cases)test('refuses non-local or malformed native diagnostic arguments '+JSON.stringify(args),()=>{
  const run=spawnSync(process.execPath,[script,...args],{cwd:root,encoding:'utf8',timeout:10000,windowsHide:true,
    env:{...process.env,AWS_PROFILE:'MUST_NOT_BE_USED',PGHOST:'MUST_NOT_BE_USED'}});
  assert.equal(run.status,1);assert.match(run.stderr,/fullscript_native_owner_arguments_refused/);
  assert.equal(run.stdout,'');
});
test('the native diagnostic does not install a managed role or certify protected rows or runtime admission',()=>{
  const source=readFileSync(new URL('./qualify-fullscript-native-owner.mjs',import.meta.url),'utf8');
  assert.match(source,/create role clinical_admin login nosuperuser inherit createdb createrole noreplication nobypassrls/);
  assert.match(source,/protectedRowsVerified:false,operatorAcceptance:false/);
  assert.match(source,/managedRoleSemanticsVerified:false,runtimeAdmission:false/);
  assert.doesNotMatch(source,/create role rds_superuser|from ['"]@aws-sdk|aws\.exe/);
  assert.match(source,/shutdown_unconfirmed/);
});
