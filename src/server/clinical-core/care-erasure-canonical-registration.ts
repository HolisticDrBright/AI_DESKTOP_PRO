if(typeof window!=='undefined')throw Error('care-erasure-canonical-registration is server-only');
import {createHash} from 'node:crypto';
import type {ClinicalCoreMigration} from './migrations';
import type {ClinicalCoreDatabase} from './database';
import {CARE_ERASURE_UPGRADE,type CareErasureUpgradeConfiguration} from './care-erasure-schema-upgrade';
import {CARE_ERASURE_INTENT_UPGRADE,runCareErasureIntentUpgrade,CareErasureIntentUpgradeError} from './care-erasure-intent-upgrade';
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const rows=(m:ClinicalCoreMigration[])=>m.map(({version,name,sha256})=>({version,name,sha256}));
const source='02026932fff5a37db42a17a1c4f80bd38a759cf8e2ccb2f4d53b8299c66065e7';
const live='447cf4ea8c8da3decbaa7edea964f97d9e3bdb029c38723bf3a5767c38679a50';
/** Registration proves the source registry matches an already-applied successor.
 * It has no apply/rehearse/upgrade argument and issues only read-only SQL. The
 * historical operator witness remains historical, never edited into approval. */
export async function inspectCanonicalCareErasure(database:ClinicalCoreDatabase,
 migrations:ClinicalCoreMigration[],reference:ClinicalCoreMigration[],configuration:CareErasureUpgradeConfiguration){
 if(migrations.length!==47||reference.length!==2
  ||sha(JSON.stringify(rows(migrations)))!==source
  ||sha(JSON.stringify(rows(migrations.slice(0,46))))!==CARE_ERASURE_UPGRADE.sourceAfter
  ||sha(JSON.stringify(rows(reference)))!==CARE_ERASURE_UPGRADE.reference
  ||![migrations,reference].every(list=>list.every((m,i)=>m.sha256===sha(m.sql)&&m.sql===m.sql.replace(/\r\n?/g,'\n')
   &&(!i||m.version>list[i-1].version))))throw new CareErasureIntentUpgradeError('artifact_refused');
 const overlay=migrations[46],p=CARE_ERASURE_INTENT_UPGRADE;
 if(overlay.version!==p.version||overlay.name!==p.name||overlay.sha256!==p.sqlSha256)
  throw new CareErasureIntentUpgradeError('artifact_refused');
 const historicalInspection=await runCareErasureIntentUpgrade(database,migrations.slice(0,46),reference,overlay,configuration,'inspect');
 if(historicalInspection.alreadyApplied!==true||historicalInspection.observedMigrationCount!==48
  ||historicalInspection.sourceMigrationCount!==47||historicalInspection.tableCount!==89
  ||historicalInspection.toLedgerSha256!==live||historicalInspection.applied!==false
  ||historicalInspection.rolledBack!==false)throw new CareErasureIntentUpgradeError('history_refused');
 return {contract:'care-intent-canonical-registration-inspection/1' as const,execution:'synthetic-staging' as const,
  canonicalRegistered:true,alreadyApplied:true,sourceMigrationCount:47,liveMigrationCount:48,
  sourceLedgerSha256:source,liveLedgerSha256:live,referenceLedgerSha256:CARE_ERASURE_UPGRADE.reference,
  historicalAliasPreserved:true,historicalInspection,schemaReplayPerformed:false,ledgerRewritePerformed:false,
  apiDeploymentPerformed:false,erasureAccepted:false,releaseAccepted:false,physicalDeviceAcceptance:false,
  activationApproved:false,phiAllowed:false};
}
