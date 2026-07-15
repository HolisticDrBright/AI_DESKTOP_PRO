/**
 * MOCK import/migration planning.
 *
 * No files are read and nothing is inserted. `buildImportPlan` returns a
 * deterministic plan so the migration UX (detect → map → resolve conflicts →
 * preview → commit → audit) can be exercised. The hard rules the real importer
 * must keep are encoded in the shapes: every record carries its origin
 * `sourceRecordId`, every record is queued for human review, and a conflict has
 * to be resolved before it can be committed — never a silent bulk insert.
 */

export type ImportSourceId =
  | "practice-better"
  | "biocanic"
  | "jane"
  | "csv"
  | "lab-pdf";

export interface ImportSource {
  id: ImportSourceId;
  name: string;
  kind: string;
  note: string;
}

export const IMPORT_SOURCES: ImportSource[] = [
  { id: "practice-better", name: "Practice Better", kind: "EHR export", note: "Clients, notes, protocols, labs" },
  { id: "biocanic", name: "Biocanic", kind: "EHR export", note: "Cases, timelines, lab results" },
  { id: "jane", name: "Jane", kind: "EHR export", note: "Clients, appointments, charts" },
  { id: "csv", name: "CSV file", kind: "Spreadsheet", note: "Any columnar client or lab data" },
  { id: "lab-pdf", name: "Lab PDF", kind: "Document", note: "Scanned or exported lab panels" },
];

export interface FieldMapping {
  source: string;
  target: string;
  required: boolean;
  /** True when the detector is confident; false → needs practitioner confirmation. */
  confident: boolean;
}

export interface ImportRecordPreview {
  /** Preserved origin id — written to `source_record_id` on import. */
  sourceRecordId: string;
  name: string;
  summary: string;
  /** Present when this record collides with an existing one. */
  conflict?: string;
  resolution: "create" | "merge" | "skip";
}

export interface ImportPlan {
  source: ImportSource;
  detectedFormat: string;
  recordCount: number;
  conflictCount: number;
  mappings: FieldMapping[];
  records: ImportRecordPreview[];
}

const MAPPINGS: Record<ImportSourceId, FieldMapping[]> = {
  "practice-better": [
    { source: "Client Name", target: "patient.name", required: true, confident: true },
    { source: "DOB", target: "patient.dob", required: true, confident: true },
    { source: "Email", target: "patient.email", required: false, confident: true },
    { source: "Program", target: "protocol.name", required: false, confident: false },
    { source: "Lab Result", target: "lab_result.value", required: false, confident: false },
  ],
  biocanic: [
    { source: "Case Client", target: "patient.name", required: true, confident: true },
    { source: "Birth Date", target: "patient.dob", required: true, confident: true },
    { source: "Timeline Entry", target: "timeline_event.note", required: false, confident: false },
    { source: "Marker", target: "lab_result.marker", required: false, confident: true },
  ],
  jane: [
    { source: "Patient", target: "patient.name", required: true, confident: true },
    { source: "Date of Birth", target: "patient.dob", required: true, confident: true },
    { source: "Chart Note", target: "note.body", required: false, confident: false },
  ],
  csv: [
    { source: "Column A", target: "patient.name", required: true, confident: false },
    { source: "Column B", target: "patient.dob", required: true, confident: false },
    { source: "Column C", target: "lab_result.value", required: false, confident: false },
  ],
  "lab-pdf": [
    { source: "Extracted patient", target: "patient.name", required: true, confident: false },
    { source: "Collected date", target: "lab_result.collected_at", required: true, confident: true },
    { source: "Analyte rows", target: "lab_result.marker", required: true, confident: false },
  ],
};

const RECORDS: Record<ImportSourceId, ImportRecordPreview[]> = {
  "practice-better": [
    { sourceRecordId: "PB-10241", name: "Alexandra Morgan", summary: "4 labs · 2 protocols", conflict: "Matches existing patient P-78435", resolution: "merge" },
    { sourceRecordId: "PB-10242", name: "Ronan Delgado", summary: "1 program · 3 notes", resolution: "create" },
    { sourceRecordId: "PB-10243", name: "Test Client", summary: "no clinical data", conflict: "Looks like a test record", resolution: "skip" },
  ],
  biocanic: [
    { sourceRecordId: "BC-5521", name: "Michael Johnson", summary: "6 markers · 1 timeline", conflict: "Matches existing patient P-64201", resolution: "merge" },
    { sourceRecordId: "BC-5522", name: "Yuki Tanaka", summary: "3 markers", resolution: "create" },
  ],
  jane: [
    { sourceRecordId: "JN-8830", name: "Priya Sharma", summary: "2 charts", conflict: "Matches existing patient P-59318", resolution: "merge" },
    { sourceRecordId: "JN-8831", name: "Andre Okafor", summary: "1 chart · 4 appts", resolution: "create" },
  ],
  csv: [
    { sourceRecordId: "row-2", name: "Dana Whitfield", summary: "1 lab value", conflict: "Possible match to P-66473", resolution: "merge" },
    { sourceRecordId: "row-3", name: "Sam Rivera", summary: "1 lab value", resolution: "create" },
    { sourceRecordId: "row-4", name: "(blank name)", summary: "malformed row", conflict: "Missing required field", resolution: "skip" },
  ],
  "lab-pdf": [
    { sourceRecordId: "pdf-p1", name: "Marcus Webb", summary: "CMP · lipid panel", conflict: "Matches existing patient P-52984", resolution: "merge" },
  ],
};

export function buildImportPlan(sourceId: ImportSourceId): ImportPlan {
  const source = IMPORT_SOURCES.find((s) => s.id === sourceId)!;
  const records = RECORDS[sourceId];
  const mappings = MAPPINGS[sourceId];
  return {
    source,
    detectedFormat: `${source.name} · ${source.kind}`,
    recordCount: records.length,
    conflictCount: records.filter((r) => r.conflict).length,
    mappings,
    records,
  };
}
