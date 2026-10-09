import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createPrivacyOperations,PrivacyOperationError} from './privacy-operations';
import type {ClinicalCoreDatabase} from './database';
import type {ProductionClinicalRequestContext} from './aws-identity-consent';
import type {ConsumerIdentityDeleter} from './owned-identity-deletion';

// Executable production SQL with fictional in-memory rows and a provider double.
const operator=randomUUID(),reviewer=randomUUID(),org=randomUUID(),digest='a'.repeat(64);
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
async function owner(){
  const id=randomUUID();
  await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)',[id,'subject_'+id.replaceAll('-','')]);
  await db.query('insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,$2,$3,true)',[id,'consumer','subject-'+id]);
  await db.query(`insert into clinical_private.owned_privacy_operator_assignments(operator_id,owner_id,reviewed_by,evidence_sha256,approved_at,expires_at)
    values($1,$2,$3,$4,now()-interval '1 day',now()+interval '1 day')`,[operator,id,reviewer,digest]);
  const request=randomUUID();
  await db.query("insert into clinical_private.owned_privacy_requests(id,owner_id,request_id,kind,status) values($1,$2,$3,'deletion','in_progress')",[request,id,randomUUID()]);
  return {id,request,subject:'subject-'+id};
}
const eight=['personal_records','personal_consents','active_plan','lab_jobs_and_documents','voice_jobs_and_transcripts','clinic_records','device_caches_and_recovery_archives','backups_and_audit'];
const settle=async(request:string,stores=eight)=>{for(const store of stores)await asOperator('select clinical_private.record_owned_privacy_fulfillment($1,$2,$3,$4)',[request,store,'not_applicable',digest]);};
const identityStatus=async(id:string)=>(await db.query<{status:string}>("select status from clinical_core.identities where person_id=$1 and identity_pool='consumer'",[id])).rows[0].status;
const latest=async(request:string)=>(await db.query<{outcome:string}>("select outcome from clinical_private.owned_privacy_fulfillment where privacy_request_id=$1 and store='identity' order by recorded_at desc,id desc limit 1",[request])).rows[0]?.outcome;
beforeAll(async()=>{
  const {manifest,files}=JSON.parse(execFileSync(process.execPath,['scripts/build-aws-production-clinical-core.mjs','--json'],{encoding:'utf8',maxBuffer:8*1024*1024,timeout:10000})) as {manifest:{migrations:{file:string}[]};files:Record<string,string>};
  db=new PGlite({extensions:{pgcrypto}});
  for(const entry of manifest.migrations){try{await db.exec(files[entry.file]);}catch(cause){throw new Error(entry.file+': '+(cause instanceof Error?cause.message:'migration_failed'));}}
  await db.query("insert into clinical_core.organizations(id,organization_label) values($1,'Fictional test organization')",[org]);
  for(const id of [operator,reviewer]){
    await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)',[id,'subject_'+id.replaceAll('-','')]);
    await db.query('insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,$2,$3,true)',[id,'workforce','subject-'+id]);
  }
},30000);
afterAll(async()=>{await db?.close();});

