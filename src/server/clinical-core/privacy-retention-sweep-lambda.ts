import {createPrivacyExportRetention,type PrivacyExportBacklog} from './owned-privacy-export-job';
import {createAwsPrivacyExportStore} from './aws-privacy-export-store';
import {createRdsDataClinicalCoreDatabase} from './rds-data-database';
import {clinicalUuid,type ClinicalCoreDatabase} from './database';
import type {ProductionClinicalRequestContext} from './aws-identity-consent';
import {OwnedStorageError} from './owned-consumer-records';

/** Scheduled export retention sweep (migration 20260920150000). Runs under the
 * retention service identity: a workforce identity named by a reviewed release
 * row in the database. With no live release row every database call refuses
 * (`retention_service_release_required`), so a deployed schedule does nothing
 * until the operating policy is approved and the row is inserted by an
 * operator. Each run expires deadline-passed jobs, removes settled finished
 * jobs with listing proof (failures back off), re-checks recorded removals
 * after the settlement window, and publishes the backlog as CloudWatch
 * embedded metrics so an alarm fires when the oldest pending removal ages past
 * the reviewed threshold. Nothing here reads export content. */
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type RetentionSweepConfiguration={enabled:boolean;evidenceSha256?:string;servicePersonId?:string;serviceSubject?:string;organizationId?:string;
  bucket?:string;kmsKeyArn?:string;bucketOwner?:string;region?:string;phiAllowed:boolean};
export function retentionSweepContext(c:RetentionSweepConfiguration):ProductionClinicalRequestContext{
  if(!c.enabled||!c.phiAllowed||!/^[a-f0-9]{64}$/.test(c.evidenceSha256??'')||!UUID.test(c.servicePersonId??'')||!UUID.test(c.organizationId??'')
    ||!/^[A-Za-z0-9:_-]{8,128}$/.test(c.serviceSubject??''))throw new Error('retention_sweep_configuration_invalid');
  return {actorPersonId:c.servicePersonId!,organizationId:c.organizationId!,identityPool:'workforce',identitySubject:c.serviceSubject!,purpose:'consent_management',
    environment:'production-clinical',dataClassification:'clinical_phi',containsPhi:true,realPatientData:true,productionBound:true};
}
export function retentionSweepStorage(c:RetentionSweepConfiguration){
  const storage={bucket:c.bucket??'',kmsKeyArn:c.kmsKeyArn??'',expectedBucketOwner:c.bucketOwner??'',region:c.region??''};
  if(!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(storage.bucket)||!/^arn:aws:kms:[a-z0-9-]+:[0-9]{12}:key\/[a-f0-9-]{36}$/.test(storage.kmsKeyArn)
    ||!/^[0-9]{12}$/.test(storage.expectedBucketOwner)||!/^[a-z0-9-]+$/.test(storage.region))throw new Error('retention_sweep_configuration_invalid');
  return storage;
}
export type RetentionSweepResult={ok:boolean;refused:'retention_service_release_required'|null;cleanup:{cleaned:number;remaining:number;deferred:number}|null;
  reconcile:{confirmed:number;reopened:number;pending:number}|null;backlog:PrivacyExportBacklog|null};
