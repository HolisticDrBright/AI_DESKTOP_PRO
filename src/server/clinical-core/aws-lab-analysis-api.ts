import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand, UpdateCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
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
  requestContext?: { authorizer?: { jwt?: { claims?: unknown } }; http?: { method?: unknown } };
};
type DocumentInput = {
  clientDocumentId: string;
  fileName: string;
  contentType: string;
  byteSize: number;
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
  panelId?: string;
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
  const value = event?.requestContext?.authorizer?.jwt?.claims;
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
    result: job.result,
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

async function createJob(event: ApiEvent, identity: Claims) {
  const input = body(event);
  if (input.dataClassification !== "synthetic_only" || input.attestsSyntheticOnly !== true
    || !Array.isArray(input.documents) || input.documents.length < 1 || input.documents.length > MAX_DOCUMENTS) {
    return refusal();
  }
  const documents = input.documents.map(safeDocument);
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
    if (method === "POST" && path === "/clinical-core/consumer/labs/jobs") return createJob(event, identity);
    const match = typeof path === "string" ? path.match(/^\/clinical-core\/consumer\/labs\/jobs\/([0-9a-f-]{36})(\/complete-upload)?$/i) : null;
    if (!match) return refusal(404);
    if (method === "POST" && match[2]) return completeUpload(event, identity, match[1]);
    if (method === "GET" && !match[2]) {
      const job = await ownedJob(match[1], identity.sub);
      return job ? json(200, status(job)) : refusal(404);
    }
    return refusal(404);
  } catch {
    return refusal();
  }
}
