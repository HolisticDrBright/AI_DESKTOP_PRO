import {test} from 'node:test';
import assert from 'node:assert/strict';
import {careCancellationArgs,verifyCancellationDatabase,verifyCancellationAnswer,
 verifyCancellationStoredReceipt,verifyCareCancellation} from './care-erasure-cancellation.mjs';
import {CARE_RELEASE as P} from './synthetic-care-release.mjs';
import {PERSONA_EMAILS} from './verify-synthetic-care-consumer.mjs';
const source={commit:'a'.repeat(40),sha256:'b'.repeat(64),clean:true};
const modes=Object.keys(PERSONA_EMAILS);
const uuid=i=>'11111111-1111-4111-8111-'+String(i).padStart(12,'0');
const database=(extra=0)=>({contract:'care-erasure-schema-upgrade/1',command:'inspect',execution:'synthetic-staging',
 awsAccountId:P.account,foundation:P.foundation,phiAllowed:false,operatorSource:{sourceCommit:source.commit,clean:true},
 observedMigrationCount:47,sourceMigrationCount:46,tableCount:88,fromLedgerSha256:P.liveBefore,toLedgerSha256:P.liveAfter,
 referenceLedgerSha256:P.reference,alreadyApplied:true,applied:false,rolledBack:false,dataPreserved:true,acceptance:false,
 phiActivation:false,apiDeploymentPerformed:false,rowCount:23980+extra,originalRowCount:23980,
 dataSha256:'c'.repeat(64),originalDataSha256:'d'.repeat(64)});
