import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {clinicalUuid,ClinicalCoreDatabaseRejection,type ClinicalCoreDatabase,type ClinicalCoreTransaction} from './database';
import type {ProductionClinicalRequestContext} from './aws-identity-consent';
import {createProductionCareConnections} from './production-care-connections';
import {createCareClaimRecovery} from './care-claim-recovery';
import {bindCareClaimRecoveryDatabase,validateCareClaimFunctions} from './care-claim-recovery-database-binding';
import {parseCareClaimResponse,careClaimRequest,type CareClaimRequest} from '../../contracts/careClaimRecovery';
import type {CareConnectionFunctionBinding} from './care-connections-database-binding';

// The actual immutable 105 artifact plus an UNRELEASED overlay. Fictional rows
// only. PGlite serializes transactions: these are NOT hosted multi-session races.
let db:PGlite,org:string,foreignOrg:string,owner:string,other:string,staff:string,patient:string;
let predecessor:CareConnectionFunctionBinding[],pins:CareConnectionFunctionBinding[],bound:ClinicalCoreDatabase;
const sha=(s:string)=>createHash('sha256').update(s,'utf8').digest('hex');
const subject=(id:string)=>'FICTIONAL-subject-'+id;
const context=(person=owner,organization=org,pool:'consumer'|'workforce'='consumer',purpose:ProductionClinicalRequestContext['purpose']='identity_link'):ProductionClinicalRequestContext=>({
  actorPersonId:person,identitySubject:subject(person),identityPool:pool,organizationId:organization,purpose,
  environment:'production-clinical',dataClassification:'clinical_phi',productionBound:true,containsPhi:true,realPatientData:true,
});
const database:ClinicalCoreDatabase={transaction:work=>db.transaction(async tx=>{
  await tx.exec('set local role clinical_core_api');
  const query:ClinicalCoreTransaction['query']=async(sql,args=[])=>{
    try{return await tx.query(sql,args.map(v=>v&&typeof v==='object'&&'kind' in v&&v.kind==='uuid'&&'value' in v?v.value:v));}
    catch(error){
      const message=error instanceof Error?error.message:'';
      if(message.includes('care_connection_invalid'))throw new ClinicalCoreDatabaseRejection('request_invalid');
      if(message.includes('care_connection_conflict'))throw new ClinicalCoreDatabaseRejection('conflict');
      if(message.includes('owned_account_deletion_write_blocked'))throw new ClinicalCoreDatabaseRejection('account_deletion_write_blocked');
      if(/care_connection_refused|request_context_refused/.test(message))throw new ClinicalCoreDatabaseRejection('identity_refused');
      throw error;
    }
  };
  return work({query});
})};
const call=(request:CareClaimRequest,person=owner,organization=org)=>createCareClaimRecovery(bound)(context(person,organization),request);
const receipt=(requestId:string,person=owner,organization=org)=>call({action:'receipt',requestId},person,organization);
const settle=(requestId:string,person=owner,organization=org)=>call({action:'settle',requestId},person,organization);
async function issue(){
  const result=await createProductionCareConnections(database)(context(staff,org,'workforce','clinical_data'),{action:'issue',patientRecordId:patient});
  if(!('token' in result))throw new Error('fictional_fixture_invalid');
  return result;
}
const functions=(sql:string)=>[...sql.matchAll(/create(?: or replace)? function ([a-z_]+\.[a-z_]+)\([^]*?as \$\$([^]*?)\$\$/g)]
  .map(([,name,body])=>({name,bodySha256:sha(body),apiExecute:name.startsWith('clinical_core.')}));
async function raw(request:unknown,c=context()){
  return database.transaction(async tx=>{
    await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)',[clinicalUuid(c.actorPersonId),clinicalUuid(c.organizationId),
      c.identityPool,c.identitySubject,c.purpose,c.environment,c.dataClassification]);
    return tx.query('select clinical_core.production_care_claim_request($1::jsonb)',[JSON.stringify(request)]);
  });
}
beforeAll(async()=>{
  const {manifest,files}=JSON.parse(execFileSync(process.execPath,['scripts/build-aws-production-clinical-core.mjs','--json'],
    {encoding:'utf8',timeout:10000,maxBuffer:8*1024*1024}));
  expect(manifest.migrations).toHaveLength(105);
  expect(sha(manifest.migrations.map((m:{version:string;file:string})=>`${m.version}:${sha(files[m.file])}`).join('\n')))
    .toBe('7da8e4ed999a3298bccc4ef33e7a1005201db45fa2b46682622a208486f17743');
  db=new PGlite({extensions:{pgcrypto}});
  for(const m of manifest.migrations)await db.exec(files[m.file]);
  const overlay=readFileSync('infra/aws-clinical-core/production-candidates/care-claim-recovery.sql','utf8').replace(/\r\n?/g,'\n');
  await db.exec(overlay);
  predecessor=functions(files['20261006020000_production_care_connections.sql']);pins=functions(overlay);
  bound=bindCareClaimRecoveryDatabase(database,predecessor,pins);
  for(const table of ['clinical_core.care_claim_requests','clinical_audit.care_claim_events'])
    expect((await db.query<{n:number}>(`select count(*)::int n from ${table}`)).rows[0].n).toBe(0);
},60000);
afterAll(async()=>{await db?.close();});
beforeEach(async()=>{
  [org,foreignOrg,owner,other,staff,patient]=Array.from({length:6},()=>randomUUID());
  for(const id of [org,foreignOrg])await db.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL CLINIC')",[id]);
  for(const [id,pool] of [[owner,'consumer'],[other,'consumer'],[staff,'workforce']]){
    await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)',[id,'subject_'+id.replaceAll('-','')]);
    await db.query('insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,$2,$3,true)',[id,pool,subject(id)]);
  }
  await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner')",[org,staff]);
  await db.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'FICTIONAL','TEST')",[patient,org,'patient_'+patient.replaceAll('-','')]);
});

