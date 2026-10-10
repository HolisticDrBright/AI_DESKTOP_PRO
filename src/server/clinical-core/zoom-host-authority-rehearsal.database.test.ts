import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { applyProductionClinicalCoreMigrations } from './production-migrations';
import { splitPostgresStatements } from './migrations';
import type { ClinicalCoreDatabase } from './database';

/** Actual source SQL transaction rehearsal, NOT the reviewed/native upgrade
 * operator, real PostgreSQL concurrency, AWS or activation evidence. */
type Artifact = { manifest: { migrations: { version:string; file:string }[] }; files:Record<string,string>;
  candidate:{ parentMigrationReleaseSha256:string; migrationReleaseSha256:string } };
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
let db:PGlite, artifact:Artifact, tables:string[], statements:string[];
const schemas=['clinical_core','clinical_private','clinical_audit','clinical_reference','commercial_reference','fullscript_delivery'];
const addedConstraint='zoom_host_appointment_org_unique';

beforeAll(async()=>{
  artifact=JSON.parse(execFileSync(process.execPath,['scripts/build-zoom-host-authority-candidate.mjs','--json'],
    {encoding:'utf8',maxBuffer:16*1024*1024,timeout:60000,windowsHide:true}));
  const migrations=artifact.manifest.migrations.map(row=>({version:row.version,name:row.file.slice(15,-4),sql:artifact.files[row.file],sha256:sha(artifact.files[row.file])}));
  db=new PGlite({extensions:{pgcrypto}});
  const admin:ClinicalCoreDatabase={transaction:work=>db.transaction(tx=>work({query:(sql,args=[])=>tx.query(sql,[...args])}))};
  await applyProductionClinicalCoreMigrations(admin,migrations.slice(0,106));
  for(const row of migrations.slice(106,113)){
    await db.exec(row.sql);
    await db.query('insert into clinical_core.schema_migrations(version,name,sha256) values($1,$2,$3)',[row.version,row.name,row.sha256]);
  }
  statements=splitPostgresStatements(migrations[113].sql);
  tables=(await db.query<{name:string}>(`select n.nspname||'.'||c.relname name from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname=any($1::text[]) and c.relkind='r' order by n.nspname,c.relname`,[schemas])).rows.map(r=>r.name);
  // Existing nonempty fictional records and an owner legal hold must survive.
  const org=randomUUID(),person=randomUUID(),patient=randomUUID(),appointment=randomUUID();
  await db.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL REHEARSAL')",[org]);
  await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)',[person,'subject_'+person.replaceAll('-','')]);
  await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'workforce',$2,true)",[person,'fixture-'+person]);
  await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner')",[org,person]);
  await db.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'FICTIONAL','HELD')",[patient,org,'patient_'+patient.replaceAll('-','')]);
  await db.query(`insert into clinical_core.appointments(id,organization_id,patient_record_id,practitioner_person_id,appointment_type,
    starts_at,ends_at,created_by_person_id,updated_by_person_id) values($1,$2,$3,$4,'telehealth','2026-10-10T17:00:00Z','2026-10-10T17:30:00Z',$4,$4)`,[appointment,org,patient,person]);
  await db.query("insert into clinical_private.owned_legal_holds(owner_id,reason_code,placed_by) values($1,'owner_dispute',$1)",[person]);
  expect((await db.query<{n:number}>('select count(*)::int n from clinical_private.owned_legal_holds where released_at is null')).rows[0].n).toBe(1);
  expect(tables).toContain('clinical_core.telehealth_note_transfers');
},120000);
afterAll(async()=>{await db?.close();});

