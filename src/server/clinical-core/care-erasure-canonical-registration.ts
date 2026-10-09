if(typeof window!=='undefined')throw Error('care-erasure-canonical-registration is server-only');
import {createHash} from 'node:crypto';
import type {ClinicalCoreMigration} from './migrations';
import type {ClinicalCoreDatabase} from './database';
import {CARE_ERASURE_UPGRADE,type CareErasureUpgradeConfiguration} from './care-erasure-schema-upgrade';
import {CARE_ERASURE_INTENT_UPGRADE,CareErasureIntentUpgradeError} from './care-erasure-intent-upgrade';
import {CATALOG_FORWARD_UPGRADE,catalogForwardMapping,runCatalogForwardUpgrade} from './catalog-forward-upgrade';
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const rows=(m:ClinicalCoreMigration[])=>m.map(({version,name,sha256})=>({version,name,sha256}));
/** Complete CURRENT registry, inspected read-only. Old reference2 reports are
 * historical, not normalized into successor authority. No replay or apply port. */
export async function inspectCanonicalCareErasure(database:ClinicalCoreDatabase,
 suppliedMigrations:ClinicalCoreMigration[],suppliedReference:ClinicalCoreMigration[],suppliedConfiguration:CareErasureUpgradeConfiguration){
 const migrations=suppliedMigrations.map(m=>({...m})),reference=suppliedReference.map(m=>({...m})),configuration={...suppliedConfiguration};
 const p=CATALOG_FORWARD_UPGRADE;
 if(migrations.length!==47||reference.length!==3
  ||sha(JSON.stringify(rows(migrations)))!==p.sourceCoreSha256
  ||sha(JSON.stringify(rows(migrations.slice(0,46))))!==CARE_ERASURE_UPGRADE.sourceAfter
  ||sha(JSON.stringify(rows(reference)))!==p.referenceAfterSha256
  ||![migrations,reference].every(list=>list.every((m,i)=>m.sha256===sha(m.sql)&&m.sql===m.sql.replace(/\r\n?/g,'\n')
   &&(!i||m.version>list[i-1].version))))throw new CareErasureIntentUpgradeError('artifact_refused');
 const overlay=migrations[46],intent=CARE_ERASURE_INTENT_UPGRADE;
 if(overlay.version!==intent.version||overlay.name!==intent.name||overlay.sha256!==intent.sqlSha256)
  throw new CareErasureIntentUpgradeError('artifact_refused');
 const parent=reference.slice(0,2),candidate=reference[2];
 catalogForwardMapping(migrations,parent,candidate,configuration);
 const catalogInspection=await runCatalogForwardUpgrade(database,migrations,parent,candidate,configuration,'inspect');
 if(catalogInspection.alreadyApplied!==true||catalogInspection.referenceMigrationCount!==3
  ||catalogInspection.referenceLedgerSha256!==p.referenceAfterSha256||catalogInspection.applied!==false
  ||catalogInspection.rolledBack!==false)throw new CareErasureIntentUpgradeError('history_refused');
 return {contract:'care-catalog-canonical-registration-inspection/1' as const,execution:'synthetic-staging' as const,
  canonicalRegistered:true,alreadyApplied:true,sourceMigrationCount:47,liveMigrationCount:48,
  sourceLedgerSha256:p.sourceCoreSha256,liveLedgerSha256:p.liveCoreSha256,referenceLedgerSha256:p.referenceAfterSha256,
  referenceMigrationCount:3,historicalReferenceCount:2,historicalReferenceSha256:p.referenceBeforeSha256,
  historicalAliasPreserved:true,catalogInspection,schemaReplayPerformed:false,ledgerRewritePerformed:false,
  apiDeploymentPerformed:false,erasureAccepted:false,releaseAccepted:false,physicalDeviceAcceptance:false,
  activationApproved:false,phiAllowed:false};
}
