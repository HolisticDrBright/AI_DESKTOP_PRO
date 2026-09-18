import { randomUUID,createHash } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand, UpdateCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { collectionRangeContextSchema, type CollectionRangeContext } from "./lab-range-population";
import { resolveLabSourcePanel, type LabSourcePanel } from "./lab-source-panel";
import { labRequestLedger, LabRequestError, requestIdentity, REQUEST_RECOVERY_VERSION, REQUEST_RETIREMENT_VERSION } from './lab-request-ledger';
import { inventoryStamp, labRecoveryDescriptor, listLabInventory, LAB_INVENTORY_VERSION } from './lab-job-inventory';
import { claimLabDeletion, reconcileLabDeletion } from './lab-deletion-cleanup';
import { stopLabExecutions } from './lab-execution-stop';
import { labObjectPrefix } from './lab-object-prefix';
import { LabAuthorizationRevoked, type LabAuthorization, type LabAuthorizationPolicy } from './owned-lab-authorization';
import { CoreSubscriptionError } from './core-subscription-guard';
import { OwnedStorageError } from './owned-consumer-records';
import { canonicalPayload } from './aws-consumer-clinical-records';
import {createLabJobPrivacy,LabPrivacyError} from './lab-job-privacy';

const CONTRACT_VERSION = "lab-analysis/1";
const MAX_BODY_BYTES = 256 * 1024;
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
const MAX_DOCUMENTS = 30;
const MIME_TYPES = new Set(["application/pdf", "image/jpeg", "image/png"]);

export type Claims = { sub: string; "custom:person_id": string; "custom:organization_id": string; "custom:synthetic_attested"?: string } & Record<string, string | undefined>;
export type ApiEvent = {
  body?: unknown;
  rawPath?: unknown;
  headers?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined>;
  requestContext?: { authorizer?: { jwt?: { claims?: unknown }; lambda?: unknown }; http?: { method?: unknown } };
};
type DocumentInput = {
  clientDocumentId: string;
  fileName: string;
  contentType: string;
  byteSize: number;
  checksumSHA256?: string;
};

export type PatientContext = {
  ageYears: number | null;
  sex: "male" | "female" | "other";
  pregnancyStatus: "not_pregnant" | "pregnant" | "unsure" | "not_applicable";
  nursing: boolean;
  mainComplaint: string | null;
  complaintDuration: string | null;
  complaintSeverity: number | null;
  conditions: string[];
  medications: string[];
  allergies: string[];
  topSymptomSignals: Array<{ categoryId: string; percentage: number }>;
  lifestyle: { sleepHours: number; sleepQuality: number; stressLevel: number; dietType: string; exerciseFrequency: number };
};

export type LongitudinalBiomarker = {
  biomarkerId: string; canonicalName: string; value: number; unit: string;
  labMin: number | null; labMax: number | null; functionalMin: number | null; functionalMax: number | null;
  status: "optimal" | "normal" | "suboptimal" | "critical" | "unclassified";
};

export type LongitudinalContext = {
  incomingPanel: { panelId: string; panelName: string; testDate: string };
  priorPanels: Array<{ panelId: string; panelName: string; testDate: string; biomarkers: LongitudinalBiomarker[] }>;
  activeProtocol: null | {
    protocolId: string; protocolName: string; version: number;
    items: Array<{ itemId: string; kind: "supplement" | "peptide" | "lifestyle"; name: string }>;
  };
};

export type StructuredLabBiomarker = {
  markerId: string;
  canonicalName: string;
  value: number;
  unit: string;
  labMin: number | null;
  labMax: number | null;
  collectionContext?: CollectionRangeContext;
};

type Job = {
  pk: string;
  ownerSub: string;
  organizationId: string;
  personId: string;
  state: string;
  passesCompleted: number;
  progressPercent: number;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: number;
  documents: Array<DocumentInput & { objectKey: string }>;
  structuredBiomarkers?: StructuredLabBiomarker[];
  sourcePanel?: LabSourcePanel;
  panelId?: string;
  sourcePanelSha256?: string;
  sourceContextSha256?: string;
  patientContext?: PatientContext;
  longitudinalContext?: LongitudinalContext;
  failureCategory: string | null;
  result: unknown | null;
  rangeReleaseSha256?: string;
  /** Absent means synthetic_only (pre-existing rows). A handler serves only its own classification. */
  dataClassification?: LabDataClassification;
  /** Production-owned jobs bind the owner's consent revisions at creation. */
  authorization?: LabAuthorization;
  /** Device-bound delivery claim recorded before a device commits the result locally. */
  delivery?: LabDelivery;
  deliveryAcknowledgment?: LabDeliveryAcknowledgment;
  deliveryTransfers?: LabDeliveryTransfer[];
};
export const LAB_DELIVERY_VERSION = 'lab-delivery/1';
export const LAB_DELIVERY_ACK_VERSION = 'lab-delivery-ack/1';
export const LAB_DELIVERY_TRANSFER_REVIEW_VERSION='lab-delivery-transfer-review/1';
export const LAB_DELIVERY_TRANSFER_VERSION='lab-delivery-transfer/1';
export type LabDeliveryTransfer={claimSha256:string;fromBindingSha256:string;toBindingSha256:string;resultSha256:string;transferredAt:string;
  previousDelivery:LabDelivery;previousAcknowledgment?:LabDeliveryAcknowledgment};
export type LabDeliveryAcknowledgment = {bindingSha256:string;disposition:'applied'|'archived_not_applied';acknowledgedAt:string;resultSha256:string};
export type LabDelivery = { bindingSha256: string; deliveredAt: string; count: number };
const DEVICE_BINDING = /^[a-f0-9]{64}$/;
export type LabDataClassification = 'synthetic_only' | 'personal_health_record';
/** The synthetic handler keeps its attested-token path. The production mode is
 * only reachable through the owned wrapper, which verifies a production-bound
 * consumer identity, revalidates consent and binds it to every job. */
import type {ExternalDeletionGuard} from './owned-external-deletion';
export type LabApiOptions =
  | { mode: 'synthetic' }
  | { mode: 'production';
      identity: (event: ApiEvent) => Claims;
      capture: (event: ApiEvent, identity: Claims) => Promise<LabAuthorization>;
      policy: LabAuthorizationPolicy;
      revalidatePrivacyIdentity:(event:ApiEvent)=>Promise<void>;
      deletionGuard?:ExternalDeletionGuard;
      requireCore: (headers: Record<string, string | undefined>) => Promise<void> };
const CLASSIFICATION: Record<LabApiOptions['mode'], LabDataClassification> = { synthetic: 'synthetic_only', production: 'personal_health_record' };
function classificationAccepted(input: Record<string, unknown>, options: LabApiOptions): boolean {
  if (options.mode === 'synthetic') return input.dataClassification === 'synthetic_only' && input.attestsSyntheticOnly === true && input.attestsOwnerConsent === undefined;
  return input.dataClassification === 'personal_health_record' && input.attestsOwnerConsent === true && input.attestsSyntheticOnly === undefined;
}

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const sfn = new SFNClient({});

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error("lab_runtime_configuration_missing");
  return value;
}

function json(statusCode: number, data: unknown) {
  return {
    statusCode,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify({ data }),
  };
}

function refusal(statusCode = 400) {
  return json(statusCode, { error: "lab_analysis_request_refused" });
}

