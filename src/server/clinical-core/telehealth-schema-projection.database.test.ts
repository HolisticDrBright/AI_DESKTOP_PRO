import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { applyProductionClinicalCoreMigrations } from './production-migrations';
import type { ClinicalCoreDatabase } from './database';
import { compileTelehealthSchemaSource, type TelehealthSchemaSource } from '../../../scripts/compile-telehealth-schema-source.mjs';
import { projectTelehealthSchema, TELEHEALTH_SCHEMA_NAMES } from '../../../scripts/telehealth-schema-projection.mjs';
import { assertTelehealthSchemaSource, inspectTelehealthSchema, type TelehealthSchemaInspectionConfiguration } from './telehealth-schema-inspection';

// Source metadata qualification only. Not a native preserving operator, provider
// release, an RDS test, an approval, or real PostgreSQL concurrent lock evidence.
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
type Artifact={manifest:{migrations:Array<{version:string;file:string}>};files:Record<string,string>};
let db:PGlite,source:TelehealthSchemaSource,artifact:Artifact;
async function projection(tx:Pick<PGlite,'query'>=db) {
  return projectTelehealthSchema(async(sql,args)=>tx.query<{name:string;digest:string}>(sql,[...args]));
}
async function add(index:number) {
  const row=artifact.manifest.migrations[index];
  await db.transaction(async tx=>{
    await tx.exec(artifact.files[row.file]);
    await tx.query('insert into clinical_core.schema_migrations(version,name,sha256) values($1,$2,$3)',
      [row.version,row.file.slice(15,-4),sha(artifact.files[row.file])]);
  });
}
beforeAll(async()=>{
  source=await compileTelehealthSchemaSource();
  artifact=JSON.parse(execFileSync(process.execPath,['scripts/build-zoom-host-authority-candidate.mjs','--json'],
    {encoding:'utf8',maxBuffer:16*1024*1024,timeout:60000,windowsHide:true}));
  db=new PGlite({extensions:{pgcrypto}});
  // Deliberately perturb OIDs in this independently built database. A projection
  // that accidentally hashes generated FK names or object OIDs would mismatch.
  await db.exec('create table public.unrelated_oid_fixture(id int primary key); create table public.unrelated_oid_child(id int references public.unrelated_oid_fixture)');
  const database:ClinicalCoreDatabase={transaction:work=>db.transaction(tx=>work({query:(sql,args=[])=>tx.query(sql,[...args])}))};
  const migrations=artifact.manifest.migrations.map(r=>({version:r.version,name:r.file.slice(15,-4),sql:artifact.files[r.file],sha256:sha(artifact.files[r.file])}));
  await applyProductionClinicalCoreMigrations(database,migrations.slice(0,106));
  await db.exec('set search_path=pg_catalog,public');
  for(let i=106;i<112;i++)await add(i);
},120000);
afterAll(async()=>{await db?.close();});

