import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync,lstatSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,dirname,join} from 'node:path';
import {crc32} from './care-messaging-zip.mjs';
import {SUCCESSOR_QUALIFICATION_RELEASE as release,assertSuccessorQualificationRows} from './successor-qualification-release.mjs';
let directory,manifest;
const sha=value=>createHash('sha256').update(value).digest('hex');
before(()=>{
 directory=mkdtempSync(join(tmpdir(),'alp-successor-fullscript-'));
 execFileSync(process.execPath,['scripts/build-successor-fullscript-api.mjs','--out-dir='+directory],{
  encoding:'utf8',maxBuffer:8*1024*1024,timeout:60000,windowsHide:true});
 manifest=JSON.parse(readFileSync(join(directory,'artifact-manifest.json'),'utf8'));
});
after(()=>{
 if(!directory)return;
 const stat=lstatSync(directory);
 if(!stat.isDirectory()||stat.isSymbolicLink()||dirname(realpathSync(directory))!==realpathSync(tmpdir())
  ||!basename(directory).startsWith('alp-successor-fullscript-'))throw Error('successor_fullscript_cleanup_refused');
 rmSync(directory,{recursive:true,force:false});
});
test('actual clean build binds source, exact 117 ledger, zip bytes and template without activation claims',()=>{
 const zip=readFileSync(join(directory,'function.zip')),code=readFileSync(join(directory,'index.js'));
 assert.equal(manifest.sourceCommit,execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim());
 assert.equal(manifest.sourceClean,true);assert.equal(manifest.contract,'successor-fullscript-api-build/1');
 for(const [key,value] of Object.entries(release))assert.equal(manifest[key],value);
 assert.equal(manifest.zipSha256,sha(zip));assert.equal(manifest.zipBytes,zip.length);
 assert.equal(manifest.codeSha256,createHash('sha256').update(zip).digest('base64'));
 assert.equal(manifest.indexSha256,sha(code));
 assert.equal(zip.readUInt32LE(0),0x04034b50);assert.equal(zip.readUInt16LE(8),0);
 const nameLength=zip.readUInt16LE(26),extraLength=zip.readUInt16LE(28),size=zip.readUInt32LE(18);
 assert.equal(zip.subarray(30,30+nameLength).toString(),'index.js');assert.equal(extraLength,0);
 assert.deepEqual(zip.subarray(30+nameLength,30+nameLength+size),code);
 assert.equal(zip.readUInt32LE(14),crc32(code));assert.equal(zip.readUInt16LE(zip.length-12),1);
 assert.equal(manifest.templateSha256,sha(readFileSync(join(directory,'template.json'))));
 assert.equal(manifest.parentTemplateSha256,sha(readFileSync(join(directory,'historical-template.json'))));
 for(const key of ['phiAllowed','deployed','hostedQualified','providerActionPerformed','completeFleetQualified','targetBindingComplete'])assert.equal(manifest[key],false);
 assert.equal(manifest.activation,'blocked');assert.equal(manifest.targetEmbedded,false);
 assertSuccessorQualificationRows(JSON.parse(readFileSync(join(directory,'release-artifact.json'),'utf8')).rows);
});
test('actual CJS packaged entry point refuses disabled or mismatched binding without a qualification marker',()=>{
 for(const change of [{QUALIFICATION_EXECUTION:'false'},{SOURCE_INPUT_SHA256:'wrong'},{CLINICAL_DATABASE_SECRET_ARN:'operator'}]){
  const invoke="const m=require("+JSON.stringify(join(directory,'index.js'))+");m.handler({routeKey:'POST /clinical-core/consumer/fullscript/draft'},"
   +JSON.stringify({functionVersion:'7',invokedFunctionArn:'arn:aws:lambda:us-east-2:588966314750:function:fictional:7'})
   +").then(r=>{if(r.statusCode!==503||r.headers?.['x-clinical-execution'])process.exit(2)}).catch(()=>process.exit(3));";
  execFileSync(process.execPath,['-e',invoke],{encoding:'utf8',timeout:10000,windowsHide:true,
   env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,...change}});
 }
});
test('generated template binds its numeric published version and separate source-addressed code key',()=>{
 const template=JSON.parse(readFileSync(join(directory,'template.json'),'utf8'));
 assert.deepEqual(template.Resources.Version.Properties.CodeSha256,{Ref:'CodeSha256'});
 assert.equal(template.Parameters.CodeSha256.Default,manifest.codeSha256);
 assert.deepEqual(template.Resources.Integration.Properties.IntegrationUri,{Ref:'Version'});
 assert.equal(template.Parameters.CodeKey.Default,'fullscript/successor-qualification-api/'+manifest.sourceCommit+'/'+manifest.sourceInputSha256+'/function.zip');
 assert.equal(template.Metadata.CredentialRole,'fullscript_draft_worker');
});
