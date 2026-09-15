import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DeleteObjectsCommand, HeadObjectCommand, ListObjectsV2Command, ListObjectVersionsCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { collectionRangeContextSchema, type CollectionRangeContext } from "./lab-range-population";
import { resolveLabSourcePanel, type LabSourcePanel } from "./lab-source-panel";
import { labRequestLedger, LabRequestError, requestIdentity, REQUEST_RECOVERY_VERSION, REQUEST_RETIREMENT_VERSION } from './lab-request-ledger';

const CONTRACT_VERSION = "lab-analysis/1";
const MAX_BODY_BYTES = 256 * 1024;
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
const MAX_DOCUMENTS = 30;
const MIME_TYPES = new Set(["application/pdf", "image/jpeg", "image/png"]);

type Claims = { sub: string; "custom:person_id": string; "custom:organization_id": string; "custom:synthetic_attested": "true" } & Record<string, string | undefined>;
type ApiEvent = {
  body?: unknown;
  rawPath?: unknown;
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
  patientContext?: PatientContext;
  longitudinalContext?: LongitudinalContext;
  failureCategory: string | null;
  result: unknown | null;
  rangeReleaseSha256?: string;
};

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

function claims(event: ApiEvent): Claims {
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

function safePatientContext(value: unknown): PatientContext | undefined {
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
    || !(row.complaintSeverity === null || (Number.isInteger(row.complaintSeverity) && Number(row.complaintSeverity) >= 1 && Number(row.complaintSeverity) <= 10))
    || !stringList(row.conditions) || !stringList(row.medications) || !stringList(row.allergies)
    || !Array.isArray(signals) || signals.length > 8 || signals.some((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return true;
      const signal = item as Record<string, unknown>;
      return typeof signal.categoryId !== "string" || signal.categoryId.length < 1 || signal.categoryId.length > 80
        || !Number.isInteger(signal.percentage) || Number(signal.percentage) < 0 || Number(signal.percentage) > 100;
    })
    || !lifestyle || Array.isArray(lifestyle)
    || typeof lifestyle.sleepHours !== "number" || lifestyle.sleepHours < 0 || lifestyle.sleepHours > 24
    || typeof lifestyle.sleepQuality !== "number" || lifestyle.sleepQuality < 0 || lifestyle.sleepQuality > 10
    || typeof lifestyle.stressLevel !== "number" || lifestyle.stressLevel < 0 || lifestyle.stressLevel > 10
    || typeof lifestyle.dietType !== "string" || !["omnivore", "vegetarian", "vegan", "keto", "paleo", "mediterranean", "other"].includes(lifestyle.dietType)
    || typeof lifestyle.exerciseFrequency !== "number" || lifestyle.exerciseFrequency < 0 || lifestyle.exerciseFrequency > 14) {
    throw new Error("patient_context_invalid");
  }
  return row as PatientContext;
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
  };
}

async function ownedJob(jobId: string, ownerSub: string): Promise<Job | null> {
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return null;
  const result = await db.send(new GetCommand({
    TableName: required("LAB_JOB_TABLE"),
    Key: { pk: `job#${jobId}` },
    ConsistentRead: true,
  }));
  const job = result.Item as Job | undefined;
  return job?.ownerSub === ownerSub ? job : null;
}

async function purgePrefix(bucket: string, prefix: string): Promise<void> {
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  do {
    const page = await s3.send(new ListObjectVersionsCommand({
      Bucket: bucket,
      Prefix: prefix,
      ...(keyMarker ? { KeyMarker: keyMarker } : {}),
      ...(versionIdMarker ? { VersionIdMarker: versionIdMarker } : {}),
    }));
    const objects = [
      ...(page.Versions ?? []).map((row) => ({ Key: row.Key!, VersionId: row.VersionId! })),
      ...(page.DeleteMarkers ?? []).map((row) => ({ Key: row.Key!, VersionId: row.VersionId! })),
    ];
    if (objects.length > 0) {
      const deleted = await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }));
      if (deleted.Errors?.length) throw new Error("lab_object_deletion_incomplete");
    }
    keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    versionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
  } while (keyMarker || versionIdMarker);
}

async function deleteJob(identity: Claims, jobId: string) {
  const job = await ownedJob(jobId, identity.sub);
  if (!job) return json(200, { contractVersion: CONTRACT_VERSION, jobId, deleted: true });
  if (!["awaiting_upload", "completed", "needs_review", "failed"].includes(job.state)) return refusal(409);

  const bucket = required("LAB_DOCUMENT_BUCKET");
  await purgePrefix(bucket, `synthetic-labs/${job.organizationId}/${job.ownerSub}/${jobId}/`);
  await purgePrefix(bucket, `synthetic-labs/artifacts/${jobId}/`);
  await db.send(new DeleteCommand({
    TableName: required("LAB_JOB_TABLE"),
    Key: { pk: job.pk },
    ConditionExpression: "ownerSub = :owner",
    ExpressionAttributeValues: { ":owner": identity.sub },
  }));
  return json(200, { contractVersion: CONTRACT_VERSION, jobId, deleted: true });
}