describe('trusted source schema metadata across the exact 112 113 and 114 assemblies',()=>{
  it('records a blocked non-deployment identity from the actual empty installer',()=>{
    expect(source.contract).toBe('telehealth-schema-source/1');
    expect(source.activation).toBe('blocked');expect(source.phiAllowed).toBe(false);expect(source.sourceOnly).toBe(true);
    expect(source.installerBundleSha256).toMatch(/^[a-f0-9]{64}$/);expect(source.projectionSqlSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(source.snapshots.map(s=>s.migrationCount)).toEqual([112,113,114]);
    expect(source.snapshots.map(s=>s.assemblySha256)).toEqual([
      '6cc191355442ae2c2349cab50466979eaab0e45961a4e1547f34785294dce4b9',
      'f940e0aacbf8a8899ea21fbb027f6132044608492baf1a9286502637b57d3ce2',
      '8e4fc72b54015f1f0b183fa308aeba8ff3db886e6e4c236fad88bf53f7820f3e']);
  });
  it('matches the independent 112 schema with unrelated OIDs',async()=>{
    expect(await projection()).toEqual(source.snapshots[0].projection);
    expect(sha(JSON.stringify(await projection()))).toBe(source.snapshots[0].schemaSha256);
    await expect(db.query("insert into clinical_core.schema_migrations(version,name,sha256) values('bad','bad','bad')")).rejects.toThrow();
  });
  it('matches the full 113 schema including admitted chart authority without seeding a key',async()=>{
    await add(112);expect(await projection()).toEqual(source.snapshots[1].projection);
    expect((await db.query<{n:number}>('select count(*)::int n from clinical_private.telehealth_admission_keys')).rows[0].n).toBe(0);
  });
  it('matches the complete 114 schema including new incoming FK triggers on historical tables',async()=>{
    await add(113);expect(await projection()).toEqual(source.snapshots[2].projection);
    const old=source.snapshots[1].projection.find(r=>r.name==='relation:clinical_core.appointments');
    const current=source.snapshots[2].projection.find(r=>r.name==='relation:clinical_core.appointments');
    expect(old?.digest).not.toBe(current?.digest);
  });

  const driftCases:Array<[string,string]>=[
    ['changed private table privileges','grant select on clinical_private.telehealth_admission_keys to clinical_core_api'],
    ['PUBLIC record privileges','grant select on clinical_core.patient_records to public'],
    ['column grants','grant select (first_name) on clinical_core.patient_records to clinical_core_api'],
    ['RLS disabled','alter table clinical_core.patient_records disable row level security'],
    ['forced RLS removed','alter table clinical_telehealth.zoom_host_releases no force row level security'],
    ['API role bypasses RLS','alter role clinical_core_api bypassrls'],
    ['API role can create roles','alter role clinical_core_api createrole'],
    ['API role can login','alter role clinical_core_api login'],
    ['role search path override',"alter role clinical_core_api set search_path='public'"],
    ['schema public create','grant create on schema clinical_private to public'],
    ['function public execute','grant execute on function clinical_private.block_update_delete() to public'],
    ['function privilege regrant','grant execute on function clinical_private.block_update_delete() to clinical_core_api with grant option'],
    ['default public table privileges','alter default privileges in schema clinical_private grant select on tables to public'],
    ['global default privileges','alter default privileges grant select on tables to public'],
    ['table owner replaced','alter table clinical_core.patient_records owner to clinical_core_api'],
    ['constraint dropped','alter table clinical_core.appointments drop constraint zoom_host_appointment_org_unique cascade'],
    ['ledger integrity removed','alter table clinical_core.schema_migrations drop constraint schema_migrations_sha256_check'],
    ['existing user triggers disabled','alter table clinical_core.appointments disable trigger user'],
    ['internal constraint triggers disabled','alter table clinical_core.appointments disable trigger all'],
    ['new policy bypass','create policy fictional_unsafe on clinical_private.telehealth_admission_keys for select to clinical_core_api using(true)'],
    ['extra private function','create function clinical_private.fictional_unsafe() returns int language sql as $$select 1$$'],
    ['extra function overload','create function clinical_private.block_update_delete(int) returns int language sql as $$select $1$$'],
    ['changed immutable function',"create or replace function clinical_private.block_update_delete() returns trigger language plpgsql as $$begin return new; end$$"],
    ['extra table','create table clinical_private.fictional_extra(id int)'],
    ['extra view','create view clinical_private.fictional_extra as select 1 id'],
    ['extra sequence','create sequence clinical_private.fictional_extra'],
    ['extra enum',"create type clinical_private.fictional_extra as enum ('unsafe')"],
    ['extra domain','create domain clinical_private.fictional_extra as int'],
    ['extra range','create type clinical_private.fictional_extra as range(subtype=int4)'],
    ['extra aggregate','create aggregate clinical_private.fictional_extra(integer)(sfunc=int4pl,stype=integer,initcond=0)'],
    ['extra collation','create collation clinical_private.fictional_extra from pg_catalog."C"'],
    ['extra application role','create role clinical_fictional_extra'],
    ['new membership set authority','create role fictional_member; grant clinical_core_api to fictional_member with set true, inherit false'],
    ['new membership inheritance','create role fictional_member; grant clinical_core_api to fictional_member with set false, inherit true'],
  ];
  it.each(driftCases)('detects %s without learning a new expected schema',async(_name,sql)=>{
    await expect(db.transaction(async tx=>{
      await tx.exec(sql);
      expect(await projection(tx)).not.toEqual(source.snapshots[2].projection);
      throw Error('FICTIONAL_ROLLBACK_METADATA_DRIFT');
    })).rejects.toThrow('FICTIONAL_ROLLBACK_METADATA_DRIFT');
    expect(await projection()).toEqual(source.snapshots[2].projection);
  },30000);
  it('reads metadata only, independent of fictional patient values and legal holds',async()=>{
    await expect(db.transaction(async tx=>{
      const org='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',person='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      await tx.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL SCHEMA TEST')",[org]);
      await tx.query("insert into clinical_core.persons(id,subject_key) values($1,'subject_fictional_metadata')",[person]);
      await tx.query("insert into clinical_private.owned_legal_holds(owner_id,reason_code,placed_by) values($1,'owner_dispute',$1)",[person]);
      expect(await projection(tx)).toEqual(source.snapshots[2].projection);
      throw Error('FICTIONAL_ROLLBACK_DATA');
    })).rejects.toThrow('FICTIONAL_ROLLBACK_DATA');
  });
});

