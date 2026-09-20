import { createOwnedActivePlan } from './owned-active-plan';
import { createOwnedPrivacyRequests } from './owned-privacy-requests';
import { canonicalPayload } from "./aws-consumer-clinical-records";
import { OWNED_COLLECTIONS, hasReproductiveCollectionContext, ownedPayloadLimit, validateOwnedPayload as validateCollectionPayload, withholdReproductiveContext, type OwnedCollection as ConsumerClinicalCollection } from './owned-lab-observations';
import type { ProductionClinicalRequestContext } from "./aws-identity-consent";
import { createHash } from "node:crypto";
import { clinicalUuid, ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase, type ClinicalCoreTransaction } from "./database";
import { createOwnedPrivacyExport } from './owned-privacy-export';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const OWNED_STORAGE_SCOPES = ["forms_checkins","symptoms_adherence","nutrition","protocols_supplements","wearables","reproductive_health","ai_context","lab_history","voice_transcription"] as const;
export type OwnedStorageScope = typeof OWNED_STORAGE_SCOPES[number];
export type OwnedRecordWrite = {
  collection: ConsumerClinicalCollection; recordId: string; expectedRevision: number;
  requestId: string; payload: Record<string, unknown>; deleted: boolean; consentRevision: number;
};
type WriteResult = { recordId: string; revision: number; duplicate: boolean; receivedAt: string };
export type OwnedRecord = { recordId: string; revision: number; payload: Record<string, unknown>; receivedAt: string };
export type OwnedTombstone = { recordId: string; revision: number; deleted: true; receivedAt: string };
export type StorageConsentState = {
  scope: OwnedStorageScope;
  release: {version:string;content:string;contentSha256:string;approvedAt:string} | null;
  current: {revision:number;status:"granted"|"revoked";releaseVersion:string;recordedAt:string} | null;
  history: Array<{revision:number;status:"granted"|"revoked";releaseVersion:string;recordedAt:string}>;
  historyLimit: number; activeRevision: number | null;
};
export class OwnedStorageError extends Error {
  constructor(readonly code: "request_invalid" | "owner_required" | "storage_unavailable" | "consent_required" | "conflict" | "legal_hold" | "account_deletion_write_blocked") { super(code); }
}

/** Internal production adapter, not an activation switch. The public workload
 * must independently verify rollout/PHI policy before calling it. No clinic
 * connection, recipient ID, or caller-selected owner is accepted in requests. */
