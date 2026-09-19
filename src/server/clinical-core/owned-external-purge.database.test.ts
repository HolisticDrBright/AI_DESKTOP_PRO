import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createPrivacyOperations,PrivacyOperationError} from './privacy-operations';
import type {ClinicalCoreDatabase} from './database';
import type {ProductionClinicalRequestContext} from './aws-identity-consent';
import type {ExternalPurgeExecutor,ExternalPurgeItem,ExternalPurgeOutcome} from './privacy-external-purge';

// Executable production SQL with fictional in-memory rows: not hosted Aurora,
// DynamoDB, S3 or a physical device. The executor is a double.
const owner=randomUUID(),operator=randomUUID(),reviewer=randomUUID(),org=randomUUID();
const ownerSub='subject-'+owner,digest='a'.repeat(64);
let db:PGlite;
const context:ProductionClinicalRequestContext={actorPersonId:operator,organizationId:org,identitySubject:'subject-'+operator,identityPool:'workforce',
  purpose:'consent_management',environment:'production-clinical',dataClassification:'clinical_phi',containsPhi:true,realPatientData:true,productionBound:true};
const database:ClinicalCoreDatabase={transaction:work=>db.transaction(async tx=>{
  await tx.exec('set local role clinical_core_api');
  return work({query:async<Row extends Record<string,unknown>>(sql:string,parameters:readonly unknown[]=[])=>
    tx.query<Row>(sql,parameters.map(p=>p&&typeof p==='object'&&'kind' in p&&p.kind==='uuid'&&'value' in p?p.value:p))});
})};
async function asOperator<T=Record<string,unknown>>(sql:string,params:unknown[]=[]){
  return db.transaction(async tx=>{
    await tx.exec('set local role clinical_core_api');
    await tx.query("select clinical_private.set_request_context($1,$2,'workforce',$3,'consent_management','production-clinical','clinical_phi')",[operator,org,'subject-'+operator]);
    return tx.query<T>(sql,params);
  });
}
const result=async<T>(sql:string,params:unknown[]=[])=>((await asOperator<{result:T}>(sql,params)).rows[0]).result;
async function request(status='in_progress'){
  const id=randomUUID();
  await db.query("insert into clinical_private.owned_privacy_requests(id,owner_id,request_id,kind,status) values($1,$2,$3,'deletion',$4)",[id,owner,randomUUID(),status]);
  return id;
}
const labJob=()=>randomUUID(),voiceJob=()=>[...Array(64)].map(()=>'0123456789abcdef'[Math.floor(Math.random()*16)]).join('');
async function inventory(requestId:string,store:'labs'|'voice',jobs:{kind:'lab_job'|'lab_cleanup'|'voice_job';jobId:string;state?:string}[],state:'scanning'|'exhausted'|'bounded'='exhausted'){
  const id=randomUUID();
  await db.query(`insert into clinical_private.owned_external_inventories(id,privacy_request_id,owner_id,owner_subject,store,source_arn,created_by,revision,scanned,item_count,issues,state,evidence_sha256)
    values($1,$2,$3,$4,$5,'arn:aws:dynamodb:us-east-2:123456789012:table/fictional',$6,1,$7,$7,0,$8,$9)`,[id,requestId,owner,ownerSub,store,operator,jobs.length,state,digest]);
  for(const job of jobs)await db.query('insert into clinical_private.owned_external_inventory_items values($1,$2,$3,$4)',
    [id,job.kind,job.jobId,{kind:job.kind,jobId:job.jobId,organizationId:org,ownerSub,state:job.state??(job.kind==='voice_job'?'ready':'completed'),updatedAt:null}]);
  return id;
}
const latest=async(requestId:string,store:string)=>(await db.query<{outcome:string}>('select outcome from clinical_private.owned_privacy_fulfillment where privacy_request_id=$1 and store=$2 order by recorded_at desc,id desc limit 1',[requestId,store])).rows[0]?.outcome;
beforeAll(async()=>{
  const {manifest,files}=JSON.parse(execFileSync(process.execPath,['scripts/build-aws-production-clinical-core.mjs','--json'],{encoding:'utf8',maxBuffer:8*1024*1024,timeout:10000})) as {manifest:{migrations:{file:string}[]};files:Record<string,string>};
  db=new PGlite({extensions:{pgcrypto}});
  for(const entry of manifest.migrations){try{await db.exec(files[entry.file]);}catch(cause){throw new Error(entry.file+': '+(cause instanceof Error?cause.message:'migration_failed'));}}
  await db.query("insert into clinical_core.organizations(id,organization_label) values($1,'Fictional test organization')",[org]);
  for(const [id,pool] of [[owner,'consumer'],[operator,'workforce'],[reviewer,'workforce']]){
    await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)',[id,'subject_'+id.replaceAll('-','')]);
    await db.query('insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,$2,$3,true)',[id,pool,'subject-'+id]);
  }
  await db.query(`insert into clinical_private.owned_privacy_operator_assignments(operator_id,owner_id,reviewed_by,evidence_sha256,approved_at,expires_at)
    values($1,$2,$3,$4,now()-interval '1 day',now()+interval '1 day')`,[operator,owner,reviewer,digest]);
  await db.query(`insert into clinical_private.owned_retention_policies(version,content,content_sha256,approved_by,approved_at)
    values('test-valid','Fictional in-memory policy',encode(public.digest('Fictional in-memory policy','sha256'),'hex'),'FIXTURE NOT APPROVAL',now()-interval '1 day')`);
  await db.exec("update clinical_private.owned_retention_policies set personal_purge_authorized_sha256=content_sha256");
},30000);
afterAll(async()=>{await db?.close();});