function claims(event: ApiEvent, options: LabApiOptions): Claims {
  if (options.mode === 'production') return options.identity(event);
  const jwtClaims = event?.requestContext?.authorizer?.jwt?.claims;
  const lambdaClaims = event?.requestContext?.authorizer?.lambda;
  const value = jwtClaims ?? (lambdaClaims && typeof lambdaClaims === "object" && !Array.isArray(lambdaClaims)
    ? {
      sub: (lambdaClaims as Record<string, unknown>).sub,
      "custom:person_id": (lambdaClaims as Record<string, unknown>).person_id,
      "custom:organization_id": (lambdaClaims as Record<string, unknown>).organization_id,
      "custom:synthetic_attested": (lambdaClaims as Record<string, unknown>).synthetic_attested,
    }
    : undefined);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("synthetic_claim_required");
  const row = value as Record<string, unknown>;
  if (row["custom:synthetic_attested"] !== "true") throw new Error("synthetic_claim_required");
  if (typeof row.sub !== "string" || !/^[0-9a-f-]{36}$/i.test(row.sub)
    || typeof row["custom:person_id"] !== "string" || !/^[0-9a-f-]{36}$/i.test(row["custom:person_id"])
    || typeof row["custom:organization_id"] !== "string" || !/^[0-9a-f-]{36}$/i.test(row["custom:organization_id"])) {
    throw new Error("synthetic_identity_invalid");
  }
  return row as Claims;
}

function body(event: ApiEvent): Record<string, unknown> {
  const raw = event?.body;
  if (typeof raw !== "string" || Buffer.byteLength(raw) > MAX_BODY_BYTES) throw new Error("body_invalid");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("body_invalid");
  return parsed;
}

function safeDocument(value: unknown): DocumentInput {
  const row = value as Partial<DocumentInput>;
  if (!row || typeof row !== "object"
    || !/^[0-9a-f-]{36}$/i.test(row.clientDocumentId ?? "")
    || typeof row.fileName !== "string"
    || row.fileName.length > 180
    || !/^[^\\/\u0000-\u001f]+\.(?:pdf|jpe?g|png)$/i.test(row.fileName)
    || !MIME_TYPES.has(row.contentType ?? "")
    || !Number.isInteger(row.byteSize)
    || (row.byteSize ?? 0) < 1
    || (row.byteSize ?? 0) > MAX_DOCUMENT_BYTES
    || (row.checksumSHA256 !== undefined && (typeof row.checksumSHA256 !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(row.checksumSHA256)))) {
    throw new Error("document_invalid");
  }
  return row as DocumentInput;
}

export function safePatientContext(value: unknown): PatientContext | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("patient_context_invalid");
  const row = value as Record<string, unknown>;
  const expectedKeys = ["ageYears", "sex", "pregnancyStatus", "nursing", "mainComplaint", "complaintDuration", "complaintSeverity", "conditions", "medications", "allergies", "topSymptomSignals", "lifestyle"];
  if (Object.keys(row).some((key) => !expectedKeys.includes(key))) throw new Error("patient_context_invalid");
  const textOrNull = (candidate: unknown, max: number) => candidate === null
    || (typeof candidate === "string" && candidate.trim().length >= 1 && candidate.length <= max);
  const stringList = (candidate: unknown) => Array.isArray(candidate) && candidate.length <= 24
    && candidate.every((item) => typeof item === "string" && item.trim().length >= 1 && item.length <= 160);
  const signals = row.topSymptomSignals;
  const lifestyle = row.lifestyle as Record<string, unknown> | undefined;
  if (!(row.ageYears === null || (Number.isInteger(row.ageYears) && Number(row.ageYears) >= 0 && Number(row.ageYears) <= 125))
    || !["male", "female", "other"].includes(String(row.sex))
    || !["not_pregnant", "pregnant", "unsure", "not_applicable"].includes(String(row.pregnancyStatus))
    || typeof row.nursing !== "boolean"
    || !textOrNull(row.mainComplaint, 500) || !textOrNull(row.complaintDuration, 120)
    || !(row.complaintSeverity === null || (Number.isInteger(row.complaintSeverity) && Number(row.complaintSeverity) >= 0 && Number(row.complaintSeverity) <= 10))
    || !stringList(row.conditions) || !stringList(row.medications) || !stringList(row.allergies)
    || !Array.isArray(signals) || signals.length > 8 || signals.some((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return true;
      const signal = item as Record<string, unknown>;
      return Object.keys(signal).some(key=>!['categoryId','percentage'].includes(key))
        || typeof signal.categoryId !== "string" || signal.categoryId.length < 1 || signal.categoryId.length > 80
        || !Number.isInteger(signal.percentage) || Number(signal.percentage) < 0 || Number(signal.percentage) > 100;
    })
    || !lifestyle || Array.isArray(lifestyle)
    || Object.keys(lifestyle).some(key=>!['sleepHours','sleepQuality','stressLevel','dietType','exerciseFrequency'].includes(key))
    || ['sleepHours','sleepQuality','stressLevel','exerciseFrequency'].some(key=>!Number.isFinite(lifestyle[key]))
    || typeof lifestyle.sleepHours !== "number" || lifestyle.sleepHours < 0 || lifestyle.sleepHours > 24
    || typeof lifestyle.sleepQuality !== "number" || lifestyle.sleepQuality < 0 || lifestyle.sleepQuality > 10
    || typeof lifestyle.stressLevel !== "number" || lifestyle.stressLevel < 0 || lifestyle.stressLevel > 10
    || typeof lifestyle.dietType !== "string" || !["omnivore", "vegetarian", "vegan", "keto", "paleo", "mediterranean", "other"].includes(lifestyle.dietType)
    || typeof lifestyle.exerciseFrequency !== "number" || lifestyle.exerciseFrequency < 0 || lifestyle.exerciseFrequency > 14) {
    throw new Error("patient_context_invalid");
  }
  return row as PatientContext;
}

export function labContextFingerprint(value:unknown):string{
  const context=safePatientContext(value);if(!context)throw new Error('patient_context_invalid');
  const canonical=(input:unknown):unknown=>{
    if(Array.isArray(input))return input.map(canonical);
    if(input&&typeof input==='object')return Object.fromEntries(Object.entries(input).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>[k,canonical(v)]));
    return input;
  };
  return createHash('sha256').update(JSON.stringify(canonical({contractVersion:'plan-context/1',context}))).digest('hex');
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length >= 1 && value.length <= max;
}

function safeNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function safeDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`));
}

function safeLongitudinalBiomarker(value: unknown): LongitudinalBiomarker {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("longitudinal_context_invalid");
  const row = value as Record<string, unknown>;
  const expected = ["biomarkerId", "canonicalName", "value", "unit", "labMin", "labMax", "functionalMin", "functionalMax", "status"];
  if (Object.keys(row).some((key) => !expected.includes(key))
    || typeof row.biomarkerId !== "string" || !/^[0-9a-f-]{36}$/i.test(row.biomarkerId)
    || !boundedString(row.canonicalName, 160) || typeof row.value !== "number" || !Number.isFinite(row.value)
    || !boundedString(row.unit, 80) || !safeNullableNumber(row.labMin) || !safeNullableNumber(row.labMax)
    || !safeNullableNumber(row.functionalMin) || !safeNullableNumber(row.functionalMax)
    || !["optimal", "normal", "suboptimal", "critical", "unclassified"].includes(String(row.status))) throw new Error("longitudinal_context_invalid");
  return row as LongitudinalBiomarker;
}

function rangeReleaseStamp(): { rangeReleaseSha256?: string } {
  if (process.env.LAB_RANGE_MODE && !["synthetic_fixture", "reviewed_release"].includes(process.env.LAB_RANGE_MODE)) throw new Error("lab_range_mode_invalid");
  if (process.env.LAB_RANGE_MODE !== "reviewed_release") return {};
  const hash = required("LAB_RANGE_RELEASE_SHA256");
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("lab_range_release_refused");
  return { rangeReleaseSha256: hash };
}

export function safeStructuredLabBiomarkers(value: unknown): StructuredLabBiomarker[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 1000) throw new Error("structured_biomarkers_invalid");
  const biomarkers = value.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("structured_biomarkers_invalid");
    const row = candidate as Record<string, unknown>;
    const expected = ["markerId", "canonicalName", "value", "unit", "labMin", "labMax", "collectionContext"];
    if (Object.keys(row).some((key) => !expected.includes(key))
      || !boundedString(row.markerId, 160) || !boundedString(row.canonicalName, 160)
      || typeof row.value !== "number" || !Number.isFinite(row.value)
      || !boundedString(row.unit, 80) || !safeNullableNumber(row.labMin) || !safeNullableNumber(row.labMax)
      || (row.labMin !== null && row.labMax !== null && Number(row.labMin) > Number(row.labMax))) {
      throw new Error("structured_biomarkers_invalid");
    }
    if (row.collectionContext !== undefined && !collectionRangeContextSchema.safeParse(row.collectionContext).success) {
      throw new Error("structured_biomarkers_invalid");
    }
    return row as StructuredLabBiomarker;
  });
  const keys = biomarkers.map((row) => `${row.canonicalName.trim().toLowerCase()}|${row.unit.trim().toLowerCase()}`);
  if (new Set(keys).size !== keys.length) throw new Error("structured_biomarkers_duplicate");
  return biomarkers;
}

export function safeLongitudinalContext(value: unknown): LongitudinalContext | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("longitudinal_context_invalid");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !["incomingPanel", "priorPanels", "activeProtocol"].includes(key))) throw new Error("longitudinal_context_invalid");
  const incoming = row.incomingPanel as Record<string, unknown> | undefined;
  if (!incoming || Array.isArray(incoming) || Object.keys(incoming).some((key) => !["panelId", "panelName", "testDate"].includes(key))
    || !boundedString(incoming.panelId, 160) || !boundedString(incoming.panelName, 180) || !safeDate(incoming.testDate)
    || !Array.isArray(row.priorPanels) || row.priorPanels.length > 20) throw new Error("longitudinal_context_invalid");
  let totalBiomarkers = 0;
  const priorPanels = row.priorPanels.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("longitudinal_context_invalid");
    const panel = candidate as Record<string, unknown>;
    if (Object.keys(panel).some((key) => !["panelId", "panelName", "testDate", "biomarkers"].includes(key))
      || !boundedString(panel.panelId, 160) || !boundedString(panel.panelName, 180) || !safeDate(panel.testDate)
      || !Array.isArray(panel.biomarkers) || panel.biomarkers.length > 1000) throw new Error("longitudinal_context_invalid");
    totalBiomarkers += panel.biomarkers.length;
    return { panelId: panel.panelId, panelName: panel.panelName, testDate: panel.testDate, biomarkers: panel.biomarkers.map(safeLongitudinalBiomarker) };
  });
  if (totalBiomarkers > 2000) throw new Error("longitudinal_context_invalid");
  let activeProtocol: LongitudinalContext["activeProtocol"] = null;
  if (row.activeProtocol !== null) {
    const protocol = row.activeProtocol as Record<string, unknown> | undefined;
    if (!protocol || Array.isArray(protocol) || Object.keys(protocol).some((key) => !["protocolId", "protocolName", "version", "items"].includes(key))
      || !boundedString(protocol.protocolId, 160) || !boundedString(protocol.protocolName, 180)
      || !Number.isInteger(protocol.version) || Number(protocol.version) < 1 || Number(protocol.version) > 10_000
      || !Array.isArray(protocol.items) || protocol.items.length > 150) throw new Error("longitudinal_context_invalid");
    activeProtocol = {
      protocolId: protocol.protocolId,
      protocolName: protocol.protocolName,
      version: protocol.version as number,
      items: protocol.items.map((candidate) => {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("longitudinal_context_invalid");
        const item = candidate as Record<string, unknown>;
        if (Object.keys(item).some((key) => !["itemId", "kind", "name"].includes(key)) || !boundedString(item.itemId, 160)
          || !["supplement", "peptide", "lifestyle"].includes(String(item.kind)) || !boundedString(item.name, 180)) throw new Error("longitudinal_context_invalid");
        return item as LongitudinalContext["activeProtocol"] extends { items: infer T } ? T extends Array<infer U> ? U : never : never;
      }),
    };
  }
  return { incomingPanel: incoming as LongitudinalContext["incomingPanel"], priorPanels, activeProtocol };
}

export function sanitizeStoredResult(result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const row = result as Record<string, unknown>;
  if (!Array.isArray(row.biomarkers)) return result;
  const biomarkers = row.biomarkers.filter((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return true;
    const canonicalName = (candidate as Record<string, unknown>).canonicalName;
    return typeof canonicalName !== "string" || canonicalName.trim().length > 0;
  });
  return biomarkers.length === row.biomarkers.length ? result : { ...row, biomarkers };
}

function status(job: Job) {
  return {
    contractVersion: CONTRACT_VERSION,
    jobId: job.pk.slice(4),
    state: job.state,
    passesCompleted: job.passesCompleted,
    passesTotal: 5,
    progressPercent: job.progressPercent,
    attempt: job.attempt,
    updatedAt: job.updatedAt,
    failureCategory: job.failureCategory,
    result: sanitizeStoredResult(job.result),
    // Only present once a device has claimed delivery; older clients never see it.
    ...(job.delivery ? { delivery: { bindingSha256: job.delivery.bindingSha256, deliveredAt: job.delivery.deliveredAt } } : {}),
  };
}

/** A completed result is claimed by exactly one device binding before that
 * device commits it locally. The same device may claim again (retry after a
 * failed local commit); a different device needs the explicit transfer flow. This is not
 * proof of persistence or active-plan adoption. The result is not changed. */
async function recordDelivery(event: ApiEvent, identity: Claims, jobId: string, options: LabApiOptions) {
  const input = body(event);
  if(input.contractVersion===LAB_DELIVERY_TRANSFER_REVIEW_VERSION||input.contractVersion===LAB_DELIVERY_TRANSFER_VERSION)return transferDelivery(input,identity,jobId,options);
  if(input.contractVersion===LAB_DELIVERY_ACK_VERSION)return acknowledgeDelivery(input,identity,jobId,options);
  if (Object.keys(input).sort().join(',') !== 'contractVersion,deviceBindingSha256' || input.contractVersion !== LAB_DELIVERY_VERSION
    || typeof input.deviceBindingSha256 !== 'string' || !DEVICE_BINDING.test(input.deviceBindingSha256)) return refusal();
  const job = await ownedJob(jobId, identity, options);
  if (!job) return refusal(404);
  if (job.state !== 'completed' || !job.result) return refusal(409);
  if (job.delivery && job.delivery.bindingSha256 !== input.deviceBindingSha256) return json(409, { contractVersion: LAB_DELIVERY_VERSION, error: 'lab_delivery_conflict' });
  const deliveredAt = job.delivery?.deliveredAt ?? new Date().toISOString();
  const delivery: LabDelivery = { bindingSha256: input.deviceBindingSha256, deliveredAt, count: (job.delivery?.count ?? 0) + 1 };
  try {
    await db.send(new UpdateCommand({
      TableName: required('LAB_JOB_TABLE'), Key: { pk: job.pk },
      UpdateExpression: 'SET delivery = :delivery, updatedAt = :now',
      ConditionExpression: job.delivery
        ? '#state = :completed AND ownerSub = :owner AND delivery.bindingSha256 = :binding AND delivery.#count = :previous'
        : '#state = :completed AND ownerSub = :owner AND attribute_not_exists(delivery)',
      ExpressionAttributeNames: { '#state': 'state', ...(job.delivery ? { '#count': 'count' } : {}) },
      ExpressionAttributeValues: { ':delivery': delivery, ':now': new Date().toISOString(), ':completed': 'completed', ':owner': identity.sub,
        ...(job.delivery ? { ':binding': input.deviceBindingSha256, ':previous': job.delivery.count } : {}) },
    }));
  } catch (error) {
    // A concurrent claim from another device wins; never overwrite it.
    if ((error as { name?: string })?.name === 'ConditionalCheckFailedException') return json(409, { contractVersion: LAB_DELIVERY_VERSION, error: 'lab_delivery_conflict' });
    throw error;
  }
  return json(200, { contractVersion: LAB_DELIVERY_VERSION, jobId, delivery });
}

/** The phone attests durable local persistence. This is distinct from a claim,
 * not independent proof of device storage, clinical adoption or clinic sync. */
async function acknowledgeDelivery(input:Record<string,unknown>,identity:Claims,jobId:string,options:LabApiOptions){
  if(Object.keys(input).sort().join(',')!=='contractVersion,deviceBindingSha256,disposition'
    ||typeof input.deviceBindingSha256!=='string'||!DEVICE_BINDING.test(input.deviceBindingSha256)
    ||!['applied','archived_not_applied'].includes(String(input.disposition)))return refusal();
  const job=await ownedJob(jobId,identity,options);
  if(!job)return refusal(404);
  const conflict=()=>json(409,{contractVersion:LAB_DELIVERY_ACK_VERSION,error:'lab_delivery_conflict'});
  if(job.state!=='completed'||!job.result||typeof job.result!=='object'||Array.isArray(job.result)||job.delivery?.bindingSha256!==input.deviceBindingSha256)return conflict();
  const resultSha256=createHash('sha256').update(canonicalPayload(job.result as Record<string,unknown>)).digest('hex');
  const matching=(ack:LabDeliveryAcknowledgment|undefined)=>!!ack&&ack.bindingSha256===input.deviceBindingSha256
    &&ack.disposition===input.disposition&&ack.resultSha256===resultSha256&&Number.isFinite(Date.parse(ack.acknowledgedAt));
  const reply=(ack:LabDeliveryAcknowledgment)=>json(200,{contractVersion:LAB_DELIVERY_ACK_VERSION,jobId,acknowledgment:ack});
  if(job.deliveryAcknowledgment)return matching(job.deliveryAcknowledgment)?reply(job.deliveryAcknowledgment):conflict();
  const acknowledgment:LabDeliveryAcknowledgment={bindingSha256:input.deviceBindingSha256,disposition:input.disposition as LabDeliveryAcknowledgment['disposition'],acknowledgedAt:new Date().toISOString(),resultSha256};
  try{
    await db.send(new UpdateCommand({TableName:required('LAB_JOB_TABLE'),Key:{pk:job.pk},
      UpdateExpression:'SET deliveryAcknowledgment = :ack, updatedAt = :now',
      ConditionExpression:'#state = :completed AND ownerSub = :owner AND delivery.bindingSha256 = :binding AND #result = :result AND attribute_not_exists(deliveryAcknowledgment)',
      ExpressionAttributeNames:{'#state':'state','#result':'result'},ExpressionAttributeValues:{':ack':acknowledgment,':now':acknowledgment.acknowledgedAt,':completed':'completed',':owner':identity.sub,':binding':input.deviceBindingSha256,':result':job.result}}));
  }catch(error){
    if((error as {name?:string})?.name!=='ConditionalCheckFailedException')throw error;
    // Retry after a concurrent identical ACK is successful only after a fresh
    // owner/classification/consent check. Deletion or differing decisions refuse.
    const fresh=await ownedJob(jobId,identity,options);
    return fresh?.state==='completed'&&fresh.delivery?.bindingSha256===input.deviceBindingSha256
      &&fresh.result&&typeof fresh.result==='object'&&!Array.isArray(fresh.result)
      &&createHash('sha256').update(canonicalPayload(fresh.result as Record<string,unknown>)).digest('hex')===resultSha256&&matching(fresh.deliveryAcknowledgment)
      ?reply(fresh.deliveryAcknowledgment!):conflict();
  }
  return reply(acknowledgment);
}

/** Explicit owner-authorized relocation, not erasure of the old phone or proof
 * of local persistence. Historical claims/ACKs are retained in the same row. */
async function transferDelivery(input:Record<string,unknown>,identity:Claims,jobId:string,options:LabApiOptions){
  const review=input.contractVersion===LAB_DELIVERY_TRANSFER_REVIEW_VERSION;
  const version=review?LAB_DELIVERY_TRANSFER_REVIEW_VERSION:LAB_DELIVERY_TRANSFER_VERSION;
  const conflict=()=>json(409,{contractVersion:version,error:'lab_delivery_conflict'});
  if(Object.keys(input).sort().join(',')!==(review?'contractVersion,toBindingSha256':'claimSha256,confirmTransfer,contractVersion,fromBindingSha256,toBindingSha256')
    ||typeof input.toBindingSha256!=='string'||!DEVICE_BINDING.test(input.toBindingSha256)
    ||(!review&&(input.confirmTransfer!==true||typeof input.fromBindingSha256!=='string'||!DEVICE_BINDING.test(input.fromBindingSha256)
      ||typeof input.claimSha256!=='string'||!DEVICE_BINDING.test(input.claimSha256)||input.fromBindingSha256===input.toBindingSha256)))return refusal();
  const job=await ownedJob(jobId,identity,options);if(!job)return refusal(404);
  const usable=(row:Job)=>row.state==='completed'&&row.expiresAt>Math.floor(Date.now()/1000)
    &&row.result&&typeof row.result==='object'&&!Array.isArray(row.result)&&row.delivery
    &&DEVICE_BINDING.test(row.delivery.bindingSha256)&&Number.isSafeInteger(row.delivery.count)&&row.delivery.count>0
    &&Number.isFinite(Date.parse(row.delivery.deliveredAt))&&(!row.deliveryTransfers||Array.isArray(row.deliveryTransfers)&&row.deliveryTransfers.length<=16);
  if(!usable(job))return conflict();
  const resultHash=(row:Job)=>createHash('sha256').update(canonicalPayload(row.result as Record<string,unknown>)).digest('hex');
  const resultSha256=resultHash(job);
  const publicTransfer=(row:LabDeliveryTransfer)=>({claimSha256:row.claimSha256,fromBindingSha256:row.fromBindingSha256,toBindingSha256:row.toBindingSha256,resultSha256:row.resultSha256,transferredAt:row.transferredAt});
  const replay=(row:Job)=>{
    const last=row.deliveryTransfers?.at(-1);
    return usable(row)&&last&&last.claimSha256===input.claimSha256&&last.fromBindingSha256===input.fromBindingSha256
      &&last.toBindingSha256===input.toBindingSha256&&row.delivery?.bindingSha256===input.toBindingSha256
      &&last.resultSha256===resultHash(row)?last:null;
  };
  const receipt=(record:LabDeliveryTransfer)=>json(200,{contractVersion:LAB_DELIVERY_TRANSFER_VERSION,jobId,transfer:publicTransfer(record)});
  if(!review){const prior=replay(job);if(prior)return receipt(prior);}
  if(job.delivery!.bindingSha256===input.toBindingSha256||(job.deliveryTransfers?.length??0)>=16)return conflict();
  // Includes prior transfers, so moving A→B→A cannot make an old review current.
  const claimSha256=createHash('sha256').update(canonicalPayload({jobId,resultSha256,expiresAt:job.expiresAt,
    delivery:job.delivery,acknowledgment:job.deliveryAcknowledgment??null,transfers:job.deliveryTransfers??[]})).digest('hex');
  if(review)return json(200,{contractVersion:version,jobId,claimSha256,fromBindingSha256:job.delivery!.bindingSha256,toBindingSha256:input.toBindingSha256,resultSha256});
  if(input.fromBindingSha256!==job.delivery!.bindingSha256||input.claimSha256!==claimSha256)return conflict();
  const at=new Date().toISOString();
  const transfer:LabDeliveryTransfer={claimSha256,fromBindingSha256:job.delivery!.bindingSha256,toBindingSha256:input.toBindingSha256,resultSha256,transferredAt:at,
    previousDelivery:job.delivery!,...(job.deliveryAcknowledgment?{previousAcknowledgment:job.deliveryAcknowledgment}:{})};
  try{
    await db.send(new UpdateCommand({TableName:required('LAB_JOB_TABLE'),Key:{pk:job.pk},
      UpdateExpression:'SET delivery = :delivery, deliveryTransfers = :transfers, updatedAt = :now REMOVE deliveryAcknowledgment',
      ConditionExpression:'#state = :completed AND ownerSub = :owner AND organizationId = :organization AND personId = :person AND delivery = :previousDelivery AND #result = :result AND expiresAt = :expiry AND expiresAt > :clock AND '
        +(job.dataClassification?'dataClassification = :classification':'attribute_not_exists(dataClassification)')+' AND '
        +(job.deliveryAcknowledgment?'deliveryAcknowledgment = :previousAck':'attribute_not_exists(deliveryAcknowledgment)')+' AND '
        +(job.deliveryTransfers?'deliveryTransfers = :previousTransfers':'attribute_not_exists(deliveryTransfers)'),
      ExpressionAttributeNames:{'#state':'state','#result':'result'},ExpressionAttributeValues:{':delivery':{bindingSha256:input.toBindingSha256,deliveredAt:at,count:1},
        ':transfers':[...(job.deliveryTransfers??[]),transfer],':now':at,':completed':'completed',':owner':identity.sub,':organization':job.organizationId,':person':job.personId,
        ...(job.dataClassification?{':classification':job.dataClassification}:{}),':previousDelivery':job.delivery,':result':job.result,
        ':expiry':job.expiresAt,':clock':Math.floor(Date.now()/1000),...(job.deliveryAcknowledgment?{':previousAck':job.deliveryAcknowledgment}:{}),
        ...(job.deliveryTransfers?{':previousTransfers':job.deliveryTransfers}:{})}}));
  }catch(error){
    if((error as {name?:string})?.name!=='ConditionalCheckFailedException')throw error;
    const fresh=await ownedJob(jobId,identity,options),prior=fresh?replay(fresh):null;
    return prior?receipt(prior):conflict();
  }
  return receipt(transfer);
}

async function ownedJob(jobId: string, identity: Claims, options: LabApiOptions, includeDeleting = false): Promise<Job | null> {
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return null;
  const result = await db.send(new GetCommand({
    TableName: required("LAB_JOB_TABLE"),
    Key: { pk: `job#${jobId}` },
    ConsistentRead: true,
  }));
  const job = result.Item as Job | undefined;
  const owned = (includeDeleting || job?.state !== 'deleting') && job?.ownerSub === identity.sub && job.organizationId === identity['custom:organization_id']
    && job.personId === identity['custom:person_id'] ? job : null;
  // includeDeleting is used only by explicit cancel/delete, never processing or
  // clinical reads. Withdrawal must not prevent the owner stopping old work.
  return owned ? classifiedJob(owned, options, includeDeleting) : null;
}
/** A handler never serves another classification's rows, and a production job
 * is re-authorized against current consent on every access. Cancellation and
 * deletion remain available after withdrawal through the caller's includeRevoked. */