describe('identity deletion SQL: last store, database disable first, provider-confirmed completion',()=>{
  it('refuses until every other store is terminal, then disables the database identity before any provider call and is idempotent',async()=>{
    const o=await owner();
    await expect(result('select clinical_private.begin_owned_identity_deletion($1) as result',[o.request])).rejects.toThrow('privacy_request_store_pending');
    expect(await identityStatus(o.id)).toBe('active');
    await settle(o.request,eight.slice(0,7));
    await expect(result('select clinical_private.begin_owned_identity_deletion($1) as result',[o.request])).rejects.toThrow('privacy_request_store_pending');
    await settle(o.request,eight.slice(7));
    const begun=await result<Record<string,unknown>>('select clinical_private.begin_owned_identity_deletion($1) as result',[o.request]);
    expect(begun).toMatchObject({ownerId:o.id,identitySubject:o.subject,providerState:'disabled',attempts:1,completedAt:null,completeAccountDeletion:false});
    expect(await identityStatus(o.id)).toBe('disabled');
    expect(await result<Record<string,unknown>>('select clinical_private.begin_owned_identity_deletion($1) as result',[o.request])).toMatchObject({providerState:'disabled',attempts:2});
    // The disabled consumer identity can no longer act as the owner.
    await expect(db.transaction(async tx=>{await tx.exec('set local role clinical_core_api');
      await tx.query("select clinical_private.set_request_context($1,$2,'consumer',$3,'clinical_data','production-clinical','clinical_phi')",[o.id,org,o.subject]);
      return tx.query("select clinical_core.list_owned_privacy_requests() as result");})).rejects.toThrow();
  });
  it('records provider progress in order, completes only on deleted or absent, refuses while held, and never changes a completed row',async()=>{
    const o=await owner();await settle(o.request);
    await result('select clinical_private.begin_owned_identity_deletion($1) as result',[o.request]);
    await expect(result('select clinical_private.record_owned_identity_deletion($1,$2,$3) as result',[o.request,'erased',digest])).rejects.toThrow('identity_deletion_invalid');
    await expect(result('select clinical_private.record_owned_identity_deletion($1,$2,$3) as result',[o.request,'deleted','nothash'])).rejects.toThrow('identity_deletion_invalid');
    expect(await result<Record<string,unknown>>('select clinical_private.record_owned_identity_deletion($1,$2,$3) as result',[o.request,'signed_out',digest])).toMatchObject({providerState:'signed_out',completedAt:null});
    await expect(result('select clinical_private.record_owned_identity_deletion($1,$2,$3) as result',[o.request,'disabled',digest])).rejects.toThrow('identity_deletion_conflict');
    expect(await latest(o.request)).toBeUndefined();
    const hold=(await db.query<{id:string}>("insert into clinical_private.owned_legal_holds(owner_id,reason_code,placed_by) values($1,'owner_dispute',$2) returning id",[o.id,reviewer])).rows[0].id;
    await expect(result('select clinical_private.record_owned_identity_deletion($1,$2,$3) as result',[o.request,'deleted',digest])).rejects.toThrow('privacy_request_held');
    await db.query('update clinical_private.owned_legal_holds set released_at=now(),released_by=$2 where id=$1',[hold,reviewer]);
    const done=await result<Record<string,unknown>>('select clinical_private.record_owned_identity_deletion($1,$2,$3) as result',[o.request,'deleted',digest]);
    expect(done).toMatchObject({providerState:'deleted',evidenceSha256:digest});expect(done.completedAt).not.toBeNull();
    expect(await latest(o.request)).toBe('purged');
    expect(await result<Record<string,unknown>>('select clinical_private.record_owned_identity_deletion($1,$2,$3) as result',[o.request,'absent','b'.repeat(64)])).toMatchObject({providerState:'deleted',evidenceSha256:digest});
    const second=await owner();await settle(second.request);
    await result('select clinical_private.begin_owned_identity_deletion($1) as result',[second.request]);
    await result('select clinical_private.record_owned_identity_deletion($1,$2,$3) as result',[second.request,'absent',digest]);
    expect(await latest(second.request)).toBe('not_applicable');
    const missing=await owner();await db.query("delete from clinical_core.identities where person_id=$1",[missing.id]);await settle(missing.request);
    await expect(result('select clinical_private.begin_owned_identity_deletion($1) as result',[missing.request])).rejects.toThrow('identity_missing');
  });
});

describe('purgeIdentity operation: provider double, ledger and reviewed completion',()=>{
  it('disables first, records only what the provider confirmed, keeps the account locked on provider failure, and completes the request afterwards',async()=>{
    const o=await owner();await settle(o.request);
    const deleter:ConsumerIdentityDeleter={delete:vi.fn().mockRejectedValueOnce(Object.assign(new Error('throttled'),{name:'TooManyRequestsException'}))
      .mockResolvedValue({state:'deleted',evidenceSha256:'c'.repeat(64)})};
    const operations=createPrivacyOperations(database,undefined,undefined,()=>deleter);
    await expect(createPrivacyOperations(database)(context,{action:'purgeIdentity',privacyRequestId:o.request,confirmation:'DELETE CONSUMER IDENTITY'})).rejects.toMatchObject({code:'service_unavailable'});
    await expect(operations(context,{action:'purgeIdentity',privacyRequestId:o.request,confirmation:'DELETE CONSUMER IDENTITY'})).rejects.toBeInstanceOf(PrivacyOperationError);
    expect(await identityStatus(o.id)).toBe('disabled');expect(await latest(o.request)).toBeUndefined();
    const detail=await operations(context,{action:'purgeIdentity',privacyRequestId:o.request,confirmation:'DELETE CONSUMER IDENTITY'});
    expect(detail).toMatchObject({privacyRequestId:o.request,kind:'deletion',status:'in_progress'});
    expect((detail as {fulfillment:{store:string;outcome:string;evidenceSha256:string|null}[]}).fulfillment.filter(f=>f.store==='identity')).toEqual([expect.objectContaining({outcome:'purged',evidenceSha256:'c'.repeat(64)})]);
    expect(deleter.delete).toHaveBeenCalledTimes(2);expect(deleter.delete).toHaveBeenCalledWith(o.subject);
    // A repeat call is a no-op against the provider: the ledger already holds the confirmation.
    await operations(context,{action:'purgeIdentity',privacyRequestId:o.request,confirmation:'DELETE CONSUMER IDENTITY'});
    expect(deleter.delete).toHaveBeenCalledTimes(2);
    const completed=await operations(context,{action:'completeDeletion',privacyRequestId:o.request,confirmation:'COMPLETE DELETION REQUEST'});
    expect(completed).toMatchObject({status:'completed'});
  });
});
