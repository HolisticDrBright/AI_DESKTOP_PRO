/** Consumer-imported observations are not verified clinical evidence. Keeping
 * this collection separate avoids expanding the legacy clinic-sharing API. */
import { CONSUMER_CLINICAL_COLLECTIONS, validateCollectionPayload, type ConsumerClinicalCollection } from './aws-consumer-clinical-records';
import { ageAtDrawCollectionContextSchema } from './lab-range-population';
import type { z } from 'zod';
import { personalMealBackupSchema } from '@/contracts/personalMealBackup';
import { dietPreferencesSchema } from '@/contracts/personalDietPreferences';
import { PERSONAL_LAB_ANALYSIS_MAX_BYTES, personalLabAnalysisEnvelopeSchema } from '@/contracts/personalLabAnalysis';
import { createHash } from 'node:crypto';

/** Owned storage refuses direct identifiers such as a date of birth, so the
 * personal copy carries the completed age at the draw instead. Restore keeps
 * that precision; profile agreement never establishes an exact birth date. */
export const ownedCollectionContextSchema = ageAtDrawCollectionContextSchema;
export type OwnedCollectionContext = z.infer<typeof ownedCollectionContextSchema>;

export const OWNED_COLLECTIONS = [...CONSUMER_CLINICAL_COLLECTIONS, 'lab_observations', 'diet_preferences', 'lab_analyses'] as const;
export type OwnedCollection = typeof OWNED_COLLECTIONS[number];
/** Durable analysis copies carry a whole completed result and get a larger
 * byte budget than ordinary personal records; the database enforces the same
 * collection-aware limit. */
export const OWNED_PAYLOAD_LIMIT_BYTES = 16_384;
export function ownedPayloadLimit(collection: string): number {
  return collection === 'lab_analyses' ? PERSONAL_LAB_ANALYSIS_MAX_BYTES : OWNED_PAYLOAD_LIMIT_BYTES;
}
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
function canonicalJsonValue(value: unknown): string {
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return `[${value.map(canonicalJsonValue).join(',')}]`;
  const object=value as Record<string,unknown>;
  return `{${Object.keys(object).sort().map(key=>`${JSON.stringify(key)}:${canonicalJsonValue(object[key])}`).join(',')}}`;
}
export function validateOwnedPayload(collection: OwnedCollection, payload: Record<string,unknown>): void {
  if(collection==='lab_analyses'){
    const parsed=personalLabAnalysisEnvelopeSchema.safeParse(payload);
    if(!parsed.success||Date.parse(parsed.data.completedAt)>Date.now()
      ||createHash('sha256').update(canonicalJsonValue(parsed.data.result)).digest('hex')!==parsed.data.resultSha256)throw new Error('owned_lab_analysis_invalid');
    return;
  }
  if(collection==='diet_preferences'){
    const parsed=dietPreferencesSchema.safeParse(payload);
    if(!parsed.success||Date.parse(parsed.data.updatedAt)>Date.now())throw new Error('owned_diet_preferences_invalid');
    return;
  }
  // Full meal copies are private owned storage only. The legacy clinic-sharing
  // payload and consent contract are deliberately not expanded.
  if(collection==='meal_logs' && Object.hasOwn(payload,'details')) {
    if(!personalMealBackupSchema.safeParse(payload).success)throw new Error('owned_meal_backup_invalid');
    return;
  }
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