async function classifiedJob(job: Job, options: LabApiOptions, includeRevoked = false): Promise<Job | null> {
  if ((job.dataClassification ?? 'synthetic_only') !== CLASSIFICATION[options.mode]) return null;
  if (options.mode === 'production' && !includeRevoked) await options.policy.verify(job);
  return job;
}

async function deleteJob(identity: Claims, jobId: string, options: LabApiOptions) {
  if(options.mode==='production'&&!options.deletionGuard)throw new OwnedStorageError('storage_unavailable');
  const job = await ownedJob(jobId, identity, options, true);
  if (job && !["awaiting_upload", "completed", "needs_review", "failed", "deleting"].includes(job.state)) return refusal(409);
  const deps={db,s3,table:required('LAB_JOB_TABLE'),bucket:required('LAB_DOCUMENT_BUCKET'),
    deletionGuard:options.mode==='production'?options.deletionGuard:undefined,
    stopExecutions:(id:string)=>stopLabExecutions(sfn,required('LAB_STATE_MACHINE_ARN'),id)};
  const scope={ownerSub:identity.sub,organizationId:identity['custom:organization_id'],personId:identity['custom:person_id']};
  if(job)await claimLabDeletion(deps,scope,jobId);
  const cleanup=await reconcileLabDeletion(deps,jobId,scope);
  return json(200, { contractVersion: CONTRACT_VERSION, jobId, deleted: true, ...cleanup });
}