type Query=Pick<PGlite,'query'>;
async function historicalData(tx:Query){
  const fingerprints=[];
  for(const name of tables){
    if(!/^[a-z_]+\.[a-z_]+$/.test(name))throw Error('invalid_source_relation');
    const filter=name==='clinical_core.schema_migrations'?" where version<'20261010200000'":'';
    const result=(await tx.query<{n:number;digest:string}>(`select count(*)::int n,
      encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)::text),'[]'::jsonb)::text,'UTF8')),'hex') digest
      from ${name} r${filter}`)).rows[0];
    fingerprints.push({name,...result});
  }
  return fingerprints;
}
async function historicalSchema(tx:Query){
  // Exact permitted parent delta: one named unique constraint and its index.
  // New child FK triggers are internal; all existing user triggers stay pinned.
  return (await tx.query<{shape:unknown}>(`select jsonb_build_object(
    'tables',(select jsonb_agg(jsonb_build_object('name',selected.name,'kind',c.relkind,'owner',c.relowner::regrole::text,
      'rls',c.relrowsecurity,'forced',c.relforcerowsecurity,'acl',coalesce(c.relacl,acldefault('r',c.relowner))::text,
      'columns',(select jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),
        'null',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,'acl',a.attacl::text,'default',pg_get_expr(d.adbin,d.adrelid)) order by a.attnum)
        from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0),
      'constraints',(select jsonb_agg(jsonb_build_object('name',k.conname,'valid',k.convalidated,'def',pg_get_constraintdef(k.oid),
        'deferred',k.condeferred,'deferrable',k.condeferrable) order by k.conname) from pg_constraint k
        where k.conrelid=c.oid and not(selected.name='clinical_core.appointments' and k.conname=$2)),
      'indexes',(select jsonb_agg(pg_get_indexdef(i.indexrelid) order by i.indexrelid::regclass::text) from pg_index i
        where i.indrelid=c.oid and not(selected.name='clinical_core.appointments' and i.indexrelid::regclass::text='clinical_core.'||$2)),
      'policies',(select jsonb_agg(to_jsonb(p)-'oid'-'polrelid' order by p.polname) from pg_policy p where p.polrelid=c.oid),
      'triggers',(select jsonb_agg(jsonb_build_object('name',t.tgname,'enabled',t.tgenabled,'def',pg_get_triggerdef(t.oid)) order by t.tgname)
        from pg_trigger t where t.tgrelid=c.oid and not t.tgisinternal)) order by selected.name)
        from jsonb_array_elements_text($1::jsonb) selected(name) join pg_class c on c.oid=selected.name::regclass),
    'functions',(select jsonb_agg(jsonb_build_object('name',p.oid::regprocedure::text,'def',pg_get_functiondef(p.oid),
      'owner',p.proowner::regrole::text,'acl',coalesce(p.proacl,acldefault('f',p.proowner))::text) order by n.nspname,p.oid::regprocedure::text)
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname=any($3::text[]) and p.prokind in ('f','p')),
    'roles',(select jsonb_agg(to_jsonb(r) order by r.rolname) from pg_roles r),
    'memberships',(select jsonb_agg(to_jsonb(m) order by m.roleid,m.member,m.grantor) from pg_auth_members m)
  ) shape`,[JSON.stringify(tables),addedConstraint,schemas])).rows[0].shape;
}
async function absent(tx:Query){
  expect((await tx.query<{name:string|null}>("select to_regnamespace('clinical_telehealth')::text name")).rows[0].name).toBeNull();
  expect((await tx.query<{n:number}>("select count(*)::int n from pg_constraint where conname=$1",[addedConstraint])).rows[0].n).toBe(0);
  expect((await tx.query<{n:number}>("select count(*)::int n from clinical_core.schema_migrations where version='20261010200000'")).rows[0].n).toBe(0);
}
async function apply(tx:Query,stop?:number){
  for(const [i,sql] of statements.entries()){
    await tx.query(sql);
    if(i===stop)throw Error('FICTIONAL_INTERRUPTED_HOST_DDL');
  }
  const last=artifact.manifest.migrations[113];
  await tx.query('insert into clinical_core.schema_migrations(version,name,sha256) values($1,$2,$3)',[last.version,last.file.slice(15,-4),sha(artifact.files[last.file])]);
}

describe('actual host candidate SQL transaction preserving the exact chart predecessor',()=>{
  it.each([1,14,29])('rolls back interrupted DDL at statement %i including parent constraint changes',async stop=>{
    const beforeData=await historicalData(db),beforeSchema=await historicalSchema(db);
    await expect(db.transaction(tx=>apply(tx,stop))).rejects.toThrow('FICTIONAL_INTERRUPTED_HOST_DDL');
    await absent(db);
    expect(await historicalData(db)).toEqual(beforeData);
    expect(await historicalSchema(db)).toEqual(beforeSchema);
  },60000);
  it('rehearses complete source apply then rolls back with all historical bytes and security preserved',async()=>{
    const beforeData=await historicalData(db),beforeSchema=await historicalSchema(db);
    await expect(db.transaction(async tx=>{
      await apply(tx);
      expect(await historicalData(tx)).toEqual(beforeData);
      expect(await historicalSchema(tx)).toEqual(beforeSchema);
      const receipts=(await tx.query<{version:string;sha256:string}>('select version,sha256 from clinical_core.schema_migrations order by version')).rows;
      expect(receipts).toHaveLength(114);
      expect(sha(receipts.map(r=>r.version+':'+r.sha256).join('\n'))).toBe(artifact.candidate.migrationReleaseSha256);
      expect((await tx.query<{n:number}>("select count(*)::int n from pg_constraint where conname=$1 and conrelid='clinical_core.appointments'::regclass and contype='u' and convalidated",[addedConstraint])).rows[0].n).toBe(1);
      for(const name of ['zoom_host_releases','zoom_host_revocations','zoom_visit_host_bindings','host_authority_events']){
        expect((await tx.query<{n:number}>('select count(*)::int n from clinical_telehealth.'+name)).rows[0].n).toBe(0);
      }
      throw Error('FICTIONAL_ROLLBACK_ONLY');
    })).rejects.toThrow('FICTIONAL_ROLLBACK_ONLY');
    await absent(db);
    expect(await historicalData(db)).toEqual(beforeData);
    expect(await historicalSchema(db)).toEqual(beforeSchema);
  },60000);
});
