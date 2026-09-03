import { createHash, randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetCommand, UpdateCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  AnalyzeDocumentCommand,
  GetDocumentAnalysisCommand,
  StartDocumentAnalysisCommand,
  TextractClient,
} from "@aws-sdk/client-textract";
import { synthesizeLabWithOpenAI } from "./aws-lab-openai";
import type { LongitudinalContext, PatientContext } from "./aws-lab-analysis-api";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const textract = new TextractClient({});
const PASS_STATE = ["extracting", "verifying", "normalizing", "interpreting", "synthesizing"] as const;
const PASS_PROGRESS = [20, 40, 60, 80, 95];
const UUID_NS = "ai-longevity-pro-synthetic-lab-v1";

type StoredDocument = { clientDocumentId: string; contentType: string; objectKey: string };
type Job = { pk: string; state: string; documents: StoredDocument[]; patientContext?: PatientContext; longitudinalContext?: LongitudinalContext };
type ExtractedCell = { text: string; confidence: number; column: number };
type ExtractedRow = { cells: ExtractedCell[]; page: number | null; documentId: string };
export type Extracted = {
  lines: Array<{ text: string; confidence: number; page: number | null; documentId: string }>;
  tableRows?: ExtractedRow[];
};
export type Biomarker = {
  canonicalName: string; reportedName: string; value: number; unit: string;
  labMin: number | null; labMax: number | null; functionalMin: number | null; functionalMax: number | null;
  sourceId: string | null; sourceVersion: string | null; population: string | null; confidence: number;
  documentId: string; page: number | null;
};

