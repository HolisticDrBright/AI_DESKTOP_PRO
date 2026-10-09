/** Current canonical history is distinct from the immutable historical parent.
 * No database client, source approval, or migration replay authority here. */
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
export const CARE_CANONICAL=Object.freeze({parentCount:46,count:47,liveCount:48,
 parentSha256:'52f2027ba0db0fd570bc4714fadf5ccd39e2caabf992081cb24be56497a52017',
 sourceSha256:'02026932fff5a37db42a17a1c4f80bd38a759cf8e2ccb2f4d53b8299c66065e7',
 liveSha256:'447cf4ea8c8da3decbaa7edea964f97d9e3bdb029c38723bf3a5767c38679a50',
 referenceCount:3,referenceSha256:'80027d6da351b0756385ba4d68c04dfb7397b21b058e5d341ce625a4c9b1611a',
 referenceParentSha256:'83d51dc056b41f47b5fb3d6020201163915faa2116004e3692af9bb41aad0f62',
 referenceVersion:'20261008060000',referenceName:'catalog_offer_current_product',
 referenceSqlSha256:'3d63f4a04b8168818844736ea5143115ca1e01fc9b2c96f0da6d5889938a6117',
 version:'20261007010000',name:'synthetic_care_erasure_intents',
 sqlSha256:'4be2ca72b0486bec171f16c5299c898d70bfbdbfd3143c4bb216fccc329299ec'});
const sha=v=>createHash('sha256').update(v).digest('hex');
const check=(ok,reason)=>{if(!ok)throw Error('care_canonical_migrations_refused:'+reason);};
const rows=m=>m.map(({version,name,sha256})=>({version,name,sha256}));
/** Expected descriptor only, not a database observation or release approval. */
export function canonicalCareRegistrationDescriptor(){
 const c=CARE_CANONICAL;
 return {contract:'care-intent-canonical-mapping/1',canonicalRegistered:true,sourceMigrationCount:c.count,
  liveMigrationCount:c.liveCount,sourceLedgerSha256:c.sourceSha256,liveLedgerSha256:c.liveSha256,
  referenceLedgerSha256:c.referenceSha256,referenceMigrationCount:c.referenceCount,
  historicalReferenceCount:2,historicalReferenceSha256:c.referenceParentSha256,
  referenceMigration:{version:c.referenceVersion,name:c.referenceName,sha256:c.referenceSqlSha256},
  historicalParentCount:c.parentCount,historicalParentSha256:c.parentSha256,
  historicalAliasPreserved:true,migration:{version:c.version,name:c.name,sha256:c.sqlSha256},
  schemaReplayAuthorized:false,ledgerRewriteAuthorized:false,productionApproved:false,phiAllowed:false};
}
export function readCareMigrationManifest(root,folder='migrations',file='manifest.json'){
 const directory=resolve(root,'infra/aws-clinical-core',folder);
 const manifest=JSON.parse(readFileSync(resolve(directory,file),'utf8'));
 check(manifest.contract_version==='clinical-core-migrations/1'&&Array.isArray(manifest.migrations),'manifest');
 const migrations=manifest.migrations.map((m,i,all)=>{
  check(/^\d{14}$/.test(m.version)&&new RegExp(`^${m.version}_[a-z0-9_]+\\.sql$`).test(m.file)
   &&(!i||m.version>all[i-1].version),'order');
  const sql=readFileSync(resolve(directory,m.file),'utf8').replace(/\r\n?/g,'\n');
  check(sql.trim().length>0,'empty_sql');
  return {version:m.version,name:m.file.slice(15,-4),sql,sha256:sha(sql)};
 });
 return {manifest,migrations};
}
export function canonicalCareMapping(migrations,reference,overlay){
 const c=CARE_CANONICAL;
 check(Array.isArray(migrations)&&migrations.length===c.count&&Array.isArray(reference)&&reference.length===c.referenceCount,'count');
 for(const list of [migrations,reference])check(list.every((m,i)=>/^\d{14}$/.test(m.version)
  &&/^[a-z0-9_]+$/.test(m.name)&&typeof m.sql==='string'&&m.sql===m.sql.replace(/\r\n?/g,'\n')
  &&m.sha256===sha(m.sql)&&(!i||m.version>list[i-1].version)),'content');
 check(sha(JSON.stringify(rows(migrations.slice(0,c.parentCount))))===c.parentSha256
  &&sha(JSON.stringify(rows(migrations)))===c.sourceSha256
  &&sha(JSON.stringify(rows(reference)))===c.referenceSha256
  &&sha(JSON.stringify(rows(reference.slice(0,2))))===c.referenceParentSha256,'history');
 const lastReference=reference.at(-1);
 check(lastReference.version===c.referenceVersion&&lastReference.name===c.referenceName
  &&lastReference.sha256===c.referenceSqlSha256,'reference_terminal');
 const terminal=migrations.at(-1);
 check(terminal.version===c.version&&terminal.name===c.name&&terminal.sha256===c.sqlSha256
  &&typeof overlay==='string'&&overlay===terminal.sql,'terminal');
 const alias=migrations.find(m=>m.version==='20260821049700');check(alias,'alias');
 const live=[...rows(migrations),{version:'20260902230000',name:alias.name,sha256:alias.sha256}]
  .sort((a,b)=>a.version<b.version?-1:a.version>b.version?1:0);
 check(sha(JSON.stringify(live))===c.liveSha256,'live_history');
 return canonicalCareRegistrationDescriptor();
}
export function readCanonicalCareMigrations(root){
 const {manifest,migrations}=readCareMigrationManifest(root),reference=readCareMigrationManifest(root,'catalog-migrations').migrations;
 check(manifest.migrations.at(-1).production_transform===false,'production_transform');
 const overlay=readFileSync(resolve(root,'infra/aws-clinical-core/source-candidates/care-erasure-intents.sql'),'utf8').replace(/\r\n?/g,'\n');
 const catalogOverlay=readFileSync(resolve(root,'infra/aws-clinical-core/source-candidates/catalog-offer-current-product.sql'),'utf8').replace(/\r\n?/g,'\n');
 check(reference.at(-1)?.sql===catalogOverlay,'reference_overlay');
 return {migrations,reference,mapping:canonicalCareMapping(migrations,reference,overlay)};
}
/** Explicit historical SOURCE/TEST view only. Current release commands never
 * call this implicitly when their old canonical-history check refuses. */
export function readHistoricalCareParentMigrations(root){
 const old=readCareMigrationManifest(root,'migrations','historical-care-parent-46.json');
 check(old.migrations.length===CARE_CANONICAL.parentCount
  &&sha(JSON.stringify(rows(old.migrations)))===CARE_CANONICAL.parentSha256,'historical_parent');
 const canonical=readCanonicalCareMigrations(root);
 check(JSON.stringify(rows(old.migrations))===JSON.stringify(rows(canonical.migrations.slice(0,46))),'historical_prefix');
 return old.migrations;
}

/** Explicit frozen reference2 input, never a fallback for current registration. */
export function readHistoricalCatalogParentMigrations(root){
 const old=readCareMigrationManifest(root,'catalog-migrations','historical-catalog-parent-2.json').migrations;
 check(old.length===2&&sha(JSON.stringify(rows(old)))===CARE_CANONICAL.referenceParentSha256,'historical_reference');
 return old;
}