/** One sweep. A refusal because no release row is live is a normal, reported outcome, not an error. */
export async function runRetentionSweep(database:ClinicalCoreDatabase,c:RetentionSweepConfiguration,deps:{store?:ReturnType<typeof createAwsPrivacyExportStore>;signal?:AbortSignal;emit?:(line:string)=>void}={}):Promise<RetentionSweepResult>{
  const context=retentionSweepContext(c),storage=retentionSweepStorage(c),signal=deps.signal??AbortSignal.timeout(600_000);
  const run=async<T>(ctx:ProductionClinicalRequestContext,work:(tx:Parameters<Parameters<ClinicalCoreDatabase['transaction']>[0]>[0])=>Promise<T>):Promise<T>=>database.transaction(async tx=>{
    await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)',[clinicalUuid(ctx.actorPersonId),clinicalUuid(ctx.organizationId),ctx.identityPool,ctx.identitySubject,ctx.purpose,ctx.environment,ctx.dataClassification]);
    return work(tx);
  });
  const retention=createPrivacyExportRetention(run,{store:deps.store??createAwsPrivacyExportStore(),storage},'retention_service');
  const result:RetentionSweepResult={ok:false,refused:null,cleanup:null,reconcile:null,backlog:null};
  try{
    const cleanup=await retention.cleanupAssignedPrivacyExports(context,100,signal);
    result.cleanup={cleaned:cleanup.cleaned,remaining:cleanup.remaining,deferred:cleanup.deferred};
    const reconcile=await retention.reconcilePrivacyExports(context,100,signal);
    result.reconcile={confirmed:reconcile.confirmed,reopened:reconcile.reopened,pending:reconcile.pending};
    result.backlog=await retention.privacyExportBacklog(context);
    result.ok=true;
  }catch(error){
    // owner_required covers the missing release row (identity_refused). Anything else is a real failure for the alarm.
    if(error instanceof OwnedStorageError&&error.code==='owner_required'){result.refused='retention_service_release_required';}
    else throw error;
  }
  (deps.emit??(line=>process.stdout.write(line+'\n')))(JSON.stringify(embeddedMetrics(result)));
  return result;
}
/** CloudWatch embedded metric format: counts only, no identifiers. */
export function embeddedMetrics(r:RetentionSweepResult){
  const b=r.backlog;
  return {_aws:{Timestamp:Date.now(),CloudWatchMetrics:[{Namespace:'ALP/PrivacyExportRetention',Dimensions:[[]],Metrics:[
    {Name:'SweepRefused',Unit:'Count'},{Name:'CleanupPending',Unit:'Count'},{Name:'CleanupDeferred',Unit:'Count'},{Name:'Settling',Unit:'Count'},
    {Name:'OldestOverdueSeconds',Unit:'Seconds'},{Name:'Reopened',Unit:'Count'},{Name:'Cleaned',Unit:'Count'}]}]},
    SweepRefused:r.refused?1:0,CleanupPending:b?.cleanupPending??0,CleanupDeferred:b?.deferred??0,Settling:b?.settling??0,
    OldestOverdueSeconds:b?.oldestOverdueSeconds??0,Reopened:r.reconcile?.reopened??0,Cleaned:r.cleanup?.cleaned??0,refused:r.refused,ok:r.ok};
}
export function retentionSweepConfigurationFromEnv(e:NodeJS.ProcessEnv):RetentionSweepConfiguration{
  return {enabled:e.RETENTION_SWEEP_ENABLED==='true',evidenceSha256:e.RETENTION_SWEEP_EVIDENCE_SHA256,servicePersonId:e.RETENTION_SERVICE_PERSON_ID,serviceSubject:e.RETENTION_SERVICE_SUBJECT,
    organizationId:e.RETENTION_SERVICE_ORGANIZATION_ID,bucket:e.PERSONAL_EXPORT_BUCKET,kmsKeyArn:e.PERSONAL_EXPORT_KMS_KEY_ARN,bucketOwner:e.PERSONAL_EXPORT_BUCKET_OWNER,region:e.AWS_REGION,phiAllowed:e.PHI_ALLOWED==='true'};
}
export async function handler(){
  const e=process.env,c=retentionSweepConfigurationFromEnv(e);
  if(!c.enabled)return {ok:false,refused:'retention_sweep_disabled'};
  const database=createRdsDataClinicalCoreDatabase({clusterArn:e.CLINICAL_DATABASE_CLUSTER_ARN??'',secretArn:e.CLINICAL_DATABASE_SECRET_ARN??'',databaseName:e.CLINICAL_DATABASE_NAME??'',region:e.AWS_REGION});
  return runRetentionSweep(database,c);
}