type TextractBlock = {
  Id?: string; BlockType?: string; Text?: string; Confidence?: number; Page?: number;
  RowIndex?: number; ColumnIndex?: number;
  Geometry?: { BoundingBox?: { Left?: number; Top?: number; Width?: number; Height?: number } };
  Relationships?: Array<{ Type?: string; Ids?: string[] }>;
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
function tableRowsFromBlocks(blocks: TextractBlock[], documentId: string): ExtractedRow[] {
  const byId = new Map(blocks.filter((block) => block.Id).map((block) => [block.Id!, block]));
  const rows: ExtractedRow[] = [];
  const textForCell = (cell: TextractBlock) => (cell.Relationships ?? [])
    .filter((relationship) => relationship.Type === "CHILD")
    .flatMap((relationship) => relationship.Ids ?? [])
    .map((id) => byId.get(id))
    .filter((block): block is TextractBlock => Boolean(block))
    .map((block) => block.BlockType === "SELECTION_ELEMENT" ? "selected" : block.Text ?? "")
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  for (const table of blocks.filter((block) => block.BlockType === "TABLE")) {
    const cellIds = (table.Relationships ?? [])
      .filter((relationship) => relationship.Type === "CHILD")
      .flatMap((relationship) => relationship.Ids ?? []);
    const grouped = new Map<number, ExtractedCell[]>();
    for (const id of cellIds) {
      const cell = byId.get(id);
      if (!cell || cell.BlockType !== "CELL" || !cell.RowIndex || !cell.ColumnIndex) continue;
      const text = textForCell(cell);
      if (!text) continue;
      const row = grouped.get(cell.RowIndex) ?? [];
      row.push({ text, confidence: cell.Confidence ?? 0, column: cell.ColumnIndex });
      grouped.set(cell.RowIndex, row);
    }
    for (const cells of grouped.values()) {
      rows.push({ cells: cells.sort((a, b) => a.column - b.column), page: table.Page ?? null, documentId });
    }
  }
  return rows;
}

function spatialRowsFromBlocks(blocks: TextractBlock[], documentId: string): ExtractedRow[] {
  const lineBlocks = blocks
    .filter((block) => block.BlockType === "LINE" && block.Text && block.Geometry?.BoundingBox)
    .map((block) => ({
      text: block.Text!,
      confidence: block.Confidence ?? 0,
      page: block.Page ?? null,
      left: block.Geometry!.BoundingBox!.Left ?? 0,
      top: block.Geometry!.BoundingBox!.Top ?? 0,
      height: block.Geometry!.BoundingBox!.Height ?? 0,
    }))
    .sort((a, b) => (a.page ?? 0) - (b.page ?? 0) || a.top - b.top || a.left - b.left);
  const groups: Array<{ page: number | null; center: number; height: number; lines: typeof lineBlocks }> = [];
  for (const line of lineBlocks) {
    const center = line.top + line.height / 2;
    const prior = groups.at(-1);
    const tolerance = Math.max(0.006, Math.min(0.02, Math.max(line.height, prior?.height ?? 0) * 0.65));
    if (prior && prior.page === line.page && Math.abs(prior.center - center) <= tolerance) {
      prior.lines.push(line);
      prior.center = prior.lines.reduce((sum, item) => sum + item.top + item.height / 2, 0) / prior.lines.length;
      prior.height = Math.max(prior.height, line.height);
    } else {
      groups.push({ page: line.page, center, height: line.height, lines: [line] });
    }
  }
  return groups
    .filter((group) => group.lines.length >= 2)
    .map((group) => ({
      page: group.page,
      documentId,
      cells: group.lines
        .sort((a, b) => a.left - b.left)
        .map((line, index) => ({ text: line.text, confidence: line.confidence, column: index + 1 })),
    }));
}

function extractedFromBlocks(blocks: TextractBlock[], documentId: string): Extracted {
  const tableRows = tableRowsFromBlocks(blocks, documentId);
  const seen = new Set(tableRows.map((row) => `${row.page}|${row.cells.map((cell) => cell.text.toLowerCase()).join("|")}`));
  for (const row of spatialRowsFromBlocks(blocks, documentId)) {
    const key = `${row.page}|${row.cells.map((cell) => cell.text.toLowerCase()).join("|")}`;
    if (!seen.has(key)) tableRows.push(row);
  }
  return {
    lines: blocks
      .filter((block) => block.BlockType === "LINE" && block.Text)
      .map((block) => ({ text: block.Text!, confidence: block.Confidence ?? 0, page: block.Page ?? null, documentId })),
    tableRows,
  };
}

async function extractDocument(document: StoredDocument): Promise<Extracted> {
  if (document.contentType !== "application/pdf") {
    const response = await textract.send(new AnalyzeDocumentCommand({
      Document: { S3Object: { Bucket: required("LAB_DOCUMENT_BUCKET"), Name: document.objectKey } },
      FeatureTypes: ["TABLES"],
    }));
    return extractedFromBlocks(response.Blocks ?? [], document.clientDocumentId);
  }
  const started = await textract.send(new StartDocumentAnalysisCommand({
    DocumentLocation: { S3Object: { Bucket: required("LAB_DOCUMENT_BUCKET"), Name: document.objectKey } },
    FeatureTypes: ["TABLES"],
    ClientRequestToken: createHash("sha256").update(document.objectKey).digest("hex").slice(0, 64),
    JobTag: "synthetic-lab",
  }));
  if (!started.JobId) throw new Error("textract_job_missing");
  for (let attempt = 0; attempt < 45; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 500 : 2_000));
    let nextToken: string | undefined;
    const blocks: TextractBlock[] = [];
    do {
      const response = await textract.send(new GetDocumentAnalysisCommand({ JobId: started.JobId, NextToken: nextToken, MaxResults: 1000 }));
      if (response.JobStatus === "FAILED") throw Object.assign(new Error("textract_failed"), { category: "document_unreadable" });
      if (response.JobStatus === "IN_PROGRESS") break;
      blocks.push(...(response.Blocks ?? []));
      nextToken = response.NextToken;
      if (!nextToken) return extractedFromBlocks(blocks, document.clientDocumentId);
    } while (nextToken);
  }
  throw Object.assign(new Error("textract_timeout"), { category: "provider_unavailable" });
}
function parseRange(line: string): { min: number | null; max: number | null } {
  const range = line.match(/(?:range|reference)?\s*[:=]?\s*(-?\d+(?:\.\d+)?)\s*[-–]\s*(-?\d+(?:\.\d+)?)/i);
  if (range) return { min: Number(range[1]), max: Number(range[2]) };
  const upper = line.match(/(?:<|≤|less than)\s*(-?\d+(?:\.\d+)?)/i);
  if (upper) return { min: null, max: Number(upper[1]) };
  const lower = line.match(/(?:>|≥|greater than)\s*(-?\d+(?:\.\d+)?)/i);
  return lower ? { min: Number(lower[1]), max: null } : { min: null, max: null };
}