/** Cancellation is explicit removal of unfinished work, not deletion of a saved result.
 * A running Lambda/provider request may finish, but cannot publish after the fence. */
async function cancelJob(event:ApiEvent,identity:Claims,jobId:string,options:LabApiOptions){
  if(options.mode==='production'&&!options.deletionGuard)throw new OwnedStorageError('storage_unavailable');
  const input=body(event);
  if(Object.keys(input).sort().join(',')!=='confirmRemoveUnfinishedAnalysis' || input.confirmRemoveUnfinishedAnalysis!==true)return refusal();
  const job=await ownedJob(jobId,identity,options,true);
  if(job&&!['awaiting_upload','queued','extracting','verifying','normalizing','interpreting','synthesizing','deleting'].includes(job.state))return refusal(409);
  const scope={ownerSub:identity.sub,organizationId:identity['custom:organization_id'],personId:identity['custom:person_id']};
  const deps={db,s3,table:required('LAB_JOB_TABLE'),bucket:required('LAB_DOCUMENT_BUCKET'),
    deletionGuard:options.mode==='production'?options.deletionGuard:undefined,
    stopExecutions:(id:string)=>stopLabExecutions(sfn,required('LAB_STATE_MACHINE_ARN'),id)};
  try{
    if(job)await claimLabDeletion(deps,scope,jobId,true);
    const cleanup=await reconcileLabDeletion(deps,jobId,scope);
    if(!cleanup)return refusal(404);
    return json(200,{contractVersion:'lab-cancellation/1',jobId,cancelled:true,deleted:true,...cleanup});
  }catch(error){
    if(error instanceof OwnedStorageError)throw error;
    if((error as {name?:unknown})?.name==='TransactionCanceledException')return refusal(409);
    // The durable outbox remains for retry. Never acknowledge a partial purge/stop.
    return refusal(503);
  }
}

