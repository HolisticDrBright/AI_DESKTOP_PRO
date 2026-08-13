import { createHash, randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetCommand, UpdateCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  DetectDocumentTextCommand,
  GetDocumentTextDetectionCommand,
  StartDocumentTextDetectionCommand,
  TextractClient,
} from "@aws-sdk/client-textract";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const textract = new TextractClient({});
const PASS_STATE = ["extracting", "verifying", "normalizing", "interpreting", "synthesizing"] as const;
const PASS_PROGRESS = [20, 40, 60, 80, 95];
const UUID_NS = "ai-longevity-pro-synthetic-lab-v1";

type StoredDocument = { clientDocumentId: string; contentType: string; objectKey: string };
type Job = { pk: string; state: string; documents: StoredDocument[] };
export type Extracted = { lines: Array<{ text: string; confidence: number; page: number | null; documentId: string }> };
export type Biomarker = {
  canonicalName: string; reportedName: string; value: number; unit: string;
  labMin: number | null; labMax: number | null; functionalMin: number; functionalMax: number;
  sourceId: string; sourceVersion: string; population: string; confidence: number;
  documentId: string; page: number | null;
};

const RULES = [
  { name: "Glucose", aliases: ["glucose"], units: ["mg/dl"], min: 75, max: 90 },
  { name: "Hemoglobin A1c", aliases: ["hemoglobin a1c", "hba1c", "a1c"], units: ["%"], min: 4.8, max: 5.4 },
  { name: "Fasting Insulin", aliases: ["fasting insulin", "insulin"], units: ["uiu/ml", "µiu/ml", "miu/l"], min: 2, max: 6 },
  { name: "TSH", aliases: ["tsh", "thyroid stimulating hormone"], units: ["uiu/ml", "miu/l"], min: 1, max: 2.5 },
  { name: "Free T3", aliases: ["free t3", "ft3"], units: ["pg/ml"], min: 3, max: 4.2 },
  { name: "Free T4", aliases: ["free t4", "ft4"], units: ["ng/dl"], min: 1.1, max: 1.5 },
  { name: "Vitamin D", aliases: ["vitamin d", "25-oh vitamin d", "25 hydroxy vitamin d"], units: ["ng/ml"], min: 50, max: 80 },
  { name: "hs-CRP", aliases: ["hs-crp", "high sensitivity crp", "c-reactive protein"], units: ["mg/l"], min: 0, max: 1 },
  { name: "Triglycerides", aliases: ["triglycerides"], units: ["mg/dl"], min: 50, max: 100 },
  { name: "HDL Cholesterol", aliases: ["hdl cholesterol", "hdl-c", "hdl"], units: ["mg/dl"], min: 60, max: 100 },
  { name: "LDL Cholesterol", aliases: ["ldl cholesterol", "ldl-c", "ldl"], units: ["mg/dl"], min: 0, max: 100 },
] as const;

