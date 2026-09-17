import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve,sep} from 'node:path';
import {randomUUID} from 'node:crypto';

const owner=randomUUID(),other=randomUUID(),operator=randomUUID(),unassigned=randomUUID(),reviewer=randomUUID(),org=randomUUID();
const digest='a'.repeat(64);
const stores=['personal_records','personal_consents','active_plan','lab_jobs_and_documents','voice_jobs_and_transcripts',
  'identity','clinic_records','device_caches_and_recovery_archives','backups_and_audit'];
let db:PGlite;
async function asActor(sql:string,params:unknown[]=[],actor:string=operator,pool='workforce'){
  return db.transaction(async tx=>{
    await tx.exec('set local role clinical_core_api');
    await tx.query("select clinical_private.set_request_context($1,$2,$3,$4,'consent_management','production-clinical','clinical_phi')",
      [actor,org,pool,'subject-'+actor]);
    return tx.query(sql,params);
  });
}
async function request(kind='deletion',who=owner){
  const id=randomUUID();
  await db.query("insert into clinical_private.owned_privacy_requests(id,owner_id,request_id,kind,status,correction) values($1,$2,$3,$4,'in_progress',$5)",
    [id,who,randomUUID(),kind,kind==='correction'?{request:'Fictional correction'}:null]);
  return id;
}
const record=(id:string,store:string,outcome:string,evidence:string|null=digest)=>asActor(
  'select clinical_private.record_owned_privacy_fulfillment($1,$2,$3,$4)',[id,store,outcome,evidence]);
const complete=(id:string)=>asActor('select clinical_private.complete_owned_privacy_request($1) as result',[id]);
const purge=(id:string,policy='test-valid')=>asActor('select clinical_private.purge_owned_personal_history($1,$2) as result',[id,policy]);
async function fill(id:string){for(const store of stores)await record(id,store,'not_applicable');}
beforeAll(async()=>{
  // Build the same production SQL artifact as CI. Its cleanup target is a
  // derived directory inside this checkout, never a home/workspace root.
  const root=resolve('.'),out=resolve('dist/aws-clinical-core/production-migrations');
  if(!out.startsWith(root+sep)||out===root)throw new Error('unsafe_build_output');
  execFileSync(process.execPath,['scripts/build-aws-production-clinical-core.mjs'],{cwd:root,stdio:'pipe'});
  db=new PGlite({extensions:{pgcrypto}});
  const manifest=JSON.parse(readFileSync(resolve(out,'manifest.json'),'utf8')) as {migrations:{file:string}[]};
  const files=manifest.migrations.map(entry=>entry.file);
  for(const file of files){
    try{await db.exec(readFileSync(resolve(out,file),'utf8'));}
    catch(cause){throw new Error(file+': '+(cause instanceof Error?cause.message:'migration_failed'));}
  }
  // All identities, approvals and retention text here are fictional in-memory fixtures.
  await db.query("insert into clinical_core.organizations(id,organization_label) values($1,'Fictional test organization')",[org]);
  for(const [id,pool] of [[owner,'consumer'],[other,'consumer'],[operator,'workforce'],[unassigned,'workforce'],[reviewer,'workforce']]){
    await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)',[id,'subject_'+id.replaceAll('-','')]);
    await db.query('insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,$2,$3,true)',[id,pool,'subject-'+id]);
  }
  await db.query(`insert into clinical_private.owned_privacy_operator_assignments(operator_id,owner_id,reviewed_by,evidence_sha256,approved_at,expires_at)
    values($1,$2,$3,$4,now()-interval '1 day',now()+interval '1 day')`,[operator,owner,reviewer,digest]);
  for(const version of ['test-valid','test-corrupt','test-future','test-retired']){
    await db.query(`insert into clinical_private.owned_retention_policies(version,content,content_sha256,approved_by,approved_at,retired_at)
      values($1,'Fictional in-memory policy',case when $1='test-corrupt' then $2 else encode(public.digest('Fictional in-memory policy','sha256'),'hex') end,
        'FIXTURE NOT APPROVAL',case when $1='test-future' then now()+interval '1 day' else now()-interval '1 day' end,
        case when $1='test-retired' then now() else null end)`,[version,digest]);
  }
},30000);
afterAll(async()=>{await db?.close();});

