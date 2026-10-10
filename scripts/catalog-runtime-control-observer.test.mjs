import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CARE_RELEASE as P} from './synthetic-care-release.mjs';
import {catalogRuntimeControlFixture} from './test-fixtures/catalog-runtime-control.mjs';
import {catalogRuntimeReadInventory,readCatalogRuntimeControl,catalogRuntimeReadQueue} from './catalog-runtime-control-observer.mjs';
import {verifyCatalogRuntimePredecessorControl} from './catalog-runtime-preflight.mjs';
function fixture(){
 const f=catalogRuntimeControlFixture(),calls=[],caller={Account:P.account,Arn:`arn:aws:sts::${P.account}:assumed-role/OrganizationAccountAccessRole/fictional`,UserId:'fictional'};
 let identities=0;
 const call=async args=>{calls.push([...args]);const [service,action]=args;
  if(service==='sts'){identities++;return structuredClone(caller);}
  if(action==='describe-stack-resources')return structuredClone(f.raw.resources);
  if(action==='describe-stacks')return structuredClone(args[3]===P.foundation?f.raw.foundation:f.raw.stack);
  if(action==='get-template')return {TemplateBody:JSON.stringify(f.raw.template)};
  if(action==='get-function-configuration')return structuredClone(f.raw.fn);
  if(action==='get-role')return structuredClone(f.raw.role);
  if(action==='list-attached-role-policies')return structuredClone(f.raw.attached);
  if(action==='list-role-policies')return structuredClone(f.raw.inline);
  if(action==='get-role-policy')return structuredClone(f.raw.policies.find(p=>p.PolicyName===args[5]));
  if(action==='describe-log-groups')return structuredClone(f.raw.logGroups);
  if(action==='get-integrations')return structuredClone(f.raw.integrations);
  if(action==='get-routes'){
   const rows=f.raw.routes.Items,offset=args.includes('--next-token')?50:0;
   return {Items:structuredClone(rows.slice(offset,offset?undefined:50)),...(offset?{}:{NextToken:'fictional-next'})};
  }
  if(action==='get-authorizers')return structuredClone(f.raw.authorizers);
  if(action==='get-stage')return structuredClone(f.raw.stage);
  if(action==='get-policy')return structuredClone(f.raw.latestPolicy);
  throw Error('unexpected read '+service+'/'+action);
 };
 return {f,calls,caller,call,identities:()=>identities};
}
test('parallel fixed observer preserves the entire raw inventory and every paginated route, without rewriting controls',async()=>{
 const x=fixture(),before=JSON.stringify(x.f.raw),raw=await readCatalogRuntimeControl(catalogRuntimeReadQueue(x.call));
 assert.deepEqual(raw,x.f.raw);assert.equal(JSON.stringify(x.f.raw),before);assert.equal(x.identities(),2);
 assert.deepEqual(verifyCatalogRuntimePredecessorControl(raw,x.f.source),x.f.preflight.control);
 assert.equal(x.calls.filter(a=>a[1]==='get-routes').length,2);
 assert(x.calls.filter(a=>a[1]==='get-routes').every(a=>a.includes('--no-paginate')));
 assert(x.calls.every(a=>!a.some(s=>/create-|update-|delete-|put-|execute-/.test(s))));
});
test('fixed four-read queue respects its bound and releases queued readers after errors without retry',async()=>{
 let active=0,peak=0,completed=0;const counts=new Map(),read=catalogRuntimeReadQueue(async id=>{
  counts.set(id,(counts.get(id)??0)+1);active++;peak=Math.max(peak,active);
  try{await new Promise(done=>setTimeout(done,2));if(id%7===0)throw Error('unconfirmed');return id;}
  finally{active--;completed++;}
 });
 const result=await Promise.allSettled(Array.from({length:39},(_,i)=>read(i)));
 assert.equal(peak,4);assert.equal(active,0);assert.equal(completed,39);assert.equal(counts.size,39);
 assert([...counts.values()].every(n=>n===1));assert.equal(result.filter(r=>r.status==='rejected').length,6);
});
test('complete observer refuses identity drift, malformed role inventory or any required unreadable source, after all reads settle',async()=>{
 for(const kind of ['identity','root','role','inline','duplicate','policy','route_denied','template']){
  const x=fixture();let completed=0;
  if(kind==='role')x.f.raw.resources.StackResources.find(r=>r.LogicalResourceId==='IdentityApiRole').PhysicalResourceId='bad/role';
  if(kind==='inline')x.f.raw.inline.IsTruncated=true;
  if(kind==='duplicate')x.f.raw.inline.PolicyNames.push(x.f.raw.inline.PolicyNames[0]);
  const call=async args=>{await new Promise(done=>setTimeout(done,1));completed++;
   if(args[0]==='sts'&&x.identities()===1&&['identity','root'].includes(kind))return {...x.caller,Arn:kind==='root'?`arn:aws:iam::${P.account}:root`:x.caller.Arn+'other'};
   if(kind==='route_denied'&&args[1]==='get-routes')throw Error('access denied');
   if(kind==='policy'&&args[1]==='get-role-policy')throw Error('unconfirmed');
   if(kind==='template'&&args[1]==='get-template')return {TemplateBody:'invalid json'};
   return x.call(args);
  };
  await assert.rejects(readCatalogRuntimeControl(catalogRuntimeReadQueue(call)),undefined,kind);
  const terminal=completed;await new Promise(done=>setTimeout(done,5));assert.equal(completed,terminal,kind);
 }
});
test('asynchronous inventory refuses malformed, repeated or unbounded pages rather than treating missing data as absence',async()=>{
 for(const kind of ['missing','repeated','oversize','total','page_limit','invalid_token']){
  let calls=0;const call=async()=>{calls++;return kind==='missing'?{}:kind==='oversize'?{Items:Array(301).fill({})}:
   kind==='invalid_token'?{Items:[],NextToken:1}:kind==='total'?{Items:Array(300).fill({}),NextToken:'next'+calls}:
   {Items:[],NextToken:kind==='repeated'?'same':'next'+calls};};
  await assert.rejects(catalogRuntimeReadInventory(call,['apigatewayv2','get-routes'],'Items','NextToken'),undefined,kind);assert(calls<=10);
 }
});
test('public observer fixes account region profile endpoints bounds and retry count and contains only read commands',()=>{
 const source=readFileSync(new URL('./catalog-runtime-control-observer.mjs',import.meta.url),'utf8');
 assert.match(source,/AWS_MAX_ATTEMPTS:'1'/);assert.match(source,/timeout:30000/);assert.match(source,/maxBuffer:4\*1024\*1024/);
 assert.match(source,/AWS_ENDPOINT_URL/);assert.doesNotMatch(source,/process\.argv|test-fixtures|'execute-change-set'|'update-stack'|'update-function-code'/);
});
