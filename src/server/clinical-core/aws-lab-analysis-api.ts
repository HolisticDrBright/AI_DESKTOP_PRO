import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DeleteObjectsCommand, HeadObjectCommand, ListObjectVersionsCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";

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
  status: "optimal" | "normal" | "suboptimal" | "critical";
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
  panelId?: string;
  patientContext?: PatientContext;
  longitudinalContext?: LongitudinalContext;
  failureCategory: string | null;
  result: unknown | null;
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
    || (row.byteSize ?? 0) > MAX_DOCUMENT_BYTES) {
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
    || !["optimal", "normal", "suboptimal", "critical"].includes(String(row.status))) throw new Error("longitudinal_context_invalid");
  return row as LongitudinalBiomarker;
}

export function safeStructuredLabBiomarkers(value: unknown): StructuredLabBiomarker[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 1000) throw new Error("structured_biomarkers_invalid");
  const biomarkers = value.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("structured_biomarkers_invalid");
    const row = candidate as Record<string, unknown>;
    const expected = ["markerId", "canonicalName", "value", "unit", "labMin", "labMax"];
    if (Object.keys(row).some((key) => !expected.includes(key))
      || !boundedString(row.markerId, 160) || !boundedString(row.canonicalName, 160)
      || typeof row.value !== "number" || !Number.isFinite(row.value)
      || !boundedString(row.unit, 80) || !safeNullableNumber(row.labMin) || !safeNullableNumber(row.labMax)
      || (row.labMin !== null && row.labMax !== null && Number(row.labMin) > Number(row.labMax))) {
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
      await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }));
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
  const bucket = required("LAB_DOCUMENT_BUCKET");
  const kmsKey = required("LAB_KMS_KEY_ARN");
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
    ...(typeof input.panelId === "string" && input.panelId.length <= 160 ? { panelId: input.panelId } : {}),
    ...(patientContext ? { patientContext } : {}),
    ...(longitudinalContext ? { longitudinalContext } : {}),
    failureCategory: null,
    result: null,
  };
  await db.send(new PutCommand({
    TableName: required("LAB_JOB_TABLE"),
    Item: job,
    ConditionExpression: "attribute_not_exists(pk)",
  }));
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const targets = await Promise.all(stored.map(async (document) => {
    const headers = {
      "content-type": document.contentType,
      "x-amz-server-side-encryption": "aws:kms",
      "x-amz-server-side-encryption-aws-kms-key-id": kmsKey,
      "x-amz-meta-job-id": jobId,
      "x-amz-meta-document-id": document.clientDocumentId,
    };
    const uploadUrl = await getSignedUrl(s3, new PutObjectCommand({
      Bucket: bucket,
      Key: document.objectKey,
      ContentType: document.contentType,
      ServerSideEncryption: "aws:kms",
      SSEKMSKeyId: kmsKey,
      Metadata: { "job-id": jobId, "document-id": document.clientDocumentId },
    }), {
      expiresIn: 15 * 60,
      unhoistableHeaders: new Set(["x-amz-meta-job-id", "x-amz-meta-document-id"]),
    });
    return { clientDocumentId: document.clientDocumentId, uploadUrl, method: "PUT", requiredHeaders: headers, expiresAt };
  }));
  return json(200, { contractVersion: CONTRACT_VERSION, jobId, state: "awaiting_upload", documents: targets });
}

