import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,writeFileSync,lstatSync,realpathSync,rmSync,cpSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,dirname,join} from 'node:path';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
let directory;
before(async()=>{
 directory=mkdtempSync(join(tmpdir(),'alp-successor-fullscript-deployment-'));
 execFileSync(process.execPath,['scripts/build-successor-fullscript-deployment-operator.mjs'],{
  encoding:'utf8',maxBuffer:8*1024*1024,timeout:60000,windowsHide:true});
 cpSync('dist/aws-clinical-core/successor-fullscript-deployment-operator',directory,{recursive:true});
 execFileSync(process.execPath,['scripts/build-successor-fullscript-api.mjs','--out-dir='+join(directory,'api')],{
  encoding:'utf8',maxBuffer:8*1024*1024,timeout:60000,windowsHide:true});
 await build({entryPoints:['src/server/fullscript/successor-deployment.fixture.ts'],outfile:join(directory,'fixture.cjs'),
  bundle:true,platform:'node',target:'node22',format:'cjs'});
});

const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'
 ?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const bytes=v=>Buffer.from(canonical(v)+'\n');
const sha=v=>createHash('sha256').update(v).digest('hex');
function nativeInputs(changed=false){
 const fixture=createRequire(import.meta.url)(join(directory,'fixture.cjs')).createSuccessorDeploymentFixture();
 const build=JSON.parse(readFileSync(join(directory,'api','artifact-manifest.json'),'utf8'));
 const template=JSON.parse(readFileSync(join(directory,'api','template.json'),'utf8')),target=JSON.parse(fixture.targetBytes.toString());
 Object.assign(target.target,{sourceCommit:build.sourceCommit,sourceInputSha256:build.sourceInputSha256,codeSha256:build.codeSha256});
 const targetBytes=bytes(target),values=Object.fromEntries(JSON.parse(fixture.parameterBytes.toString()).map(p=>[p.ParameterKey,p.ParameterValue]));
 Object.assign(values,{SourceCommit:build.sourceCommit,SourceInputSha256:build.sourceInputSha256,CodeSha256:build.codeSha256,
  CodeKey:template.Parameters.CodeKey.Default,TargetReviewSha256:sha(targetBytes)});
 const parameterBytes=bytes(Object.entries(values).map(([ParameterKey,ParameterValue])=>({ParameterKey,ParameterValue})));
 const review=JSON.parse(fixture.reviewBytes.toString());
 Object.assign(review,{reviewedAt:new Date().toISOString(),sourceCommit:build.sourceCommit,sourceInputSha256:build.sourceInputSha256,
  zipSha256:build.zipSha256,templateSha256:build.templateSha256,targetSha256:sha(targetBytes),parameterSha256:sha(parameterBytes)});
 // A digest-only alteration still passes offline consistency. The actual
 // independently rebuilt manifest must catch it before any AWS work.
 if(changed)build.sourceCandidateSha256=build.sourceCandidateSha256==='f'.repeat(64)?'e'.repeat(64):'f'.repeat(64);
 const contents=[Buffer.from(JSON.stringify(build,null,2)+'\n'),readFileSync(join(directory,'api','function.zip')),
  readFileSync(join(directory,'api','template.json')),targetBytes,parameterBytes,bytes(review)];
 return contents.map((content,index)=>{
  const file=join(directory,(changed?'changed':'positive')+'-'+index+'.input');writeFileSync(file,content);return file;
 });
}
test('compiled validation positively rebuilds the actual API but makes no deployment or hosted claim',()=>{
 const output=execFileSync(process.execPath,[join(directory,'index.cjs'),'--fictional-successor-fullscript-deployment-only','validate',...nativeInputs()],{
  encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024,windowsHide:true});
 const result=JSON.parse(output);assert.equal(result.contract,'successor-fullscript-deployment-validation/1');
 assert.equal(result.sourceRebuilt,true);assert.equal(result.sourceObserved,true);assert.equal(result.migrationCount,117);
 for(const key of ['awsObserved','approvedForDeployment','deployed','hostedQualified','completeFleetQualified','providerActionPerformed','phiAllowed'])
  assert.equal(result[key],false);
});
test('actual rebuild refuses an altered candidate digest despite internally consistent input',()=>{
 assert.throws(()=>execFileSync(process.execPath,[join(directory,'index.cjs'),'--fictional-successor-fullscript-deployment-only','validate',...nativeInputs(true)],{
  encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024,windowsHide:true}),error=>{
   assert.equal(error.status,1);assert.equal(String(error.stderr).trim(),'successor_fullscript_deployment_command_refused');
   assert.equal(String(error.stdout).trim(),'');return true;
  });
});
after(()=>{
 if(!directory)return;
 const stat=lstatSync(directory);
 if(!stat.isDirectory()||stat.isSymbolicLink()||dirname(realpathSync(directory))!==realpathSync(tmpdir())
  ||!basename(directory).startsWith('alp-successor-fullscript-deployment-'))throw Error('successor_fullscript_deployment_cleanup_refused');
 rmSync(directory,{recursive:true,force:false});
});
test('actual clean-built command binds source and executable bytes without deployment authority',()=>{
 const manifest=JSON.parse(readFileSync(join(directory,'artifact-manifest.json'),'utf8'));
 assert.equal(manifest.sourceClean,true);assert.equal(manifest.contract,'successor-fullscript-deployment-operator-build/1');
 assert.equal(manifest.sourceCommit,execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim());
 assert.equal(manifest.operatorSha256,createHash('sha256').update(readFileSync(join(directory,'index.cjs'))).digest('hex'));
 for(const key of ['deployed','providerActionPerformed','completeFleetQualified','hostedQualified','phiAllowed'])assert.equal(manifest[key],false);
});
test('compiled CLI refuses malformed modes and paths before cloud or provider work',()=>{
 for(const args of [[],['--wrong'],['--fictional-successor-fullscript-deployment-only'],
  ['--fictional-successor-fullscript-deployment-only','inspect','relative','relative','relative','relative','relative','relative'],
  ['--fictional-successor-fullscript-deployment-only','inspect',...Array(6).fill(join(directory,'missing'))]]){
  let failed=false;
  try{execFileSync(process.execPath,[join(directory,'index.cjs'),...args],{
   encoding:'utf8',timeout:15000,windowsHide:true,env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot}});}
  catch(error){failed=true;assert.equal(error.status,1);assert.equal(String(error.stderr).trim(),'successor_fullscript_deployment_command_refused');
   assert.equal(String(error.stdout).trim(),'');}
  assert.equal(failed,true);
 }
});
