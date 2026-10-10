if(typeof window!=='undefined')throw Error('telehealth-schema-inspection is server-only');
import { createHash } from 'node:crypto';
import type { ClinicalCoreDatabase } from './database';
import type { ClinicalCoreMigration } from './migrations';
import { assertQualificationConfiguration, assertQualificationOperatorIdentity, type QualificationTargetConfiguration } from './qualification-target';
import type { TelehealthSchemaSource } from '../../../scripts/compile-telehealth-schema-source.mjs';
import { projectTelehealthSchema, TELEHEALTH_SCHEMA_PROJECTION } from '../../../scripts/telehealth-schema-projection.mjs';

const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const releases=Object.freeze([
  {count:112,ledger:'45aec4369ec94bf6339a17e47eadba7b81e7b5195fd5be46c2903e587b709fb4',
    assembly:'6cc191355442ae2c2349cab50466979eaab0e45961a4e1547f34785294dce4b9',
    schema:'98f3f5fa4cbf9d744645d2adacf7f670cbb7acd2730d2efa671c19ce27c77538'},
  {count:113,ledger:'c980ff93f46b4e4fe36360a0f39288a2fb604a87c522ee88d4421f35f6035384',
    assembly:'f940e0aacbf8a8899ea21fbb027f6132044608492baf1a9286502637b57d3ce2',
    schema:'2926b31d6e3963c6fefb4ae7f26f8abffd1aff52bdc71dca7d0564c48ae57adb'},
  {count:114,ledger:'7c09615ba12bd1122d34d459c57e1c88c42f1c51d598f4f71183e472b15d802c',
    assembly:'8e4fc72b54015f1f0b183fa308aeba8ff3db886e6e4c236fad88bf53f7820f3e',
    schema:'f338287b111e87a830fbf71268a9250e3bcc5aab0cb7ae31daa47c19cc90e2fa'},
]);
type Category='boundary_refused'|'artifact_refused'|'history_refused'|'schema_refused'|'engine_refused'|'inspection_failed';
export class TelehealthSchemaInspectionError extends Error {
  constructor(readonly category:Category){super(category);this.name='TelehealthSchemaInspectionError';}
}
const fail=(category:Category):never=>{throw new TelehealthSchemaInspectionError(category);};
const keys=(value:unknown,expected:string)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===expected;
export type TelehealthSchemaInspectionConfiguration=QualificationTargetConfiguration & {
  region:'us-east-2';activation:'blocked';phiAllowed:false;
};

/** Source pins are NOT review hashes. Expected schema is never accepted from a
 * live target or merely because its self-reported digest matches itself. */
export function assertTelehealthSchemaSource(source:TelehealthSchemaSource,m:readonly ClinicalCoreMigration[]) {
  if(!keys(source,'activation,contract,installerBundleSha256,phiAllowed,postgresVersion,projectionSqlSha256,snapshots,sourceOnly'))fail('artifact_refused');
  if(source.contract!=='telehealth-schema-source/1'||source.sourceOnly!==true||source.activation!=='blocked'||source.phiAllowed!==false
    ||source.postgresVersion!=='18.3'||source.projectionSqlSha256!==sha(TELEHEALTH_SCHEMA_PROJECTION)
    ||!/^[a-f0-9]{64}$/.test(source.installerBundleSha256)||!Array.isArray(source.snapshots)||source.snapshots.length!==3||!Array.isArray(m)||m.length!==114)fail('artifact_refused');
  if(m.some((r,i)=>!keys(r,'name,sha256,sql,version')||typeof r.sql!=='string'||typeof r.name!=='string'||typeof r.version!=='string'
    ||!/^\d{14}$/.test(r.version)||!/^[a-z0-9_]+$/.test(r.name)||r.sql.includes('\r')||sha(r.sql)!==r.sha256
    ||i>0&&r.version<=m[i-1].version))fail('artifact_refused');
  for(const [i,pin] of releases.entries()) {
    const s=source.snapshots[i],prefix=m.slice(0,pin.count);
    if(!keys(s,'assemblySha256,migrationCount,migrationReleaseSha256,projection,schemaSha256')
      ||s.migrationCount!==pin.count||s.migrationReleaseSha256!==pin.ledger||s.assemblySha256!==pin.assembly||s.schemaSha256!==pin.schema
      ||sha(JSON.stringify(s.projection))!==pin.schema
      ||sha(prefix.map(r=>r.version+':'+r.sha256).join('\n'))!==pin.ledger
      ||sha(prefix.map(r=>r.version+':'+r.version+'_'+r.name+'.sql:'+r.sha256).join('\n'))!==pin.assembly)fail('artifact_refused');
  }
}