describe('external purge SQL: batches, terminal outcomes and store fulfillment',()=>{
  it('hands out bounded batches of non-terminal items with the owner scope, refuses unfinished inventories and held requests',async()=>{
    const requestId=await request('submitted');const jobs=[labJob(),labJob(),labJob()].sort();
    const scanning=await inventory(requestId,'labs',jobs.map(jobId=>({kind:'lab_job' as const,jobId})),'scanning');
    await expect(result('select clinical_private.begin_owned_external_purge($1,$2,10) as result',[requestId,scanning])).rejects.toThrow('external_inventory_incomplete');
    const inv=await inventory(requestId,'labs',jobs.map(jobId=>({kind:'lab_job' as const,jobId})));
    const first=await result<{ownerId:string;ownerSub:string;items:{jobId:string;attempts:number}[];summary:{state:string;remaining:number}}>('select clinical_private.begin_owned_external_purge($1,$2,2) as result',[requestId,inv]);
    expect(first.ownerId).toBe(owner);expect(first.ownerSub).toBe(ownerSub);expect(first.items.map(i=>i.jobId)).toEqual(jobs.slice(0,2));
    expect(first.summary).toMatchObject({state:'in_progress',remaining:3,total:3});
    expect((await db.query<{status:string}>('select status from clinical_private.owned_privacy_requests where id=$1',[requestId])).rows[0].status).toBe('in_progress');
    for(const limit of [0,11])await expect(result('select clinical_private.begin_owned_external_purge($1,$2,$3) as result',[requestId,inv,limit])).rejects.toThrow('external_purge_invalid');
    const otherRequest=await request();
    await expect(result('select clinical_private.begin_owned_external_purge($1,$2,10) as result',[otherRequest,inv])).rejects.toThrow('external_purge_invalid');
    const hold=(await db.query<{id:string}>("insert into clinical_private.owned_legal_holds(owner_id,reason_code,placed_by) values($1,'owner_dispute',$2) returning id",[owner,reviewer])).rows[0].id;
    await expect(result('select clinical_private.begin_owned_external_purge($1,$2,10) as result',[requestId,inv])).rejects.toThrow('privacy_request_held');
    // A refusal may still be recorded while held so the ledger explains it; a cleaned claim may not.
    await result('select clinical_private.record_owned_external_purge_item($1,$2,$3,$4,$5) as result',[inv,'lab_job',jobs[0],'refused','legal_hold']);
    await expect(result('select clinical_private.record_owned_external_purge_item($1,$2,$3,$4,$5) as result',[inv,'lab_job',jobs[0],'cleaned','x'])).rejects.toThrow('privacy_request_held');
    await db.query('update clinical_private.owned_legal_holds set released_at=now(),released_by=$2 where id=$1',[hold,reviewer]);
    const again=await result<{items:{jobId:string;attempts:number}[]}>('select clinical_private.begin_owned_external_purge($1,$2,10) as result',[requestId,inv]);
    expect(again.items.map(i=>[i.jobId,i.attempts])).toEqual([[jobs[0],1],[jobs[1],0],[jobs[2],0]]);
  });
  it('keeps terminal outcomes immutable, refuses unknown items and finishes only when everything inventoried is terminal',async()=>{
    const requestId=await request();const jobs=[labJob(),labJob()].sort();
    const inv=await inventory(requestId,'labs',jobs.map(jobId=>({kind:'lab_job' as const,jobId})));
    await expect(result('select clinical_private.record_owned_external_purge_item($1,$2,$3,$4,$5) as result',[inv,'lab_job',randomUUID(),'cleaned','x'])).rejects.toThrow('external_purge_invalid');
    await expect(result('select clinical_private.record_owned_external_purge_item($1,$2,$3,$4,$5) as result',[inv,'lab_job',jobs[0],'erased','x'])).rejects.toThrow('external_purge_invalid');
    await expect(result('select clinical_private.finish_owned_external_purge($1,$2) as result',[requestId,inv])).rejects.toThrow('external_purge_incomplete');
    let summary=await result<Record<string,unknown>>('select clinical_private.record_owned_external_purge_item($1,$2,$3,$4,$5) as result',[inv,'lab_job',jobs[0],'claimed','provider busy']);
    expect(summary).toMatchObject({claimed:1,remaining:2,state:'in_progress'});
    summary=await result('select clinical_private.record_owned_external_purge_item($1,$2,$3,$4,$5) as result',[inv,'lab_job',jobs[0],'cleaned','late_upload_watch']);
    expect(summary).toMatchObject({cleaned:1,claimed:0,remaining:1});
    summary=await result('select clinical_private.record_owned_external_purge_item($1,$2,$3,$4,$5) as result',[inv,'lab_job',jobs[0],'refused','late attempt must not reopen']);
    expect(summary).toMatchObject({cleaned:1,refused:0});
    await expect(result('select clinical_private.finish_owned_external_purge($1,$2) as result',[requestId,inv])).rejects.toThrow('external_purge_incomplete');
    summary=await result('select clinical_private.record_owned_external_purge_item($1,$2,$3,$4,$5) as result',[inv,'lab_job',jobs[1],'not_found','no job or cleanup record remains']);
    expect(summary).toMatchObject({notFound:1,remaining:0,state:'complete',completeStorePurge:false});
    const finished=await result<Record<string,unknown>>('select clinical_private.finish_owned_external_purge($1,$2) as result',[requestId,inv]);
    expect(finished).toMatchObject({fulfillmentStore:'lab_jobs_and_documents',fulfillmentOutcome:'purged'});
    expect(await latest(requestId,'lab_jobs_and_documents')).toBe('purged');
    // A bounded inventory cannot prove the store empty: pending, never purged.
    const bounded=await inventory(requestId,'voice',[{kind:'voice_job',jobId:voiceJob()}],'bounded');
    const item=(await db.query<{job_id:string}>('select job_id from clinical_private.owned_external_inventory_items where inventory_id=$1',[bounded])).rows[0].job_id;
    await result('select clinical_private.record_owned_external_purge_item($1,$2,$3,$4,$5) as result',[bounded,'voice_job',item,'cleaned','objects removed']);
    expect(await result('select clinical_private.finish_owned_external_purge($1,$2) as result',[requestId,bounded])).toMatchObject({fulfillmentStore:'voice_jobs_and_transcripts',fulfillmentOutcome:'pending'});
    expect(await latest(requestId,'voice_jobs_and_transcripts')).toBe('pending');
  });
});

