import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {createOwnedPrivacyRequests} from './owned-privacy-requests';
import {ClinicalCoreDatabaseRejection,type ClinicalCoreTransaction} from './database';
import type {ProductionClinicalRequestContext} from './aws-identity-consent';
import {privacyDetailSchema} from '@/contracts/privacyOperations';

// Executable production SQL (migration 20260920170000) over fictional in-memory rows.
// No lab store, voice store, hosted database or real person is involved.
const owner=randomUUID(),other=randomUUID(),operator=randomUUID(),unassigned=randomUUID(),reviewer=randomUUID(),org=randomUUID();
let db:PGlite;
function classify(error:unknown){
  const message=error instanceof Error?error.message:'';
  if(/\b(privacy_request_conflict|privacy_dispute_target_changed|privacy_dispute_resolution_conflict|privacy_dispute_target_required)\b/.test(message))return new ClinicalCoreDatabaseRejection('conflict');
  if(/\b(consumer_owner_required|privacy_operator_required|privacy_operator_assignment_required|request_context_refused)\b/.test(message))return new ClinicalCoreDatabaseRejection('identity_refused');
  if(/\b(privacy_dispute_invalid|privacy_request_invalid|privacy_dispute_resolution_invalid)\b/.test(message))return new ClinicalCoreDatabaseRejection('request_invalid');
  return error;
}
const context=(who=owner,pool:'consumer'|'workforce'='consumer',purpose:'consent_management'|'clinical_data'='consent_management'):ProductionClinicalRequestContext=>({actorPersonId:who,organizationId:org,identityPool:pool,identitySubject:'subject-'+who,
  purpose,environment:'production-clinical',dataClassification:'clinical_phi',containsPhi:true,realPatientData:true,productionBound:true});
const run=<T,>(c:ProductionClinicalRequestContext,work:(tx:ClinicalCoreTransaction)=>Promise<T>)=>db.transaction(async tx=>{
  await tx.exec('set local role clinical_core_api');
  await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)',[c.actorPersonId,c.organizationId,c.identityPool,c.identitySubject,c.purpose,c.environment,c.dataClassification]);
  return work({query:async(sql:string,args:unknown[]=[])=>{try{return await tx.query(sql,args.map(v=>typeof v==='object'&&v!==null&&'kind' in v&&v.kind==='uuid'&&'value' in v?v.value:v));}catch(error){throw classify(error);}}} as unknown as ClinicalCoreTransaction);
});
const requests=createOwnedPrivacyRequests(run as never);
const asOperator=async<T,>(sql:string,args:unknown[]=[],who=operator)=>(await run(context(who,'workforce'),tx=>tx.query<{result:T}>(sql,args))).rows[0]?.result;
const resolve=(id:string,outcome:string,amendment:string|null,explanation='Verified in the lab inventory; the amended result is recorded under the named digest.',who=operator)=>
  asOperator<Record<string,unknown>>('select clinical_private.resolve_owned_dispute($1,$2,$3,$4) as result',[id,outcome,amendment,explanation],who);
const detail=(id:string,who=operator)=>asOperator<Record<string,unknown>>('select clinical_private.get_assigned_privacy_request($1) as result',[id],who);
const dispute=(patch:Record<string,unknown>={})=>({version:'personal-dispute/1',store:'lab_processing_result',referenceId:randomUUID(),contentSha256:'c'.repeat(64),
  statement:'FICTIONAL: the ferritin value on this processed report does not match the source document.',requestedAction:'amend',...patch});
