import type {ProductionClinicalRequestContext} from './aws-identity-consent';
import {clinicalUuid,ClinicalCoreDatabaseRejection,type ClinicalCoreDatabase} from './database';
import {privacyOperationSchema,parsePrivacyOperationResult,type PrivacyOperation} from '@/contracts/privacyOperations';
import {externalInventorySummarySchema} from '@/contracts/privacyOperations';
import type {ExternalInventoryReader} from './privacy-external-inventory';
import {z} from 'zod';
export class PrivacyOperationError extends Error{
  constructor(readonly code:'reauth_required'|'privacy_access_refused'|'request_invalid'|'conflict'|'legal_hold'|'service_unavailable'|'external_inventory_not_activated'|'personal_purge_not_activated'){super(code);}
}
export function createPrivacyOperations(database:ClinicalCoreDatabase,inventory?:()=>ExternalInventoryReader){
  return async(context:ProductionClinicalRequestContext,input:PrivacyOperation)=>{
    const parsed=privacyOperationSchema.safeParse(input);
    if(!parsed.success)throw new PrivacyOperationError('request_invalid');
    const v=parsed.data;
    if(context.identityPool!=='workforce'||context.purpose!=='consent_management'||context.environment!=='production-clinical'
      ||context.dataClassification!=='clinical_phi'||!context.productionBound||!context.containsPhi||!context.realPatientData)
      throw new PrivacyOperationError('privacy_access_refused');
    try{return await database.transaction(async tx=>{
      await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)',[
        clinicalUuid(context.actorPersonId),clinicalUuid(context.organizationId),context.identityPool,context.identitySubject,
        context.purpose,context.environment,context.dataClassification]);
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
    });}catch(error){
      if(error instanceof PrivacyOperationError)throw error;
      if(error instanceof ClinicalCoreDatabaseRejection){
        const code=error.category;
        throw new PrivacyOperationError(code==='identity_refused'||code==='operation_refused'?'privacy_access_refused':
          code==='conflict'||code==='legal_hold'||code==='request_invalid'?code:'service_unavailable');
      }
      throw new PrivacyOperationError('service_unavailable');
    }
  };
}
function decode(value:unknown):unknown{return typeof value==='string'?JSON.parse(value):value;}
