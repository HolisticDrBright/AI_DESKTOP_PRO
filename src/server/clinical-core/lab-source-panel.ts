import { z } from 'zod';
import { collectionRangeContextSchema } from './lab-range-population';
export const labSourcePanelSchema=z.object({
  panelId:z.string().trim().min(1).max(160),
  panelName:z.string().trim().min(1).max(180),
  testDate:z.string().date(),
}).strict();
export type LabSourcePanel=z.infer<typeof labSourcePanelSchema>;
/** Preserve recorded provenance; never manufacture a date from upload time. */
export function resolveLabSourcePanel(job:{
  sourcePanel?:unknown;
  longitudinalContext?:{incomingPanel:unknown};
  structuredBiomarkers?:Array<{collectionContext?:unknown}>;
}):LabSourcePanel|null{
  const current=job.sourcePanel===undefined?null:labSourcePanelSchema.parse(job.sourcePanel);
  const historical=job.longitudinalContext?labSourcePanelSchema.parse(job.longitudinalContext.incomingPanel):null;
  if(current&&historical&&(current.panelId!==historical.panelId||current.panelName!==historical.panelName||current.testDate!==historical.testDate))
    throw new Error('lab_source_panel_mismatch');
  const source=current??historical;
  if(source&&source.testDate>new Date().toISOString().slice(0,10))throw new Error('lab_source_date_invalid');
  for(const row of job.structuredBiomarkers??[]){
    if(row.collectionContext===undefined)continue;
    const context=collectionRangeContextSchema.parse(row.collectionContext);
    if(!source||context.observedOn!==source.testDate)throw new Error('lab_collection_date_mismatch');
  }
  return source;
}
