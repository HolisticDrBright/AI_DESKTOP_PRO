import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createOwnedConsumerRecordsAdapter} from './owned-consumer-records';
import {createOwnedConsumerApi} from './owned-consumer-api';
import {createPrivacyOperations} from './privacy-operations';
import {createPrivacyOperationsApi,PRIVACY_OPERATIONS_ROUTE} from './privacy-operations-api';
import type {ClinicalCoreDatabase} from './database';
import type {ApiGatewayV2Event} from './aws-identity-api';

const owner=randomUUID(),other=randomUUID(),operator=randomUUID(),unassigned=randomUUID(),reviewer=randomUUID(),org=randomUUID();
const digest='a'.repeat(64);
const stores=['personal_records','personal_consents','active_plan','lab_jobs_and_documents','voice_jobs_and_transcripts',
  'identity','clinic_records','device_caches_and_recovery_archives','backups_and_audit'];
let db:PGlite;
async function asActor(sql:string,params:unknown[]=[],actor:string=operator,pool='workforce',purpose='consent_management'){
  return db.transaction(async tx=>{
    await tx.exec('set local role clinical_core_api');
    await tx.query("select clinical_private.set_request_context($1,$2,$3,$4,$5,'production-clinical','clinical_phi')",
      [actor,org,pool,'subject-'+actor,purpose]);
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
async function correctionFixture(){
  const recordId=randomUUID();
  await db.query(`insert into clinical_private.consumer_storage_consent_releases(scope,version,content,content_sha256,approved_by,approved_at)
    values('forms_checkins','correction-fixture','Fictional only',encode(public.digest('Fictional only','sha256'),'hex'),'FICTIONAL TEST',now()) on conflict do nothing`);
  await db.query("insert into clinical_core.consumer_storage_consents(owner_id,scope,revision,status,release_version) values($1,'forms_checkins',1,'granted','correction-fixture') on conflict do nothing",[owner]);
  const payload={height_cm:170,note:'Fictional only'};
  await asActor("select clinical_core.write_owned_consumer_record('wellness_profiles',$1,0,$2,$3::jsonb,false,1)",[recordId,randomUUID(),JSON.stringify(payload)],owner,'consumer','clinical_data');
  const row=(await asActor("select clinical_core.list_owned_correction_targets('wellness_profiles',25,null) as result",[],owner,'consumer')).rows[0] as {result:{recordId:string;payloadSha256:string}[]};
  const hash=row.result.find(r=>r.recordId===recordId)!.payloadSha256;
  const correction={version:'personal-correction/1',collection:'wellness_profiles',recordId,expectedRevision:1,expectedPayloadSha256:hash,
    field:'height_cm',requestedValue:180,reason:'Fictional input correction'};
  return {correction,payload,recordId};
}
const submitCorrection=(correction:unknown,requestId=randomUUID(),actor=owner)=>asActor(
  "select clinical_core.submit_owned_privacy_request($1,'correction',$2::jsonb) as result",[requestId,JSON.stringify(correction)],actor,'consumer');
const resolveCorrection=(id:string,outcome='applied',revision:number|null=2,reason='Verified against the saved correction')=>asActor(
  'select clinical_private.resolve_owned_correction($1,$2,$3,$4) as result',[id,outcome,revision,reason]);
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
  it('lists only assigned requests, pages without duplicates and audits workforce reads',async()=>{
    for(let i=0;i<28;i++)await request();
    const foreign=await request('deletion',other);
    const page=(after:string|null=null)=>asActor('select clinical_private.list_assigned_privacy_requests($1,25,false) as result',[after]);
    const first=(await page()).rows[0] as {result:{privacyRequestId:string;ownerId:string}[]};
    expect(first.result).toHaveLength(25);expect(first.result.every(r=>r.ownerId===owner)).toBe(true);
    const last=first.result.at(-1)!.privacyRequestId;
    const second=(await page(last)).rows[0] as typeof first;
    expect(second.result.every(r=>r.privacyRequestId>last&&r.ownerId===owner)).toBe(true);
    expect([...first.result,...second.result].some(r=>r.privacyRequestId===foreign)).toBe(false);
    expect((await asActor('select clinical_private.list_assigned_privacy_requests() as result',[],unassigned)).rows).toEqual([{result:[]}]);
    await expect(asActor('select clinical_private.list_assigned_privacy_requests()',[],owner,'consumer')).rejects.toThrow('privacy_operator_required');
    await expect(asActor('select clinical_private.get_assigned_privacy_request($1)',[foreign])).rejects.toThrow('privacy_operator_assignment_required');
    await expect(asActor('select * from clinical_audit.privacy_operator_access')).rejects.toThrow('permission denied');
    const audits=await db.query('select distinct operator_id from clinical_audit.privacy_operator_access');
    expect(audits.rows).toEqual([{operator_id:operator}]);
    await expect(db.exec("update clinical_audit.privacy_operator_access set action='detail'")).rejects.toThrow('append_only_record');
  });
  it('rechecks assignment expiry and revocation when opening a previously listed request',async()=>{
    const id=await request();
    expect((await asActor('select clinical_private.get_assigned_privacy_request($1) as result',[id])).rows[0]).toMatchObject({result:{privacyRequestId:id}});
    await db.exec('update clinical_private.owned_privacy_operator_assignments set revoked_at=now()');
    try{
      expect((await asActor('select clinical_private.list_assigned_privacy_requests() as result')).rows).toEqual([{result:[]}]);
      await expect(asActor('select clinical_private.get_assigned_privacy_request($1)',[id])).rejects.toThrow('privacy_operator_assignment_required');
    }finally{await db.exec('update clinical_private.owned_privacy_operator_assignments set revoked_at=null');}
  });
  it('round-trips assigned correction review and verified resolution through workforce API, adapter and production SQL',async()=>{
    const {correction,payload,recordId}=await correctionFixture();
    const id=((await submitCorrection(correction)).rows[0] as {result:{privacyRequestId:string}}).result.privacyRequestId;
    const database:ClinicalCoreDatabase={transaction:work=>db.transaction(async tx=>{
      await tx.exec('set local role clinical_core_api');
      return work({query:async<Row extends Record<string,unknown>>(sql:string,parameters:readonly unknown[]=[])=>
        tx.query<Row>(sql,parameters.map(p=>p&&typeof p==='object'&&'kind' in p&&p.kind==='uuid'&&'value' in p?p.value:p))});
    })};
    const issuer='https://cognito-idp.us-east-2.amazonaws.com/workforce',audience='12345678901234567890',now=Date.now(),t=Math.floor(now/1000);
    const handler=createPrivacyOperationsApi({configuration:{workforceIssuer:issuer,workforceAudience:audience,phiAllowed:true,
      activation:'approved',evidenceSha256:digest,mfaReviewSha256:digest},operations:()=>createPrivacyOperations(database),now:()=>now});
    const event=(body:unknown):ApiGatewayV2Event=>({routeKey:PRIVACY_OPERATIONS_ROUTE,body:JSON.stringify(body),headers:{'content-type':'application/json'},
      requestContext:{authorizer:{jwt:{claims:{iss:issuer,aud:audience,sub:'subject-'+operator,token_use:'id',email_verified:'true',
        'custom:person_id':operator,'custom:organization_id':org,'custom:production_bound':'true',iat:t,auth_time:t,exp:t+600}}}}});
    const detail=await handler(event({action:'detail',privacyRequestId:id}));
    expect(detail.statusCode).toBe(200);
    expect(JSON.parse(detail.body).data).toMatchObject({privacyRequestId:id,correction:{originalValue:170,requestedValue:180,currentValue:170,
      currentRevision:1,resolution:null,originalAvailable:true}});
    expect(detail.body).not.toContain('"note"'); // Unrelated intake fields stay private.
    await asActor("select clinical_core.write_owned_consumer_record('wellness_profiles',$1,1,$2,$3::jsonb,false,1)",[recordId,randomUUID(),JSON.stringify({...payload,height_cm:180})],owner,'consumer','clinical_data');
    const command={action:'resolve',privacyRequestId:id,outcome:'applied',appliedRevision:2,explanation:'Verified fictional change'};
    const result=await handler(event(command));expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).data).toMatchObject({status:'completed',correction:{resolution:{outcome:'applied',appliedRevision:2}}});
    expect((await handler(event(command))).body).toBe(result.body);
  });
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
    const priorRecords=Number((await db.query<{n:number}>('select count(*)::int as n from clinical_core.owned_consumer_record_versions where owner_id=$1',[owner])).rows[0].n);
    const priorConsents=Number((await db.query<{n:number}>('select count(*)::int as n from clinical_core.consumer_storage_consents where owner_id=$1',[owner])).rows[0].n);
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
    expect((await purge(id)).rows[0]).toMatchObject({result:{privacyRequestId:id,records:priorRecords+2,consents:priorConsents+1,activePlans:1,policyVersion:'test-valid'}});
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
  it('binds correction requests, survives lost-response retries, and resolves only an actual normal-path successor',async()=>{
    const {correction,payload,recordId}=await correctionFixture(),command=randomUUID();
    const submitted=(await submitCorrection(correction,command)).rows[0] as {result:{privacyRequestId:string}};
    const id=submitted.result.privacyRequestId;
    expect(submitted).toMatchObject({result:{status:'submitted',duplicate:false,correctionTarget:{recordId,expectedRevision:1,expectedPayloadSha256:correction.expectedPayloadSha256}}});
    await expect(resolveCorrection(id)).rejects.toThrow('privacy_correction_not_applied');
    await asActor("select clinical_core.write_owned_consumer_record('wellness_profiles',$1,1,$2,$3::jsonb,false,1)",[recordId,randomUUID(),JSON.stringify({...payload,height_cm:180})],owner,'consumer','clinical_data');
    expect((await submitCorrection(correction,command)).rows[0]).toMatchObject({result:{duplicate:true}});
    const result=await resolveCorrection(id);
    expect(result.rows[0]).toMatchObject({result:{status:'completed',correctionResolution:{outcome:'applied',appliedRevision:2,evidenceSha256:expect.stringMatching(/^[a-f0-9]{64}$/)}}});
    expect((await resolveCorrection(id)).rows).toEqual(result.rows);
    await expect(resolveCorrection(id,'applied',2,'Changed explanation')).rejects.toThrow('privacy_correction_resolution_conflict');
    expect((await db.query('select count(*)::int as n from clinical_core.owned_consumer_record_versions where owner_id=$1 and record_id=$2',[owner,recordId])).rows).toEqual([{n:2}]);
    await expect(db.query("update clinical_private.owned_correction_resolutions set explanation='changed' where privacy_request_id=$1",[id])).rejects.toThrow('append_only_record');
    await expect(db.query('delete from clinical_private.owned_correction_targets where privacy_request_id=$1',[id])).rejects.toThrow('append_only_record');
  });
  it('rejects stale, forged, missing and cross-owner correction targets before submission',async()=>{
    const {correction}=await correctionFixture();
    for(const patch of [{expectedRevision:2},{expectedPayloadSha256:'b'.repeat(64)},{recordId:randomUUID()}]){
      await expect(submitCorrection({...correction,...patch})).rejects.toThrow('privacy_correction_target_changed');
    }
    await expect(submitCorrection(correction,randomUUID(),other)).rejects.toThrow('privacy_correction_target_changed');
    for(const patch of [{field:'missing'},{field:'__proto__'},{requestedValue:170},{expectedRevision:null},{extra:true},{version:'old'}]){
      await expect(submitCorrection({...correction,...patch})).rejects.toThrow('privacy_correction_invalid');
    }
    const {expectedRevision:_,...legacy}=correction;void _;
    await expect(submitCorrection(legacy)).rejects.toThrow('privacy_correction_invalid');
  });
  it('does not mark a correction applied if another field changed or the proposed value is absent',async()=>{
    const {correction,payload,recordId}=await correctionFixture();
    const id=((await submitCorrection(correction)).rows[0] as {result:{privacyRequestId:string}}).result.privacyRequestId;
    await asActor("select clinical_core.write_owned_consumer_record('wellness_profiles',$1,1,$2,$3::jsonb,false,1)",[recordId,randomUUID(),JSON.stringify({...payload,height_cm:180,note:'unrelated change'})],owner,'consumer','clinical_data');
    await expect(resolveCorrection(id)).rejects.toThrow('privacy_correction_not_applied');
    const declined=(await resolveCorrection(id,'declined',null,'The saved change includes unrelated fields; a fresh review is needed.')).rows[0];
    expect(declined).toMatchObject({result:{status:'refused',completedAt:null,correctionResolution:{outcome:'declined',appliedRevision:null,appliedPayloadSha256:null}}});
  });
  it('refuses correction resolution under a legal hold or without scoped operator authority',async()=>{
    const {correction}=await correctionFixture();
    const id=((await submitCorrection(correction)).rows[0] as {result:{privacyRequestId:string}}).result.privacyRequestId;
    await expect(asActor("select clinical_private.resolve_owned_correction($1,'declined',null,'reviewed')",[id],unassigned)).rejects.toThrow('privacy_operator_assignment_required');
    await expect(asActor("select clinical_private.resolve_owned_correction($1,'declined',null,'reviewed')",[id],owner,'consumer')).rejects.toThrow('privacy_operator_required');
    const hold=(await asActor("select clinical_private.place_owned_legal_hold($1,'owner_dispute') as id",[owner])).rows[0] as {id:string};
    try{await expect(resolveCorrection(id,'declined',null,'Reviewed')).rejects.toThrow('privacy_request_held');}
    finally{await asActor('select clinical_private.release_owned_legal_hold($1)',[hold.id]);}
    await expect(asActor("select clinical_core.submit_owned_privacy_request_v1($1,'correction','{}')",[randomUUID()],owner,'consumer')).rejects.toThrow('permission denied');
  });
  it('round-trips target discovery, submission and ledger visibility through the real API adapter and SQL',async()=>{
    const {correction}=await correctionFixture();
    const database:ClinicalCoreDatabase={transaction:work=>db.transaction(async tx=>{
      await tx.exec('set local role clinical_core_api');
      return work({query:async<Row extends Record<string,unknown>>(sql:string,parameters:readonly unknown[]=[])=>
        tx.query<Row>(sql,parameters.map(p=>p&&typeof p==='object'&&'kind' in p&&p.kind==='uuid'&&'value' in p?p.value:p))});
    })};
    const issuer='https://cognito-idp.us-east-2.amazonaws.com/fixture',audience='12345678901234567890',now=Date.now();
    // In-memory production-contract test only; no deployed flags, JWTs or PHI.
    const handler=createOwnedConsumerApi({configuration:{consumerIssuer:issuer,consumerAudience:audience,phiAllowed:true,
      activationState:'approved',activationEvidenceSha256:digest,allowedScopes:['forms_checkins']},
      adapter:()=>createOwnedConsumerRecordsAdapter(database),now:()=>now});
    const event=(method:string,who=owner,body?:unknown,queryStringParameters:Record<string,string>={}):ApiGatewayV2Event=>({
      routeKey:`${method} /clinical-core/consumer/personal/privacy-request`,queryStringParameters,
      ...(body?{body:JSON.stringify(body),headers:{'content-type':'application/json'}}:{}),
      requestContext:{authorizer:{jwt:{claims:{iss:issuer,aud:audience,sub:'subject-'+who,token_use:'id',email_verified:'true',
        exp:Math.floor(now/1000)+600,iat:Math.floor(now/1000),'custom:person_id':who,'custom:organization_id':org,'custom:production_bound':'true'}}}}});
    const targets=await handler(event('GET',owner,undefined,{view:'correction-targets',collection:'wellness_profiles'}));
    expect(targets.statusCode).toBe(200);expect(JSON.parse(targets.body).data).toEqual(expect.arrayContaining([expect.objectContaining({recordId:correction.recordId,revision:1})]));
    const foreign=await handler(event('GET',other,undefined,{view:'correction-targets',collection:'wellness_profiles'}));
    expect(JSON.parse(foreign.body).data.some((r:{recordId:string})=>r.recordId===correction.recordId)).toBe(false);
    const submitted=await handler(event('POST',owner,{requestId:randomUUID(),kind:'correction',correction}));
    expect(submitted.statusCode).toBe(200);const receipt=JSON.parse(submitted.body).data;
    expect(receipt.correctionTarget).toMatchObject({recordId:correction.recordId,expectedRevision:1});
    await resolveCorrection(receipt.privacyRequestId,'declined',null,'Fictional reviewed explanation');
    const listed=await handler(event('GET'));
    expect(JSON.parse(listed.body).data.requests).toEqual(expect.arrayContaining([expect.objectContaining({privacyRequestId:receipt.privacyRequestId,
      status:'refused',correctionResolution:expect.objectContaining({outcome:'declined',explanation:'Fictional reviewed explanation'})})]));
    expect((await handler(event('GET',owner,undefined,{view:'correction-targets',collection:'wellness_profiles',ownerId:other}))).statusCode).toBe(400);
  });
});