describe('privacy operations: guarded multi-transaction purge and reviewed completion',()=>{
  it('drives the executor per inventoried item, records every outcome, finishes the store and completes the request only when all nine stores are terminal',async()=>{
    const requestId=await request();const jobs=[labJob(),labJob(),labJob()].sort();
    const inv=await inventory(requestId,'labs',[{kind:'lab_job',jobId:jobs[0]},{kind:'lab_job',jobId:jobs[1]},{kind:'lab_cleanup',jobId:jobs[2]}]);
    const seen:ExternalPurgeItem[]=[];let calls=0;
    const executor:ExternalPurgeExecutor={purge:vi.fn(async(store:'labs'|'voice',scope:{ownerId:string;ownerSub:string;organizationId:string},item:ExternalPurgeItem):Promise<ExternalPurgeOutcome>=>{
      seen.push(item);calls++;expect(store).toBe('labs');expect(scope).toEqual({ownerId:owner,ownerSub,organizationId:org});
      if(item.jobId===jobs[1]&&item.attempts===0)return {state:'refused',detail:'storage_unavailable'};
      if(item.kind==='lab_cleanup')throw new Error('executor crashed');
      return {state:'cleaned',detail:'late_upload_watch'};
    })};
    const operations=createPrivacyOperations(database,undefined,()=>executor);
    const first=await operations(context,{action:'purgeExternal',privacyRequestId:requestId,inventoryId:inv,store:'labs',maxItems:2,confirmation:'PURGE EXTERNAL STORE'});
    expect(first).toMatchObject({state:'in_progress',total:3,cleaned:1,refused:1,remaining:2,inventoryState:'exhausted'});
    // Batches are ordered by kind then id under the C collation: the cleanup record precedes the jobs.
    expect(seen.map(i=>[i.kind,i.jobId])).toEqual([['lab_cleanup',jobs[2]],['lab_job',jobs[0]]]);
    const second=await operations(context,{action:'purgeExternal',privacyRequestId:requestId,inventoryId:inv,store:'labs',maxItems:10,confirmation:'PURGE EXTERNAL STORE'});
    expect(second).toMatchObject({cleaned:1,refused:2,remaining:2,state:'in_progress'});
    expect(seen.slice(2).map(i=>[i.kind,i.jobId,i.attempts])).toEqual([['lab_cleanup',jobs[2],1],['lab_job',jobs[1],0]]);
    (executor.purge as ReturnType<typeof vi.fn>).mockImplementation(async(_store:string,_scope:unknown,item:ExternalPurgeItem):Promise<ExternalPurgeOutcome>=>
      item.kind==='lab_cleanup'?{state:'not_found',detail:'no job or cleanup record remains'}:{state:'cleaned',detail:'late_upload_watch'});
    const third=await operations(context,{action:'purgeExternal',privacyRequestId:requestId,inventoryId:inv,store:'labs',maxItems:10,confirmation:'PURGE EXTERNAL STORE'});
    expect(third).toMatchObject({cleaned:2,notFound:1,remaining:0,state:'complete',fulfillmentStore:'lab_jobs_and_documents',fulfillmentOutcome:'purged',completeStorePurge:false});
    expect(calls).toBe(4);expect(executor.purge).toHaveBeenCalledTimes(6);
    // Completion stays blocked until every store is terminal; nothing is inferred.
    await expect(operations(context,{action:'completeDeletion',privacyRequestId:requestId,confirmation:'COMPLETE DELETION REQUEST'})).rejects.toBeInstanceOf(PrivacyOperationError);
    await expect(asOperator('select clinical_private.complete_owned_privacy_request($1) as result',[requestId])).rejects.toThrow('privacy_request_store_pending');
    expect((await db.query<{status:string}>('select status from clinical_private.owned_privacy_requests where id=$1',[requestId])).rows[0].status).toBe('in_progress');
    const voice=await inventory(requestId,'voice',[]);
    expect(await operations(context,{action:'purgeExternal',privacyRequestId:requestId,inventoryId:voice,store:'voice',maxItems:10,confirmation:'PURGE EXTERNAL STORE'})).toMatchObject({total:0,state:'complete',fulfillmentOutcome:'not_applicable'});
    for(const store of ['personal_records','personal_consents','active_plan','identity'])
      await asOperator('select clinical_private.record_owned_privacy_fulfillment($1,$2,$3,$4)',[requestId,store,'not_applicable',digest]);
    const clinic=await operations(context,{action:'recordDisposition',privacyRequestId:requestId,store:'clinic_records',outcome:'not_applicable',evidenceSha256:'b'.repeat(64)});
    expect(clinic).toMatchObject({privacyRequestId:requestId,status:'in_progress'});
    // A not_enumerable device disposition keeps the request open; completion needs the reviewed not_applicable decision.
    await operations(context,{action:'recordDisposition',privacyRequestId:requestId,store:'device_caches_and_recovery_archives',outcome:'not_enumerable',evidenceSha256:'c'.repeat(64)});
    await expect(asOperator('select clinical_private.complete_owned_privacy_request($1) as result',[requestId])).rejects.toThrow('privacy_request_store_pending');
    await operations(context,{action:'recordDisposition',privacyRequestId:requestId,store:'device_caches_and_recovery_archives',outcome:'not_applicable',evidenceSha256:'c'.repeat(64)});
    await expect(operations(context,{action:'retainByPolicy',privacyRequestId:requestId,store:'backups_and_audit',evidenceSha256:'d'.repeat(64),policyVersion:'not-a-policy'})).rejects.toBeInstanceOf(PrivacyOperationError);
    const retained=await operations(context,{action:'retainByPolicy',privacyRequestId:requestId,store:'backups_and_audit',evidenceSha256:'d'.repeat(64),policyVersion:'test-valid'});
    expect(retained).toMatchObject({status:'in_progress'});
    const completed=await operations(context,{action:'completeDeletion',privacyRequestId:requestId,confirmation:'COMPLETE DELETION REQUEST'});
    expect(completed).toMatchObject({privacyRequestId:requestId,kind:'deletion',status:'completed'});
    expect(await latest(requestId,'backups_and_audit')).toBe('retained_by_policy');
  });
  it('refuses purge without an executor, an unassigned operator or a foreign request, and never records anything for them',async()=>{
    const requestId=await request();const inv=await inventory(requestId,'labs',[{kind:'lab_job',jobId:labJob()}]);
    const executor:ExternalPurgeExecutor={purge:vi.fn(async()=>({state:'cleaned' as const,detail:'x'}))};
    await expect(createPrivacyOperations(database)(context,{action:'purgeExternal',privacyRequestId:requestId,inventoryId:inv,store:'labs',maxItems:1,confirmation:'PURGE EXTERNAL STORE'})).rejects.toMatchObject({code:'service_unavailable'});
    // The raw PGlite wrapper does not classify SQL rejections; the assignment refusal still surfaces as an operation error and records nothing.
    const stranger={...context,actorPersonId:reviewer,identitySubject:'subject-'+reviewer};
    await expect(createPrivacyOperations(database,undefined,()=>executor)(stranger,{action:'purgeExternal',privacyRequestId:requestId,inventoryId:inv,store:'labs',maxItems:1,confirmation:'PURGE EXTERNAL STORE'})).rejects.toBeInstanceOf(PrivacyOperationError);
    await expect(asOperator('select clinical_private.begin_owned_external_purge($1,$2,1) as result',[requestId,inv]).then(()=>db.transaction(async tx=>{
      await tx.exec('set local role clinical_core_api');
      await tx.query("select clinical_private.set_request_context($1,$2,'workforce',$3,'consent_management','production-clinical','clinical_phi')",[reviewer,org,'subject-'+reviewer]);
      return tx.query('select clinical_private.begin_owned_external_purge($1,$2,1) as result',[requestId,inv]);
    }))).rejects.toThrow('privacy_operator_assignment_required');
    await expect(createPrivacyOperations(database,undefined,()=>executor)(context,{action:'purgeExternal',privacyRequestId:requestId,inventoryId:inv,store:'voice',maxItems:1,confirmation:'PURGE EXTERNAL STORE'})).rejects.toThrow('privacy_response_invalid');
    expect(executor.purge).toHaveBeenCalledTimes(1);
    expect((await db.query('select count(*)::int as n from clinical_private.owned_external_purge_items where inventory_id=$1',[inv])).rows[0]).toMatchObject({n:1});
  });
});