async function createJob(event: ApiEvent, identity: Claims, options: LabApiOptions) {
  const input = body(event);
  if (!classificationAccepted(input, options)
    || !Array.isArray(input.documents) || input.documents.length < 1 || input.documents.length > MAX_DOCUMENTS) {
    return refusal();
  }
  const documents = input.documents.map(safeDocument);
  const patientContext = safePatientContext(input.patientContext);
  const longitudinalContext = safeLongitudinalContext(input.longitudinalContext);
  if (new Set(documents.map((row) => row.clientDocumentId)).size !== documents.length) return refusal();
  const jobId = randomUUID();
  const now = new Date().toISOString();
  const stored = documents.map((document) => ({
    ...document,
    objectKey: `${labObjectPrefix()}/${identity["custom:organization_id"]}/${identity.sub}/${jobId}/${document.clientDocumentId}/${document.fileName}`,
  }));
  const job: Job = {
    pk: `job#${jobId}`,
    ownerSub: identity.sub,
    organizationId: identity["custom:organization_id"],
    personId: identity["custom:person_id"],
    state: "awaiting_upload",
    ...inventoryStamp({ownerSub:identity.sub,organizationId:identity['custom:organization_id'],personId:identity['custom:person_id']}, now, `job#${jobId}`),
    passesCompleted: 0,
    progressPercent: 0,
    attempt: 1,
    createdAt: now,
    updatedAt: now,
    expiresAt: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
    documents: stored,
    ...rangeReleaseStamp(),
    ...(typeof input.panelId === "string" && input.panelId.length <= 160 ? { panelId: input.panelId } : {}),
    ...(patientContext ? { patientContext } : {}),
    ...(longitudinalContext ? { longitudinalContext } : {}),
    failureCategory: null,
    result: null,
    ...(await productionBinding(event, identity, options)),
  };
  if(input.request!==undefined){
    const {request,...intent}=input;
    const saved=await labRequestLedger(db,required('LAB_JOB_TABLE')).create(job,request,'documents',intent,job);
    // A replayed identity is re-authorized: a job bound to withdrawn consent is not handed back.
    if(!await classifiedJob(saved,options))return refusal(404);
    return json(200,{contractVersion:REQUEST_RECOVERY_VERSION,requestId:requestIdentity(request).id,jobId:saved.pk.slice(4)});
  }
  await db.send(new PutCommand({TableName:required('LAB_JOB_TABLE'),Item:job,ConditionExpression:'attribute_not_exists(pk)'}));
  const targets = await uploadTargets(job, stored);
  return json(200, { contractVersion: CONTRACT_VERSION, jobId, state: "awaiting_upload", documents: targets });
}

/** Production creation requires server-verified paid Core and captures the
 * owner's current consent revisions; the job carries them for every later
 * upload, dispatch and read. Synthetic jobs carry neither. */
async function productionBinding(event: ApiEvent, identity: Claims, options: LabApiOptions): Promise<Pick<Job, 'dataClassification' | 'authorization'>> {
  if (options.mode === 'synthetic') return { dataClassification: 'synthetic_only' };
  await options.requireCore(event.headers ?? {});
  const authorization = await options.capture(event, identity);
  if (authorization.identitySubject !== identity.sub || authorization.organizationId !== identity['custom:organization_id']
    || authorization.personId !== identity['custom:person_id']) throw new LabAuthorizationRevoked();
  return { dataClassification: 'personal_health_record', authorization };
}

async function uploadTargets(job: Job, documents: Job['documents']) {
  const jobId = job.pk.slice(4), bucket = required('LAB_DOCUMENT_BUCKET'), kmsKey = required('LAB_KMS_KEY_ARN');
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  return Promise.all(documents.map(async (document) => {
    const headers = {
      "content-type": document.contentType,
      "x-amz-server-side-encryption": "aws:kms",
      "x-amz-server-side-encryption-aws-kms-key-id": kmsKey,
      "x-amz-meta-job-id": jobId,
      "x-amz-meta-document-id": document.clientDocumentId,
      ...(document.checksumSHA256 ? { 'x-amz-checksum-sha256': document.checksumSHA256, 'if-none-match': '*' } : {}),
    };
    const uploadUrl = await getSignedUrl(s3, new PutObjectCommand({
      Bucket: bucket,
      Key: document.objectKey,
      ContentType: document.contentType,
      ServerSideEncryption: "aws:kms",
      SSEKMSKeyId: kmsKey,
      Metadata: { "job-id": jobId, "document-id": document.clientDocumentId },
      ...(document.checksumSHA256 ? { ChecksumSHA256: document.checksumSHA256, IfNoneMatch: '*' } : {}),
    }), {
      expiresIn: 15 * 60,
      unhoistableHeaders: new Set(["x-amz-meta-job-id", "x-amz-meta-document-id", 'x-amz-checksum-sha256']),
      signableHeaders: new Set(['if-none-match']),
    });
    return { clientDocumentId: document.clientDocumentId, uploadUrl, method: "PUT", requiredHeaders: headers, expiresAt };
  }));
}

async function verifyUploadedDocument(job: Job, document: Job['documents'][number]): Promise<boolean> {
  let head;
  try {
    head = await s3.send(new HeadObjectCommand({ Bucket: required('LAB_DOCUMENT_BUCKET'), Key: document.objectKey,
      ...(document.checksumSHA256 ? { ChecksumMode: 'ENABLED' as const } : {}) }));
  } catch (error) {
    // AccessDenied/transient failures do not mean the object is missing.
    if ((error as { name?: string })?.name === 'NotFound') return false;
    throw error;
  }
  if (head.ContentLength !== document.byteSize || head.ContentType !== document.contentType
    || head.ServerSideEncryption !== 'aws:kms' || head.SSEKMSKeyId !== required('LAB_KMS_KEY_ARN')
    || head.Metadata?.['job-id'] !== job.pk.slice(4) || head.Metadata?.['document-id'] !== document.clientDocumentId
    || (document.checksumSHA256 && head.ChecksumSHA256 !== document.checksumSHA256)) throw new Error('lab_uploaded_object_invalid');
  return true;
}

