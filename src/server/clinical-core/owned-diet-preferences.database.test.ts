import {beforeAll,afterAll,it,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {DIET_PREFERENCES_ID as id,dietPreferencesSchema} from '@/contracts/personalDietPreferences';
import {validateOwnedPayload} from './owned-lab-observations';
const owner=randomUUID(),other=randomUUID(),org=randomUUID();let db:PGlite;
const payload={id,version:'personal-diet-preferences/1',activeDiets:['LOW_FODMAP'],allergies:'Fictional tree nut entry',notes:'Fictional preference',
  updatedAt:'2026-01-01T00:00:00.000Z',sourceStatus:'patient_reported_not_prescribed'};
async function actor(sql:string,params:unknown[]=[],who=owner,purpose='clinical_data'){
  return db.transaction(async tx=>{await tx.exec('set local role clinical_core_api');
    await tx.query("select clinical_private.set_request_context($1,$2,'consumer',$3,$4,'production-clinical','clinical_phi')",[who,org,'subject-'+who,purpose]);
    return tx.query(sql,params);});
}
const write=(p:unknown,revision=0,request=randomUUID(),recordId=id,deleted=false)=>actor(
  "select clinical_core.write_owned_consumer_record('diet_preferences',$1,$2,$3,$4::jsonb,$5,1) as result",[recordId,revision,request,JSON.stringify(p),deleted]);
beforeAll(async()=>{
  const {manifest,files}=JSON.parse(execFileSync(process.execPath,['scripts/build-aws-production-clinical-core.mjs','--json'],{encoding:'utf8',maxBuffer:8*1024*1024,timeout:10000}));
  db=new PGlite({extensions:{pgcrypto}});for(const m of manifest.migrations)await db.exec(files[m.file]);
  await db.query("insert into clinical_core.organizations(id,organization_label) values($1,'Fictional diet test')",[org]);
  for(const who of [owner,other]){
    await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)',[who,'subject_'+who.replaceAll('-','')]);
    await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'consumer',$2,true)",[who,'subject-'+who]);
  }
  await db.exec("insert into clinical_private.consumer_storage_consent_releases(scope,version,content,content_sha256,approved_by,approved_at) values('nutrition','fictional-diet','Fictional only',encode(public.digest('Fictional only','sha256'),'hex'),'TEST NOT APPROVAL',now())");
  for(const who of [owner,other])await actor("select clinical_core.set_owned_consumer_consent('nutrition','granted','fictional-diet',0)",[],who,'consent_management');
},30000);
afterAll(async()=>{await db?.close();});
it('stores an owner singleton with exact replay, conflict protection, audit and isolated reads',async()=>{
  validateOwnedPayload('diet_preferences',payload);const command=randomUUID();
  expect((await write(payload,0,command)).rows[0]).toMatchObject({result:{recordId:id,revision:1,duplicate:false}});
  expect((await write(payload,0,command)).rows[0]).toMatchObject({result:{revision:1,duplicate:true}});
  await expect(write({...payload,notes:'Changed'},0)).rejects.toThrow('revision_conflict');
  const rows=await actor("select clinical_core.list_owned_consumer_records('diet_preferences',10) as result");
  expect(rows.rows[0]).toMatchObject({result:[{recordId:id,payload}]});
  expect((await actor("select clinical_core.list_owned_consumer_records('diet_preferences',10) as result",[],other)).rows[0]).toEqual({result:[]});
  expect((await db.query<{count:number}>("select count(*)::integer as count from clinical_audit.consumer_storage_events where owner_id=$1 and collection='diet_preferences' and action='record.written'",[owner])).rows[0].count).toBe(1);
});
it('SQL refuses invalid payloads even when the application validator is bypassed',async()=>{
  for(const bad of [{...payload,ownerId:owner},{...payload,activeDiets:['KETO','KETO']},{...payload,activeDiets:[null]},
    {...payload,activeDiets:'KETO'},{...payload,activeDiets:['UNKNOWN']},{...payload,allergies:null},
    {...payload,notes:'x'.repeat(2001)},{...payload,sourceStatus:'prescribed'},
    {...payload,updatedAt:'infinity'},{...payload,updatedAt:'9999-01-01T00:00:00Z'},{...payload,id:randomUUID()}]){
    await expect(write(bad,1)).rejects.toThrow('owned_diet_preferences_invalid');
    expect(()=>validateOwnedPayload('diet_preferences',bad)).toThrow();
  }
  await expect(write(payload,0,randomUUID(),randomUUID())).rejects.toThrow('owned_diet_preferences_invalid');
  expect(dietPreferencesSchema.safeParse({...payload,dose:'made up'}).success).toBe(false);
});
it('includes the collection in owner privacy export and correction-target inventory',async()=>{
  const start=await actor('select clinical_core.start_owned_privacy_export($1) as result',[randomUUID()],owner,'consent_management');
  const exportId=(start.rows[0] as {result:{exportId:string}}).result.exportId;
  const page=await actor("select clinical_core.read_owned_privacy_export($1,'records',100,null) as result",[exportId],owner,'consent_management');
  expect(page.rows[0]).toMatchObject({result:{items:[{collection:'diet_preferences',recordId:id,payload}]}});
  const targets=await actor("select clinical_core.list_owned_correction_targets('diet_preferences',25,null) as result",[],owner,'consent_management');
  expect(targets.rows[0]).toMatchObject({result:[{collection:'diet_preferences',recordId:id}]});
  const hold=randomUUID();
  await db.query("insert into clinical_private.owned_legal_holds(id,owner_id,reason_code,placed_by) values($1,$2,'owner_dispute',$3)",[hold,owner,other]);
  try{await expect(write({},1,randomUUID(),id,true)).rejects.toThrow('legal_hold');}
  finally{await db.query('update clinical_private.owned_legal_holds set released_at=now(),released_by=$2 where id=$1',[hold,other]);}
});
it('withdrawal stops reads/writes and regrant permits a revision-bound logical removal',async()=>{
  await actor("select clinical_core.set_owned_consumer_consent('nutrition','revoked',null,1)",[],owner,'consent_management');
  await expect(write(payload,1)).rejects.toThrow('consent_required');
  await expect(actor("select clinical_core.list_owned_consumer_records('diet_preferences',10)")).rejects.toThrow('consent_required');
  await actor("select clinical_core.set_owned_consumer_consent('nutrition','granted','fictional-diet',2)",[],owner,'consent_management');
  await actor("select clinical_core.write_owned_consumer_record('diet_preferences',$1,1,$2,'{}'::jsonb,true,3)",[id,randomUUID()]);
  expect((await actor("select clinical_core.list_owned_consumer_records('diet_preferences',10) as result")).rows[0]).toEqual({result:[]});
  expect((await db.query<{count:number}>("select count(*)::integer as count from clinical_core.owned_consumer_record_versions where owner_id=$1 and collection='diet_preferences'",[owner])).rows[0].count).toBe(2);
});
