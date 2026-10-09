import {beforeAll,afterAll,it,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createOwnedConsumerRecordsAdapter} from './owned-consumer-records';
import {ClinicalCoreDatabaseRejection,type ClinicalCoreDatabase} from './database';
import {createOwnedLabAuthorization} from './owned-lab-authorization';
import {createOwnedVoiceAuthorization,voiceOwner} from './owned-voice-authorization';
import type {ProductionClinicalRequestContext} from './aws-identity-consent';
let db:PGlite;const org=randomUUID();
const fixtureScopes=['forms_checkins','protocols_supplements','ai_context','lab_history','voice_transcription'];
async function call(owner:string,sql:string,params:unknown[]=[],purpose='clinical_data'){
  return db.transaction(async tx=>{await tx.exec('set local role clinical_core_api');
    await tx.query("select clinical_private.set_request_context($1,$2,'consumer',$3,$4,'production-clinical','clinical_phi')",[owner,org,'subject-'+owner,purpose]);
    return tx.query(sql,params);});
}
async function owner(){
  const id=randomUUID();
  await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)',[id,'subject_'+id.replaceAll('-','')]);
  await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'consumer',$2,true)",[id,'subject-'+id]);
  for(const scope of fixtureScopes)await call(id,'select clinical_core.set_owned_consumer_consent($1,\'granted\',\'fictional-fence\',0)',[scope],'consent_management');
  return id;
}
const write=(who:string,id=randomUUID(),rev=0,command=randomUUID(),deleted=false,collection='wellness_profiles')=>call(who,
  'select clinical_core.write_owned_consumer_record($1,$2,$3,$4,\'{}\'::jsonb,$5,1) as result',[collection,id,rev,command,deleted]);
async function submit(who:string){const request=randomUUID();await call(who,"select clinical_core.submit_owned_privacy_request($1,'deletion',null)",[request],'consent_management');return request;}
beforeAll(async()=>{
  const {manifest,files}=JSON.parse(execFileSync(process.execPath,['scripts/build-aws-production-clinical-core.mjs','--json'],{encoding:'utf8',maxBuffer:8*1024*1024,timeout:10000}));
  db=new PGlite({extensions:{pgcrypto}});for(const m of manifest.migrations)await db.exec(files[m.file]);
  await db.query("insert into clinical_core.organizations(id,organization_label) values($1,'Fictional deletion fence test')",[org]);
  for(const scope of fixtureScopes)await db.query("insert into clinical_private.consumer_storage_consent_releases(scope,version,content,content_sha256,approved_by,approved_at) values($1,'fictional-fence','Fixture only',encode(public.digest('Fixture only','sha256'),'hex'),'TEST NOT APPROVAL',now())",[scope]);
},30000);
afterAll(async()=>{await db?.close();});

it('binds real lab and voice policies to the owner closure ledger without blocking privacy reads',async()=>{
  const a=await owner(),b=await owner();
  const database:ClinicalCoreDatabase={transaction:work=>db.transaction(async tx=>{
    await tx.exec('set local role clinical_core_api');
    return work({query:async<Row extends Record<string,unknown>>(sql:string,params:readonly unknown[]=[])=>{
      try{return await tx.query<Row>(sql,params.map(p=>p&&typeof p==='object'&&'kind' in p&&p.kind==='uuid'&&'value' in p?p.value:p));}
      catch(error){if(error instanceof Error&&error.message==='owned_account_deletion_write_blocked')throw new ClinicalCoreDatabaseRejection('account_deletion_write_blocked');throw error;}
    }});
  })};
  const adapter=createOwnedConsumerRecordsAdapter(database);
  const context:ProductionClinicalRequestContext={actorPersonId:a,organizationId:org,identityPool:'consumer',identitySubject:'subject-'+a,
    purpose:'consent_management',environment:'production-clinical',dataClassification:'clinical_phi',containsPhi:true,realPatientData:true,productionBound:true};
  const lab=createOwnedLabAuthorization(()=>adapter),voice=createOwnedVoiceAuthorization(()=>adapter);
  const l=await lab.capture(context),v=await voice.capture(context);
  const lj={authorization:l,ownerSub:l.identitySubject,personId:a,organizationId:org},vj={authorization:v,owner:voiceOwner(context)};
  await lab.policy.verify(lj);await voice.policy.verify(vj);await submit(a);
  await expect(lab.policy.verify(lj)).rejects.toMatchObject({reason:'account_deletion_write_blocked'});
  await expect(voice.policy.verify(vj)).rejects.toMatchObject({reason:'account_deletion_write_blocked'});
  await expect(adapter.processingConsentStates(context,'lab')).rejects.toMatchObject({code:'account_deletion_write_blocked'});
  expect((await adapter.consentState(context,'lab_history')).activeRevision).toBe(1);
  const other={...context,actorPersonId:b,identitySubject:'subject-'+b};
  expect((await adapter.processingConsentStates(other,'voice')).map(s=>s.scope)).toEqual(['ai_context','voice_transcription']);
});

