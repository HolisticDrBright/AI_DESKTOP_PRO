/** Consumer-imported observations are not verified clinical evidence. Keeping
 * this collection separate avoids expanding the legacy clinic-sharing API. */
import { CONSUMER_CLINICAL_COLLECTIONS, validateCollectionPayload, type ConsumerClinicalCollection } from './aws-consumer-clinical-records';
import { ageAtDrawCollectionContextSchema } from './lab-range-population';
import type { z } from 'zod';

/** Owned storage refuses direct identifiers such as a date of birth, so the
 * personal copy carries the completed age at the draw instead. Restore keeps
 * that precision; profile agreement never establishes an exact birth date. */
export const ownedCollectionContextSchema = ageAtDrawCollectionContextSchema;
export type OwnedCollectionContext = z.infer<typeof ownedCollectionContextSchema>;

export const OWNED_COLLECTIONS = [...CONSUMER_CLINICAL_COLLECTIONS, 'lab_observations'] as const;
export type OwnedCollection = typeof OWNED_COLLECTIONS[number];
export type OwnedLabObservation = {
  id: string; panelId: string; markerId: string; panelName: string;
  name: string; value: number; unit: string | null; drawnAt: string;
  reportedRange: { low: number | null; high: number | null } | null;
  sourceStatus: 'consumer_import_unverified';
  /** Owner-recorded context at collection. Reproductive dimensions require an
   * active reproductive_health consent on write and on read. */
  collectionContext?: OwnedCollectionContext;
};
const REPRODUCTIVE_DIMENSIONS = ['pregnancyStatus','cyclePhase','reproductiveStage','contraception','pregnancyTrimester'] as const;
export function hasReproductiveCollectionContext(payload: Record<string,unknown>): boolean {
  const context=payload.collectionContext;
  if(!context||typeof context!=='object'||Array.isArray(context)) return false;
  return REPRODUCTIVE_DIMENSIONS.some(key=>(context as Record<string,unknown>)[key]!==null&&(context as Record<string,unknown>)[key]!==undefined);
}
/** Withdrawn reproductive consent hides the whole recorded context rather than
 * returning a partial record whose nulls would read as "not pregnant". */
export function withholdReproductiveContext(payload: Record<string,unknown>): Record<string,unknown> {
  if(!hasReproductiveCollectionContext(payload)) return payload;
  const { collectionContext:_omitted, ...rest } = payload; void _omitted;
  return rest;
}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validateOwnedPayload(collection: OwnedCollection, payload: Record<string,unknown>): void {
  if(collection!=='lab_observations') { validateCollectionPayload(collection as ConsumerClinicalCollection,payload); return; }
  const keys=['id','panelId','markerId','panelName','name','value','unit','drawnAt','reportedRange','sourceStatus'];
  const optional=['collectionContext'];
  const text=(v:unknown,max:number)=>typeof v==='string'&&v.trim().length>0&&v.length<=max;
  const num=(v:unknown)=>v===null||typeof v==='number'&&Number.isFinite(v);
  const range=payload.reportedRange as Record<string,unknown>|null;
  if(Object.keys(payload).some(k=>!keys.includes(k)&&!optional.includes(k))||keys.some(k=>!(k in payload))
    || !['id','panelId','markerId'].every(k=>typeof payload[k]==='string'&&UUID.test(payload[k] as string))
    || !text(payload.panelName,200)||!text(payload.name,160)||typeof payload.value!=='number'||!Number.isFinite(payload.value)
    || !(payload.unit===null||text(payload.unit,60))
    || typeof payload.drawnAt!=='string'||!/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/.test(payload.drawnAt)
    || !Number.isFinite(Date.parse(payload.drawnAt))||new Date(payload.drawnAt).toISOString()!==payload.drawnAt
    || Date.parse(payload.drawnAt)>Date.now()||payload.sourceStatus!=='consumer_import_unverified'
    || (range!==null && (!range||typeof range!=='object'||Array.isArray(range)
      || Object.keys(range).length!==2||!('low' in range)||!('high' in range)||!num(range.low)||!num(range.high)
      || (typeof range.low==='number'&&typeof range.high==='number'&&range.low>=range.high)))) {
    throw new Error('owned_lab_observation_invalid');
  }
  if('collectionContext' in payload) {
    // Context describes this draw only: undefined means absent, never null.
    const parsed=ownedCollectionContextSchema.safeParse(payload.collectionContext);
    if(!parsed.success||parsed.data.observedOn!==(payload.drawnAt as string).slice(0,10)) throw new Error('owned_lab_observation_invalid');
  }
}
