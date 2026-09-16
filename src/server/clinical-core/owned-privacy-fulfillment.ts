import {createHash} from 'node:crypto';
import type {PrivacyStore} from './owned-privacy-requests';
/** Store-by-store fulfillment of a deletion request for one verified owner.
 * Every step is attributable, bounded and idempotent; every receipt carries
 * only counts and a fingerprint of identifiers, never content. Nothing is
 * reported as erased that the store did not confirm, and stores this
 * orchestrator cannot enumerate are reported as such. Backups and audit
 * records are governed by the retention policy, not by this operation. */
export type FulfillmentReceipt={store:PrivacyStore;outcome:'tombstoned'|'purged'|'not_applicable'|'pending'|'refused'|'not_enumerable'|'retained_by_policy';
  count:number;evidenceSha256:string;detail:string};
export type LabStore={
  listOwnedJobs(cursor?:string):Promise<{jobs:{jobId:string;state:string}[];nextCursor:string|null}>;
  deleteOrCancel(jobId:string,active:boolean):Promise<{deleted:true;cleanupStatus:string}>;
};
export type IdentityStore={
  disable(identitySubject:string):Promise<void>;
  globalSignOut(identitySubject:string):Promise<void>;
  delete(identitySubject:string):Promise<void>;
};
export type FulfillmentInput={
  ownerScope:{ownerSub:string;organizationId:string;personId:string};
  lab?:LabStore;
  identity?:IdentityStore;
  /** Identity deletion is irreversible and only allowed after every other store completed. */
  confirmIdentityDeletion?:true;
  maxJobs?:number;
};
const ACTIVE=new Set(['awaiting_upload','queued','extracting','verifying','normalizing','interpreting','synthesizing']);
const fingerprint=(rows:unknown[])=>createHash('sha256').update(JSON.stringify([...rows].map(r=>JSON.stringify(r)).sort())).digest('hex');
export async function fulfillOwnerDeletion(input:FulfillmentInput):Promise<{receipts:FulfillmentReceipt[];complete:false}>{
  if(!/^[A-Za-z0-9:_-]{8,128}$/.test(input.ownerScope.ownerSub))throw new Error('privacy_fulfillment_scope_invalid');
  const receipts:FulfillmentReceipt[]=[];
  // Lab jobs and documents: enumerate the owner's inventory and drive the
  // existing deletion outbox. Active jobs are cancelled (explicit removal of
  // unfinished work); completed ones are deleted. Object cleanup is the
  // outbox's responsibility and its receipt says late_upload_watch, not erased.
  if(input.lab){
    const seen=new Set<string>();const ids:string[]=[];let cursor:string|undefined;let pages=0;let refused=0;
    try{
      do{
        const page=await input.lab.listOwnedJobs(cursor);
        if(page.jobs.length>20||(page.nextCursor!==null&&(typeof page.nextCursor!=='string'||seen.has(page.nextCursor))))throw new Error('privacy_fulfillment_inventory_invalid');
        for(const job of page.jobs){
          if(!/^[0-9a-f-]{36}$/i.test(job.jobId)||ids.includes(job.jobId))throw new Error('privacy_fulfillment_inventory_invalid');
          if(ids.length>=(input.maxJobs??500))throw new Error('privacy_fulfillment_bounded');
          const result=await input.lab.deleteOrCancel(job.jobId,ACTIVE.has(job.state));
          if(result.deleted!==true)refused++;else ids.push(job.jobId);
        }
        if(page.nextCursor)seen.add(page.nextCursor);cursor=page.nextCursor??undefined;pages++;
        if(pages>50)throw new Error('privacy_fulfillment_bounded');
      }while(cursor);
      receipts.push({store:'lab_jobs_and_documents',outcome:refused?'pending':'tombstoned',count:ids.length,evidenceSha256:fingerprint(ids),
        detail:refused?`${refused} job(s) refused deletion; retry required`:'jobs claimed for deletion; object cleanup runs through the durable outbox (late_upload_watch)'});
    }catch{
      receipts.push({store:'lab_jobs_and_documents',outcome:'pending',count:ids.length,evidenceSha256:fingerprint(ids),detail:'privacy_fulfillment_retry_required'});
    }
  }else receipts.push({store:'lab_jobs_and_documents',outcome:'pending',count:0,evidenceSha256:fingerprint([]),detail:'lab store not attached to this run'});
  // Voice jobs have no per-owner index; they cannot be enumerated safely here.
  receipts.push({store:'voice_jobs_and_transcripts',outcome:'not_enumerable',count:0,evidenceSha256:fingerprint([]),detail:'no owner index; requires the owned voice inventory and a reviewed per-owner drain'});
  // Missing inventory and unverified retention are blockers, not evidence of
  // erasure. Include every store before considering irreversible identity work.
  for (const store of ['personal_records','personal_consents','active_plan','clinic_records'] as const) {
    receipts.push({store,outcome:'pending',count:0,evidenceSha256:fingerprint([]),detail:'verified operator fulfillment receipt required'});
  }
  receipts.push({store:'device_caches_and_recovery_archives',outcome:'not_enumerable',count:0,evidenceSha256:fingerprint([]),detail:'device-held data is not reachable from this service; reviewed disposition required'});
  receipts.push({store:'backups_and_audit',outcome:'pending',count:0,evidenceSha256:fingerprint([]),detail:'approved retention and legal-hold disposition must be verified; no erasure asserted'});
  // Identity is last. This candidate cannot yet verify all stores, retention,
  // and holds, so neither disable nor sign-out nor deletion may run.
  if(input.identity){
    const pending=receipts.some(r=>!['purged','not_applicable'].includes(r.outcome));
    if(input.confirmIdentityDeletion!==true||pending){
      receipts.push({store:'identity',outcome:'pending',count:0,evidenceSha256:fingerprint([input.ownerScope.ownerSub]),detail:pending?'other stores pending':'explicit confirmation required'});
    }else{
      try{
        await input.identity.disable(input.ownerScope.ownerSub);
        await input.identity.globalSignOut(input.ownerScope.ownerSub);
        await input.identity.delete(input.ownerScope.ownerSub);
        receipts.push({store:'identity',outcome:'purged',count:1,evidenceSha256:fingerprint([input.ownerScope.ownerSub]),detail:'disabled, signed out and deleted in the consumer pool'});
      }catch{
        receipts.push({store:'identity',outcome:'pending',count:0,evidenceSha256:fingerprint([input.ownerScope.ownerSub]),detail:'privacy_identity_retry_required'});
      }
    }
  }else receipts.push({store:'identity',outcome:'pending',count:0,evidenceSha256:fingerprint([]),detail:'identity store not attached to this run'});
  return {receipts,complete:false};
}