let recordId:string;
beforeAll(async()=>{
  const {manifest,files}=JSON.parse(execFileSync(process.execPath,['scripts/build-aws-production-clinical-core.mjs','--json'],{encoding:'utf8',maxBuffer:8*1024*1024,timeout:10000}));
  db=new PGlite({extensions:{pgcrypto}});for(const m of manifest.migrations)await db.exec(files[m.file]);
  await db.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL')",[org]);
  for(const [id,pool] of [[owner,'consumer'],[other,'consumer'],[operator,'workforce'],[unassigned,'workforce'],[reviewer,'workforce']]){
    await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)',[id,'subject_'+id.replaceAll('-','')]);
    await db.query('insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,$2,$3,true)',[id,pool,'subject-'+id]);
  }
  await db.query(`insert into clinical_private.owned_privacy_operator_assignments(operator_id,owner_id,reviewed_by,evidence_sha256,approved_at,expires_at)
    values($1,$2,$3,$4,now()-interval '1 day',now()+interval '1 day')`,[operator,owner,reviewer,'a'.repeat(64)]);
  await db.query(`insert into clinical_private.consumer_storage_consent_releases(scope,version,content,content_sha256,approved_by,approved_at)
    values('forms_checkins','dispute-fixture','Fictional only',encode(public.digest('Fictional only','sha256'),'hex'),'FICTIONAL TEST',now())`);
  await db.query("insert into clinical_core.consumer_storage_consents(owner_id,scope,revision,status,release_version) values($1,'forms_checkins',1,'granted','dispute-fixture')",[owner]);
  recordId=randomUUID();
  await run(context(owner,'consumer','clinical_data'),tx=>tx.query("select clinical_core.write_owned_consumer_record('wellness_profiles',$1,0,$2,$3::jsonb,false,1)",[recordId,randomUUID(),JSON.stringify({height_cm:170})]));
},60000);
afterAll(async()=>{await db?.close();});
describe('owner disputes of lab results, documents, transcripts and personal records (migration 20260920170000)',()=>{
  it('records a dispute without changing anything, returns it in the ledger with the statement, replays the same request and refuses a conflicting one',async()=>{
    const input=dispute(),requestId=randomUUID();
    const first=await requests.submitPrivacyRequest(context(),{requestId,kind:'dispute',dispute:input});
    expect(first).toMatchObject({kind:'dispute',status:'submitted',requestId,completedAt:null,disputeTarget:{store:'lab_processing_result',referenceId:input.referenceId,contentSha256:'c'.repeat(64),requestedAction:'amend',
      statementSha256:createHash('sha256').update(input.statement).digest('hex'),statement:input.statement}});
    expect(first.disputeResolution).toBeUndefined();expect(first.correctionTarget).toBeUndefined();
    expect((await requests.listPrivacyRequests(context())).find(r=>r.privacyRequestId===first.privacyRequestId)).toMatchObject({kind:'dispute',disputeTarget:{referenceId:input.referenceId}});
    expect(await requests.submitPrivacyRequest(context(),{requestId,kind:'dispute',dispute:input})).toMatchObject({privacyRequestId:first.privacyRequestId,duplicate:true});
    await expect(requests.submitPrivacyRequest(context(),{requestId,kind:'dispute',dispute:{...input,statement:'Different statement.'}})).rejects.toThrow('conflict');
    await expect(requests.submitPrivacyRequest(context(),{requestId,kind:'deletion'})).rejects.toThrow('conflict');
    // Nothing about the referenced content is touched or created.
    expect((await db.query<{n:number}>('select count(*)::int n from clinical_core.owned_consumer_record_versions where owner_id=$1',[owner])).rows[0].n).toBe(1);
  });
  it('validates the payload per store and refuses a personal-record dispute for a record the owner does not hold',async()=>{
    for(const patch of [{store:'voice_transcript'},{referenceId:'not-a-reference!'},{contentSha256:'X'.repeat(64)},{statement:'   '},{statement:'x'.repeat(4001)},{requestedAction:'delete'},{version:'personal-dispute/2'},{extra:1}])
      await expect(requests.submitPrivacyRequest(context(),{requestId:randomUUID(),kind:'dispute',dispute:dispute(patch)}),JSON.stringify(patch)).rejects.toThrow('request_invalid');
    await expect(requests.submitPrivacyRequest(context(),{requestId:randomUUID(),kind:'dispute'})).rejects.toThrow('request_invalid');
    await expect(requests.submitPrivacyRequest(context(),{requestId:randomUUID(),kind:'deletion',dispute:dispute()})).rejects.toThrow('request_invalid');
    // Straight to SQL: the database applies the same shape rules to a request the adapter did not see.
    await expect(run(context(),tx=>tx.query("select clinical_core.submit_owned_privacy_request($1,'dispute',$2::jsonb)",[randomUUID(),JSON.stringify(dispute({store:'voice_transcript'}))]))).rejects.toThrow('request_invalid');
    await expect(run(context(),tx=>tx.query("select clinical_core.submit_owned_privacy_request($1,'dispute',$2::jsonb)",[randomUUID(),JSON.stringify({...dispute(),extra:true})]))).rejects.toThrow('request_invalid');
    await expect(requests.submitPrivacyRequest(context(),{requestId:randomUUID(),kind:'dispute',dispute:dispute({store:'personal_record',referenceId:randomUUID(),contentSha256:null})})).rejects.toThrow('conflict');
    await expect(requests.submitPrivacyRequest(context(other),{requestId:randomUUID(),kind:'dispute',dispute:dispute({store:'personal_record',referenceId:recordId,contentSha256:null})})).rejects.toThrow('conflict');
    const voice=await requests.submitPrivacyRequest(context(),{requestId:randomUUID(),kind:'dispute',dispute:dispute({store:'voice_transcript',referenceId:'b'.repeat(64),contentSha256:null,requestedAction:'remove'})});
    expect(voice.disputeTarget).toMatchObject({store:'voice_transcript',referenceId:'b'.repeat(64),contentSha256:null,requestedAction:'remove'});
    const record=await requests.submitPrivacyRequest(context(),{requestId:randomUUID(),kind:'dispute',dispute:dispute({store:'personal_record',referenceId:recordId,contentSha256:null,requestedAction:'annotate'})});
    expect(record.disputeTarget).toMatchObject({store:'personal_record',referenceId:recordId,requestedAction:'annotate'});
    // Corrections still require their payload and deletions still refuse one: the widened constraint keeps the old rules.
    await expect(db.query("insert into clinical_private.owned_privacy_requests(owner_id,request_id,kind,status) values($1,$2,'correction','submitted')",[owner,randomUUID()])).rejects.toThrow(/owned_privacy_requests_check/);
    await expect(db.query("insert into clinical_private.owned_privacy_requests(owner_id,request_id,kind,status,dispute) values($1,$2,'deletion','submitted','{}'::jsonb)",[owner,randomUUID()])).rejects.toThrow(/owned_privacy_requests_check/);
    await expect(db.query("insert into clinical_private.owned_privacy_requests(owner_id,request_id,kind,status) values($1,$2,'appeal','submitted')",[owner,randomUUID()])).rejects.toThrow(/owned_privacy_requests_kind_check/);
  });
  it('shows the assigned operator the target and statement, resolves once with evidence, replays the same decision, refuses a different one and the unassigned operator',async()=>{
    const input=dispute({store:'lab_document'});
    const submitted=await requests.submitPrivacyRequest(context(),{requestId:randomUUID(),kind:'dispute',dispute:input});
    const id=submitted.privacyRequestId;
    const seen=privacyDetailSchema.parse(await detail(id));
    expect(seen).toMatchObject({kind:'dispute',status:'submitted',correction:null,dispute:{target:{store:'lab_document',referenceId:input.referenceId,requestedAction:'amend'},statement:input.statement,resolution:null}});
    expect(JSON.stringify(seen.dispute!.target)).not.toContain('"statement"');
    await expect(detail(id,unassigned)).rejects.toThrow('identity_refused');
    await expect(resolve(id,'amended',null)).rejects.toThrow('request_invalid');
    await expect(resolve(id,'declined','d'.repeat(64))).rejects.toThrow('request_invalid');
    await expect(resolve(id,'amended','not-a-digest')).rejects.toThrow('request_invalid');
    await expect(resolve(id,'amended','d'.repeat(64),' ')).rejects.toThrow('request_invalid');
    await expect(resolve(id,'amended','d'.repeat(64),'x',unassigned)).rejects.toThrow('identity_refused');
    await expect(run(context(owner),tx=>tx.query('select clinical_private.resolve_owned_dispute($1,$2,$3,$4)',[id,'amended','d'.repeat(64),'owner cannot resolve']))).rejects.toThrow('identity_refused');
    const resolved=await resolve(id,'amended','d'.repeat(64));
    expect(resolved).toMatchObject({status:'completed',disputeResolution:{outcome:'amended',amendmentSha256:'d'.repeat(64),explanation:expect.stringContaining('Verified')}});
    expect(typeof resolved.completedAt).toBe('string');
    expect(await resolve(id,'amended','d'.repeat(64))).toMatchObject({status:'completed',disputeResolution:{outcome:'amended'}});
    await expect(resolve(id,'declined',null)).rejects.toThrow('conflict');
    await expect(resolve(id,'amended','e'.repeat(64))).rejects.toThrow('conflict');
    const after=privacyDetailSchema.parse(await detail(id));
    expect(after.dispute!.resolution).toMatchObject({outcome:'amended',amendmentSha256:'d'.repeat(64)});
    expect(after.dispute!.resolution!.evidenceSha256).toMatch(/^[a-f0-9]{64}$/);
    // The owner sees the outcome in the ledger; the adapter's consistency checks accept it.
    const mine=(await requests.listPrivacyRequests(context())).find(r=>r.privacyRequestId===id)!;
    expect(mine).toMatchObject({status:'completed',disputeResolution:{outcome:'amended',amendmentSha256:'d'.repeat(64)}});
    expect((await db.query<{n:number}>("select count(*)::int n from clinical_audit.consumer_storage_events where owner_id=$1 and action='privacy_request.completed'",[owner])).rows[0].n).toBeGreaterThanOrEqual(1);
  });
  it('declines with an explanation and no evidence, leaving the request refused and open to nothing further',async()=>{
    const submitted=await requests.submitPrivacyRequest(context(),{requestId:randomUUID(),kind:'dispute',dispute:dispute({requestedAction:'remove'})});
    const declined=await resolve(submitted.privacyRequestId,'declined',null,'The processed values match the source document line by line; no amendment is warranted.');
    expect(declined).toMatchObject({status:'refused',completedAt:null,disputeResolution:{outcome:'declined',amendmentSha256:null}});
    await expect(resolve(submitted.privacyRequestId,'removed','f'.repeat(64))).rejects.toThrow('conflict');
    const mine=(await requests.listPrivacyRequests(context())).find(r=>r.privacyRequestId===submitted.privacyRequestId)!;
    expect(mine).toMatchObject({status:'refused',disputeResolution:{outcome:'declined'}});
    // A correction request cannot be resolved through the dispute path and vice versa.
    await expect(run(context(operator,'workforce'),tx=>tx.query('select clinical_private.resolve_owned_correction($1,$2,$3,$4)',[submitted.privacyRequestId,'declined',null,'x']))).rejects.toThrow('request_invalid');
  });
});