const NON_ANALYTE_NAMES = /^(?:test|analyte|biomarker|result|results|value|units?|reference|reference range|range|status|flag|current|previous|date|patient|accession|specimen|service date)$/i;
const IDENTIFIER_TEXT = /(?:date of birth|telephone|address|street|accession|patient id|medical record|mrn|service date|collection date|received date|reported date|laboratory director|phlebotomist)/i;
const STRICT_NUMBER = /^(?:[HL]\s*)?(?:<=?|>=?|≤|≥)?\s*(-?\d+(?:\.\d+)?)(?:\s*[HL*])?$/i;

function cleanAnalyteName(value: string): string {
  return value.replace(/\s+/g, " ").replace(/[\s:;-]+$/, "").trim();
}

function unitFromName(value: string): string | null {
  const matches = [...value.matchAll(/\(([^()]*)\)/g)];
  const candidate = matches.at(-1)?.[1]?.trim();
  return candidate && /[%/A-Za-zµμ]/.test(candidate) ? candidate.replace(/[μµ]/g, "u").toLowerCase() : null;
}

function matchingRule(value: string) {
  const normalized = value.toLowerCase().replace(/[μµ]/g, "u");
  return RULES.find((rule) => rule.aliases.some((alias) => new RegExp(`(^|\\b)${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\b|$)`, "i").test(normalized)));
}

export function normalizeExtractedLabTables(extracted: Extracted): Biomarker[] {
  const output: Biomarker[] = [];
  for (const row of extracted.tableRows ?? []) {
    const cells = row.cells.filter((cell) => cell.text.trim());
    if (cells.length < 2) continue;
    const nameIndex = cells.findIndex((cell) => {
      const name = cleanAnalyteName(cell.text);
      return name.length >= 2 && name.length <= 180 && /[A-Za-z]/.test(name)
        && !NON_ANALYTE_NAMES.test(name) && !IDENTIFIER_TEXT.test(name);
    });
    if (nameIndex < 0) continue;
    const valueIndex = cells.findIndex((cell, index) => index > nameIndex && STRICT_NUMBER.test(cell.text.trim()));
    if (valueIndex < 0) continue;
    const valueMatch = cells[valueIndex].text.trim().match(STRICT_NUMBER);
    if (!valueMatch) continue;

    const reportedName = cleanAnalyteName(cells[nameIndex].text);
    const rule = matchingRule(reportedName);
    const rowTail = cells.slice(valueIndex + 1).map((cell) => cell.text).join(" ");
    const range = parseRange(rowTail);
    const rowText = cells.map((cell) => cell.text).join(" ").toLowerCase().replace(/[μµ]/g, "u");
    const unit = unitFromName(reportedName)
      ?? rule?.units.find((candidate) => rowText.includes(candidate.replace(/[μµ]/g, "u")))
      ?? cells.slice(valueIndex + 1).map((cell) => cell.text.trim()).find((text) => /^[%A-Za-zµμ][%A-Za-z0-9µμ/^.-]{0,39}$/.test(text))?.replace(/[μµ]/g, "u").toLowerCase()
      ?? "not reported";
    const canonicalName = rule?.name ?? reportedName.replace(/\s*\([^()]*\)\s*$/, "").trim();
    // OCR sometimes promotes a standalone result flag such as "(H)" into the
    // analyte column. It is not a biomarker and must not poison the full result.
    if (!canonicalName || !/[A-Za-z]/.test(canonicalName)) continue;
    output.push({
      canonicalName, reportedName, value: Number(valueMatch[1]), unit,
      labMin: range.min, labMax: range.max,
      functionalMin: rule?.min ?? null, functionalMax: rule?.max ?? null,
      sourceId: rule ? stableUuid(`range:${rule.name}`) : null,
      sourceVersion: rule ? "synthetic-functional-ranges/1" : null,
      population: rule ? "Synthetic adult test fixture; practitioner verification required" : null,
      confidence: Math.max(0, Math.min(1, Math.min(...cells.map((cell) => cell.confidence)) / 100)),
      documentId: row.documentId, page: row.page,
    });
  }
  return output.filter((row, index) => {
    const key = `${row.canonicalName.toLowerCase()}|${row.unit.toLowerCase()}`;
    return output.findIndex((candidate) => `${candidate.canonicalName.toLowerCase()}|${candidate.unit.toLowerCase()}` === key) === index;
  });
}