async function resumeUpload(identity: Claims, jobId: string, options: LabApiOptions) {
  const job = await ownedJob(jobId, identity, options);
  if (!job || job.organizationId !== identity['custom:organization_id'] || job.personId !== identity['custom:person_id']) return refusal(404);
  if (job.state !== 'awaiting_upload' || job.expiresAt <= Math.floor(Date.now() / 1000)
    || !job.documents.length || job.documents.some(d => !d.checksumSHA256)) return refusal(409);
  const missing: Job['documents'] = [], uploadedDocuments: { clientDocumentId: string }[] = [];
  for (const document of job.documents) {
    // A prefix-scoped list avoids treating a missing object's ambiguous HEAD 403
    // as absence; all access/network failures still stop recovery.
    const present = await s3.send(new ListObjectsV2Command({Bucket:required('LAB_DOCUMENT_BUCKET'),Prefix:document.objectKey,MaxKeys:1}));
    if (present.Contents?.some(row=>row.Key===document.objectKey) && await verifyUploadedDocument(job, document)) uploadedDocuments.push({ clientDocumentId: document.clientDocumentId });
    else missing.push(document);
  }
  const documents = await uploadTargets(job, missing);
  return json(200, { contractVersion: CONTRACT_VERSION, jobId, state: 'awaiting_upload', documents, uploadedDocuments });
}

async function createPlanJob(event: ApiEvent, identity: Claims, options: LabApiOptions) {
  const input = body(event);
  const expected = ["request", "panelId", "panelName", "testDate", "patientContext", "longitudinalContext", "dataClassification", "attestsSyntheticOnly", "attestsOwnerConsent", "biomarkers", "sourcePanelSha256","sourceContextSha256"];
  if (Object.keys(input).some((key) => !expected.includes(key))
    || !classificationAccepted(input, options)
    || !boundedString(input.panelId, 160) || !boundedString(input.panelName, 180) || !safeDate(input.testDate)
    || (input.sourcePanelSha256 !== undefined && (typeof input.sourcePanelSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.sourcePanelSha256)))) return refusal();
  const structuredBiomarkers = safeStructuredLabBiomarkers(input.biomarkers);
  const sourcePanel=resolveLabSourcePanel({sourcePanel:{panelId:input.panelId,panelName:input.panelName,testDate:input.testDate},structuredBiomarkers});
  const patientContext = safePatientContext(input.patientContext);
  if(input.sourceContextSha256!==undefined&&input.sourceContextSha256!==labContextFingerprint(patientContext))return refusal();
  const longitudinalContext = safeLongitudinalContext(input.longitudinalContext);
  if (longitudinalContext && (longitudinalContext.incomingPanel.panelId !== input.panelId
    || longitudinalContext.incomingPanel.panelName !== input.panelName
    || longitudinalContext.incomingPanel.testDate !== input.testDate)) return refusal();
  const jobId = randomUUID();
  const now = new Date().toISOString();
  const job: Job = {
    pk: `job#${jobId}`,
    ownerSub: identity.sub,
    organizationId: identity["custom:organization_id"],
    personId: identity["custom:person_id"],
    state: "queued",
    ...inventoryStamp({ownerSub:identity.sub,organizationId:identity['custom:organization_id'],personId:identity['custom:person_id']}, now, `job#${jobId}`),
    passesCompleted: 0,
    progressPercent: 5,
    attempt: 1,
    createdAt: now,
    updatedAt: now,
    expiresAt: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
    documents: [],
    structuredBiomarkers,
    ...(sourcePanel?{sourcePanel}:{}),
    ...rangeReleaseStamp(),
    panelId: input.panelId,
    ...(typeof input.sourcePanelSha256 === 'string' ? {sourcePanelSha256:input.sourcePanelSha256} : {}),
    ...(typeof input.sourceContextSha256 === 'string' ? {sourceContextSha256:input.sourceContextSha256} : {}),
    ...(patientContext ? { patientContext } : {}),
    ...(longitudinalContext ? { longitudinalContext } : {}),
    failureCategory: null,
    result: null,
    ...(await productionBinding(event, identity, options)),
  };
  if(input.request!==undefined){
    const {request,...intent}=input;
    const saved=await labRequestLedger(db,required('LAB_JOB_TABLE')).create(job,request,'saved',intent,job);
    if(!await classifiedJob(saved,options))return refusal(404);
    await ensureQueuedExecution(saved);
    return json(200,{contractVersion:REQUEST_RECOVERY_VERSION,requestId:requestIdentity(request).id,jobId:saved.pk.slice(4)});
  }
  await db.send(new PutCommand({ TableName: required("LAB_JOB_TABLE"), Item: job, ConditionExpression: "attribute_not_exists(pk)" }));
  await ensureQueuedExecution(job);
  console.info(JSON.stringify({ event: "structured_lab_plan_job_created", jobId, markerCount: structuredBiomarkers.length }));
  return json(200, { contractVersion: CONTRACT_VERSION, jobId, state: "queued" });
}

/** A transient start failure must not lose the durable job ID or create another job on retry. */
async function ensureQueuedExecution(job: Job): Promise<void> {
  if (job.state !== "queued") return;
  const jobId = job.pk.slice(4);
  try {
    await sfn.send(new StartExecutionCommand({ stateMachineArn: required("LAB_STATE_MACHINE_ARN"),
      name: `${job.structuredBiomarkers ? "lab-plan" : "lab"}-${jobId}`, input: JSON.stringify({ jobId }) }));
  } catch (error) {
    if (error && typeof error === "object" && (error as { name?: string }).name === "ExecutionAlreadyExists") return;
    // Polling retries this exact named execution; queued state remains truthful.
    console.warn("lab_execution_start_pending");
  }
}

async function completeUpload(event: ApiEvent, identity: Claims, jobId: string, options: LabApiOptions) {
  const input = body(event);
  const job = await ownedJob(jobId, identity, options);
  if (!job) return refusal(404);
  if (job.state !== "awaiting_upload") { await ensureQueuedExecution(job); return json(200, status(job)); }
  if (!Array.isArray(input.uploadedDocuments)
    || input.uploadedDocuments.length !== job.documents.length) return refusal(409);
  const ids = new Set(input.uploadedDocuments.map((row) => (
    row && typeof row === "object" && !Array.isArray(row)
      ? (row as Record<string, unknown>).clientDocumentId
      : undefined
  )));
  if (ids.size !== job.documents.length || job.documents.some((row) => !ids.has(row.clientDocumentId))) return refusal();
  for (const document of job.documents) {
    if (!await verifyUploadedDocument(job, document)) return refusal(409);
  }
  const updatedAt = new Date().toISOString();
  await db.send(new UpdateCommand({
    TableName: required("LAB_JOB_TABLE"), Key: { pk: job.pk },
    UpdateExpression: "SET #state = :queued, progressPercent = :progress, updatedAt = :now",
    ConditionExpression: "#state = :awaiting AND ownerSub = :owner",
    ExpressionAttributeNames: { "#state": "state" },
    ExpressionAttributeValues: { ":queued": "queued", ":progress": 5, ":now": updatedAt, ":awaiting": "awaiting_upload", ":owner": identity.sub },
  }));
  await ensureQueuedExecution({ ...job, state: "queued" });
  return json(200, status({ ...job, state: "queued", progressPercent: 5, updatedAt }));
}

