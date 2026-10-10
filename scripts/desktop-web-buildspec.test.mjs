import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';

// Execute the template's actual single-line commands in a real shell. Only
// docker/aws are fictional local functions; there are no credentials or builds.
const template=JSON.parse(readFileSync(new URL('../infra/aws-clinical-core/desktop-web-hosting.json',import.meta.url),'utf8'));
const spec=template.Resources.DesktopWebBuildProject.Properties.Source.BuildSpec['Fn::Sub'];
const shell=process.platform==='win32'?'C:\\Program Files\\Git\\bin\\bash.exe':'/bin/bash';
assert.ok(existsSync(shell),'A real bash shell is required; this gate must not silently skip');
const commands=phase=>{
 const section=spec.match(new RegExp(`^  ${phase}:\\n([^]*?)(?=^  [a-z_]+:|$(?![^]))`,'m'))?.[1];
 assert.ok(section,'Missing build phase '+phase);
 const result=section.split('\n').filter(line=>/^      - /.test(line)).map(line=>line.slice(8));
 assert.ok(result.length,'Missing commands for '+phase);return result;
};
const run=(phase,values)=>{
 const env={...process.env};
 for(const key of ['CODEBUILD_BUILD_SUCCEEDING','CODEBUILD_RESOLVED_SOURCE_VERSION','IMAGE_TAG'])delete env[key];
 Object.assign(env,values,{ECR_REGISTRY:'fictional.invalid',ECR_REPOSITORY_URI:'fictional.invalid/test'});
 return spawnSync(shell,['--noprofile','--norc','-e','-c',
  'aws(){ return 0; }; docker(){ if [ "$1" = push ]; then printf "FICTIONAL_PUSH_REACHED\\n"; fi; };\n'+commands(phase).join('\n')],
  {env,encoding:'utf8',windowsHide:true,timeout:5000,maxBuffer:65536});
};
for(const [label,state] of [['failed','0'],['missing',undefined],['unknown','2'],['malformed','yes']]){
 test('post_build refuses publication when prior build state is '+label,()=>{
  const result=run('post_build',state===undefined?{}:{CODEBUILD_BUILD_SUCCEEDING:state});
  assert.equal(result.error,undefined);assert.notEqual(result.status,0);
  assert.doesNotMatch(result.stdout,/FICTIONAL_PUSH_REACHED/);
 });
}
test('successful prior build can reach exactly one publication command',()=>{
 const result=run('post_build',{CODEBUILD_BUILD_SUCCEEDING:'1'});
 assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);
 assert.equal(result.stdout,'FICTIONAL_PUSH_REACHED\n');
 assert.equal(commands('post_build').filter(line=>line.startsWith('docker push ')).length,1);
});
const source='a'.repeat(40);
for(const [label,values] of [
 ['different downloaded commit',{IMAGE_TAG:source,CODEBUILD_RESOLVED_SOURCE_VERSION:'b'.repeat(40)}],
 ['missing downloaded commit',{IMAGE_TAG:source}],
 ['short mutable tag',{IMAGE_TAG:'aaaaaaa',CODEBUILD_RESOLVED_SOURCE_VERSION:'aaaaaaa'}],
 ['nonhex tag',{IMAGE_TAG:'g'.repeat(40),CODEBUILD_RESOLVED_SOURCE_VERSION:'g'.repeat(40)}],
 ['missing tag',{CODEBUILD_RESOLVED_SOURCE_VERSION:source}],
])test('pre_build refuses '+label,()=>{
 const result=run('pre_build',values);
 assert.equal(result.error,undefined);assert.notEqual(result.status,0);
});
test('pre_build admits the exact full downloaded source identity',()=>{
 const result=run('pre_build',{IMAGE_TAG:source,CODEBUILD_RESOLVED_SOURCE_VERSION:source});
 assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);
});
test('CloudFormation source and tag parameters require complete immutable commits',()=>{
 for(const key of ['SourceVersion','ImageTag']){
  const pattern=new RegExp(template.Parameters[key].AllowedPattern);
  assert.equal(pattern.test(source),true);assert.equal(pattern.test('main'),false);assert.equal(pattern.test('a'.repeat(7)),false);
 }
});
