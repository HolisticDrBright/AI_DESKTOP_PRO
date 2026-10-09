import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createOwnedConsumerRecordsAdapter,OwnedStorageError} from './owned-consumer-records';
import type {ClinicalCoreDatabase} from './database';
import type {ProductionClinicalRequestContext} from './aws-identity-consent';

// Executable production SQL with fictional in-memory rows: not hosted Aurora
// and not a physical device pair.
const owner=randomUUID(),other=randomUUID(),org=randomUUID();let db:PGlite;
const observation=(id:string)=>({id,panelId:'10000000-0000-4000-8000-000000000001',markerId:randomUUID(),panelName:'Fictional panel',name:'Ferritin',value:12,unit:null,drawnAt:'2026-01-01T00:00:00.000Z',reportedRange:null,sourceStatus:'consumer_import_unverified'});
async function actor<T=Record<string,unknown>>(sql:string,params:unknown[]=[],who=owner,purpose='clinical_data'){
  return db.transaction(async tx=>{await tx.exec('set local role clinical_core_api');
    await tx.query("select clinical_private.set_request_context($1,$2,'consumer',$3,$4,'production-clinical','clinical_phi')",[who,org,'subject-'+who,purpose]);
    return tx.query<T>(sql,params);});
}
const write=(recordId:string,payload:unknown,revision:number,deleted=false)=>actor(
  "select clinical_core.write_owned_consumer_record('lab_observations',$1,$2,$3,$4::jsonb,$5,1) as result",[recordId,revision,randomUUID(),JSON.stringify(payload),deleted]);
const tombstones=async(who=owner,limit=10,after?:{receivedAt:string;recordId:string})=>
  ((await actor<{result:{recordId:string;revision:number;deleted:boolean;receivedAt:string}[]}>(
    'select clinical_core.list_owned_consumer_tombstones($1,$2::integer,$3::timestamptz,$4::uuid) as result',['lab_observations',limit,after?.receivedAt??null,after?.recordId??null],who)).rows[0]).result;
const context:ProductionClinicalRequestContext={actorPersonId:owner,organizationId:org,identitySubject:'subject-'+owner,identityPool:'consumer',
  purpose:'clinical_data',environment:'production-clinical',dataClassification:'clinical_phi',containsPhi:true,realPatientData:true,productionBound:true};
const database:ClinicalCoreDatabase={transaction:work=>db.transaction(async tx=>{
  await tx.exec('set local role clinical_core_api');
  return work({query:async<Row extends Record<string,unknown>>(sql:string,parameters:readonly unknown[]=[])=>
    tx.query<Row>(sql,parameters.map(p=>p&&typeof p==='object'&&'kind' in p&&p.kind==='uuid'&&'value' in p?p.value:p))});
})};
const kept=randomUUID(),removed=randomUUID(),removedLater=randomUUID();
beforeAll(async()=>{
  const {manifest,files}=JSON.parse(execFileSync(process.execPath,['scripts/build-aws-production-clinical-core.mjs','--json'],{encoding:'utf8',maxBuffer:8*1024*1024,timeout:10000}));
  db=new PGlite({extensions:{pgcrypto}});for(const m of manifest.migrations)await db.exec(files[m.file]);
  await db.query("insert into clinical_core.organizations(id,organization_label) values($1,'Fictional tombstone test')",[org]);
  for(const who of [owner,other]){
    await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)',[who,'subject_'+who.replaceAll('-','')]);
    await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'consumer',$2,true)",[who,'subject-'+who]);
  }
  await db.exec("insert into clinical_private.consumer_storage_consent_releases(scope,version,content,content_sha256,approved_by,approved_at) values('lab_history','fictional-lab','Fictional only',encode(public.digest('Fictional only','sha256'),'hex'),'TEST NOT APPROVAL',now())");
  await actor("select clinical_core.set_owned_consumer_consent('lab_history','granted','fictional-lab',0)",[],owner,'consent_management');
  for(const id of [kept,removed,removedLater])await write(id,observation(id),0);
  await write(removed,{},1,true);
},30000);
afterAll(async()=>{await db?.close();});

describe('owned record tombstone listing',()=>{
  it('returns only latest-version tombstones without payload while live listing keeps hiding them',async()=>{
    const live=(await actor<{result:{recordId:string}[]}>("select clinical_core.list_owned_consumer_records('lab_observations',10) as result")).rows[0].result;
    expect(live.map(r=>r.recordId).sort()).toEqual([kept,removedLater].sort());
    const rows=await tombstones();
    expect(rows).toEqual([{recordId:removed,revision:2,deleted:true,receivedAt:expect.any(String)}]);
    expect(JSON.stringify(rows)).not.toContain('Ferritin');
  });
  it('orders and paginates by receipt, and a later deletion appears after the cursor',async()=>{
    await write(removedLater,{},1,true);
    const all=await tombstones(owner,10);
    expect(all.map(r=>r.recordId)).toEqual([removed,removedLater]);
    const first=await tombstones(owner,1);expect(first).toHaveLength(1);expect(first[0].recordId).toBe(removed);
    const rest=await tombstones(owner,10,{receivedAt:first[0].receivedAt,recordId:first[0].recordId});
    expect(rest.map(r=>r.recordId)).toEqual([removedLater]);
    expect(await tombstones(owner,10,{receivedAt:rest[0].receivedAt,recordId:rest[0].recordId})).toEqual([]);
  });
  it('keeps owner isolation, consent, purpose and bounds like live listing',async()=>{
    await expect(tombstones(other)).rejects.toThrow(/consumer_storage_consent_required/);
    await actor("select clinical_core.set_owned_consumer_consent('lab_history','granted','fictional-lab',0)",[],other,'consent_management');
    expect(await tombstones(other)).toEqual([]);
    await expect(actor("select clinical_core.list_owned_consumer_tombstones('lab_observations',10) as result",[],owner,'consent_management')).rejects.toThrow(/owned_record_request_invalid/);
    await expect(tombstones(owner,0)).rejects.toThrow(/owned_record_request_invalid/);
    await expect(actor('select clinical_core.list_owned_consumer_tombstones($1,10,$2::timestamptz,null) as result',['lab_observations','2026-01-01T00:00:00Z'])).rejects.toThrow(/owned_record_request_invalid/);
  });
  it('is parsed strictly by the adapter and records a listing audit event',async()=>{
    const adapter=createOwnedConsumerRecordsAdapter(database);
    const rows=await adapter.listTombstones(context,{collection:'lab_observations',limit:5});
    expect(rows.map(r=>({recordId:r.recordId,revision:r.revision,deleted:r.deleted}))).toEqual([{recordId:removed,revision:2,deleted:true},{recordId:removedLater,revision:2,deleted:true}]);
    await expect(adapter.listTombstones(context,{collection:'lab_observations',limit:101})).rejects.toBeInstanceOf(OwnedStorageError);
    await expect(adapter.listTombstones({...context,actorPersonId:other},{collection:'lab_observations',limit:5})).rejects.toBeInstanceOf(OwnedStorageError);
    const audit=await db.query<{n:number}>("select count(*)::int as n from clinical_audit.consumer_storage_events where owner_id=$1 and action='records.listed' and collection='lab_observations'",[owner]);
    expect(audit.rows[0].n).toBeGreaterThanOrEqual(5);
  });
});