export function normalizeExtractedLabLines(extracted: Extracted): Biomarker[] {
  const output: Biomarker[] = normalizeExtractedLabTables(extracted);
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
function reportedRangeStatus(value: number, min: number | null, max: number | null) {
  if ((min === null || value >= min) && (max === null || value <= max)) return "normal";
  const anchor = Math.max(Math.abs(min ?? 0), Math.abs(max ?? 0), 1);
  return (min !== null && value < min - anchor) || (max !== null && value > max + anchor) ? "critical" : "suboptimal";
}
async function executePass(job: Job, pass: number): Promise<unknown | null> {
  const jobId = job.pk.slice(4);
  if (pass === 0) {
    const lines: Extracted["lines"] = [];
    const tableRows: ExtractedRow[] = [];
    for (const document of job.documents) {
      const extracted = await extractDocument(document);
      lines.push(...extracted.lines);
      tableRows.push(...(extracted.tableRows ?? []));
    }
    await writeArtifact(jobId, "extracted", { lines, tableRows });
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
    const interpreted = biomarkers.map((row) => ({
      ...row,
      status: row.functionalMin !== null && row.functionalMax !== null
        ? functionalRangeStatus(row.value, row.functionalMin, row.functionalMax)
        : reportedRangeStatus(row.value, row.labMin, row.labMax),
    }));
    await writeArtifact(jobId, "interpreted", { biomarkers: interpreted });
    return null;
  }
  const { biomarkers } = await readArtifact(jobId, "interpreted") as { biomarkers: Array<Biomarker & { status: string }> };
  const flagged = biomarkers.filter((row) => row.status !== "optimal");
  const generatedAt = new Date().toISOString();
  const resultBiomarkers = biomarkers.map((row) => ({
    biomarkerId: stableUuid(`biomarker:${row.canonicalName}:${row.unit}`),
    canonicalName: row.canonicalName,
    reportedName: row.reportedName,
    value: row.value,
    unit: row.unit,
    labReferenceRange: { min: row.labMin, max: row.labMax, rawText: row.labMin === null && row.labMax === null ? "Not reported or not reliably extracted" : `${row.labMin ?? ""}-${row.labMax ?? ""}` },
    functionalRange: row.functionalMin !== null && row.functionalMax !== null && row.sourceId && row.sourceVersion && row.population ? { min: row.functionalMin, max: row.functionalMax, sourceId: row.sourceId, sourceVersion: row.sourceVersion, population: row.population } : null,
    status: row.status,
    extractionConfidence: row.confidence,
    verificationState: row.confidence >= 0.8 ? "independently_verified" : "needs_human_review",
    sourceDocumentId: row.documentId,
    sourcePage: row.page,
  }));
  const currentForSynthesis = resultBiomarkers.map((row) => ({
    biomarkerId: row.biomarkerId,
    canonicalName: row.canonicalName,
    value: row.value,
    unit: row.unit,
    labMin: row.labReferenceRange.min,
    labMax: row.labReferenceRange.max,
    functionalMin: row.functionalRange?.min ?? null,
    functionalMax: row.functionalRange?.max ?? null,
    status: row.status,
    panelId: job.longitudinalContext?.incomingPanel.panelId ?? jobId,
    testDate: job.longitudinalContext?.incomingPanel.testDate ?? generatedAt.slice(0, 10),
  }));
  const priorForSynthesis = (job.longitudinalContext?.priorPanels ?? []).flatMap((panel) => panel.biomarkers.map((row) => ({
    ...row,
    panelId: panel.panelId,
    testDate: panel.testDate,
  })));
  const aiSynthesis = await synthesizeLabWithOpenAI({
    jobId,
    patientContext: job.patientContext,
    biomarkers: [...currentForSynthesis, ...priorForSynthesis],
    activeProtocol: job.longitudinalContext?.activeProtocol ?? null,
  });
  const analysisId = randomUUID();
  const sourcePanelId = job.longitudinalContext?.incomingPanel.panelId ?? jobId;
  const symptomCategoryIds = job.patientContext?.topSymptomSignals.map((row) => row.categoryId) ?? [];
  const inputSnapshotSha256 = createHash("sha256").update(JSON.stringify({
    biomarkers: currentForSynthesis,
    patientContext: job.patientContext ?? null,
    priorPanels: job.longitudinalContext?.priorPanels ?? [],
  })).digest("hex");
  const result = {
    analysisId, reviewState: "consumer_education", generatedAt,
    summary: `AI-assisted consumer laboratory interpretation. ${biomarkers.length} reported biomarker(s) were retained; ${flagged.length} are outside an available governed functional range or reporting laboratory range. ${aiSynthesis.summary} Uncertainty: ${aiSynthesis.uncertainty}`,
    biomarkers: resultBiomarkers,
    recommendations: [],
    priorityActions: aiSynthesis.priorityActions,
    generatedPlan: {
      planId: stableUuid(`generated-plan:${analysisId}`),
      generationMode: "automatic_consumer_wellness",
      version: (job.longitudinalContext?.activeProtocol?.version ?? 0) + 1,
      sourceAnalysisId: analysisId,
      sourcePanelId,
      supersedesProtocolId: job.longitudinalContext?.activeProtocol?.protocolId ?? null,
      generatedAt,
      title: aiSynthesis.generatedPlan.title,
      summary: aiSynthesis.generatedPlan.summary,
      confidence: aiSynthesis.generatedPlan.confidence,
      inputSnapshotSha256,
      biomarkerIds: [...new Set(aiSynthesis.generatedPlan.tasks.flatMap((task) => task.biomarkerIds))],
      symptomCategoryIds: [...new Set(aiSynthesis.generatedPlan.tasks.flatMap((task) => task.symptomCategoryIds))]
        .filter((id) => symptomCategoryIds.includes(id)),
      tasks: aiSynthesis.generatedPlan.tasks.map((task, index) => ({
        taskId: stableUuid(`generated-plan-task:${analysisId}:${index}`),
        ...task,
      })),
      supplementRecommendations: [],
      productSelectionState: "awaiting_governed_catalog_approval",
      safety: {
        medicationOrAllergyReviewRequired: Boolean((job.patientContext?.medications.length ?? 0) + (job.patientContext?.allergies.length ?? 0)),
        pregnancyOrNursingReviewRequired: job.patientContext?.pregnancyStatus === "pregnant"
          || job.patientContext?.pregnancyStatus === "unsure" || job.patientContext?.nursing === true,
        noMedicationHormoneOrPeptideChanges: true,
      },
      provider: { model: aiSynthesis.providerModel, promptVersion: "lab-plan/1" },
    },
    citations: biomarkers.filter((row) => row.sourceId && row.sourceVersion).map((row) => ({ sourceId: row.sourceId!, sourceVersion: row.sourceVersion!, claimIds: [] })).filter((row, index, all) => all.findIndex((candidate) => candidate.sourceId === row.sourceId) === index),
    longitudinalReview: {
      reviewState: "consumer_education",
      panelCount: (job.longitudinalContext?.priorPanels.length ?? 0) + 1,
      generatedAt,
      summary: aiSynthesis.longitudinalSummary,
      planImpact: {
        status: "consumer_information",
        headline: aiSynthesis.planImpact.headline,
        changes: aiSynthesis.planImpact.changes.map((change, index) => ({
          changeId: stableUuid(`plan-impact:${jobId}:${index}:${change.kind}`),
          ...change,
        })),
      },
    },
  };
  await writeArtifact(jobId, "ai-synthesis", { ...aiSynthesis, referencedBiomarkerIds: aiSynthesis.referencedBiomarkerIds });
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
