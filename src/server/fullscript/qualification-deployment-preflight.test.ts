import {beforeAll,expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fullscriptQualificationTemplate} from '../../../scripts/fullscript-qualification-template.mjs';
import {preflightFullscriptDeployment} from './qualification-deployment-preflight';
const canonical=(v:unknown):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'
 ?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}':JSON.stringify(v);
const bytes=(v:unknown)=>Buffer.from(canonical(v)+'\n'),pretty=(v:unknown)=>Buffer.from(JSON.stringify(v,null,2)+'\n');
const sha=(v:Buffer)=>createHash('sha256').update(v).digest('hex');
let fixture:ReturnType<typeof setup>;
function setup(migrations:unknown[]){
 const zipBytes=Buffer.from('FICTIONAL ZIP BYTES: no deployed artifact'),sourceCommit='a'.repeat(40);
 const build={contract:'fullscript-api-build/1',sourceCommit,clean:true,handler:'index.handler',runtime:'nodejs22.x',
  indexSha256:'b'.repeat(64),zipSha256:sha(zipBytes),codeSha256:createHash('sha256').update(zipBytes).digest('base64'),
  execution:'qualification_only',phiAllowed:false,activation:'blocked',targetEmbedded:false,immutableTargetVersionRequired:true,
  targetReviewRequired:true,publishedVersionRequired:true,deployed:false,hostedQualified:false,providerActionPerformed:false};
 const target={contract:'fullscript-qualification-target-release/2',target:{execution:'qualification',account:'588966314750',region:'us-east-2',
  phiAllowed:false,activation:'blocked',sourceCommit,apiId:'a123456789',functionArn:'arn:aws:lambda:us-east-2:588966314750:function:alp-fullscript-qualification-fictional',
  codeSha256:build.codeSha256,clusterArn:'arn:aws:rds:us-east-2:588966314750:cluster:fictional',
  secretArn:'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional-db',databaseName:'clinical_core_qualification',
  organizationId:'11111111-1111-4111-8111-111111111111',consumerIssuer:'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_FictionalConsumer',
  consumerAudience:'c'.repeat(26),workforceIssuer:'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_FictionalWorkforce',workforceAudience:'w'.repeat(26),
  consumerSubjects:['FICTIONAL-consumer-one','FICTIONAL-consumer-two'],workforceSubjects:['FICTIONAL-workforce'],migrations},
  credentials:{providerSecretArn:'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional-provider',providerSecretVersion:'f'.repeat(32),
   tokenTable:'fictional-tokens',redirectUri:'https://fictional.example.test/api/live/fullscript/oauth/callback'},
  // FICTIONAL fixture attestation; never an actual owner review.
  review:{reviewer:'Brandon Bright',reviewedAt:'2026-10-01T00:00:00.000Z',decision:'approved',scope:'fictional-fullscript-api-target-only',
   versionBinding:'observed-numeric-version-of-exact-reviewed-code'}};
 const template=fullscriptQualificationTemplate(build),definitions=template.Parameters as Record<string,{Default?:string}>;
 const parameters:Record<string,string>={...Object.fromEntries(Object.entries(definitions).map(([k,v])=>[k,v.Default??''])),
  QualificationExecution:'true',FunctionName:target.target.functionArn.split(':').at(-1)!,ApiId:target.target.apiId,
  ConsumerAuthorizerId:'fictionalconsumer',WorkforceAuthorizerId:'fictionalworkforce',ConsumerPoolId:'us-east-2_FictionalConsumer',WorkforcePoolId:'us-east-2_FictionalWorkforce',
  OrganizationId:target.target.organizationId,CodeObjectVersion:'FICTIONAL-code-version',TargetKey:'fullscript/qualification-target/'+'1'.repeat(32)+'/target.json',
  TargetObjectVersion:'FICTIONAL-target-version',TargetReviewSha256:sha(bytes(target)),DatabaseClusterArn:target.target.clusterArn,DatabaseSecretArn:target.target.secretArn,
  ProviderSecretArn:target.credentials.providerSecretArn,ProviderSecretVersion:target.credentials.providerSecretVersion,TokenTableName:target.credentials.tokenTable,
  RedirectUri:target.credentials.redirectUri,AlarmTopicArn:'arn:aws:sns:us-east-2:588966314750:ai-clinical-core-qualification-alarms'};
 return {sourceCommit,clean:true,now:Date.parse('2026-10-09T21:00:00Z'),buildBytes:pretty(build),zipBytes,targetBytes:bytes(target),
  templateBytes:pretty(template),parameterBytes:bytes(Object.entries(parameters).map(([ParameterKey,ParameterValue])=>({ParameterKey,ParameterValue})))};
}
beforeAll(()=>{
 const artifact=JSON.parse(execFileSync(process.execPath,['scripts/build-fullscript-candidate.mjs','--json'],{encoding:'utf8',maxBuffer:8*1024*1024,timeout:30000,windowsHide:true}));
 fixture=setup(artifact.manifest.migrations.map((m:{version:string;file:string})=>({version:m.version,name:m.file.slice(15,-4),sha256:sha(Buffer.from(artifact.files[m.file]))})));
});
it('binds all explicit parameters but never reports deployment approval or hosted evidence',()=>{
 const report=preflightFullscriptDeployment(fixture);expect(report).toMatchObject({verdict:'locally_consistent',awsObserved:false,
  ownerDeploymentReviewRequired:true,approvedForDeployment:false,deployed:false,hostedQualified:false,phiAllowed:false});
 expect(JSON.stringify(report)).not.toContain('fictional-provider');expect(report.parameterCount).toBe(27);
});
it.each(['FunctionName','ApiId','OrganizationId','ConsumerPoolId','WorkforcePoolId','DatabaseName','DatabaseClusterArn','DatabaseSecretArn',
 'ProviderSecretArn','ProviderSecretVersion','TokenTableName','RedirectUri','TargetReviewSha256','SourceCommit','CodeSha256','CodeKey',
 'QualificationExecution','PhiAllowed','Activation','CodeObjectVersion','TargetObjectVersion','TargetKey','AlarmTopicArn'])('refuses changed %s',key=>{
 const rows=JSON.parse(fixture.parameterBytes.toString()) as {ParameterKey:string;ParameterValue:string}[];
 rows.find(row=>row.ParameterKey===key)!.ParameterValue=key.endsWith('ObjectVersion')?'null':'changed';
 expect(()=>preflightFullscriptDeployment({...fixture,parameterBytes:bytes(rows)})).toThrow('fullscript_deployment_preflight_refused');
});
it.each(['missing','unknown','duplicate','previous','same-authorizer','encoding','duplicate-key'])('refuses malformed parameters %s',kind=>{
 const rows=JSON.parse(fixture.parameterBytes.toString()) as Record<string,string>[];
 if(kind==='missing')rows.pop();if(kind==='unknown')rows.push({ParameterKey:'Extra',ParameterValue:'x'});
 if(kind==='duplicate')rows.push(rows[0]);if(kind==='previous')rows[0]={ParameterKey:rows[0].ParameterKey,UsePreviousValue:'true'};
 if(kind==='same-authorizer')rows.find(r=>r.ParameterKey==='WorkforceAuthorizerId')!.ParameterValue='fictionalconsumer';
 let b=bytes(rows);if(kind==='encoding')b=Buffer.from(b.toString().replace(/\n/g,'\r\n'));
 if(kind==='duplicate-key')b=Buffer.from(b.toString().replace('"ParameterKey":','"ParameterKey":"hidden", "ParameterKey":'));
 expect(()=>preflightFullscriptDeployment({...fixture,parameterBytes:b})).toThrow('fullscript_deployment_preflight_refused');
});
it.each(['zip','template','source','dirty','future-review','missing-review','missing-gate','wrong-ledger'])('refuses changed authority %s',kind=>{
 const changed={...fixture};
 if(kind==='zip')changed.zipBytes=Buffer.from('changed');if(kind==='template')changed.templateBytes=Buffer.from('{}\n');
 if(kind==='source')changed.sourceCommit='c'.repeat(40);if(kind==='dirty')changed.clean=false;
 if(kind==='future-review'||kind==='missing-review'||kind==='wrong-ledger'){
  const target=JSON.parse(changed.targetBytes.toString());if(kind==='future-review')target.review.reviewedAt='2099-01-01T00:00:00.000Z';
  if(kind==='missing-review')delete target.review;if(kind==='wrong-ledger')target.target.migrations[0].sha256='d'.repeat(64);changed.targetBytes=bytes(target);
 }
 if(kind==='missing-gate'){const build=JSON.parse(changed.buildBytes.toString());delete build.immutableTargetVersionRequired;changed.buildBytes=pretty(build);}
 expect(()=>preflightFullscriptDeployment(changed)).toThrow('fullscript_deployment_preflight_refused');
});
