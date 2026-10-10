import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { ClinicalCoreDatabase, ClinicalCoreTransaction } from './database';
import type { ClinicalCoreMigration } from './migrations';
import type { QualificationUpgradeConfiguration } from './qualification-schema-upgrade';
import { applyProductionClinicalCoreMigrations } from './production-migrations';
import { FULLSCRIPT_UPGRADE, runFullscriptSchemaUpgrade } from './fullscript-schema-upgrade';

const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
let pg:PGlite,m:ClinicalCoreMigration[];
const c:QualificationUpgradeConfiguration={ expectedAccountId:'588966314750',region:'us-east-2',phiAllowed:false,activation:'blocked',
  clusterArn:'arn:aws:rds:us-east-2:588966314750:cluster:fictional',secretArn:'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional',
  qualificationDatabaseName:'clinical_core_qualification',stagingDatabaseName:'clinical_core',
  fromReleaseSha256:FULLSCRIPT_UPGRADE.parent107,toReleaseSha256:FULLSCRIPT_UPGRADE.successor111 };
type Intercept=(sql:string,tx:{query:(sql:string,args?:unknown[])=>Promise<unknown>})=>Promise<void>;
// Only PGlite's fixed database name is modeled; all migrations, grants,
// triggers, checks, fingerprints, transactions and rollback are real SQL.
const database=(intercept?:Intercept,name='clinical_core_qualification'):ClinicalCoreDatabase=>({transaction:work=>pg.transaction(async tx=>work({
  query:async(sql,args=[])=>{
    if(intercept)await intercept(sql,tx);
    if(sql==='select current_database() as name')return {rows:[{name}]};
    return tx.query(sql,[...args]);
  },
} as ClinicalCoreTransaction))});
const absent=async()=>{
  const r=(await pg.query<{n:number;absent:boolean}>(`select (select count(*)::int from clinical_core.schema_migrations) n,
    to_regnamespace('fullscript_delivery') is null and not exists(select 1 from pg_roles where rolname='fullscript_draft_worker') absent`)).rows[0];
  expect(r).toEqual({n:107,absent:true});
};
beforeAll(async()=>{
  const a=JSON.parse(execFileSync(process.execPath,['scripts/build-fullscript-candidate.mjs','--json'],{encoding:'utf8',maxBuffer:8*1024*1024,timeout:30000}));
  m=a.manifest.migrations.map((r:{version:string;file:string})=>({version:r.version,name:r.file.slice(15,-4),sql:a.files[r.file],sha256:sha(a.files[r.file])}));
  pg=new PGlite({extensions:{pgcrypto}});
  await applyProductionClinicalCoreMigrations(database(),m.slice(0,106));
  await pg.exec(m[106].sql);
  await pg.query('insert into clinical_core.schema_migrations(version,name,sha256) values($1,$2,$3)',[m[106].version,m[106].name,m[106].sha256]);
  const org=randomUUID(),person=randomUUID(),patient=randomUUID();
  await pg.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL release preservation')",[org]);
  await pg.query("insert into clinical_core.persons(id,subject_key) values($1,'subject_fictional_fullscript_release')",[person]);
  await pg.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,'patient_fictional_fullscript_release','FICTIONAL','TEST')",[patient,org]);
},90000);
afterAll(async()=>{await pg?.close();});
describe('111 blocked candidate real-SQL preservation and rollback, not hosted evidence',()=>{
  it('inspects all historical tables read-only with no source approval, grants or rows created',async()=>{
    const queries:string[]=[];
    expect(await runFullscriptSchemaUpgrade(database(async sql=>{queries.push(sql);}),m,c,'inspect')).toMatchObject({
      observedMigrationCount:107,historicalTableCount:209,rowCount:3,applied:false,newRows:0,phiAllowed:false,activation:'blocked',
    });
    expect(queries[0]).toContain('read only'); expect(queries.some(s=>/^(create|alter|insert|update|delete)/i.test(s))).toBe(false);
    await absent();
  },30000);
  it('actually applies four extensions inside a rollback rehearsal and proves complete historical row/receipt/schema preservation',async()=>{
    const before=await runFullscriptSchemaUpgrade(database(),m,c,'inspect');
    const rehearsal=await runFullscriptSchemaUpgrade(database(),m,c,'rehearse');
    expect(rehearsal).toMatchObject({observedMigrationCount:107,rolledBack:true,applied:false,dataPreserved:true,historicalSchemaPreserved:true});
    expect(rehearsal.dataSha256).toBe(before.dataSha256);expect(rehearsal.historicalSchemaSha256).toBe(before.historicalSchemaSha256);
    await absent();
  },60000);
  it.each(['clinical_core','postgres','clinical_core_production'])('refuses real observed database %s before DDL',async name=>{
    await expect(runFullscriptSchemaUpgrade(database(undefined,name),m,c,'rehearse')).rejects.toMatchObject({category:'boundary_refused'});
    await absent();
  });
  it.each([
    {expectedAccountId:'173535830222'},{phiAllowed:true},{activation:'approved'},{region:'us-east-1'},
    {secretArn:'arn:aws:secretsmanager:us-east-2:173535830222:secret:fictional'},
  ])('refuses unsafe boundary %j before database work',async delta=>{
    await expect(runFullscriptSchemaUpgrade({transaction:async()=>{throw Error('unexpected_db');}},m,{...c,...delta} as QualificationUpgradeConfiguration,'inspect'))
      .rejects.toMatchObject({category:'boundary_refused'});
  });
  it('refuses changed historic names as well as SQL hashes',async()=>{
    const row=m[1];
    await pg.query("update clinical_core.schema_migrations set name='forged_name' where version=$1",[row.version]);
    try {await expect(runFullscriptSchemaUpgrade(database(),m,c,'inspect')).rejects.toMatchObject({category:'history_refused'});}
    finally {await pg.query('update clinical_core.schema_migrations set name=$1 where version=$2',[row.name,row.version]);}
    await absent();
  });
  it('refuses forged extension bytes even if supplied sha is recomputed',async()=>{
    const altered=m.map(r=>({...r}));altered[110].sql+='\nselect 1;';altered[110].sha256=sha(altered[110].sql);
    await expect(runFullscriptSchemaUpgrade(database(),altered,c,'rehearse')).rejects.toMatchObject({category:'artifact_refused'});
  });
  it('refuses forged artifact names independently of the version/SQL-only release hash',async()=>{
    const altered=m.map(r=>({...r}));altered[1].name='forged_history';
    await expect(runFullscriptSchemaUpgrade(database(),altered,c,'inspect')).rejects.toMatchObject({category:'artifact_refused'});
  });
  it('a busy migration fence refuses before any extension can be written',async()=>{
    const real=database();
    const busy:ClinicalCoreDatabase={transaction:work=>real.transaction(tx=>work({query:async(sql,args)=>
      sql.includes('pg_try_advisory_xact_lock')?{rows:[{acquired:false}]}:tx.query(sql,args)} as ClinicalCoreTransaction))};
    await expect(runFullscriptSchemaUpgrade(busy,m,c,'rehearse')).rejects.toMatchObject({category:'upgrade_busy'});
    await absent();
  });
  it('requires an exact pre-admission observation before committing, not just a caller boolean',async()=>{
    await expect(runFullscriptSchemaUpgrade(database(),m,c,'upgrade')).rejects.toMatchObject({category:'boundary_refused'});
    const before=await runFullscriptSchemaUpgrade(database(),m,c,'inspect');
    await expect(runFullscriptSchemaUpgrade(database(),m,c,'upgrade',{...before,observedMigrationCount:107,rowCount:999})).rejects.toMatchObject({category:'admission_changed'});
    await absent();
  },30000);
  it('a lost extension receipt rolls back SQL, new role and all prior extension receipts',async()=>{
    const r=m[110];
    await expect(runFullscriptSchemaUpgrade(database(async(sql,tx)=>{
      if(sql.startsWith('insert into clinical_core.schema_migrations')) {
        const found=await tx.query('select to_regprocedure(\'fullscript_delivery.migration_ledger()\') is not null as present') as {rows:Array<{present:boolean}>};
        if(found.rows[0].present)throw Error('FICTIONAL lost receipt '+r.version);
      }
    }),m,c,'rehearse')).rejects.toMatchObject({category:'upgrade_failed'});
    await absent();
  },30000);
  it('detects unauthorized historical schema change and rolls it back',async()=>{
    let altered=false;
    await expect(runFullscriptSchemaUpgrade(database(async(sql,tx)=>{
      if(!altered && /create schema fullscript_delivery/.test(sql)) {altered=true;await tx.query('alter table clinical_core.patient_records add column forbidden text');}
    }),m,c,'rehearse')).rejects.toMatchObject({category:'verification_failed'});
    expect((await pg.query<{n:number}>("select count(*)::int n from information_schema.columns where table_schema='clinical_core' and table_name='patient_records' and column_name='forbidden'")).rows[0].n).toBe(0);
    await absent();
  },30000);
  it('rejects widened execute authority on new functions without silently granting public access',async()=>{
    await expect(runFullscriptSchemaUpgrade(database(async(sql,tx)=>{
      if(sql.includes('grant execute on function fullscript_delivery.external_consent_request'))
        await tx.query('grant execute on function fullscript_delivery.external_consent_request(jsonb,jsonb) to public');
    }),m,c,'rehearse')).rejects.toMatchObject({category:'verification_failed',stage:'extension_function:fullscript_delivery.external_consent_request'});
    await absent();
  },30000);
  it('rejects an unintended role grant and preserves historical memberships',async()=>{
    await expect(runFullscriptSchemaUpgrade(database(async(sql,tx)=>{
      if(sql.includes('grant usage on schema fullscript_delivery'))await tx.query('grant fullscript_draft_worker to clinical_core_api');
    }),m,c,'rehearse')).rejects.toMatchObject({category:'verification_failed',stage:'after_schema'});
    await absent();
  },30000);
  it('rejects new table shape drift rather than verifying only names and counts',async()=>{
    await expect(runFullscriptSchemaUpgrade(database(async(sql,tx)=>{
      if(sql.includes('grant select,insert,update on fullscript_delivery.draft_intents'))
        await tx.query('alter table fullscript_delivery.draft_intents add column unreviewed jsonb');
    }),m,c,'rehearse')).rejects.toMatchObject({category:'verification_failed',stage:'extension_shape'});
    await absent();
  },30000);
  it('detects a historical record change without certifying preservation and rolls it back',async()=>{
    let changed=false;
    await expect(runFullscriptSchemaUpgrade(database(async(sql,tx)=>{
      if(!changed && /create schema fullscript_delivery/.test(sql)){changed=true;await tx.query("update clinical_core.patient_records set first_name='FICTIONAL CORRUPTION'");}
    }),m,c,'rehearse')).rejects.toMatchObject({category:'verification_failed',stage:'after_data'});
    expect((await pg.query<{first_name:string}>('select first_name from clinical_core.patient_records')).rows[0].first_name).toBe('FICTIONAL');
    await absent();
  },30000);
  it('preserves a previously installed exact 108 consent extension without reapplying it',async()=>{
    await pg.transaction(async tx=>{await tx.exec(m[107].sql);await tx.query('insert into clinical_core.schema_migrations(version,name,sha256) values($1,$2,$3)',[m[107].version,m[107].name,m[107].sha256]);});
    try {
      const q:string[]=[];
      const result=await runFullscriptSchemaUpgrade(database(async sql=>{q.push(sql);}),m,{...c,fromReleaseSha256:FULLSCRIPT_UPGRADE.parent108},'rehearse');
      expect(result).toMatchObject({observedMigrationCount:108,rolledBack:true});
      expect(q.some(sql=>sql.includes('drop constraint consent_artifacts_scope_check'))).toBe(false);
    } finally {
      // Fictional test fixture teardown only; no runtime downgrade command exists.
      await pg.exec(`alter table clinical_core.consent_artifacts drop constraint consent_artifacts_scope_check;
        alter table clinical_core.consent_grants drop constraint consent_grants_scope_check;`);
      const text=m[107].sql.replace(",'telehealth_recording'",'').replace(",\n    'research_n_of_1','telehealth_recording'",",\n    'research_n_of_1'");
      for(const statement of text.split(';').filter(s=>s.includes('add constraint')))await pg.exec(statement+';');
      await pg.query('delete from clinical_core.schema_migrations where version=$1',[m[107].version]);
    }
    await absent();
  },60000);
  it('commits only after exact admission, leaves all approvals/releases/consents empty and refuses blind reapply after receipt loss',async()=>{
    const before=await runFullscriptSchemaUpgrade(database(),m,c,'inspect');
    const result=await runFullscriptSchemaUpgrade(database(),m,c,'upgrade',{...before,observedMigrationCount:107});
    expect(result).toMatchObject({observedMigrationCount:111,applied:true,newTableCount:8,newRows:0,dataPreserved:true});
    const rows=(await pg.query<{n:number}>('select count(*)::int n from fullscript_delivery.authority_releases')).rows;
    expect(rows[0].n).toBe(0);
    await expect(runFullscriptSchemaUpgrade(database(),m,c,'upgrade',{...before,observedMigrationCount:107})).rejects.toMatchObject({category:'recovery_required'});
  },60000);
});