async function createPlanJob(event: ApiEvent, identity: Claims) {
  const input = body(event);
  const expected = ["panelId", "panelName", "testDate", "patientContext", "longitudinalContext", "dataClassification", "attestsSyntheticOnly", "biomarkers"];
  if (Object.keys(input).some((key) => !expected.includes(key))
    || input.dataClassification !== "synthetic_only" || input.attestsSyntheticOnly !== true
    || !boundedString(input.panelId, 160) || !boundedString(input.panelName, 180) || !safeDate(input.testDate)) return refusal();
  const structuredBiomarkers = safeStructuredLabBiomarkers(input.biomarkers);
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
    panelId: input.panelId,
    ...(patientContext ? { patientContext } : {}),
    ...(longitudinalContext ? { longitudinalContext } : {}),
    failureCategory: null,
    result: null,
  };
  await db.send(new PutCommand({ TableName: required("LAB_JOB_TABLE"), Item: job, ConditionExpression: "attribute_not_exists(pk)" }));
  await sfn.send(new StartExecutionCommand({
    stateMachineArn: required("LAB_STATE_MACHINE_ARN"),
    name: `lab-plan-${jobId}`,
    input: JSON.stringify({ jobId }),
  }));
  console.info(JSON.stringify({ event: "structured_lab_plan_job_created", jobId, markerCount: structuredBiomarkers.length }));
  return json(200, { contractVersion: CONTRACT_VERSION, jobId, state: "queued" });
}

async function completeUpload(event: ApiEvent, identity: Claims, jobId: string) {
  const input = body(event);
  const job = await ownedJob(jobId, identity.sub!);
  if (!job) return refusal(404);
  if (job.state !== "awaiting_upload") return json(200, status(job));
  if (!Array.isArray(input.uploadedDocuments)
    || input.uploadedDocuments.length !== job.documents.length) return refusal(409);
  const ids = new Set(input.uploadedDocuments.map((row) => (
    row && typeof row === "object" && !Array.isArray(row)
      ? (row as Record<string, unknown>).clientDocumentId
      : undefined
  )));
  if (ids.size !== job.documents.length || job.documents.some((row) => !ids.has(row.clientDocumentId))) return refusal();
  for (const document of job.documents) {
    const head = await s3.send(new HeadObjectCommand({ Bucket: required("LAB_DOCUMENT_BUCKET"), Key: document.objectKey }));
    if (head.ContentLength !== document.byteSize
      || head.ContentType !== document.contentType
      || head.ServerSideEncryption !== "aws:kms"
      || head.Metadata?.["job-id"] !== jobId
      || head.Metadata?.["document-id"] !== document.clientDocumentId) return refusal(409);
  }
  const updatedAt = new Date().toISOString();
  await db.send(new UpdateCommand({
    TableName: required("LAB_JOB_TABLE"), Key: { pk: job.pk },
    UpdateExpression: "SET #state = :queued, progressPercent = :progress, updatedAt = :now",
    ConditionExpression: "#state = :awaiting AND ownerSub = :owner",
    ExpressionAttributeNames: { "#state": "state" },
    ExpressionAttributeValues: { ":queued": "queued", ":progress": 5, ":now": updatedAt, ":awaiting": "awaiting_upload", ":owner": identity.sub },
  }));
  await sfn.send(new StartExecutionCommand({
    stateMachineArn: required("LAB_STATE_MACHINE_ARN"),
    name: `lab-${jobId}`,
    input: JSON.stringify({ jobId }),
  }));
  return json(200, status({ ...job, state: "queued", progressPercent: 5, updatedAt }));
}

export async function createAwsLabAnalysisApiHandler(event: ApiEvent) {
  try {
    const identity = claims(event);
    const method = event?.requestContext?.http?.method;
    const path = event?.rawPath;
    if (method === "POST" && (path === "/clinical-core/consumer/labs/jobs" || path === "/clinical-core/synthetic-session/labs/jobs")) return createJob(event, identity);
    if (method === "POST" && (path === "/clinical-core/consumer/labs/plan-jobs" || path === "/clinical-core/synthetic-session/labs/plan-jobs")) return createPlanJob(event, identity);
    const match = typeof path === "string" ? path.match(/^\/clinical-core\/(?:consumer|synthetic-session)\/labs\/jobs\/([0-9a-f-]{36})(\/complete-upload)?$/i) : null;
    if (!match) return refusal(404);
    if (method === "POST" && match[2]) return completeUpload(event, identity, match[1]);
    if (method === "DELETE" && !match[2]) return deleteJob(identity, match[1]);
    if (method === "GET" && !match[2]) {
      const job = await ownedJob(match[1], identity.sub);
      return job ? json(200, status(job)) : refusal(404);
    }
    return refusal(404);
  } catch {
    return refusal();
  }
}
