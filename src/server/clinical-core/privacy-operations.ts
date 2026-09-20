import type {ProductionClinicalRequestContext} from './aws-identity-consent';
import {clinicalUuid,ClinicalCoreDatabaseRejection,type ClinicalCoreDatabase} from './database';
import {privacyOperationSchema,parsePrivacyOperationResult,type PrivacyOperation} from '@/contracts/privacyOperations';
import {externalInventorySummarySchema} from '@/contracts/privacyOperations';
import type {ExternalInventoryReader} from './privacy-external-inventory';
import type {ExternalPurgeExecutor,ExternalPurgeOutcome} from './privacy-external-purge';
import type {ConsumerIdentityDeleter} from './owned-identity-deletion';
import {OwnedStorageError} from './owned-consumer-records';
import {createPrivacyExportRetention,type PrivacyExportObjectStorage,type PrivacyExportStore} from './owned-privacy-export-job';
import {z} from 'zod';
export class PrivacyOperationError extends Error{
  constructor(readonly code:'reauth_required'|'privacy_access_refused'|'request_invalid'|'conflict'|'legal_hold'|'service_unavailable'|'external_inventory_not_activated'|'personal_purge_not_activated'|'external_purge_not_activated'|'export_cleanup_not_activated',cause?:unknown){super(code,cause===undefined?undefined:{cause});}
}
type Tx=Parameters<Parameters<ClinicalCoreDatabase['transaction']>[0]>[0];
const purgeBatchSchema=z.object({ownerId:z.string().uuid(),ownerSub:z.string().regex(/^[A-Za-z0-9:_-]{8,128}$/),
  items:z.array(z.object({kind:z.enum(['lab_job','lab_cleanup','voice_job']),jobId:z.string().min(1).max(64),
    organizationId:z.string().uuid(),inventoryState:z.string().min(1).max(40),attempts:z.number().int().min(0).max(1000)}).strict()).max(10),
  summary:z.unknown()}).strict();
const identityBeginSchema=z.object({ownerId:z.string().uuid(),identitySubject:z.string().regex(/^[A-Za-z0-9:_-]{8,128}$/),
  providerState:z.enum(['disabled','signed_out','deleted','absent']),completedAt:z.string().nullable()}).passthrough();
