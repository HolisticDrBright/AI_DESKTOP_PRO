import {expect,it} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ClinicalCoreDatabase,ClinicalCoreTransaction} from './database';
import {applyProductionClinicalCoreMigrations} from './production-migrations';
import {executeFullscriptUpgradeCommand} from './fullscript-upgrade-command';
import {createNativeFullscriptCustody,openNativeFullscriptRecovery} from './fullscript-native-custody';
import {build,bytes,caller,foundation,migrations,sha,target} from './__fixtures__/fullscript-upgrade';

it('real SQL engine and real file journal compose through the command with empty extension authority (fictional AWS/outer fence)',async()=>{
  const pg=new PGlite({extensions:{pgcrypto}}),root=mkdtempSync(join(tmpdir(),'alp-fullscript-operator-'));
  const operatorFile=join(root,'original.cjs');writeFileSync(operatorFile,'FICTIONAL operator');
  const m=migrations(),database:ClinicalCoreDatabase={transaction:work=>pg.transaction(async tx=>work({query:async(sql,args=[])=>
    sql==='select current_database() as name'?{rows:[{name:'clinical_core_qualification'}]}:tx.query(sql,[...args])} as ClinicalCoreTransaction))};
  try {
    await applyProductionClinicalCoreMigrations(database,m.slice(0,106));await pg.exec(m[106].sql);
    await pg.query('insert into clinical_core.schema_migrations(version,name,sha256) values($1,$2,$3)',[m[106].version,m[106].name,m[106].sha256]);
    const observations:string[]=[];
    const result=await executeFullscriptUpgradeCommand(['upgrade','--target',join(root,'FICTIONAL.json'),'--target-sha256',sha(bytes(target)),
      '--confirm-fictional-fullscript-upgrade'],build,{
      readTarget:()=>bytes(target),operatorSha256:()=>sha(readFileSync(operatorFile)),observeCaller:()=>caller,observeFoundation:()=>foundation,
      loadMigrations:()=>m,createDatabase:()=>database,
      // PGlite is single-connection. Outer multi-session fencing is fictional;
      // the engine's own migration/fixture/table locks and rollback are real SQL.
      withFence:work=>work({verify:async()=>{observations.push('outer-fence');}}),
      createCustody:(binding,baseline,fence)=>createNativeFullscriptCustody({root,operatorFile},binding,baseline,fence),
      openRecoveryCustody:(binding,fence)=>openNativeFullscriptRecovery({root,operatorFile},binding,fence),
    });
    expect(result).toMatchObject({observedMigrationCount:111,applied:true,custodySettled:true,rowCount:0,newRows:0,phiAllowed:false,activation:'blocked'});
    expect(existsSync(join(root,'operator.lock'))).toBe(false);
    const journal=readFileSync(join(root,readdirSync(root).find(v=>v.endsWith('.fullscript.events.jsonl'))!),'utf8');
    expect(journal.trim().split('\n').map(v=>JSON.parse(v).stage)).toEqual(['baseline','rehearsal','write_admitted','write_reply','readback_one','readback_two']);
    expect(observations.length).toBeGreaterThan(10);
    expect((await pg.query<{n:number}>('select count(*)::int n from fullscript_delivery.authority_releases')).rows[0].n).toBe(0);
    expect((await pg.query<{n:number}>('select count(*)::int n from clinical_core.schema_migrations')).rows[0].n).toBe(111);
  } finally {await pg.close();rmSync(root,{recursive:true,force:true});}
},90000);
