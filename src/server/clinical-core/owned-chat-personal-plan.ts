import {OwnedStorageError, type OwnedRecord} from './owned-consumer-records';

/** Consumer-owned history is not proof of generation, efficacy, or clinical approval.
 * Deliberately excludes generation_json, affiliate links and peptide protocols. */
export function personalPlanContext(rows:OwnedRecord[]) {
  const row=[...rows].filter(r=>r.payload.status==='active')
    .sort((a,b)=>b.receivedAt.localeCompare(a.receivedAt)||b.recordId.localeCompare(a.recordId))[0];
  if(!row)return null;
  const p=row.payload;
  const bounded=(v:unknown,max:number):string=>{
    if(typeof v!=='string'||!v.trim()||v.length>max)throw new OwnedStorageError('storage_unavailable');
    return v;
  };
  const objects=(v:unknown,max:number):Record<string,unknown>[]=>{
    if(!Array.isArray(v)||v.length>max||v.some(x=>!x||typeof x!=='object'||Array.isArray(x)))throw new OwnedStorageError('storage_unavailable');
    return v as Record<string,unknown>[];
  };
  const recordedText=(v:unknown,max:number)=>v===undefined||v===null||v===''?null:bounded(v,max);
  if(!Number.isInteger(p.version)||Number(p.version)<1)throw new OwnedStorageError('storage_unavailable');
  return {
    contractVersion:'consumer-plan-context/1' as const,
    reviewStatus:'not_clinician_reviewed' as const,
    sourceStatus:'consumer_saved_unverified' as const,
    recordId:row.recordId,recordRevision:row.revision,recordedAt:row.receivedAt,
    name:bounded(p.name,200),version:Number(p.version),status:'active' as const,
    omittedSupplementCount:0,omittedTaskCount:0,
    recordedSupplements:objects(p.supplements_json,200).map(s=>({
      name:bounded(s.name,200),dose:recordedText(s.dose,200),frequency:recordedText(s.frequency,120),
    })),
    recordedTasks:objects(p.lifestyle_tasks_json,100).map(t=>({
      name:bounded(t.name,200),frequency:recordedText(t.frequency,120),
    })),
  };
}