function fake(){
 const receipts=new Set(),calls=[],events=[];let sequence=0,auth=0,inspect=0,id=100;
 const d={source:async()=>structuredClone(source),inspect:async()=>database(inspect++?5:0),
  control:async()=>({revision:'fixed'}),uuid:()=>uuid(++id),record:async e=>events.push(e),
  authenticate:async mode=>({owner:uuid(modes.indexOf(mode)+1),sessionId:'session-'+(++auth),mode}),
  stored:async(owner,request)=>receipts.has(owner+request)?[{scope:'domain',outcome:'cancelled',receiptAbsent:true}]:[],
  request:async(session,input)=>{calls.push(input);const key=session.owner+input.requestId;
   if(input.action==='settle_erasure')receipts.add(key);
   return {response:{status:200,headers:new Headers({'apigw-requestid':'gateway-'+(++sequence)})},
    value:{data:{...input,outcome:receipts.has(key)?'cancelled':'unresolved',receipt:null}}};}};
 return {d,calls,events,receipts};
}
test('argument and parent database binding cannot accept a report, production or the unupgraded ledger',()=>{
 careCancellationArgs(['--verify-fictional-cancellation-first']);
 for(const args of [[],['--skip'],['--verify-fictional-cancellation-first','file']])assert.throws(()=>careCancellationArgs(args));
 verifyCancellationDatabase(database(),source);
 for(const [k,v] of Object.entries({observedMigrationCount:46,sourceMigrationCount:45,tableCount:87,phiAllowed:true,
  execution:'production',applied:true,rolledBack:true,alreadyApplied:false,referenceLedgerSha256:'0'.repeat(64),
  originalDataSha256:'',rowCount:0}))assert.throws(()=>verifyCancellationDatabase({...database(),[k]:v},source));
});
test('each cancelled and absent response binds exact action, scope, id, null receipt and unique live gateway evidence',()=>{
 const input={action:'erase_receipt',scope:'domain',requestId:uuid(1)},r={status:200,headers:new Headers({'apigw-requestid':'gateway-1'})};
 const value={data:{...input,outcome:'cancelled',receipt:null}};
 verifyCancellationAnswer(input,'cancelled',r,value);
 for(const v of [null,{},[],{error:'not_configured'}, {...value,error:'bad'},
  {data:{...value.data,outcome:'erased'}},{data:{...value.data,requestId:uuid(2)}},
  {data:{...value.data,scope:'account_closure'}},{data:{...value.data,receipt:{}}},
  {data:{...value.data,action:'settle_erasure'}},{data:{...value.data,owner:'hidden'}}])
  assert.throws(()=>verifyCancellationAnswer(input,'cancelled',r,v));
 assert.throws(()=>verifyCancellationAnswer(input,'cancelled',{...r,status:403},value));
 assert.throws(()=>verifyCancellationAnswer(input,'cancelled',{...r,headers:new Headers()},value));
});
test('stored cancellation must exist exactly once and be the null-receipt domain tombstone',()=>{
 verifyCancellationStoredReceipt([{scope:'domain',outcome:'cancelled',receiptAbsent:true}]);
 for(const rows of [[],[{},{}],[{scope:'domain',outcome:'erased',receiptAbsent:false}],
  [{scope:'account_closure',outcome:'cancelled',receiptAbsent:true}],
  [{scope:'domain',outcome:'cancelled',receiptAbsent:true,unexpected:'extra'}]])
  assert.throws(()=>verifyCancellationStoredReceipt(rows));
});
test('all five owners run all seven cases with independent cancellation, separate sign-ins and unchanged original data',async()=>{
 const f=fake(),result=await verifyCareCancellation(f.d);
 assert.equal(result.observations.length,35);assert.equal(f.receipts.size,5);
 assert.equal(result.terminalCancellationRowsAdded,5);
 for(const mode of modes)assert.equal(result.observations.filter(o=>o.persona===mode).length,7);
 assert.equal(f.calls.filter(c=>c.action==='erase_request').length,5);
 assert.equal(f.events.filter(e=>e.stage==='stored_cancellation_verified').length,5);
 for(const k of ['erasedOutcomeVerified','lostReplyErasureVerified','retainedRoutingRecoveryVerified',
  'fullJourneyAcceptance','physicalDeviceAcceptance','qualificationEvidence','activationEvidence','phiAllowed'])assert.equal(result[k],false);
});
test('a claimed cancellation without a stored row can never admit the late erase',async()=>{
 const f=fake();f.d.stored=async()=>[];
 await assert.rejects(verifyCareCancellation(f.d),/stored_cancellation/);
 assert.equal(f.calls.some(c=>c.action==='erase_request'),false);
});
test('unresolved cancellation response and unknown mutating outcome never cause a retry or late erase',async()=>{
 for(const kind of ['unresolved','lost']){
  const f=fake(),request=f.d.request;
  f.d.request=async(s,input)=>{if(input.action==='settle_erasure'){
   if(kind==='lost'){f.calls.push(input);throw new Error('unknown transport');}
   const a=await request(s,input);a.value.data.outcome='unresolved';return a;
  }return request(s,input);};
  await assert.rejects(verifyCareCancellation(f.d));
  assert.equal(f.calls.filter(c=>c.action==='settle_erasure').length,1);
  assert.equal(f.calls.some(c=>c.action==='erase_request'),false);
 }
});
test('second authentication must be distinct and same-owner; isolation identity must differ',async()=>{
 for(const kind of ['same_session','wrong_owner','same_stranger']){
  const f=fake();let n=0;
  f.d.authenticate=async()=>({owner:uuid(kind==='same_stranger'?1:++n===3?2:kind==='wrong_owner'?n:1),
   sessionId:kind==='same_session'?'same-session':'different-session-'+n});
  await assert.rejects(verifyCareCancellation(f.d),/sessions/);
  assert.equal(f.calls.length,0);
 }
});
test('receipt leakage, repeated gateway evidence, row mutation and missing cancellation row are findings',async()=>{
 for(const kind of ['leak','replay','data','extra_rows','late_row_missing']){
  const f=fake(),request=f.d.request,stored=f.d.stored;let n=0,reads=0;
  if(kind==='data'||kind==='extra_rows')f.d.inspect=async()=>++n===1?database():{
   ...database(kind==='extra_rows'?6:5),...(kind==='data'?{originalDataSha256:'e'.repeat(64)}:{})};
  if(kind==='late_row_missing')f.d.stored=async(...args)=>++reads===3?[]:stored(...args);
  f.d.request=async(s,input)=>{const a=await request(s,input);
   if(kind==='replay')a.response.headers.set('apigw-requestid','same-gateway');
   if(kind==='leak'&&input.action==='erase_receipt'&&!f.receipts.has(s.owner+input.requestId)&&f.receipts.size)
    a.value.data.outcome='cancelled';
   return a;};
  await assert.rejects(verifyCareCancellation(f.d));
 }
});
test('source, control-plane drift and reused erasure identities refuse progress',async()=>{
 for(const kind of ['source','control','id']){
  const f=fake();let n=0;
  if(kind==='source')f.d.source=async()=>({...source,sha256:++n>1?'f'.repeat(64):source.sha256});
  if(kind==='control')f.d.control=async()=>({revision:++n>1?'drift':'fixed'});
  if(kind==='id')f.d.uuid=()=>uuid(100);
  await assert.rejects(verifyCareCancellation(f.d));
 }
});
