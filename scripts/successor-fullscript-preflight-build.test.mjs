import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,lstatSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,dirname,join} from 'node:path';
let directory;
before(()=>{
 directory=mkdtempSync(join(tmpdir(),'alp-successor-fullscript-preflight-'));
 execFileSync(process.execPath,['scripts/build-successor-fullscript-preflight.mjs','--out-dir='+directory],{
  encoding:'utf8',maxBuffer:8*1024*1024,timeout:60000,windowsHide:true});
});
after(()=>{
 if(!directory)return;
 const stat=lstatSync(directory);
 if(!stat.isDirectory()||stat.isSymbolicLink()||dirname(realpathSync(directory))!==realpathSync(tmpdir())
  ||!basename(directory).startsWith('alp-successor-fullscript-preflight-'))throw Error('successor_fullscript_preflight_cleanup_refused');
 rmSync(directory,{recursive:true,force:false});
});
test('actual clean-built command binds source and executable bytes without deployment authority',()=>{
 const manifest=JSON.parse(readFileSync(join(directory,'artifact-manifest.json'),'utf8'));
 assert.equal(manifest.sourceClean,true);assert.equal(manifest.contract,'successor-fullscript-preflight-build/1');
 assert.equal(manifest.sourceCommit,execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim());
 assert.equal(manifest.executableSha256,createHash('sha256').update(readFileSync(join(directory,'index.cjs'))).digest('hex'));
 for(const key of ['awsActionsAllowed','providerActionsAllowed','deploymentAllowed','phiAllowed'])assert.equal(manifest[key],false);
});
test('compiled CLI refuses malformed modes and paths before cloud or provider work',()=>{
 for(const args of [[],['--wrong'],['--inspect-fictional-successor-fullscript-only'],
  ['--inspect-fictional-successor-fullscript-only','relative','relative','relative','relative','relative'],
  ['--inspect-fictional-successor-fullscript-only',...Array(5).fill(join(directory,'missing'))]]){
  let failed=false;
  try{execFileSync(process.execPath,[join(directory,'index.cjs'),...args],{
   encoding:'utf8',timeout:15000,windowsHide:true,env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot}});}
  catch(error){failed=true;assert.equal(error.status,1);assert.equal(String(error.stderr).trim(),'successor_fullscript_deployment_preflight_refused');
   assert.equal(String(error.stdout).trim(),'');}
  assert.equal(failed,true);
 }
});