export type PrivacyExportRetentionDelivery={store:PrivacyExportStore;storage:PrivacyExportObjectStorage};
export function createPrivacyOperations(database:ClinicalCoreDatabase,inventory?:()=>ExternalInventoryReader,purge?:()=>ExternalPurgeExecutor,identity?:()=>ConsumerIdentityDeleter,
  exportRetention?:()=>PrivacyExportRetentionDelivery){
  const withContext=async<T>(context:ProductionClinicalRequestContext,work:(tx:Tx)=>Promise<T>):Promise<T>=>{
    try{return await database.transaction(async tx=>{
      await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)',[
        clinicalUuid(context.actorPersonId),clinicalUuid(context.organizationId),context.identityPool,context.identitySubject,
        context.purpose,context.environment,context.dataClassification]);
      return work(tx);
    });}catch(error){throw mapError(error);}
  };
  return async(context:ProductionClinicalRequestContext,input:PrivacyOperation)=>{
    const parsed=privacyOperationSchema.safeParse(input);
    if(!parsed.success)throw new PrivacyOperationError('request_invalid');
    const v=parsed.data;
    if(context.identityPool!=='workforce'||context.purpose!=='consent_management'||context.environment!=='production-clinical'
      ||context.dataClassification!=='clinical_phi'||!context.productionBound||!context.containsPhi||!context.realPatientData)
      throw new PrivacyOperationError('privacy_access_refused');
    if(v.action==='cleanupExports'||v.action==='reconcileExports'||v.action==='exportBacklog'){
      // Retention independent of the owner: finished and deadline-passed export jobs of assigned owners are removed
      // from the reviewed bucket with listing proof and certified under the owner lock, one short transaction each;
      // certified removals are reconciled again after the settlement window; the backlog is counts only.
      if(!exportRetention)throw new PrivacyOperationError('service_unavailable');
      const retention=createPrivacyExportRetention((c,work)=>withContext(c,work),exportRetention(),'operator');
      try{
        const signal=AbortSignal.timeout(50_000);
        const result=v.action==='cleanupExports'?await retention.cleanupAssignedPrivacyExports(context,v.maxItems,signal)
          :v.action==='reconcileExports'?await retention.reconcilePrivacyExports(context,v.maxItems,signal)
          :await retention.privacyExportBacklog(context);
        return parsePrivacyOperationResult(v,result);
      }catch(error){
        if(error instanceof PrivacyOperationError)throw error;
        if(error instanceof OwnedStorageError)throw new PrivacyOperationError(error.code==='owner_required'?'privacy_access_refused':error.code==='request_invalid'?'request_invalid':error.code==='conflict'?'conflict':'service_unavailable');
        throw mapError(error);
      }
    }
    if(v.action==='purgeExternal'){
      // Multiple short transactions: the batch is chosen under the request lock,
      // each remote mutation then runs under its own guarded lock, and each
      // outcome is recorded as soon as the store reported it.
      if(!purge)throw new PrivacyOperationError('service_unavailable');
      const executor=purge();
      const begun=purgeBatchSchema.parse(decode((await withContext(context,tx=>tx.query<{result:unknown}>(
        'select clinical_private.begin_owned_external_purge($1,$2,$3) as result',[clinicalUuid(v.privacyRequestId),clinicalUuid(v.inventoryId),v.maxItems]))).rows[0]?.result));
      let summary:unknown=begun.summary;
      const scope={ownerId:begun.ownerId,ownerSub:begun.ownerSub};
      for(const item of begun.items){
        let outcome:ExternalPurgeOutcome;
        try{outcome=await executor.purge(v.store,{...scope,organizationId:item.organizationId},item);}
        catch{outcome={state:'refused',detail:'executor_failure'};}
        if(!['cleaned','claimed','not_found','refused'].includes(outcome.state)||typeof outcome.detail!=='string'||!outcome.detail.trim())outcome={state:'refused',detail:'executor_outcome_invalid'};
        summary=decode((await withContext(context,tx=>tx.query<{result:unknown}>(
          'select clinical_private.record_owned_external_purge_item($1,$2,$3,$4,$5) as result',
          [clinicalUuid(v.inventoryId),item.kind,item.jobId,outcome.state,outcome.detail.slice(0,120)]))).rows[0]?.result);
      }
      const progress=z.object({remaining:z.number().int().min(0),inventoryState:z.string()}).passthrough().parse(summary);
      if(progress.remaining===0&&progress.inventoryState!=='scanning'){
        summary=decode((await withContext(context,tx=>tx.query<{result:unknown}>(
          'select clinical_private.finish_owned_external_purge($1,$2) as result',[clinicalUuid(v.privacyRequestId),clinicalUuid(v.inventoryId)]))).rows[0]?.result);
      }
      return parsePrivacyOperationResult(v,summary);
    }
    if(v.action==='purgeIdentity'){
      // Identity is last. The database identity is disabled under the request lock
      // before the provider is called; the store is recorded only from the provider's
      // own confirmation, and the detail returned comes from a fresh read.
      if(!identity)throw new PrivacyOperationError('service_unavailable');
      const begun=identityBeginSchema.parse(decode((await withContext(context,tx=>tx.query<{result:unknown}>(
        'select clinical_private.begin_owned_identity_deletion($1) as result',[clinicalUuid(v.privacyRequestId)]))).rows[0]?.result));
      if(begun.completedAt===null){
        const deleter=identity();
        const record=(state:string,evidence:string)=>withContext(context,tx=>tx.query('select clinical_private.record_owned_identity_deletion($1,$2,$3)',[clinicalUuid(v.privacyRequestId),state,evidence]));
        let outcome:Awaited<ReturnType<ConsumerIdentityDeleter['delete']>>;
        // The database identity is already disabled; a provider failure leaves the
        // account locked and unrecorded so the operator retries with the same ledger row.
        try{outcome=await deleter.delete(begun.identitySubject);}
        catch(error){throw new PrivacyOperationError('service_unavailable',error);}
        await record(outcome.state,outcome.evidenceSha256);
      }
      return withContext(context,async tx=>{
        const result=await tx.query<{result:unknown}>('select clinical_private.get_assigned_privacy_request($1) as result',[clinicalUuid(v.privacyRequestId)]);
        return parsePrivacyOperationResult(v,decode(result.rows[0]?.result));
      });
    }
    return withContext(context,async tx=>{
      if(v.action==='recordDisposition'){
        await tx.query('select clinical_private.record_owned_privacy_fulfillment($1,$2,$3,$4)',[clinicalUuid(v.privacyRequestId),v.store,v.outcome,v.evidenceSha256]);
      }
      if(v.action==='retainByPolicy'){
        await tx.query('select clinical_private.record_owned_privacy_retention($1,$2,$3,$4)',[clinicalUuid(v.privacyRequestId),v.store,v.evidenceSha256,v.policyVersion]);
      }
      if(v.action==='completeDeletion'){
        await tx.query('select clinical_private.complete_owned_privacy_request($1)',[clinicalUuid(v.privacyRequestId)]);
      }
      if(v.action==='externalInventory'){
        if(!inventory)throw new PrivacyOperationError('service_unavailable');
        const reader=inventory();
        const opened=await tx.query<{result:unknown}>('select clinical_private.open_owned_external_inventory($1,$2,$3,$4) as result',
          [clinicalUuid(v.privacyRequestId),clinicalUuid(v.inventoryId),v.store,reader.source(v.store)]);
        const privateResult=z.object({ownerId:z.string().uuid(),ownerSub:z.string().regex(/^[A-Za-z0-9:_-]{8,128}$/),
          cursor:z.unknown(),summary:externalInventorySummarySchema}).strict().parse(decode(opened.rows[0]?.result));
        const summary=privateResult.summary;
        if(summary.inventoryId!==v.inventoryId||summary.privacyRequestId!==v.privacyRequestId||summary.store!==v.store)
          throw new PrivacyOperationError('service_unavailable');
        // Exact prior revision retry returns the committed page, never rescans.
        if(summary.revision===v.expectedRevision+1||summary.revision===v.expectedRevision&&summary.state!=='scanning')
          return parsePrivacyOperationResult(v,summary);
        if(summary.revision!==v.expectedRevision)throw new PrivacyOperationError('conflict');
        const page=await reader.read(v.store,privateResult,privateResult.cursor);
        const saved=await tx.query<{result:unknown}>('select clinical_private.append_owned_external_inventory($1,$2,$3::jsonb,$4::jsonb,$5,$6) as result',
          [clinicalUuid(v.inventoryId),v.expectedRevision,JSON.stringify(page.items),page.cursor===null?null:JSON.stringify(page.cursor),page.scanned,page.issues]);
        return parsePrivacyOperationResult(v,decode(saved.rows[0]?.result));
      }
      if(v.action==='list'){
        const result=await tx.query<{result:unknown}>('select clinical_private.list_assigned_privacy_requests($1,25,$2) as result',
          [v.after?clinicalUuid(v.after):null,v.includeClosed]);
        const items=decode(result.rows[0]?.result);
        if(!Array.isArray(items))throw new Error('shape');
        return parsePrivacyOperationResult(v,{items,nextAfter:items.length===25?items.at(-1)?.privacyRequestId:null});
      }
      if(v.action==='resolve')await tx.query('select clinical_private.resolve_owned_correction($1,$2,$3,$4)',
        [clinicalUuid(v.privacyRequestId),v.outcome,v.appliedRevision,v.explanation]);
      if(v.action==='previewPersonalPurge'||v.action==='purgePersonal'){
        const result=v.action==='previewPersonalPurge'
          ?await tx.query<{result:unknown}>('select clinical_private.preview_owned_personal_purge($1,$2) as result',[clinicalUuid(v.privacyRequestId),v.policyVersion])
          :await tx.query<{result:unknown}>('select clinical_private.execute_owned_personal_purge($1,$2,$3,$4,$5,$6) as result',
            [clinicalUuid(v.privacyRequestId),clinicalUuid(v.commandId),v.policyVersion,v.policySha256,v.inventorySha256,v.confirmation]);
        return parsePrivacyOperationResult(v,decode(result.rows[0]?.result));
      }
      const result=await tx.query<{result:unknown}>('select clinical_private.get_assigned_privacy_request($1) as result',[clinicalUuid(v.privacyRequestId)]);
      return parsePrivacyOperationResult(v,decode(result.rows[0]?.result));
    });
  };
}
function mapError(error:unknown):PrivacyOperationError{
  if(error instanceof PrivacyOperationError)return error;
  if(error instanceof ClinicalCoreDatabaseRejection){
    const code=error.category;
    return new PrivacyOperationError(code==='identity_refused'||code==='operation_refused'?'privacy_access_refused':
      code==='conflict'||code==='legal_hold'||code==='request_invalid'?code:'service_unavailable');
  }
  // The cause stays server-side for logs; the API never forwards it.
  return new PrivacyOperationError('service_unavailable',error);
}
function decode(value:unknown):unknown{return typeof value==='string'?JSON.parse(value):value;}