it('requires the processing operation and purpose and does not manufacture a grant after withdrawal',async()=>{
  const a=await owner();
  await expect(call(a,"select clinical_core.get_owned_processing_consent_states('voice')")).rejects.toThrow('consent_request_invalid');
  await expect(call(a,"select clinical_core.get_owned_processing_consent_states('other')",[],'consent_management')).rejects.toThrow('consent_request_invalid');
  await call(a,"select clinical_core.set_owned_consumer_consent('ai_context','revoked',null,1)",[],'consent_management');
  expect((await call(a,"select clinical_core.get_owned_processing_consent_states('voice') as result",[],'consent_management')).rows[0]).toMatchObject({result:{ownerId:a,operation:'voice',states:[{scope:'ai_context',activeRevision:null},{scope:'voice_transcription',activeRevision:1}]}});
});

it.each(['submitted','held','in_progress','completed'])('fences new personal saves for %s deletion without hiding reads or blocking another owner',async status=>{
  const a=await owner(),b=await owner(),id=randomUUID(),command=randomUUID();
  await write(a,id,0,command);const request=await submit(a);
  // Fictional status setup tests each state; it does not bypass fulfillment in production.
  await db.query('update clinical_private.owned_privacy_requests set status=$1 where owner_id=$2 and request_id=$3',[status,a,request]);
  await expect(write(a)).rejects.toThrow('owned_account_deletion_write_blocked');
  await expect(write(a,id,1)).rejects.toThrow('owned_account_deletion_write_blocked');
  expect((await write(a,id,0,command)).rows[0]).toMatchObject({result:{duplicate:true,revision:1}});
  expect((await call(a,"select clinical_core.get_owned_consumer_record('wellness_profiles',$1) as result",[id])).rows[0]).toMatchObject({result:{recordId:id,revision:1}});
  await write(b);
  expect((await call(a,'select clinical_core.list_owned_privacy_requests() as result',[],'consent_management')).rows[0]).toMatchObject({result:[{status}]});
});

it('preserves withdrawal, export, tombstones and audit while refusing new consent grants and resurrection',async()=>{
  const a=await owner(),id=randomUUID();await write(a,id);const request=await submit(a);
  await call(a,'select clinical_core.start_owned_privacy_export($1)',[randomUUID()],'consent_management');
  await call(a,'select clinical_core.tombstone_owned_personal_records($1)',[request],'consent_management');
  expect((await call(a,"select clinical_core.get_owned_consumer_record('wellness_profiles',$1) as result",[id])).rows[0]).toMatchObject({result:{deleted:true,revision:2}});
  await expect(write(a,id,2)).rejects.toThrow('owned_account_deletion_write_blocked');
  await call(a,"select clinical_core.set_owned_consumer_consent('forms_checkins','revoked',null,1)",[],'consent_management');
  await expect(call(a,"select clinical_core.set_owned_consumer_consent('forms_checkins','granted','fictional-fence',2)",[],'consent_management')).rejects.toThrow('owned_account_deletion_write_blocked');
  const rows=await db.query<{count:number}>("select count(*)::integer as count from clinical_audit.consumer_storage_events where owner_id=$1 and action='record.written'",[a]);
  expect(rows.rows[0].count).toBe(1);
});

it('preserves legal holds and prevents new plan adoption while allowing release',async()=>{
  const a=await owner(),plan=randomUUID(),plan2=randomUUID();
  await write(a,plan,0,randomUUID(),false,'protocols');await write(a,plan2,0,randomUUID(),false,'protocols');
  const adopt="select clinical_core.adopt_owned_active_plan($1,1,$2,1,$3,$4,$5)";
  await call(a,adopt,[plan,'a'.repeat(64),randomUUID(),null,null]);
  await submit(a);
  await expect(call(a,adopt,[plan2,'b'.repeat(64),randomUUID(),plan,1])).rejects.toThrow('owned_account_deletion_write_blocked');
  await call(a,'select clinical_core.release_owned_active_plan($1,$2,1)',[randomUUID(),plan]);
  await expect(call(a,adopt,[plan2,'b'.repeat(64),randomUUID(),null,null])).rejects.toThrow('owned_account_deletion_write_blocked');
  await db.query("insert into clinical_private.owned_legal_holds(owner_id,reason_code,placed_by) values($1,'owner_dispute',$1)",[a]);
  await expect(write(a,plan,1,randomUUID(),true,'protocols')).rejects.toThrow('legal_hold');
});

it('does not fence a refused deletion or a correction request, and a per-record tombstone does not close the account',async()=>{
  const a=await owner(),id=randomUUID();await write(a,id);await write(a,id,1,randomUUID(),true);await write(a);
  await submit(a);
  await db.query("update clinical_private.owned_privacy_requests set status='refused' where owner_id=$1",[a]);
  await db.query("insert into clinical_private.owned_privacy_requests(owner_id,request_id,kind,status,correction) values($1,$2,'correction','submitted','{}')",[a,randomUUID()]);
  await write(a);
});

it('guards the SQL tables even without the app adapter and exposes no guard execution privileges',async()=>{
  const a=await owner();await submit(a);
  await expect(db.query("insert into clinical_core.owned_consumer_record_versions(owner_id,collection,record_id,revision,request_id,command_sha256,payload,deleted,consent_revision) values($1,'wellness_profiles',$2,1,$3,$4,'{}',false,1)",[a,randomUUID(),randomUUID(),'a'.repeat(64)])).rejects.toThrow('owned_account_deletion_write_blocked');
  await expect(call(a,'select clinical_private.assert_owned_storage_writable($1)',[a])).rejects.toThrow('permission denied');
  await expect(call(a,"update clinical_private.owned_privacy_requests set status='refused' where owner_id=$1",[a])).rejects.toThrow('permission denied');
});
