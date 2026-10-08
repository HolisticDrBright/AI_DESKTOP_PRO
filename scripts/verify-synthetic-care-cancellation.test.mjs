import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CARE_RELEASE as P} from './synthetic-care-release.mjs';
import {CARE_RECOVERY_ROUTE as R} from './care-recovery-routing.mjs';
import {verifyCancellationControlPlane,verifyRetainedCancellationControlPlane,cancellationFailureCode,collectCancellationInventory} from './verify-synthetic-care-cancellation.mjs';
import {careControlObservation} from './test-fixtures/care-control.mjs';
const source=JSON.parse(readFileSync(new URL('../infra/aws-clinical-core/identity-api-extension.json',import.meta.url),'utf8'));
const observation=careControlObservation;
test('post-parent control plane pins exact code, source template, JWT authority, IAM, encrypted logs and returned route',()=>{
 const original=observation(),before=structuredClone(original);
 const result=verifyCancellationControlPlane(original,source);
 assert.equal(result.routeCount,51);assert.equal(result.phiAllowed,false);assert.deepEqual(original,before);
 for(const mutate of [
  o=>o.foundation.Stacks[0].Outputs.find(v=>v.OutputKey==='PhiAllowed').OutputValue='true',
  o=>o.stack.Stacks[0].StackStatus='UPDATE_IN_PROGRESS',o=>o.stack.Stacks.push(o.stack.Stacks[0]),
  o=>o.stack.Stacks[0].Parameters.find(v=>v.ParameterKey==='LambdaCodeKey').ParameterValue='other',
  o=>o.fn.Environment.Variables.CLINICAL_DATABASE_NAME='clinical_core_qualification',
  o=>o.fn.CodeSha256=Buffer.from(P.previousZipSha256,'hex').toString('base64'),
  o=>o.template.Resources.IdentityApiFunction.Properties.Code.S3ObjectVersion='latest',
  o=>o.integrations.Items[0].IntegrationUri=R.retainedArn,o=>o.integrations.NextToken='hidden',
  o=>o.stage.AutoDeploy=false,o=>o.stage.DefaultRouteSettings.ThrottlingRateLimit=100,
  o=>o.routes.Items.pop(),o=>o.routes.Items[0].AuthorizationType='NONE',
  o=>o.authorizers.Items[0].JwtConfiguration.Audience.push('other'),
  o=>o.authorizers.NextToken='hidden',o=>o.routes.Items.push(o.routes.Items[0]),
  o=>delete o.inline.IsTruncated,o=>delete o.attached.IsTruncated,
  o=>o.logGroups.nextToken='hidden',
  o=>o.policies[0].PolicyDocument.Statement[0].Resource='*',
  o=>o.attached.AttachedPolicies.push({PolicyArn:'AdministratorAccess'}),
  o=>o.role.Role.AssumeRolePolicyDocument.Statement[0].Principal.Service='ec2.amazonaws.com',
  o=>o.logGroups.logGroups[0].retentionInDays=1,o=>o.logGroups.logGroups[0].kmsKeyId='other',
  o=>o.latestPolicy.Policy=JSON.stringify({Version:'2012-10-17',Statement:[]}),
 ]){const value=observation();mutate(value);assert.throws(()=>verifyCancellationControlPlane(value,source));}
});
test('retained verification inspects the actual qualified URI without normalizing it to the current handler',()=>{
 const value=observation();assert.throws(()=>verifyRetainedCancellationControlPlane(value,source));
 value.integrations.Items[0].IntegrationUri=R.retainedArn;
 assert.equal(verifyRetainedCancellationControlPlane(value,source).routeCount,51);
 assert.throws(()=>verifyCancellationControlPlane(value,source));
 value.integrations.Items[0].IntegrationUri=R.latestArn+':2';
 assert.throws(()=>verifyRetainedCancellationControlPlane(value,source));
});
test('only incidental role last-use and log volume metadata are excluded from the stable control digest',()=>{
 const a=observation(),b=observation();
 b.role.Role.RoleLastUsed={LastUsedDate:'fictional-later',Region:P.region};b.logGroups.logGroups[0].storedBytes=100;
 assert.deepEqual(verifyCancellationControlPlane(a,source),verifyCancellationControlPlane(b,source));
 b.fn.RevisionId='new-revision';assert.notDeepEqual(verifyCancellationControlPlane(a,source),verifyCancellationControlPlane(b,source));
});
test('actual runner binds fixed synthetic observers, exact S3 stream and bounded read-only receipt inspection',()=>{
 const script=readFileSync(new URL('./verify-synthetic-care-cancellation.mjs',import.meta.url),'utf8');
 assert.match(script,/readCareArtifact\(object.Body,manifest,signal\)/);
 assert.match(script,/observeSyntheticMemberIdentity\(\)/);
 assert.match(script,/careSourceSnapshot\(root,'desktop'\)/);
 assert.match(script,/maxAttempts:1/);
 assert.equal((script.match(/'--no-paginate'/g)??[]).length,3);
 assert.equal((script.match(/collectCancellationInventory\(aws,/g)??[]).length,4);
 assert.match(script,/inline.IsTruncated===false/);
 assert.match(script,/where owner_id=cast\(:owner as uuid\) and request_id=cast\(:request as uuid\) limit 2/);
 assert.match(script,/if\(!mutationAdmitted\|\|settled\)/);
 assert.doesNotMatch(script,/AdminCreateUser|AdminSetUserPassword|PutObjectCommand|update-integration|update-function|execute-change-set|UPDATE |DELETE |INSERT |process.env|\['upgrade'\]/);
 assert.equal(cancellationFailureCode(new Error('raw health text secret')),'synthetic_care_release_refused:erasure_cancellation_failed');
 assert.equal(cancellationFailureCode(new Error('synthetic_care_release_refused:erasure_cancellation_case')),
  'synthetic_care_release_refused:erasure_cancellation_case');
});
test('all raw inventory pages must terminate within bounds; repeated, absent or malformed pages refuse',()=>{
 const calls=[];
 const result=collectCancellationInventory(args=>{calls.push(args);
  return calls.length===1?{Items:[{RouteKey:'first'}],NextToken:'next'}:{Items:[{RouteKey:'second'}]};},
  ['apigatewayv2','get-routes'],'Items','NextToken');
 assert.deepEqual(result,{Items:[{RouteKey:'first'},{RouteKey:'second'}]});
 assert.deepEqual(calls,[['apigatewayv2','get-routes','--no-paginate'],
  ['apigatewayv2','get-routes','--no-paginate','--next-token','next']]);
 assert.deepEqual(collectCancellationInventory(()=>({logGroups:[]}),['logs','describe-log-groups'],'logGroups','nextToken'),{logGroups:[]});
 for(const bad of [{},null,{Items:Array(301).fill({})},{Items:[],NextToken:''},
  {Items:[],NextToken:7},{Items:[],NextToken:'x'.repeat(2049)}]){
  assert.throws(()=>collectCancellationInventory(()=>bad,['test'],'Items','NextToken'));
 }
 assert.throws(()=>collectCancellationInventory(()=>({Items:[],NextToken:'repeated'}),['test'],'Items','NextToken'),/inventory_token/);
 let pages=0;
 assert.throws(()=>collectCancellationInventory(()=>({Items:[],NextToken:String(++pages)}),['test'],'Items','NextToken'),/inventory_pages/);
 pages=0;
 assert.throws(()=>collectCancellationInventory(()=>({Items:Array(300).fill({}),NextToken:String(++pages)}),['test'],'Items','NextToken'),/inventory_bound/);
});