describe('privacy fulfillment: executable production SQL with fictional data (not hosted Aurora)',()=>{
  it('denies consumers, unassigned workforce and assignments for another owner',async()=>{
    const id=await request();
    for(const [actor,pool,error] of [[owner,'consumer','privacy_operator_required'],[unassigned,'workforce','privacy_operator_assignment_required']]){
      await expect(asActor('select clinical_private.complete_owned_privacy_request($1)',[id],actor,pool)).rejects.toThrow(error);
    }
    await expect(complete(await request('deletion',other))).rejects.toThrow('privacy_operator_assignment_required');
    await expect(asActor("select clinical_private.place_owned_legal_hold($1,'owner_dispute')",[other])).rejects.toThrow('privacy_operator_assignment_required');
  });
  it('denies self-assignment and direct access to old unsafe implementations',async()=>{
    await expect(asActor('insert into clinical_private.owned_privacy_operator_assignments default values')).rejects.toThrow('permission denied');
    for(const sql of ["select clinical_private.place_owned_legal_hold_v1($1,'owner_dispute')",
      "select clinical_private.release_owned_legal_hold_v1($1)","select clinical_private.purge_owned_personal_history_v1($1,'test-valid')",
      "select clinical_private.record_owned_privacy_fulfillment_v1($1,'identity','purged',null)"]){
      await expect(asActor(sql,[owner])).rejects.toThrow('permission denied');
    }
    await expect(asActor('select * from clinical_private.owned_privacy_operator_assignments')).rejects.toThrow('permission denied');
  });
  it.each(['revoked','expired','future'])('refuses %s operator authority',async state=>{
    await db.query(`update clinical_private.owned_privacy_operator_assignments set
      revoked_at=case when $1='revoked' then now() else null end,
      approved_at=case when $1='future' then now()+interval '1 hour' else now()-interval '2 days' end,
      expires_at=case when $1='expired' then now()-interval '1 day' else now()+interval '1 day' end`,[state]);
    try{await expect(complete(await request())).rejects.toThrow('privacy_operator_assignment_required');}
    finally{await db.exec("update clinical_private.owned_privacy_operator_assignments set revoked_at=null,approved_at=now()-interval '1 day',expires_at=now()+interval '1 day'");}
  });
  it.each(['tombstoned','not_enumerable','refused','pending'])('cannot complete while a store is %s',async outcome=>{
    const id=await request();await fill(id);await record(id,'identity',outcome);
    await expect(complete(id)).rejects.toThrow('privacy_request_store_pending');
    expect((await db.query('select status from clinical_private.owned_privacy_requests where id=$1',[id])).rows).toEqual([{status:'in_progress'}]);
  });
  it('requires all stores and evidence, including when historical rows lack it',async()=>{
    const id=await request();await expect(complete(id)).rejects.toThrow('privacy_request_store_pending');
    await expect(record(id,'identity','purged',null)).rejects.toThrow('privacy_fulfillment_evidence_required');
    await expect(record(id,'identity','not_applicable',null)).rejects.toThrow('privacy_fulfillment_evidence_required');
    await fill(id);
    await db.query("insert into clinical_private.owned_privacy_fulfillment(privacy_request_id,store,outcome,operator) values($1,'identity','purged','legacy-fixture')",[id]);
    await expect(complete(id)).rejects.toThrow('privacy_request_store_pending');
  });
  it('completes with evidenced final outcomes, and rejects replay or later mutations',async()=>{
    const id=await request();await fill(id);
    expect((await complete(id)).rows[0]).toMatchObject({result:{status:'completed',legalHold:false}});
    expect((await db.query('select completed_by from clinical_private.owned_privacy_requests where id=$1',[id])).rows).toEqual([{completed_by:operator}]);
    await expect(complete(id)).rejects.toThrow('privacy_request_invalid');
    await expect(record(id,'identity','pending')).rejects.toThrow('privacy_request_invalid');
  });
  it('requires reconciliation of legacy terminal receipts even when a hash was present',async()=>{
    const id=await request();await fill(id);
    await db.query("insert into clinical_private.owned_privacy_fulfillment(privacy_request_id,store,outcome,evidence_sha256,operator) values($1,'identity','purged',$2,'legacy-fixture')",[id,digest]);
    await expect(complete(id)).rejects.toThrow('privacy_request_store_pending');
    await record(id,'identity','purged');
    expect((await complete(id)).rows[0]).toMatchObject({result:{status:'completed'}});
  });
  it('does not mistake deletion receipts for a completed correction',async()=>{
    const id=await request('correction');await fill(id);
    await expect(complete(id)).rejects.toThrow('privacy_correction_resolution_required');
  });
  it('rechecks actual holds even when a stale request status says in_progress',async()=>{
    const id=await request();await fill(id);
    const hold=(await asActor("select clinical_private.place_owned_legal_hold($1,'owner_dispute') as id",[owner])).rows[0] as {id:string};
    await db.query("update clinical_private.owned_privacy_requests set status='in_progress' where id=$1",[id]);
    await expect(complete(id)).rejects.toThrow('privacy_request_held');
    await expect(purge(id)).rejects.toThrow('privacy_request_held');
    await expect(record(id,'personal_records','purged')).rejects.toThrow('privacy_request_held');
    await expect(record(id,'personal_records','tombstoned')).rejects.toThrow('privacy_request_held');
    await asActor('select clinical_private.release_owned_legal_hold($1)',[hold.id]);
    await expect(asActor('select clinical_private.release_owned_legal_hold($1)',[hold.id])).rejects.toThrow('legal_hold_invalid');
    expect((await complete(id)).rows[0]).toMatchObject({result:{status:'completed'}});
  });
  it.each(['missing','test-corrupt','test-future','test-retired'])('refuses invalid retention policy %s',async policy=>{
    await expect(purge(await request(),policy)).rejects.toThrow('retention_policy_required');
  });
  it('requires policy-bound retention and rechecks policy at completion',async()=>{
    const id=await request();await fill(id);
    await expect(record(id,'backups_and_audit','retained_by_policy')).rejects.toThrow('retention_policy_receipt_required');
    await asActor('select clinical_private.record_owned_privacy_retention($1,$2,$3,$4)',[id,'backups_and_audit',digest,'test-valid']);
    await db.query("update clinical_private.owned_retention_policies set retired_at=now() where version='test-valid'");
    try{await expect(complete(id)).rejects.toThrow('retention_policy_required');}
    finally{await db.exec("update clinical_private.owned_retention_policies set retired_at=null where version='test-valid'");}
    expect((await complete(id)).rows[0]).toMatchObject({result:{status:'completed',fulfillment:expect.arrayContaining([{store:'backups_and_audit',outcome:'retained_by_policy',evidenceSha256:digest,recordedAt:expect.any(String)}])}});
  });
  it('runs a scoped personal-history purge and records exact store receipts without claiming whole-account completion',async()=>{
    const id=await request();
    await db.query(`insert into clinical_private.consumer_storage_consent_releases(scope,version,content,content_sha256,approved_by,approved_at)
      values('protocols_supplements','fixture-only','Not approved for real use',encode(public.digest('Not approved for real use','sha256'),'hex'),'FICTIONAL TEST',now())`);
    const recordId=randomUUID();
    for(const who of [owner,other]){
      await db.query("insert into clinical_core.consumer_storage_consents(owner_id,scope,revision,status,release_version) values($1,'protocols_supplements',1,'granted','fixture-only')",[who]);
      for(const revision of who===owner?[1,2]:[1]){
        await db.query(`insert into clinical_core.owned_consumer_record_versions(owner_id,collection,record_id,revision,request_id,command_sha256,payload,deleted,consent_revision)
          values($1,'protocols',$2,$3,$4,$5,'{}',false,1)`,[who,recordId,revision,randomUUID(),digest]);
      }
      await db.query(`insert into clinical_core.owned_consumer_active_plans(owner_id,record_id,revision,content_sha256,consent_revision,adopted_at,adoption_request_id)
        values($1,$2,1,$3,1,now(),$4)`,[who,recordId,digest,randomUUID()]);
      await db.query(`insert into clinical_core.owned_consumer_active_plan_history(owner_id,action,request_id,record_id,revision,content_sha256,consent_revision)
        values($1,'adopted',$2,$3,1,$4,1)`,[who,randomUUID(),recordId,digest]);
    }
    expect((await purge(id)).rows[0]).toMatchObject({result:{privacyRequestId:id,records:2,consents:1,activePlans:1,policyVersion:'test-valid'}});
    for(const table of ['owned_consumer_record_versions','consumer_storage_consents','owned_consumer_active_plans','owned_consumer_active_plan_history']){
      expect((await db.query(`select owner_id from clinical_core.${table}`)).rows).toEqual([{owner_id:other}]);
    }
    expect((await db.query('select store,outcome from clinical_private.owned_privacy_fulfillment where privacy_request_id=$1 order by store',[id])).rows)
      .toEqual(['active_plan','personal_consents','personal_records'].map(store=>({store,outcome:'purged'})));
    expect((await db.query("select count(*)::int as n from clinical_audit.consumer_storage_events where owner_id=$1 and action='privacy_request.purged'",[owner])).rows).toEqual([{n:1}]);
    await expect(complete(id)).rejects.toThrow('privacy_request_store_pending');
  });
  it('keeps consumer request views owner-scoped',async()=>{
    const own=await asActor('select clinical_core.list_owned_privacy_requests() as result',[],owner,'consumer');
    const foreign=await asActor('select clinical_core.list_owned_privacy_requests() as result',[],other,'consumer');
    const a=(own.rows[0] as {result:{privacyRequestId:string}[]}).result.map(r=>r.privacyRequestId);
    const b=(foreign.rows[0] as {result:{privacyRequestId:string}[]}).result.map(r=>r.privacyRequestId);
    expect(a.length).toBeGreaterThan(0);expect(b.length).toBeGreaterThan(0);expect(a.some(id=>b.includes(id))).toBe(false);
  });
});