export function createOwnedConsumerRecordsAdapter(database: ClinicalCoreDatabase) {
  const run = <T>(context: ProductionClinicalRequestContext, purpose: "clinical_data" | "consent_management", work: (tx: ClinicalCoreTransaction) => Promise<T>) => {
    if (context.identityPool !== "consumer" || context.purpose !== purpose
      || context.environment !== "production-clinical" || context.dataClassification !== "clinical_phi"
      || context.containsPhi !== true || context.realPatientData !== true || context.productionBound !== true
      || !UUID.test(context.actorPersonId) || !UUID.test(context.organizationId)
      || !/^[A-Za-z0-9:_-]{8,128}$/.test(context.identitySubject)) throw new OwnedStorageError("owner_required");
    return database.transaction(async tx => {
      await tx.query("select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)", [
        clinicalUuid(context.actorPersonId), clinicalUuid(context.organizationId), context.identityPool,
        context.identitySubject, context.purpose, context.environment, context.dataClassification,
      ]);
      return work(tx);
    }).catch(error => {
      if (error instanceof OwnedStorageError) throw error;
      if (error instanceof ClinicalCoreDatabaseRejection) {
        if (error.category === "identity_refused") throw new OwnedStorageError("owner_required");
        if (["consent_required","conflict","request_invalid","legal_hold","account_deletion_write_blocked"].includes(error.category)) {
          throw new OwnedStorageError(error.category as "consent_required" | "conflict" | "request_invalid" | "legal_hold" | "account_deletion_write_blocked");
        }
      }
      throw new OwnedStorageError("storage_unavailable");
    });
  };
  return {
    /** Consent-management transaction under the same identity gate and rejection mapping; used by export jobs. */
    runPrivacy:<T>(context:ProductionClinicalRequestContext,work:(tx:ClinicalCoreTransaction)=>Promise<T>)=>run(context,'consent_management',work),
    ...createOwnedPrivacyExport((context, work) => run(context, 'consent_management', work)),
    ...createOwnedActivePlan((context, work) => run(context, 'clinical_data', work)),
    ...createOwnedPrivacyRequests((context, work) => run(context, 'consent_management', work)),
    async recent(context:ProductionClinicalRequestContext,input:{collection:ConsumerClinicalCollection;limit:number}):Promise<OwnedRecord[]> {
      exactKeys(input,['collection','limit']);collection(input.collection);if(!Number.isInteger(input.limit)||input.limit<1||input.limit>100)invalid();
      return run(context,'clinical_data',async tx=>{
        const result=await tx.query<{result:unknown}>('select clinical_core.recent_owned_consumer_records($1,$2::integer) as result',[input.collection,input.limit]);
        const values=parsed(result.rows[0]?.result);if(!Array.isArray(values)||values.length>input.limit)unavailable();
        const rows=values.map(raw=>{const v=object(raw);if(typeof v.recordId!=='string'||!UUID.test(v.recordId)||!revision(v.revision,1)||!date(v.receivedAt))unavailable();const payload=object(v.payload);try{validateCollectionPayload(input.collection,payload);}catch{unavailable();}return {recordId:v.recordId as string,revision:v.revision as number,payload,receivedAt:v.receivedAt as string};});
        return redactWithdrawnContext(tx,input.collection,rows);
      });
    },
    async get(context: ProductionClinicalRequestContext,input: {collection:ConsumerClinicalCollection;recordId:string}): Promise<(OwnedRecord & {deleted:boolean}) | null> {
      exactKeys(input,["collection","recordId"]); collection(input.collection);
      if (!UUID.test(input.recordId)) invalid();
      return run(context,"clinical_data",async tx => {
        const result = await tx.query<{result:unknown}>("select clinical_core.get_owned_consumer_record($1,$2) as result",[input.collection,clinicalUuid(input.recordId)]);
        const raw = parsed(result.rows[0]?.result); if (raw === null) return null;
        const value = object(raw);
        if (value.recordId !== input.recordId || !revision(value.revision,1) || typeof value.deleted !== "boolean" || !date(value.receivedAt)) unavailable();
        const payload = object(value.payload);
        try { const encoded=canonicalPayload(payload,ownedPayloadLimit(input.collection)); if (value.deleted ? encoded !== "{}" : false) unavailable(); if (!value.deleted) validateCollectionPayload(input.collection,payload); } catch { unavailable(); }
        const [row]=await redactWithdrawnContext(tx,input.collection,[{recordId:input.recordId,revision:value.revision as number,payload,receivedAt:value.receivedAt as string}]);
        return {...row,deleted:value.deleted as boolean};
      });
    },
    async consentState(context:ProductionClinicalRequestContext,scope:OwnedStorageScope): Promise<StorageConsentState> {
      if (!OWNED_STORAGE_SCOPES.includes(scope)) invalid();
      return run(context,"consent_management",async tx => {
        const result=await tx.query<{result:unknown}>("select clinical_core.get_owned_storage_consent_state($1) as result",[scope]);
        return parseConsentState(result.rows[0]?.result,scope);
      });
    },
    async processingConsentStates(context:ProductionClinicalRequestContext,operation:'lab'|'voice'):Promise<StorageConsentState[]> {
      if(!['lab','voice'].includes(operation))invalid();
      return run(context,'consent_management',async tx=>{
        const result=await tx.query<{result:unknown}>('select clinical_core.get_owned_processing_consent_states($1) as result',[operation]);
        const value=object(result.rows[0]?.result);
        if(value.version!=='owned-processing-consent/1'||value.ownerId!==context.actorPersonId||value.operation!==operation
          ||!Array.isArray(value.states)||value.states.length!==2)unavailable();
        return [parseConsentState(value.states[0],'ai_context'),parseConsentState(value.states[1],operation==='lab'?'lab_history':'voice_transcription')];
      });
    },
    async write(context: ProductionClinicalRequestContext, input: OwnedRecordWrite): Promise<WriteResult> {
      exactKeys(input,["collection","recordId","expectedRevision","requestId","payload","deleted","consentRevision"]);
      collection(input.collection);
      if (!UUID.test(input.recordId) || !UUID.test(input.requestId) || !revision(input.expectedRevision,0)
        || !revision(input.consentRevision,1) || typeof input.deleted !== "boolean"
        || !input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)) invalid();
      let payload: string;
      if (input.payload.id !== undefined && input.payload.id !== input.recordId) invalid();
      try {
        if (!input.deleted) validateCollectionPayload(input.collection,input.payload);
        payload = canonicalPayload(input.payload,ownedPayloadLimit(input.collection));
      } catch { invalid(); }
      if (input.deleted && payload !== "{}") invalid();
      const reproductive = !input.deleted && input.collection === "lab_observations" && hasReproductiveCollectionContext(input.payload);
      return run(context,"clinical_data",async tx => {
        // lab_history consent is checked by the SQL function; reproductive
        // dimensions additionally need the owner's reproductive_health consent,
        // checked under the same owner lock as consent withdrawal. A database
        // trigger also enforces this for callers bypassing this adapter.
        if (reproductive && !(await reproductiveConsentActive(tx))) throw new OwnedStorageError("consent_required");
        const result = await tx.query<{ result: unknown }>("select clinical_core.write_owned_consumer_record($1,$2,$3::integer,$4,$5::jsonb,$6,$7::integer) as result", [
          input.collection,clinicalUuid(input.recordId),input.expectedRevision,clinicalUuid(input.requestId),payload,input.deleted,input.consentRevision,
        ]);
        const value = object(result.rows[0]?.result);
        if (value.recordId !== input.recordId || !revision(value.revision,1) || typeof value.duplicate !== "boolean" || !date(value.receivedAt)) unavailable();
        return { recordId: value.recordId as string, revision: value.revision as number, duplicate: value.duplicate as boolean, receivedAt: value.receivedAt as string };
      });
    },
    async list(context: ProductionClinicalRequestContext, input: {
      collection: ConsumerClinicalCollection; limit: number; after?: { receivedAt: string; recordId: string };
    }): Promise<OwnedRecord[]> {
      exactKeys(input,["collection","limit","after"]);
      collection(input.collection);
      if (!Number.isInteger(input.limit) || input.limit<1 || input.limit>100) invalid();
      if (input.after) {
        exactKeys(input.after,["receivedAt","recordId"]);
        if (!date(input.after.receivedAt) || !UUID.test(input.after.recordId)) invalid();
      }
      return run(context,"clinical_data",async tx => {
        const result = await tx.query<{ result: unknown }>("select clinical_core.list_owned_consumer_records($1,$2::integer,$3::timestamptz,$4::uuid) as result", [
          input.collection,input.limit,input.after?.receivedAt ?? null,input.after ? clinicalUuid(input.after.recordId) : null,
        ]);
        const data = parsed(result.rows[0]?.result);
        if (!Array.isArray(data) || data.length>input.limit) unavailable();
        const rows = (data as unknown[]).map(row => {
          const value = object(row);
          if (typeof value.recordId !== "string" || !UUID.test(value.recordId) || !revision(value.revision,1) || !date(value.receivedAt)) unavailable();
          const payload = object(value.payload);
          try { canonicalPayload(payload,ownedPayloadLimit(input.collection)); validateCollectionPayload(input.collection,payload); } catch { unavailable(); }
          return { recordId: value.recordId as string,revision: value.revision as number,payload,receivedAt: value.receivedAt as string };
        });
        return redactWithdrawnContext(tx,input.collection,rows);
      });
    },
    /** Latest-version tombstones only, no payload. Lets a device learn what the
     * owner removed elsewhere; it never asserts that device copies are gone. */
    async listTombstones(context: ProductionClinicalRequestContext, input: {
      collection: ConsumerClinicalCollection; limit: number; after?: { receivedAt: string; recordId: string };
    }): Promise<OwnedTombstone[]> {
      exactKeys(input,["collection","limit","after"]);
      collection(input.collection);
      if (!Number.isInteger(input.limit) || input.limit<1 || input.limit>100) invalid();
      if (input.after) {
        exactKeys(input.after,["receivedAt","recordId"]);
        if (!date(input.after.receivedAt) || !UUID.test(input.after.recordId)) invalid();
      }
      return run(context,"clinical_data",async tx => {
        const result = await tx.query<{ result: unknown }>("select clinical_core.list_owned_consumer_tombstones($1,$2::integer,$3::timestamptz,$4::uuid) as result", [
          input.collection,input.limit,input.after?.receivedAt ?? null,input.after ? clinicalUuid(input.after.recordId) : null,
        ]);
        const data = parsed(result.rows[0]?.result);
        if (!Array.isArray(data) || data.length>input.limit) unavailable();
        return (data as unknown[]).map(row => {
          const value = object(row);
          exactKeys(value,["recordId","revision","deleted","receivedAt"]);
          if (typeof value.recordId !== "string" || !UUID.test(value.recordId) || !revision(value.revision,1) || value.deleted !== true || !date(value.receivedAt)) unavailable();
          return { recordId: value.recordId as string,revision: value.revision as number,deleted: true as const,receivedAt: value.receivedAt as string };
        });
      });
    },
    async setConsent(context: ProductionClinicalRequestContext, input: {
      scope: OwnedStorageScope; status: "granted" | "revoked"; releaseVersion?: string; expectedRevision: number;
    }) {
      exactKeys(input,["scope","status","releaseVersion","expectedRevision"]);
      if (!OWNED_STORAGE_SCOPES.includes(input.scope) || !["granted","revoked"].includes(input.status)
        || !revision(input.expectedRevision,0) || (input.status === "granted" && !/^[A-Za-z0-9._/-]{1,80}$/.test(input.releaseVersion ?? ""))) invalid();
      return run(context,"consent_management",async tx => {
        const result = await tx.query<{ result: unknown }>("select clinical_core.set_owned_consumer_consent($1,$2,$3,$4::integer) as result", [input.scope,input.status,input.releaseVersion ?? null,input.expectedRevision]);
        const value = object(result.rows[0]?.result);
        if (value.scope !== input.scope || value.status !== input.status || value.revision !== input.expectedRevision+1 || typeof value.releaseVersion !== "string") unavailable();
        return { scope: input.scope,status: input.status,revision: value.revision as number,releaseVersion: value.releaseVersion as string };
      });
    },
  };
}
async function reproductiveConsentActive(tx: ClinicalCoreTransaction): Promise<boolean> {
  const result = await tx.query<{ result: unknown }>("select clinical_core.owned_reproductive_context_allowed() as result");
  const value = result.rows[0]?.result;
  if (typeof value !== 'boolean') unavailable();
  return value;
}
/** Reads never surface reproductive collection context after that consent is
 * withdrawn; the stored record stays intact for a later re-grant or deletion. */