export function createLabAnalysisApi(options: LabApiOptions) {
  return async function labAnalysisApiHandler(event: ApiEvent) {
  try {
    const identity = claims(event, options);
    const method = event?.requestContext?.http?.method;
    const path = event?.rawPath;
    const privacy=typeof path==='string'?path.match(/^\/clinical-core\/(?:consumer|synthetic-session)\/labs\/jobs\/([0-9a-f-]{36})\/(privacy-copy|documents\/([0-9a-f-]{36})\/privacy-download)$/i):null;
    if(privacy){
      if(Object.keys(event.queryStringParameters??{}).length)return refusal();
      const scope={ownerSub:identity.sub,organizationId:identity['custom:organization_id'],personId:identity['custom:person_id']};
      const reader=createLabJobPrivacy({classification:CLASSIFICATION[options.mode],prefix:labObjectPrefix(),kmsKeyArn:required('LAB_KMS_KEY_ARN'),
        revalidate:async()=>{if(options.mode==='production')await options.revalidatePrivacyIdentity(event);else claims(event,options);},
        read:async id=>(await db.send(new GetCommand({TableName:required('LAB_JOB_TABLE'),Key:{pk:`job#${id}`},ConsistentRead:true}))).Item,
        head:key=>s3.send(new HeadObjectCommand({Bucket:required('LAB_DOCUMENT_BUCKET'),Key:key,ChecksumMode:'ENABLED'})),
        sign:input=>getSignedUrl(s3,new GetObjectCommand({Bucket:required('LAB_DOCUMENT_BUCKET'),Key:input.key,
          VersionId:input.versionId,IfMatch:input.etag,ResponseContentType:input.contentType,ResponseCacheControl:'no-store',
          ResponseContentDisposition:`attachment; filename="${input.downloadName}"`}),{expiresIn:input.seconds}),
      });
      if(privacy[2]==='privacy-copy'&&method==='GET')return json(200,await reader.copy(scope,privacy[1]));
      if(privacy[3]&&method==='POST'){
        const input=body(event);
        if(Object.keys(input).join(',')!=='confirmDownload'||input.confirmDownload!==true)return refusal();
        return json(200,await reader.document(scope,privacy[1],privacy[3]));
      }
      return refusal(405);
    }
    if (method === 'GET' && typeof path === 'string') {
      const scope = {ownerSub:identity.sub,organizationId:identity['custom:organization_id'],personId:identity['custom:person_id']};
      if (/^\/clinical-core\/(?:consumer|synthetic-session)\/labs\/inventory$/.test(path)) {
        const query = event.queryStringParameters ?? {};
        if (Object.keys(query).some(k => k !== 'cursor')) return refusal();
        return json(200, await listLabInventory(db, required('LAB_JOB_TABLE'), scope, query.cursor));
      }
      const recovery = path.match(/^\/clinical-core\/(?:consumer|synthetic-session)\/labs\/jobs\/([0-9a-f-]{36})\/recovery$/i);
      if (recovery) {
        const job = await ownedJob(recovery[1], identity, options);
        const descriptor = job ? labRecoveryDescriptor(job, scope) : null;
        return descriptor ? json(200, {contractVersion:LAB_INVENTORY_VERSION, job:descriptor}) : refusal(404);
      }
    }
    if(method==='POST' && typeof path==='string'){
      const retirement=path.match(/^\/clinical-core\/(?:consumer|synthetic-session)\/labs\/requests\/([0-9a-f-]{36})\/retire$/i);
      if(retirement){
        const input=body(event);
        if(Object.keys(input).some(k=>k!=='request'))return refusal();
        const request=requestIdentity(input.request);
        if(request.id!==retirement[1].toLowerCase())return refusal();
        await labRequestLedger(db,required('LAB_JOB_TABLE')).retire({ownerSub:identity.sub,organizationId:identity['custom:organization_id'],personId:identity['custom:person_id']},request);
        return json(200,{contractVersion:REQUEST_RETIREMENT_VERSION,requestId:request.id,status:'retired'});
      }
      const recoveryCreate=path.match(/^\/clinical-core\/(?:consumer|synthetic-session)\/labs\/requests\/(documents|saved)$/);
      if(recoveryCreate){
        requestIdentity(body(event).request); // Dedicated routes cannot fall back to legacy creation.
        return recoveryCreate[1]==='documents'?await createJob(event,identity,options):await createPlanJob(event,identity,options);
      }
    }
    if(method==='GET' && typeof path==='string'){
      if(/^\/clinical-core\/(?:consumer|synthetic-session)\/labs\/request-recovery$/.test(path))return json(200,{contractVersion:REQUEST_RECOVERY_VERSION});
      const discovery=path.match(/^\/clinical-core\/(?:consumer|synthetic-session)\/labs\/requests\/([0-9a-f-]{36})$/i);
      if(discovery){
        const job=await labRequestLedger(db,required('LAB_JOB_TABLE')).discover<Job>({ownerSub:identity.sub,organizationId:identity['custom:organization_id'],personId:identity['custom:person_id']},discovery[1]);
        if(!await classifiedJob(job,options))return refusal(404);
        await ensureQueuedExecution(job);
        return json(200,{contractVersion:REQUEST_RECOVERY_VERSION,requestId:discovery[1].toLowerCase(),jobId:job.pk.slice(4)});
      }
    }
    if (method === "POST" && (path === "/clinical-core/consumer/labs/jobs" || path === "/clinical-core/synthetic-session/labs/jobs")) return await createJob(event, identity, options);
    if (method === "POST" && (path === "/clinical-core/consumer/labs/plan-jobs" || path === "/clinical-core/synthetic-session/labs/plan-jobs")) return await createPlanJob(event, identity, options);
    const match = typeof path === "string" ? path.match(/^\/clinical-core\/(?:consumer|synthetic-session)\/labs\/jobs\/([0-9a-f-]{36})(\/(?:complete-upload|resume-upload|cancel|delivery))?$/i) : null;
    if (!match) return refusal(404);
    if (method === 'POST' && match[2] === '/delivery') return await recordDelivery(event,identity,match[1],options);
    if (method === 'POST' && match[2] === '/cancel') return await cancelJob(event,identity,match[1],options);
    if (method === "POST" && match[2] === '/resume-upload') return await resumeUpload(identity, match[1], options);
    if (method === "POST" && match[2] === '/complete-upload') return await completeUpload(event, identity, match[1], options);
    if (method === "DELETE" && !match[2]) return await deleteJob(identity, match[1], options);
    if (method === "GET" && !match[2]) {
      const job = await ownedJob(match[1], identity, options);
      if (job) await ensureQueuedExecution(job);
      return job ? json(200, status(job)) : refusal(404);
    }
    return refusal(404);
  } catch (error) {
    if(error instanceof LabPrivacyError)return json(error.status,{error:error.code});
    if(error instanceof LabRequestError)return json(error.statusCode,{contractVersion:REQUEST_RECOVERY_VERSION,error:error.code});
    if(error instanceof LabAuthorizationRevoked)return json(403,{error:error.reason});
    if(error instanceof OwnedStorageError&&error.code==='account_deletion_write_blocked')return json(403,{error:error.code});
    if(error instanceof CoreSubscriptionError)return json(402,{error:'core_subscription_required'});
    if(error instanceof OwnedStorageError&&error.code==='owner_required')return json(401,{error:'reauth_required'});
    if(error instanceof OwnedStorageError&&error.code==='legal_hold')return json(409,{error:'lab_deletion_held'});
    if(error instanceof OwnedStorageError)return json(503,{error:'lab_analysis_unavailable'});
    return refusal();
  }
  };
}
/** Synthetic handler: unchanged attested-token behavior and object namespace. */
export const createAwsLabAnalysisApiHandler = createLabAnalysisApi({ mode: 'synthetic' });
