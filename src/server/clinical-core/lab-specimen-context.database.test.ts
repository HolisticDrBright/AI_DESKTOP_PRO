import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {labSpecimenTransferSchema,specimenContent,type LabSpecimenTransfer} from '../../contracts/labSpecimenTransfer';
import {createAwsSyntheticClinicalStateAdapter} from './aws-clinical-state';
import {ClinicalCoreDatabaseRejection,type ClinicalCoreDatabase} from './database';
import type {SyntheticRequestContext} from './aws-identity-consent';

const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const org=id(1),otherOrg=id(2),owner=id(3),other=id(4),clinician=id(5),patient=id(6),connection=id(7),provider=id(8),event=id(9);
let db:PGlite,serial=100;
const content=():LabSpecimenTransfer=>({version:'lab-specimen-context/1',connectionId:connection,labEventId:event,
  labPayloadSha256:'a'.repeat(64),requestId:id(++serial),expectedRevision:0,consentVersion:1,reproductiveConsentVersion:null,
  context:{source:'patient_reported',verification:'unverified',recordedAt:'2026-01-03T00:00:00.000Z',observedOn:'2026-01-02',
    ageAtDraw:{value:35,unit:'years'},sex:'female',assayId:null,pregnancyStatus:null,cyclePhase:null,
    reproductiveStage:null,contraception:null,pregnancyTrimester:null}});
async function asActor<T>(actor:string,organization:string,pool:'consumer'|'workforce',purpose:string,work:(tx:Parameters<Parameters<PGlite['transaction']>[0]>[0])=>Promise<T>){
  return db.transaction(async tx=>{
    await tx.exec('set local role clinical_core_api');
    await tx.query("select clinical_private.set_request_context($1,$2,$3,$4,$5,'synthetic-staging','synthetic_only')",
      [actor,organization,pool,'subject-'+actor,purpose]);
    return work(tx);
  });
}
const send=(p:LabSpecimenTransfer,actor=owner,organization=org)=>asActor(actor,organization,'consumer','clinical_data',
  tx=>tx.query("select * from clinical_core.record_lab_specimen_context($1)",[specimenContent(p)]));
beforeAll(async()=>{
  db=new PGlite({extensions:{pgcrypto}});
  for(const file of ['20260812010000_synthetic_identity_consent.sql','20260812220000_identity_function_column_qualification.sql',
    '20260821010000_governed_synthetic_lab_import.sql','20260821048000_reproductive_health_consent.sql',
    '20260916080000_synthetic_lab_specimen_context.sql']){
    try{await db.exec(readFileSync('infra/aws-clinical-core/migrations/'+file,'utf8'));}
    catch(cause){throw new Error(file+': '+(cause instanceof Error?cause.message:'migration_failed'));}
  }
  await db.query("insert into clinical_core.organizations(id,synthetic_label) values($1,'Fictional A'),($2,'Fictional B')",[org,otherOrg]);
  for(const [person,pool] of [[owner,'consumer'],[other,'consumer'],[clinician,'workforce']]){
    await db.query("insert into clinical_core.persons(id,synthetic_subject_key) values($1,$2)",[person,'syn_'+person.replaceAll('-','')]);
    await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,synthetic_attested) values($1,$2,$3,true)",[person,pool,'subject-'+person]);
  }
  await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner')",[org,clinician]);
  await db.query("insert into clinical_core.patient_records(id,organization_id,synthetic_record_key) values($1,$2,'patient_syn_context_01')",[patient,org]);
  await db.query("insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at) values($1,$2,$3,$4,'verified',now())",[connection,org,patient,owner]);
  await db.query(`insert into clinical_core.sync_providers(id,organization_id,stable_id,contract_version,lab_contract_version,adapter_version,state,reviewed_by_person_id,reviewed_at,
    specimen_context_contract,specimen_context_reviewed_by,specimen_context_reviewed_at)
    values($1,$2,'alp_patient_sync','patient-sync/1','lab-result/1','test','active',$3,now(),'lab-specimen-context/1',$3,now())`,[provider,org,clinician]);
  await db.query(`insert into clinical_core.lab_import_events(id,organization_id,patient_record_id,connection_id,provider_id,provider_event_id,
    external_panel_id,external_marker_id,resource_version,panel_name,marker_name,value_numeric,collected_at,occurred_at,payload_sha256)
    values($1,$2,$3,$4,$5,'lab:test:context','panel_01','marker_01','1','Fictional panel','Fictional marker',1,'2026-01-02',now(),$6)`,
    [event,org,patient,connection,provider,'a'.repeat(64)]);
  for(const [scope,version,artifact] of [['lab_results_import','test/1',id(10)],['lab_specimen_context','lab-specimen-context-consent/1',id(11)],['reproductive_health','test/1',id(12)]]){
    await db.query(`insert into clinical_core.consent_artifacts(id,organization_id,scope,artifact_version,content_sha256,jurisdiction,status,approved_at,approved_by_person_id)
      values($1,$2,$3,$4,$5,'US-SYNTHETIC','approved',now(),$6)`,[artifact,org,scope,version,'b'.repeat(64),clinician]);
    await asActor(owner,org,'consumer','consent_management',tx=>tx.query(
      "select * from clinical_core.record_consent_grant($1,$2,$3,'patient_app','self')",[connection,artifact,scope]));
  }
},30000);
afterAll(async()=>{await db?.close();});