function required(name: string) { const value = process.env[name]; if (!value) throw new Error("lab_runtime_configuration_missing"); return value; }
function stableUuid(value: string): string {
  const hex = createHash("sha256").update(`${UUID_NS}:${value}`).digest("hex").slice(0, 32).split("");
  hex[12] = "4"; hex[16] = ((parseInt(hex[16], 16) & 3) | 8).toString(16);
  return `${hex.slice(0,8).join("")}-${hex.slice(8,12).join("")}-${hex.slice(12,16).join("")}-${hex.slice(16,20).join("")}-${hex.slice(20).join("")}`;
}
async function streamText(body: unknown): Promise<string> {
  if (!body || typeof body !== "object" || !("transformToString" in body)
    || typeof (body as { transformToString?: unknown }).transformToString !== "function") {
    throw new Error("artifact_body_invalid");
  }
  return (body as { transformToString(): Promise<string> }).transformToString();
}
async function readArtifact(jobId: string, name: string) {
  const response = await s3.send(new GetObjectCommand({ Bucket: required("LAB_DOCUMENT_BUCKET"), Key: `synthetic-labs/artifacts/${jobId}/${name}.json` }));
  return JSON.parse(await streamText(response.Body));
}
async function writeArtifact(jobId: string, name: string, value: unknown) {
  await s3.send(new PutObjectCommand({ Bucket: required("LAB_DOCUMENT_BUCKET"), Key: `synthetic-labs/artifacts/${jobId}/${name}.json`, Body: JSON.stringify(value), ContentType: "application/json", ServerSideEncryption: "aws:kms", SSEKMSKeyId: required("LAB_KMS_KEY_ARN") }));
}
async function extractDocument(document: StoredDocument): Promise<Extracted["lines"]> {
  if (document.contentType !== "application/pdf") {
    const response = await textract.send(new DetectDocumentTextCommand({ Document: { S3Object: { Bucket: required("LAB_DOCUMENT_BUCKET"), Name: document.objectKey } } }));
    return (response.Blocks ?? []).filter((block) => block.BlockType === "LINE" && block.Text).map((block) => ({ text: block.Text!, confidence: block.Confidence ?? 0, page: block.Page ?? null, documentId: document.clientDocumentId }));
  }
  const started = await textract.send(new StartDocumentTextDetectionCommand({
    DocumentLocation: { S3Object: { Bucket: required("LAB_DOCUMENT_BUCKET"), Name: document.objectKey } },
    ClientRequestToken: createHash("sha256").update(document.objectKey).digest("hex").slice(0, 64),
    JobTag: "synthetic-lab",
  }));
  if (!started.JobId) throw new Error("textract_job_missing");
  for (let attempt = 0; attempt < 45; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 500 : 2_000));
    let nextToken: string | undefined;
    const lines: Extracted["lines"] = [];
    do {
      const response = await textract.send(new GetDocumentTextDetectionCommand({ JobId: started.JobId, NextToken: nextToken, MaxResults: 1000 }));
      if (response.JobStatus === "FAILED") throw Object.assign(new Error("textract_failed"), { category: "document_unreadable" });
      if (response.JobStatus === "IN_PROGRESS") break;
      for (const block of response.Blocks ?? []) if (block.BlockType === "LINE" && block.Text) lines.push({ text: block.Text, confidence: block.Confidence ?? 0, page: block.Page ?? null, documentId: document.clientDocumentId });
      nextToken = response.NextToken;
      if (!nextToken) return lines;
    } while (nextToken);
  }
  throw Object.assign(new Error("textract_timeout"), { category: "provider_unavailable" });
}
function parseRange(line: string): { min: number | null; max: number | null } {
  const range = line.match(/(?:range|reference)?\s*[:=]?\s*(-?\d+(?:\.\d+)?)\s*[-–]\s*(-?\d+(?:\.\d+)?)/i);
  return range ? { min: Number(range[1]), max: Number(range[2]) } : { min: null, max: null };
}
export function normalizeExtractedLabLines(extracted: Extracted): Biomarker[] {
  const output: Biomarker[] = [];
  for (const line of extracted.lines) {
    const lower = line.text.toLowerCase().replace(/[μµ]/g, "u");
    for (const rule of RULES) {
      if (!rule.aliases.some((alias) => new RegExp(`(^|\\b)${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\b|$)`, "i").test(lower))) continue;
      const numbers = [...line.text.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
      if (!numbers.length) continue;
      const value = numbers[0];
      const normalizedUnit = line.text.toLowerCase().replace(/[μµ]/g, "u");
      const unit = rule.units.find((candidate) => normalizedUnit.includes(candidate.replace(/[μµ]/g, "u"))) ?? rule.units[0];
      const range = parseRange(line.text.slice((line.text.match(/-?\d+(?:\.\d+)?/)?.index ?? 0) + String(value).length));
      output.push({ canonicalName: rule.name, reportedName: line.text.slice(0, 160), value, unit, labMin: range.min, labMax: range.max, functionalMin: rule.min, functionalMax: rule.max, sourceId: stableUuid(`range:${rule.name}`), sourceVersion: "synthetic-functional-ranges/1", population: "Synthetic adult test fixture; practitioner verification required", confidence: Math.max(0, Math.min(1, line.confidence / 100)), documentId: line.documentId, page: line.page });
      break;
    }
  }
  return output.filter((row, index) => output.findIndex((candidate) => candidate.canonicalName === row.canonicalName) === index);
}
export function functionalRangeStatus(value: number, min: number, max: number) {
  if (value >= min && value <= max) return "optimal";
  const span = Math.max(max - min, Math.abs(max), 1);
  return value < min - span || value > max + span ? "critical" : "suboptimal";
}
async function executePass(job: Job, pass: number): Promise<unknown | null> {
  const jobId = job.pk.slice(4);
  if (pass === 0) {
    const lines: Extracted["lines"] = [];
    for (const document of job.documents) {
      lines.push(...await extractDocument(document));
    }
    await writeArtifact(jobId, "extracted", { lines });
    return null;
  }
  if (pass === 1) {
    const extracted = await readArtifact(jobId, "extracted") as Extracted;
    const verified = extracted.lines.map((line) => ({ ...line, normalizedText: line.text.replace(/\s+/g, " ").trim(), needsHumanReview: line.confidence < 80 }));
    await writeArtifact(jobId, "verified", { lines: verified });
    return null;
  }
  if (pass === 2) {
    const extracted = await readArtifact(jobId, "extracted") as Extracted;
    const biomarkers = normalizeExtractedLabLines(extracted);
    if (!biomarkers.length) throw Object.assign(new Error("no_supported_biomarkers"), { category: "document_unreadable" });
    await writeArtifact(jobId, "normalized", { biomarkers });
    return null;
  }
  if (pass === 3) {
    const { biomarkers } = await readArtifact(jobId, "normalized") as { biomarkers: Biomarker[] };
    const interpreted = biomarkers.map((row) => ({ ...row, status: functionalRangeStatus(row.value, row.functionalMin, row.functionalMax) }));
    await writeArtifact(jobId, "interpreted", { biomarkers: interpreted });
    return null;
  }
  const { biomarkers } = await readArtifact(jobId, "interpreted") as { biomarkers: Array<Biomarker & { status: string }> };
  const flagged = biomarkers.filter((row) => row.status !== "optimal");
  const generatedAt = new Date().toISOString();
  const result = {
    analysisId: randomUUID(), reviewState: "draft_for_practitioner_review", generatedAt,
    summary: flagged.length ? `${flagged.length} of ${biomarkers.length} supported biomarker(s) fall outside the synthetic functional ranges. This is a test interpretation and requires practitioner review.` : `All ${biomarkers.length} supported biomarker(s) fall within the synthetic functional ranges. This is a test interpretation and requires practitioner review.`,
    biomarkers: biomarkers.map((row) => ({ biomarkerId: stableUuid(`biomarker:${row.canonicalName}`), canonicalName: row.canonicalName, reportedName: row.reportedName, value: row.value, unit: row.unit, labReferenceRange: { min: row.labMin, max: row.labMax, rawText: row.labMin === null && row.labMax === null ? "Not reported or not reliably extracted" : `${row.labMin ?? ""}-${row.labMax ?? ""}` }, functionalRange: { min: row.functionalMin, max: row.functionalMax, sourceId: row.sourceId, sourceVersion: row.sourceVersion, population: row.population }, status: row.status, extractionConfidence: row.confidence, verificationState: row.confidence >= 0.8 ? "independently_verified" : "needs_human_review", sourceDocumentId: row.documentId, sourcePage: row.page })),
    recommendations: [],
    priorityActions: flagged.map((row) => `Review ${row.canonicalName} (${row.value} ${row.unit}) with a qualified practitioner before changing treatment.`).slice(0, 12),
    citations: biomarkers.map((row) => ({ sourceId: row.sourceId, sourceVersion: row.sourceVersion, claimIds: [] })).filter((row, index, all) => all.findIndex((candidate) => candidate.sourceId === row.sourceId) === index),
  };
  await writeArtifact(jobId, "result", result);
  return result;
}

export async function createAwsLabAnalysisWorker(event: { jobId?: string; pass?: number; fail?: boolean; failureCategory?: string }) {
  const jobId = event.jobId ?? ""; const pass = event.pass ?? -1;
  if (/^[0-9a-f-]{36}$/i.test(jobId) && event.fail === true) {
    const allowed = new Set(["document_unreadable", "verification_disagreement", "unsupported_document", "provider_unavailable", "safety_review_required", "internal_failure"]);
    const category = allowed.has(event.failureCategory ?? "") ? event.failureCategory : "internal_failure";
    await db.send(new UpdateCommand({ TableName: required("LAB_JOB_TABLE"), Key: { pk: `job#${jobId}` }, UpdateExpression: "SET #state = :failed, failureCategory = :category, updatedAt = :now", ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":failed": "failed", ":category": category, ":now": new Date().toISOString() } }));
    return { jobId, failed: true };
  }
  if (!/^[0-9a-f-]{36}$/i.test(jobId) || !Number.isInteger(pass) || pass < 0 || pass > 4) throw new Error("worker_input_invalid");
  const response = await db.send(new GetCommand({ TableName: required("LAB_JOB_TABLE"), Key: { pk: `job#${jobId}` }, ConsistentRead: true }));
  const job = response.Item as Job | undefined;
  const allowedStartStates = new Set(["queued", PASS_STATE[pass], ...(pass > 0 ? [PASS_STATE[pass - 1]] : [])]);
  if (!job || !allowedStartStates.has(job.state)) throw new Error("job_state_invalid");
  const now = new Date().toISOString();
  await db.send(new UpdateCommand({ TableName: required("LAB_JOB_TABLE"), Key: { pk: job.pk }, UpdateExpression: "SET #state = :state, progressPercent = :progress, updatedAt = :now", ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":state": PASS_STATE[pass], ":progress": PASS_PROGRESS[pass], ":now": now } }));
  try {
    const output = await executePass(job, pass);
    const terminal = pass === 4;
    const updatedAt = new Date().toISOString();
    await db.send(new UpdateCommand({
      TableName: required("LAB_JOB_TABLE"),
      Key: { pk: job.pk },
      UpdateExpression: terminal
        ? "SET #state = :state, passesCompleted = :completed, progressPercent = :progress, updatedAt = :now, #result = :result"
        : "SET #state = :state, passesCompleted = :completed, progressPercent = :progress, updatedAt = :now",
      ExpressionAttributeNames: { "#state": "state", ...(terminal ? { "#result": "result" } : {}) },
      ExpressionAttributeValues: {
        ":state": terminal ? "completed" : PASS_STATE[pass],
        ":completed": pass + 1,
        ":progress": terminal ? 100 : PASS_PROGRESS[pass],
        ":now": updatedAt,
        ...(terminal ? { ":result": output } : {}),
      },
    }));
    return { jobId, pass, completed: true };
  } catch (error) {
    const detail = error && typeof error === "object" ? error as Record<string, unknown> : {};
    const errorName = typeof detail.name === "string" ? detail.name : "UnknownError";
    const errorCode = typeof detail.Code === "string"
      ? detail.Code
      : typeof detail.code === "string" ? detail.code : null;
    console.error("lab_worker_pass_failed", { pass, errorName, errorCode });
    const category = typeof detail.category === "string"
      ? detail.category
      : errorName === "UnsupportedDocumentException" ? "unsupported_document" : "internal_failure";
    const wrapped = new Error(category);
    wrapped.name = category;
    throw wrapped;
  }
}