async function createJob(event: ApiEvent, identity: Claims) {
  const input = body(event);
  if (input.dataClassification !== "synthetic_only" || input.attestsSyntheticOnly !== true
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
    objectKey: `synthetic-labs/${identity["custom:organization_id"]}/${identity.sub}/${jobId}/${document.clientDocumentId}/${document.fileName}`,
  }));
  const job: Job = {
    pk: `job#${jobId}`,
    ownerSub: identity.sub,
    organizationId: identity["custom:organization_id"],
    personId: identity["custom:person_id"],
    state: "awaiting_upload",
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
  };
  if(input.request!==undefined){
    const {request,...intent}=input;
    const saved=await labRequestLedger(db,required('LAB_JOB_TABLE')).create(job,request,'documents',intent,job);
    return json(200,{contractVersion:REQUEST_RECOVERY_VERSION,requestId:requestIdentity(request).id,jobId:saved.pk.slice(4)});
  }
  await db.send(new PutCommand({TableName:required('LAB_JOB_TABLE'),Item:job,ConditionExpression:'attribute_not_exists(pk)'}));
  const targets = await uploadTargets(job, stored);
  return json(200, { contractVersion: CONTRACT_VERSION, jobId, state: "awaiting_upload", documents: targets });
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

async function resumeUpload(identity: Claims, jobId: string) {
  const job = await ownedJob(jobId, identity.sub);
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

async function createPlanJob(event: ApiEvent, identity: Claims) {
  const input = body(event);
  const expected = ["request", "panelId", "panelName", "testDate", "patientContext", "longitudinalContext", "dataClassification", "attestsSyntheticOnly", "biomarkers"];
  if (Object.keys(input).some((key) => !expected.includes(key))
    || input.dataClassification !== "synthetic_only" || input.attestsSyntheticOnly !== true
    || !boundedString(input.panelId, 160) || !boundedString(input.panelName, 180) || !safeDate(input.testDate)) return refusal();
  const structuredBiomarkers = safeStructuredLabBiomarkers(input.biomarkers);
  const sourcePanel=resolveLabSourcePanel({sourcePanel:{panelId:input.panelId,panelName:input.panelName,testDate:input.testDate},structuredBiomarkers});
  const patientContext = safePatientContext(input.patientContext);
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
    ...(patientContext ? { patientContext } : {}),
    ...(longitudinalContext ? { longitudinalContext } : {}),
    failureCategory: null,
    result: null,
  };
  if(input.request!==undefined){
    const {request,...intent}=input;
    const saved=await labRequestLedger(db,required('LAB_JOB_TABLE')).create(job,request,'saved',intent,job);
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

async function completeUpload(event: ApiEvent, identity: Claims, jobId: string) {
  const input = body(event);
  const job = await ownedJob(jobId, identity.sub!);
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

export async function createAwsLabAnalysisApiHandler(event: ApiEvent) {
  try {
    const identity = claims(event);
    const method = event?.requestContext?.http?.method;
    const path = event?.rawPath;
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
        return recoveryCreate[1]==='documents'?await createJob(event,identity):await createPlanJob(event,identity);
      }
    }
    if(method==='GET' && typeof path==='string'){
      if(/^\/clinical-core\/(?:consumer|synthetic-session)\/labs\/request-recovery$/.test(path))return json(200,{contractVersion:REQUEST_RECOVERY_VERSION});
      const discovery=path.match(/^\/clinical-core\/(?:consumer|synthetic-session)\/labs\/requests\/([0-9a-f-]{36})$/i);
      if(discovery){
        const job=await labRequestLedger(db,required('LAB_JOB_TABLE')).discover<Job>({ownerSub:identity.sub,organizationId:identity['custom:organization_id'],personId:identity['custom:person_id']},discovery[1]);
        await ensureQueuedExecution(job);
        return json(200,{contractVersion:REQUEST_RECOVERY_VERSION,requestId:discovery[1].toLowerCase(),jobId:job.pk.slice(4)});
      }
    }
    if (method === "POST" && (path === "/clinical-core/consumer/labs/jobs" || path === "/clinical-core/synthetic-session/labs/jobs")) return await createJob(event, identity);
    if (method === "POST" && (path === "/clinical-core/consumer/labs/plan-jobs" || path === "/clinical-core/synthetic-session/labs/plan-jobs")) return await createPlanJob(event, identity);
    const match = typeof path === "string" ? path.match(/^\/clinical-core\/(?:consumer|synthetic-session)\/labs\/jobs\/([0-9a-f-]{36})(\/(?:complete-upload|resume-upload))?$/i) : null;
    if (!match) return refusal(404);
    if (method === "POST" && match[2] === '/resume-upload') return await resumeUpload(identity, match[1]);
    if (method === "POST" && match[2] === '/complete-upload') return await completeUpload(event, identity, match[1]);
    if (method === "DELETE" && !match[2]) return await deleteJob(identity, match[1]);
    if (method === "GET" && !match[2]) {
      const job = await ownedJob(match[1], identity.sub);
      if (job) await ensureQueuedExecution(job);
      return job ? json(200, status(job)) : refusal(404);
    }
    return refusal(404);
  } catch (error) {
    if(error instanceof LabRequestError)return json(error.statusCode,{contractVersion:REQUEST_RECOVERY_VERSION,error:error.code});
    return refusal();
  }
}