describe('exact claim recovery, actual SQL/API role',()=>{
  it('reads an absent receipt as unresolved without deciding or claiming',async()=>{
    const requestId=randomUUID();expect(await receipt(requestId)).toEqual({requestId,status:'unresolved'});
    expect((await db.query('select * from clinical_core.care_claim_requests where organization_id=$1',[org])).rows).toHaveLength(0);
    expect((await db.query('select * from clinical_core.patient_connections where organization_id=$1',[org])).rows).toHaveLength(0);
  });
  it('canonicalizes uppercase request ids without losing their receipt correlation',async()=>{
    const requestId=randomUUID();expect(await call({action:'settle',requestId:requestId.toUpperCase()})).toEqual({requestId,status:'cancelled'});
    expect(await receipt(requestId.toUpperCase())).toEqual({requestId,status:'cancelled'});
  });
  it('recovers a lost reply, replays identically and settles as committed with one claim and no consent',async()=>{
    const invitation=await issue(),requestId=randomUUID(),request={action:'claim' as const,requestId,token:invitation.token};
    const result=await call(request);
    expect(result).toMatchObject({requestId,status:'committed',connection:{connectionId:invitation.connectionId,patientRecordId:patient,state:'verified',version:2}});
    expect(await receipt(requestId)).toEqual(result);expect(await settle(requestId)).toEqual(result);expect(await call(request)).toEqual(result);
    const decisions=(await db.query('select token_sha256,status from clinical_core.care_claim_requests where organization_id=$1',[org])).rows;
    expect(decisions).toEqual([{token_sha256:sha(invitation.token),status:'committed'}]);
    expect((await db.query<{n:number}>('select count(*)::int n from clinical_audit.events where resource_id=$1',[invitation.connectionId])).rows[0].n).toBe(2);
    expect((await db.query<{n:number}>('select count(*)::int n from clinical_core.consent_grants where connection_id=$1',[invitation.connectionId])).rows[0].n).toBe(0);
    const events=(await db.query('select action,outcome from clinical_audit.care_claim_events where organization_id=$1 order by occurred_at',[org])).rows;
    expect(events).toEqual([{action:'claim',outcome:'committed'},{action:'receipt',outcome:'committed'},{action:'settle',outcome:'committed'},{action:'claim',outcome:'committed'}]);
    expect(JSON.stringify(result)).not.toContain(invitation.token);expect(JSON.stringify(events)).not.toContain(sha(invitation.token));
  });
  it('settlement before admission permanently fences a late claim and converges on another device',async()=>{
    const invitation=await issue(),requestId=randomUUID();
    expect(await settle(requestId)).toEqual({requestId,status:'cancelled'});
    await expect(call({action:'claim',requestId,token:invitation.token})).rejects.toThrow('conflict');
    expect(await receipt(requestId)).toEqual({requestId,status:'cancelled'});expect(await settle(requestId)).toEqual({requestId,status:'cancelled'});
    expect((await db.query('select state,consumer_person_id from clinical_core.patient_connections where id=$1',[invitation.connectionId])).rows[0])
      .toEqual({state:'invitation_pending',consumer_person_id:null});
    // Only a new explicit identity can claim the still-live invitation.
    expect(await call({action:'claim',requestId:randomUUID(),token:invitation.token})).toMatchObject({status:'committed'});
    expect(await receipt(requestId)).toEqual({requestId,status:'cancelled'});
  });
  it('refuses reusing a successful request identity for a different code',async()=>{
    const invitation=await issue(),requestId=randomUUID();await call({action:'claim',requestId,token:invitation.token});
    const changed=invitation.token[0]==='A'?'B':'A';
    await expect(call({action:'claim',requestId,token:changed+invitation.token.slice(1)})).rejects.toThrow('conflict');
    expect(await receipt(requestId)).toMatchObject({status:'committed'});
  });
  it('keeps the same request id scoped to its authenticated owner and organization',async()=>{
    const invitation=await issue(),requestId=randomUUID();await call({action:'claim',requestId,token:invitation.token});
    expect(await receipt(requestId,other)).toEqual({requestId,status:'unresolved'});
    expect(await receipt(requestId,owner,foreignOrg)).toEqual({requestId,status:'unresolved'});
    expect(await settle(requestId,other)).toEqual({requestId,status:'cancelled'});
    expect(await receipt(requestId)).toMatchObject({status:'committed'});
  });
  it.each(['revoked','archived','replaced'] as const)('withholds locations after %s and never reconnects by replay',async fault=>{
    const invitation=await issue(),requestId=randomUUID(),request={action:'claim' as const,requestId,token:invitation.token};await call(request);
    if(fault==='revoked')await db.query("update clinical_core.patient_connections set state='revoked',revoked_at=clock_timestamp() where id=$1",[invitation.connectionId]);
    if(fault==='archived')await db.query("update clinical_core.patient_records set status='archived' where id=$1",[patient]);
    if(fault==='replaced')await db.query('update clinical_core.patient_connections set consumer_person_id=$1 where id=$2',[other,invitation.connectionId]);
    for(const result of [await receipt(requestId),await settle(requestId),await call(request)])expect(result).toEqual({requestId,status:'withheld'});
  });
  it('a paused accessible link returns only the historical successful command, not a fresh verified state',async()=>{
    const invitation=await issue(),requestId=randomUUID(),result=await call({action:'claim',requestId,token:invitation.token});
    await db.query("update clinical_core.patient_connections set state='paused',paused_at=clock_timestamp(),version=version+1 where id=$1",[invitation.connectionId]);
    expect(await receipt(requestId)).toEqual(result);
    expect((await db.query('select state,version from clinical_core.patient_connections where id=$1',[invitation.connectionId])).rows[0]).toEqual({state:'paused',version:3});
  });
  it('allows receipt and permanent settlement during account deletion but refuses a new claim',async()=>{
    const invitation=await issue(),requestId=randomUUID();
    await db.query("insert into clinical_private.owned_privacy_requests(owner_id,request_id,kind,status) values($1,$2,'deletion','submitted')",[owner,randomUUID()]);
    expect(await receipt(requestId)).toEqual({requestId,status:'unresolved'});
    await expect(call({action:'claim',requestId,token:invitation.token})).rejects.toThrow('account_deletion_write_blocked');
    expect(await settle(requestId)).toEqual({requestId,status:'cancelled'});
  });
  it('rolls back both the connection and receipt if response correlation fails',async()=>{
    const invitation=await issue(),requestId=randomUUID();
    const corrupt:ClinicalCoreDatabase={transaction:work=>bound.transaction(tx=>work({query:async<R extends Record<string,unknown>>(sql:string,args:readonly unknown[]=[])=>{
      const result=await tx.query<R>(sql,args);if(sql.includes('production_care_claim_request'))return {rows:[{data:{requestId:randomUUID(),status:'committed'}} as unknown as R]};return result;
    }}))};
    await expect(createCareClaimRecovery(corrupt)(context(),{action:'claim',requestId,token:invitation.token})).rejects.toThrow('service_unavailable');
    expect(await receipt(requestId)).toEqual({requestId,status:'unresolved'});
    expect((await db.query<{state:string}>('select state from clinical_core.patient_connections where id=$1',[invitation.connectionId])).rows[0].state).toBe('invitation_pending');
  });
  it.each([null,[],{}, {action:null},{action:'settle'}, {action:'settle',requestId:null}, {action:'settle',requestId:1},
    {action:'settle',requestId:'bad'}, {action:'settle',requestId:'00000000-0000-0000-0000-000000000000'}, {action:'settle',requestId:randomUUID(),token:'ABCDEFGHIJKLM'},
    {action:'receipt',requestId:randomUUID(),ownerId:randomUUID()}, {action:'claim',requestId:randomUUID()},
    {action:'claim',requestId:randomUUID(),token:null},{action:'claim',requestId:randomUUID(),token:4},
    {action:'claim',requestId:randomUUID(),token:'A'.repeat(25)}, {action:'claim',requestId:randomUUID(),token:'0'.repeat(13)},
  ].map(request=>[request]))('refuses malformed SQL independently of client validation: %j',async request=>{
    await expect(raw(request)).rejects.toThrow('request_invalid');
  });
  it('refuses unsigned context, inactive identities, wrong pool and wrong purpose',async()=>{
    await expect(database.transaction(tx=>tx.query('select clinical_core.production_care_claim_request($1::jsonb)',[JSON.stringify({action:'settle',requestId:randomUUID()})]))).rejects.toThrow('identity_refused');
    for(const c of [context(staff,org,'workforce'),context(owner,org,'consumer','consent_management'),{...context(),productionBound:false} as unknown as ProductionClinicalRequestContext])
      await expect(createCareClaimRecovery(bound)(c,{action:'settle',requestId:randomUUID()})).rejects.toThrow('identity_refused');
    await db.query("update clinical_core.identities set status='disabled' where person_id=$1",[owner]);
    await expect(settle(randomUUID())).rejects.toThrow('identity_refused');
  });
  it('makes decisions and receipt audit append-only even under administrative writes',async()=>{
    const requestId=randomUUID();await settle(requestId);
    for(const table of ['clinical_core.care_claim_requests','clinical_audit.care_claim_events']){
      await expect(db.query(`delete from ${table} where request_id=$1`,[requestId])).rejects.toThrow('append_only_record');
      await expect(db.query(`update ${table} set request_id=$1 where request_id=$2`,[randomUUID(),requestId])).rejects.toThrow('append_only_record');
    }
  });
  it.each([
    ['alter function clinical_private.care_claim_result(uuid,uuid,uuid) stable','alter function clinical_private.care_claim_result(uuid,uuid,uuid) volatile'],
    ['alter function clinical_core.production_care_claim_request(jsonb) security invoker','alter function clinical_core.production_care_claim_request(jsonb) security definer'],
    ['grant execute on function clinical_core.production_care_claim_request(jsonb) to public','revoke execute on function clinical_core.production_care_claim_request(jsonb) from public'],
    ['grant execute on function clinical_private.care_claim_result(uuid,uuid,uuid) to clinical_core_api','revoke execute on function clinical_private.care_claim_result(uuid,uuid,uuid) from clinical_core_api'],
    ['grant select on clinical_core.care_claim_requests to clinical_core_api','revoke select on clinical_core.care_claim_requests from clinical_core_api'],
    ['grant select(token_sha256) on clinical_core.care_claim_requests to public','revoke select(token_sha256) on clinical_core.care_claim_requests from public'],
    ['alter table clinical_core.care_claim_requests no force row level security','alter table clinical_core.care_claim_requests force row level security'],
    ['alter table clinical_audit.care_claim_events disable row level security','alter table clinical_audit.care_claim_events enable row level security'],
    ['grant truncate on clinical_audit.care_claim_events to public','revoke truncate on clinical_audit.care_claim_events from public'],
    ['alter table clinical_audit.care_claim_events disable trigger care_claim_events_immutable','alter table clinical_audit.care_claim_events enable trigger care_claim_events_immutable'],
    ['alter function clinical_private.care_connection_actor(text,text) volatile','alter function clinical_private.care_connection_actor(text,text) stable'],
  ])('refuses deployed metadata drift before writing: %s',async(change,restore)=>{
    await db.exec(change);try{await expect(settle(randomUUID())).rejects.toThrow('service_unavailable');}finally{await db.exec(restore);}
    expect(await settle(randomUUID())).toMatchObject({status:'cancelled'});
  });
  it('pins function bytes and rejects added overloads',async()=>{
    const signature='clinical_core.production_care_claim_request(jsonb)';
    const definition=(await db.query<{d:string}>('select pg_get_functiondef($1::regprocedure) d',[signature])).rows[0].d;
    await db.exec(`create or replace function clinical_core.production_care_claim_request(_request jsonb) returns jsonb language plpgsql security definer set search_path='' as $$begin return '{}'::jsonb;end$$`);
    try{await expect(settle(randomUUID())).rejects.toThrow('service_unavailable');}finally{await db.exec(definition);}
    await db.exec(`create function clinical_private.care_claim_result(integer) returns jsonb language plpgsql security definer set search_path='' as $$begin return '{}'::jsonb;end$$`);
    try{await expect(settle(randomUUID())).rejects.toThrow('service_unavailable');}finally{await db.exec('drop function clinical_private.care_claim_result(integer)');}
  });
  it('denies direct API reads, helper execution and writes',async()=>{
    for(const sql of ['select * from clinical_core.care_claim_requests','select * from clinical_audit.care_claim_events',
      'select clinical_private.care_claim_result(null,null,null)','truncate clinical_core.care_claim_requests'])
      await expect(database.transaction(tx=>tx.query(sql))).rejects.toThrow('permission denied');
  });
  it('validates immutable source pins and strict action-correlated receipts',()=>{
    for(const invalid of [[],[pins[0],pins[0]],[{...pins[0],bodySha256:'wrong'},pins[1]],[pins[0],{...pins[1],apiExecute:false}]])
      expect(()=>validateCareClaimFunctions(invalid)).toThrow('care_claim_binding_invalid');
    const request={action:'settle' as const,requestId:randomUUID()};
    expect(()=>parseCareClaimResponse(request,{requestId:request.requestId,status:'unresolved'})).toThrow();
    expect(()=>parseCareClaimResponse(request,{requestId:randomUUID(),status:'cancelled'})).toThrow();
    expect(()=>parseCareClaimResponse(request,{requestId:request.requestId,status:'cancelled',patientRecordId:patient})).toThrow();
    expect(careClaimRequest.safeParse({...request,organizationId:org}).success).toBe(false);
  });
});