/** Read-only source engine. No upgrade/apply method, provider credential, key or
 * host release. Native custody, reviewed owner/engine binding and preserving
 * writes are separate work. PGlite 18.3 fingerprints must NOT admit a different
 * Aurora engine or owner via an override or a weaker prefix comparison. */
export async function inspectTelehealthSchema(database:ClinicalCoreDatabase,supplied:readonly ClinicalCoreMigration[],
  compiled:TelehealthSchemaSource,configuration:TelehealthSchemaInspectionConfiguration,observedOperator:unknown) {
  const migrations=supplied.map(r=>({...r})),source=structuredClone(compiled),c={...configuration};
  assertTelehealthSchemaSource(source,migrations);
  try{assertQualificationConfiguration(c,c.region);assertQualificationOperatorIdentity(observedOperator,c.expectedAccountId);}catch{fail('boundary_refused');}
  if(c.expectedAccountId!=='588966314750'||c.region!=='us-east-2'||c.qualificationDatabaseName!=='clinical_core_qualification'
    ||c.stagingDatabaseName!=='clinical_core'||c.activation!=='blocked'||c.phiAllowed!==false)fail('boundary_refused');
  try{return await database.transaction(async tx=>{
    await tx.query('set transaction isolation level repeatable read read only');
    await tx.query("set local lock_timeout='5s'");await tx.query("set local statement_timeout='30s'");
    await tx.query('set local search_path=pg_catalog,public');
    const identity=(await tx.query<{database_name:string;owner:string;version:string}>(
      "select current_database() database_name,current_user::text owner,current_setting('server_version') version")).rows;
    if(identity.length!==1||identity[0].database_name!==c.qualificationDatabaseName)fail('boundary_refused');
    if(identity[0].version!==source.postgresVersion||identity[0].owner!=='postgres')fail('engine_refused');
    const ledger=(await tx.query<{version:string;name:string;sha256:string}>(
      'select version,name,sha256 from clinical_core.schema_migrations order by version limit 115')).rows;
    const pin=releases.find(r=>r.count===ledger.length)??fail('history_refused');
    if(ledger.some((r,i)=>r.version!==migrations[i]?.version||r.name!==migrations[i]?.name||r.sha256!==migrations[i]?.sha256))fail('history_refused');
    const projection=await projectTelehealthSchema((sql,args)=>tx.query<{name:string;digest:string}>(sql,args));
    if(sha(JSON.stringify(projection))!==pin.schema)fail('schema_refused');
    return {contract:'telehealth-schema-inspection/1' as const,execution:'qualification' as const,mode:'read_only_source_inspection' as const,
      migrationCount:pin.count,migrationReleaseSha256:pin.ledger,assemblySha256:pin.assembly,schemaSha256:pin.schema,
      postgresVersion:source.postgresVersion,phiAllowed:false as const,activation:'blocked' as const,
      schemaItems:projection.length,providerAuthorized:false as const,upgradeAuthorized:false as const};
  });}catch(error){if(error instanceof TelehealthSchemaInspectionError)throw error;return fail('inspection_failed');}
}