describe('read only exact source and qualification identity inspection',()=>{
  const configuration:TelehealthSchemaInspectionConfiguration={
    expectedAccountId:'588966314750',region:'us-east-2',qualificationDatabaseName:'clinical_core_qualification',stagingDatabaseName:'clinical_core',
    clusterArn:'arn:aws:rds:us-east-2:588966314750:cluster:fictional',secretArn:'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional',
    activation:'blocked',phiAllowed:false,
  };
  const operator={Account:'588966314750',Arn:'arn:aws:sts::588966314750:assumed-role/fictional/operator'};
  const migrations=()=>artifact.manifest.migrations.map(r=>({version:r.version,name:r.file.slice(15,-4),sql:artifact.files[r.file],sha256:sha(artifact.files[r.file])}));
  // PGlite has no qualification database name or STS. Only the name transport
  // and operator identity below are fictional. All ledger and schema reads,
  // role metadata and read-only transaction controls use the actual database.
  const target=(overrides:Record<string,string>={}):ClinicalCoreDatabase=>({transaction:work=>db.transaction(tx=>work({
    async query(sql,args=[]){
      const result=await tx.query<Record<string,unknown>>(sql,[...args]);
      if(sql.startsWith('select current_database() database_name'))return {rows:result.rows.map(row=>({...row,database_name:'clinical_core_qualification',...overrides}))} as never;
      return result as never;
    },
  }))});
  it('inspects the exact 114 source and real schema without authorizing any upgrade or provider action',async()=>{
    const result=await inspectTelehealthSchema(target(),migrations(),source,configuration,operator);
    expect(result.migrationCount).toBe(114);expect(result.schemaSha256).toBe(source.snapshots[2].schemaSha256);
    expect(result.mode).toBe('read_only_source_inspection');expect(result.upgradeAuthorized).toBe(false);expect(result.providerAuthorized).toBe(false);
  });
  it.each([
    ['staging database',{database_name:'clinical_core'},'boundary_refused'],
    ['other owner',{owner:'fictional_owner'},'engine_refused'],
    ['another engine',{version:'16.9'},'engine_refused'],
  ])('refuses %s instead of learning its schema',async(_name,overrides,refusal)=>{
    await expect(inspectTelehealthSchema(target(overrides),migrations(),source,configuration,operator)).rejects.toThrow(refusal);
  });
  it.each([
    ['production account',{expectedAccountId:'173535830222'}],['other region',{region:'us-east-1'}],
    ['PHI enabled',{phiAllowed:true}],['approved activation',{activation:'approved'}],
    ['different database',{qualificationDatabaseName:'other_qualification'}],
  ])('refuses %s before a database transaction',async(_name,overrides)=>{
    let touched=false;
    const refusal:ClinicalCoreDatabase={transaction:async()=>{touched=true;throw Error('MUST NOT QUERY');}};
    await expect(inspectTelehealthSchema(refusal,migrations(),source,{...configuration,...overrides} as TelehealthSchemaInspectionConfiguration,operator)).rejects.toThrow('boundary_refused');
    expect(touched).toBe(false);
  });
  it('refuses root identity and unknown sign-in account',async()=>{
    for(const identity of [{...operator,Arn:'arn:aws:iam::588966314750:root'},{...operator,Account:'173535830222'},null])
      await expect(inspectTelehealthSchema(target(),migrations(),source,configuration,identity)).rejects.toThrow('boundary_refused');
  });
  it.each(['activation','phiAllowed','sourceOnly','postgresVersion','projectionSqlSha256','installerBundleSha256'])('refuses a changed compiled %s',key=>{
    const changed=structuredClone(source) as unknown as Record<string,unknown>;changed[key]='changed';
    expect(()=>assertTelehealthSchemaSource(changed as TelehealthSchemaSource,migrations())).toThrow('artifact_refused');
  });
  it('refuses metadata learned from another target even with a recomputed digest',()=>{
    const changed=structuredClone(source);changed.snapshots[2].projection[0].digest='a'.repeat(64);
    changed.snapshots[2].schemaSha256=sha(JSON.stringify(changed.snapshots[2].projection));
    expect(()=>assertTelehealthSchemaSource(changed,migrations())).toThrow('artifact_refused');
  });
  it.each([
    ['unknown approval',s=>({...s,approvedForPhi:true})],
    ['missing snapshot',s=>({...s,snapshots:s.snapshots.slice(1)})],
    ['missing activation',s=>{const c={...s} as Partial<TelehealthSchemaSource>;delete c.activation;return c;}],
    ['unknown snapshot field',s=>({...s,snapshots:s.snapshots.map((p,i)=>i===2?{...p,approved:true}:p)})],
    ['null snapshot',s=>({...s,snapshots:[null,...s.snapshots.slice(1)]})],
  ] as Array<[string,(s:TelehealthSchemaSource)=>unknown]>)('refuses %s',(_name,mutate)=>{
    expect(()=>assertTelehealthSchemaSource(mutate(structuredClone(source)) as TelehealthSchemaSource,migrations())).toThrow('artifact_refused');
  });
  it('refuses renamed, shortened or edited source migrations',()=>{
    const all=migrations();
    for(const changed of [all.slice(1),all.map((r,i)=>i===0?{...r,name:'changed'}:r),all.map((r,i)=>i===113?{...r,sql:r.sql+'\n-- changed',sha256:sha(r.sql+'\n-- changed')}:r)])
      expect(()=>assertTelehealthSchemaSource(source,changed)).toThrow('artifact_refused');
  });
});