async function redactWithdrawnContext(tx: ClinicalCoreTransaction, collection: ConsumerClinicalCollection, rows: OwnedRecord[]): Promise<OwnedRecord[]> {
  if (collection !== "lab_observations" || !rows.some(row => hasReproductiveCollectionContext(row.payload))) return rows;
  if (await reproductiveConsentActive(tx)) return rows;
  return rows.map(row => ({ ...row, payload: withholdReproductiveContext(row.payload) }));
}
function parseConsentState(raw:unknown,scope:OwnedStorageScope):StorageConsentState {
  const value=object(raw);
  if(value.scope!==scope||value.historyLimit!==100||!Array.isArray(value.history)||value.history.length>100
    ||(value.activeRevision!==null&&!revision(value.activeRevision,1)))unavailable();
  const entry=(raw:unknown)=>{const v=object(raw);if(!revision(v.revision,1)||!['granted','revoked'].includes(v.status as string)||typeof v.releaseVersion!=='string'||!date(v.recordedAt))unavailable();
    return {revision:v.revision as number,status:v.status as 'granted'|'revoked',releaseVersion:v.releaseVersion as string,recordedAt:v.recordedAt as string};};
  let release:StorageConsentState['release']=null;
  if(value.release!==null){const r=object(value.release);
    if(typeof r.version!=='string'||typeof r.content!=='string'||r.content.length<1||r.content.length>12000||!date(r.approvedAt)
      ||r.contentSha256!==createHash('sha256').update(r.content).digest('hex'))unavailable();
    release={version:r.version as string,content:r.content as string,contentSha256:r.contentSha256 as string,approvedAt:r.approvedAt as string};
  }
  return {scope,release,current:value.current===null?null:entry(value.current),history:value.history.map(entry),historyLimit:100,activeRevision:value.activeRevision as number|null};
}
function invalid(): never { throw new OwnedStorageError("request_invalid"); }
function unavailable(): never { throw new OwnedStorageError("storage_unavailable"); }
function revision(value: unknown,min: number) { return typeof value === "number" && Number.isSafeInteger(value) && value>=min && value<2_147_483_647; }
function date(value: unknown) { return typeof value === "string" && value.length<=40 && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)); }
function collection(value: ConsumerClinicalCollection) { if (!OWNED_COLLECTIONS.includes(value)) invalid(); }
function exactKeys(value: object,allowed: string[]) { if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid(); }
function parsed(value: unknown): unknown { try { return typeof value === "string" ? JSON.parse(value) : value; } catch { unavailable(); } }
function object(value: unknown): Record<string, unknown> { const data = parsed(value); if (!data || typeof data !== "object" || Array.isArray(data)) unavailable(); return data as Record<string,unknown>; }
