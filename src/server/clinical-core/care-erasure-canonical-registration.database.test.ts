import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import type {ClinicalCoreDatabase,ClinicalCoreTransaction} from './database';
import {applyClinicalCoreMigrations,loadClinicalCoreMigrations,type ClinicalCoreMigration} from './migrations';
import {applyGovernedCatalogMigrations,loadGovernedCatalogMigrations} from './catalog-migrations';
import {CARE_ERASURE_AWS,type CareErasureUpgradeConfiguration} from './care-erasure-schema-upgrade';
import {inspectCanonicalCareErasure} from './care-erasure-canonical-registration';
let pg:PGlite,m:ClinicalCoreMigration[],reference:ClinicalCoreMigration[];
const config:CareErasureUpgradeConfiguration={account:CARE_ERASURE_AWS.account,region:CARE_ERASURE_AWS.region,
 clusterArn:CARE_ERASURE_AWS.clusterArn,secretArn:CARE_ERASURE_AWS.secretArn,databaseName:'clinical_core',
 phiAllowed:false,environment:'synthetic-staging',dataClassification:'synthetic_only'};
const queries:string[]=[];
const db:ClinicalCoreDatabase={transaction:work=>pg.transaction(async tx=>work({query:async(sql:string,p:readonly unknown[]=[])=>{
 queries.push(sql);if(sql==='select current_database() as name')return {rows:[{name:'clinical_core'}]};
 return tx.query(sql,[...p]);
}} as ClinicalCoreTransaction))};
beforeAll(async()=>{
 pg=new PGlite({extensions:{pgcrypto}});m=loadClinicalCoreMigrations();reference=loadGovernedCatalogMigrations();
 await applyClinicalCoreMigrations(db,m);await applyGovernedCatalogMigrations(db,reference);
 const alias=m.find(x=>x.version==='20260821049700')!;
 await pg.query("insert into clinical_core.schema_migrations(version,name,sha256) values('20260902230000',$1,$2)",[alias.name,alias.sha256]);
 await pg.query("insert into clinical_core.organizations(synthetic_label) values('Fictional canonical registration clinic')");
 queries.length=0;
},60000);
afterAll(async()=>pg?.close());
describe('actual canonical47 SQL with preserved alias and already-applied inspection',()=>{
 it('inspects current successor twice without replay, ledger rewrite, or new authority',async()=>{
  queries.length=0;const before=await inspectCanonicalCareErasure(db,m,reference,config);
  const after=await inspectCanonicalCareErasure(db,m,reference,config);expect(after).toEqual(before);
  expect(before).toMatchObject({canonicalRegistered:true,alreadyApplied:true,sourceMigrationCount:47,liveMigrationCount:48,
   schemaReplayPerformed:false,ledgerRewritePerformed:false,erasureAccepted:false,releaseAccepted:false,phiAllowed:false,
   referenceMigrationCount:3,historicalReferenceCount:2,
   catalogInspection:{canonicalRegistered:false,applied:false,alreadyApplied:true,tableCount:89,referenceMigrationCount:3}});
  expect(queries.filter(sql=>sql.startsWith('set transaction'))).toHaveLength(2);
  expect(queries.some(sql=>/^(?:create|alter|insert|update|delete|drop|truncate|lock)\b/i.test(sql))).toBe(false);
  expect((await pg.query<{n:number}>('select count(*)::int n from clinical_core.schema_migrations')).rows[0].n).toBe(48);
 });
 it('canonical migration replay recognizes terminal receipt without reapplying its SQL',async()=>{
  queries.length=0;const result=await applyClinicalCoreMigrations(db,m);
  expect(result.applied).toEqual([]);expect(result.alreadyApplied).toHaveLength(47);
  expect(queries.some(sql=>sql.includes('rename to care_data_erasure_request_v1_terminal'))).toBe(false);
  expect((await pg.query<{n:number}>('select count(*)::int n from clinical_core.schema_migrations')).rows[0].n).toBe(48);
 });
 it('refuses missing or rewritten source before a transaction begins',async()=>{
  let opened=false;const never:ClinicalCoreDatabase={transaction:async()=>{opened=true;throw Error('unexpected');}};
  for(const changed of [m.slice(0,46),[...m].reverse(),m.map((x,i)=>i===46?{...x,name:'changed'}:x),
   m.map((x,i)=>i===46?{...x,sql:x.sql+'-- changed\n'}:x)])
   await expect(inspectCanonicalCareErasure(never,changed,reference,config)).rejects.toThrow('artifact_refused');
  for(const changed of [reference.slice(0,1),reference.slice(0,2),[...reference,reference[2]],[...reference].reverse(),reference.map((x,i)=>i?x:{...x,sql:x.sql+'-- changed\n'}),
   reference.map((x,i)=>i?x:{...x,sql:x.sql.replace(/\n/g,'\r\n')})])
   await expect(inspectCanonicalCareErasure(never,m,changed,config)).rejects.toThrow('artifact_refused');
  expect(opened).toBe(false);
 });
 it('missing actual catalog receipt is refused read-only rather than silently migrated',async()=>{
  const row=(await pg.query<{version:string;name:string;sha256:string}>('select version,name,sha256 from clinical_reference.schema_migrations where version=$1',[reference[2].version])).rows[0];
  await pg.query('delete from clinical_reference.schema_migrations where version=$1',[reference[2].version]);queries.length=0;
  try{
   await expect(inspectCanonicalCareErasure(db,m,reference,config)).rejects.toMatchObject({category:expect.stringMatching(/^(policy|history)_refused$/)});
   expect(queries.some(sql=>/^(?:create|alter|insert|update|delete|drop|truncate)\b/i.test(sql))).toBe(false);
  }finally{await pg.query('insert into clinical_reference.schema_migrations(version,name,sha256) values($1,$2,$3)',[row.version,row.name,row.sha256]);}
 });
 it('captures admitted source and configuration before a caller can alter them during SQL inspection',async()=>{
  const source=m.map(x=>({...x})),catalog=reference.map(x=>({...x})),configuration={...config};let opened=0;
  const mutating:ClinicalCoreDatabase={transaction:work=>{
   opened++;source[0].sql='drop schema clinical_core cascade;';catalog[2].name='changed';Object.assign(configuration,{phiAllowed:true});
   return db.transaction(work);
  }};
  const result=await inspectCanonicalCareErasure(mutating,source,catalog,configuration);
  expect(opened).toBe(1);expect(result.referenceMigrationCount).toBe(3);expect(result.phiAllowed).toBe(false);
  expect(result.catalogInspection.applied).toBe(false);
 });
 it('refuses actual missing successor or rewritten alias instead of applying or repairing history',async()=>{
  for(const version of ['20261007010000','20260902230000']){
   const row=(await pg.query<{version:string;name:string;sha256:string}>('select version,name,sha256 from clinical_core.schema_migrations where version=$1',[version])).rows[0];
   await pg.query('delete from clinical_core.schema_migrations where version=$1',[version]);
   // Missing terminal + present successor table is also an inventory mismatch;
   // either refusal must happen read-only, never by applying/repairing SQL.
   queries.length=0;
   try{await expect(inspectCanonicalCareErasure(db,m,reference,config)).rejects.toMatchObject({category:expect.stringMatching(/^(history|inventory)_refused$/)});
    expect(queries.some(sql=>/^(?:create|alter|insert|update|delete|drop|truncate)\b/i.test(sql))).toBe(false);}
   finally{await pg.query('insert into clinical_core.schema_migrations(version,name,sha256) values($1,$2,$3)',[row.version,row.name,row.sha256]);}
  }
 });
 it('keeps qualification/production/PHI boundaries refused',async()=>{
  for(const patch of [{account:'173535830222'},{databaseName:'clinical_core_qualification'},{phiAllowed:true}])
   await expect(inspectCanonicalCareErasure(db,m,reference,{...config,...patch} as CareErasureUpgradeConfiguration)).rejects.toThrow('boundary_refused');
 });
});