describe('specimen context SQL against in-memory PostgreSQL (not hosted Aurora)',()=>{
  it('keeps the production overlay identical apart from the authenticated boundary',()=>{
    const source=readFileSync('infra/aws-clinical-core/migrations/20260916080000_synthetic_lab_specimen_context.sql','utf8');
    expect(readFileSync('infra/aws-clinical-core/production-migrations/20260916080000_production_lab_specimen_context.sql','utf8'))
      .toBe(source.replaceAll('assert_synthetic_context','assert_production_context'));
  });
  it('inserts exact context and gives an idempotent hash-bound receipt',async()=>{
    const p=content(),r=(await send(p)).rows[0] as Record<string,unknown>;
    expect(r).toMatchObject({lab_event_id:event,request_id:p.requestId,revision:1,duplicate:false,
      payload_sha256:createHash('sha256').update(specimenContent(p)).digest('hex')});
    expect((await send(p)).rows[0]).toMatchObject({...r,duplicate:true});
    await expect(send({...p,context:{...p.context,assayId:'changed'}})).rejects.toThrow('specimen_context_conflict');
  });
  it('rejects stale revision and supports explicit successor without mutating history',async()=>{
    await expect(send(content())).rejects.toThrow('specimen_context_conflict');
    expect((await send({...content(),expectedRevision:1})).rows[0]).toMatchObject({revision:2});
    await expect(db.exec("update clinical_core.lab_specimen_context_versions set context='{}'")).rejects.toThrow();
    expect((await db.query("select count(*)::int as n from clinical_core.lab_specimen_context_versions")).rows).toEqual([{n:2}]);
  });
  it('denies different patients and organizations for writes and row-level reads',async()=>{
    await expect(send(content(),other)).rejects.toThrow('specimen_context_refused');
    await expect(send(content(),owner,otherOrg)).rejects.toThrow();
    for(const [actor,organization] of [[other,org],[owner,otherOrg]]){
      expect((await asActor(actor,organization,'consumer','clinical_data',tx=>tx.query("select * from clinical_core.lab_specimen_context_versions"))).rows).toEqual([]);
    }
    expect((await asActor(clinician,org,'workforce','clinical_data',tx=>tx.query("select id from clinical_core.lab_specimen_context_versions"))).rows).toHaveLength(2);
  });
  it('denies direct insert permission even to the linked consumer',async()=>{
    await expect(asActor(owner,org,'consumer','clinical_data',tx=>tx.exec("insert into clinical_core.lab_specimen_context_versions default values"))).rejects.toThrow('permission denied');
  });
  it('requires matching imported result hash and collection date',async()=>{
    await expect(send({...content(),labPayloadSha256:'c'.repeat(64)})).rejects.toThrow('specimen_context_refused');
    await expect(send({...content(),context:{...content().context,observedOn:'2026-01-01'}})).rejects.toThrow('specimen_context_refused');
  });
  it('enforces reproductive scope independently and never accepts client approval markings',async()=>{
    const p={...content(),expectedRevision:2,reproductiveConsentVersion:1,context:{...content().context,cyclePhase:'luteal' as const}};
    expect((await send(p)).rows[0]).toMatchObject({revision:3});
    await expect(send({...p,requestId:id(++serial),reproductiveConsentVersion:2})).rejects.toThrow('specimen_consent_required');
    expect(labSpecimenTransferSchema.safeParse({...p,context:{...p.context,verification:'verified'}}).success).toBe(false);
    // Bypass TypeScript to exercise database-side strictness too.
    for(const ctx of [{...p.context,dateOfBirth:'1990-01-01'},{...p.context,verification:'verified'},{...p.context,pregnancyTrimester:1}]){
      await expect(asActor(owner,org,'consumer','clinical_data',tx=>tx.query(
        "select * from clinical_core.record_lab_specimen_context($1)",[JSON.stringify({...p,context:ctx})]))).rejects.toThrow('specimen_context_invalid');
    }
  });
  it('refuses capability suspension without affecting the ordinary lab provider contract',async()=>{
    await db.query("update clinical_core.sync_providers set specimen_context_contract=null,specimen_context_reviewed_by=null,specimen_context_reviewed_at=null where id=$1",[provider]);
    await expect(send({...content(),expectedRevision:3})).rejects.toThrow('specimen_provider_approval_required');
    await db.query("update clinical_core.sync_providers set specimen_context_contract='lab-specimen-context/1',specimen_context_reviewed_by=$2,specimen_context_reviewed_at=now() where id=$1",[provider,clinician]);
  });
  it('withdrawal and re-grant cannot revive an old command',async()=>{
    const p={...content(),expectedRevision:3};
    await asActor(owner,org,'consumer','consent_management',tx=>tx.query("select * from clinical_core.revoke_consent_grant($1,'lab_specimen_context','patient_request')",[connection]));
    await expect(send(p)).rejects.toThrow('specimen_consent_required');
    await asActor(owner,org,'consumer','consent_management',tx=>tx.query("select * from clinical_core.record_consent_grant($1,$2,'lab_specimen_context','patient_app','self')",[connection,id(11)]));
    await expect(send(p)).rejects.toThrow('specimen_consent_required');
    expect((await send({...p,consentVersion:3})).rows[0]).toMatchObject({revision:4});
  });
  it('round-trips the real application adapter through SQL and read RLS',async()=>{
    const database:ClinicalCoreDatabase={transaction:work=>db.transaction(async tx=>{
      await tx.exec('set local role clinical_core_api');
      return work({query:async<Row extends Record<string,unknown>>(sql:string,parameters:readonly unknown[]=[])=>{
        try{return await tx.query<Row>(sql,parameters.map(p=>p&&typeof p==='object'&&'kind' in p&&p.kind==='uuid'&&'value' in p?p.value:p));}
        catch{throw new ClinicalCoreDatabaseRejection('operation_refused');}
      }});
    })};
    const adapter=createAwsSyntheticClinicalStateAdapter(database);
    const context=(actor=owner,organization=org,pool:'consumer'|'workforce'='consumer'):SyntheticRequestContext=>({
      actorPersonId:actor,organizationId:organization,identityPool:pool,identitySubject:'subject-'+actor,
      purpose:'clinical_data',environment:'synthetic-staging',dataClassification:'synthetic_only',containsPhi:false,realPatientData:false});
    const p={...content(),consentVersion:3,expectedRevision:4};
    const receipt=await adapter.importLabSpecimenContext!(context(),p);
    expect(receipt).toMatchObject({version:'lab-specimen-receipt/1',labEventId:event,requestId:p.requestId,revision:5,duplicate:false});
    expect(await adapter.getLabSpecimenContext!(context(),event)).toMatchObject({version:'lab-specimen-record/1',
      labEventId:event,revision:5,context:p.context,labPayloadSha256:p.labPayloadSha256,payloadSha256:receipt.payloadSha256});
    expect(await adapter.getLabSpecimenContext!(context(other),event)).toBeNull();
    expect(await adapter.getLabSpecimenContext!(context(clinician,org,'workforce'),event)).toMatchObject({revision:5});
  });
});