describe('bounded metadata response parsing',()=>{
  const rows=()=>Array.from({length:500},(_,i)=>({name:'row:'+String(i).padStart(4,'0'),digest:'a'.repeat(64)}));
  const malformed:Array<[string,(r:Array<{name:string;digest:string}>)=>unknown]>=[
    ['missing array',()=>undefined],['empty',()=>[]],['under minimum',r=>r.slice(0,499)],
    ['over maximum',()=>Array.from({length:3001},(_,i)=>({name:String(i).padStart(4,'0'),digest:'a'.repeat(64)}))],
    ['null entry',r=>[null,...r.slice(1)]],['duplicate',r=>[r[0],r[0],...r.slice(2)]],
    ['unordered',r=>r.reverse()],['missing digest',r=>[{name:r[0].name},...r.slice(1)]],
    ['extra field',r=>[{...r[0],text:'DO NOT COPY RECORD CONTENT'},...r.slice(1)]],
    ['invalid digest',r=>[{...r[0],digest:'not-a-sha'},...r.slice(1)]],
    ['oversized UTF8 name',r=>[{...r[0],name:'é'.repeat(501)},...r.slice(1)]],
  ];
  it.each(malformed)('refuses %s',async(_name,mutate)=>{
    await expect(projectTelehealthSchema(async()=>({rows:mutate(rows()) as never}))).rejects.toThrow('telehealth_schema_projection_refused');
  });
  it('copies the valid result without retaining mutable transport objects',async()=>{
    const original=rows(),result=await projectTelehealthSchema(async()=>({rows:original}));
    expect(result).toEqual(original);original[0].digest='b'.repeat(64);expect(result[0].digest).toBe('a'.repeat(64));
  });
  it('uses bounded JSON scalar names compatible with the AWS encoder, never an array parameter',async()=>{
    await projectTelehealthSchema(async(_sql,args)=>{
      expect(args).toEqual([JSON.stringify(TELEHEALTH_SCHEMA_NAMES)]);expect(typeof args[0]).toBe('string');return {rows:rows()};
    });
  });
});
