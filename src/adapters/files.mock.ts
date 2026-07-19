"use client";

/**
 * Patient files (MOCK). Seed documents are synthetic; the demo "upload"
 * never reads or transmits a real file — it records a labeled session entry
 * only.
 */
import { createSessionStore, newSessionId } from "./session-kv";
import { recordAuditEntry } from "./session-store";

export type FileKind = "lab-pdf" | "imported-record" | "consent" | "generated-report" | "image";

export interface PatientFile {
  id: string;
  patientId: string;
  name: string;
  kind: FileKind;
  atLabel: string;
  size: string;
  source: string;
  sessionAdded?: boolean;
}

export const FILE_KIND_LABEL: Record<FileKind, string> = {
  "lab-pdf": "Lab PDF",
  "imported-record": "Imported record",
  consent: "Consent",
  "generated-report": "Generated report",
  image: "Image",
};

const SEED_FILES: PatientFile[] = [
  { id: "f-1", patientId: "p-78435", name: "quest-panel-2026-06-28.pdf", kind: "lab-pdf", atLabel: "Jun 28", size: "412 KB", source: "Quest import (audited)" },
  { id: "f-2", patientId: "p-78435", name: "quest-panel-2026-05-13.pdf", kind: "lab-pdf", atLabel: "May 13", size: "388 KB", source: "Quest import (audited)" },
  { id: "f-3", patientId: "p-78435", name: "recording-consent-2026-04-22.pdf", kind: "consent", atLabel: "Apr 22", size: "96 KB", source: "Signed in clinic" },
  { id: "f-4", patientId: "p-78435", name: "visit-summary-jul-9.pdf", kind: "generated-report", atLabel: "Jul 9", size: "148 KB", source: "Composer draft → approved" },
  { id: "f-5", patientId: "p-78435", name: "practice-better-export.zip", kind: "imported-record", atLabel: "Apr 20", size: "2.1 MB", source: "Imports wizard" },
  { id: "f-6", patientId: "p-64201", name: "labcorp-panel-2026-07-10.pdf", kind: "lab-pdf", atLabel: "Jul 10", size: "365 KB", source: "LabCorp import (audited)" },
  { id: "f-7", patientId: "p-64201", name: "cgm-export-jun.csv", kind: "imported-record", atLabel: "Jul 2", size: "824 KB", source: "Device export" },
  { id: "f-8", patientId: "p-59318", name: "iron-studies-2026-07-15.pdf", kind: "lab-pdf", atLabel: "Jul 15", size: "298 KB", source: "Quest import (audited)" },
  { id: "f-9", patientId: "p-59318", name: "ferritin-trend.pdf", kind: "generated-report", atLabel: "Today", size: "84 KB", source: "Patient app attachment" },
];

const store = createSessionStore<PatientFile[]>("aidp:demo:files", []);

export function useFiles(patientId: string): PatientFile[] {
  const added = store.use();
  return [...added.filter((f) => f.patientId === patientId), ...SEED_FILES.filter((f) => f.patientId === patientId)];
}

/** Demo upload: metadata-only session entry. No file content is read. */
export function addDemoFile(patientId: string, patientName: string, name: string, kind: FileKind) {
  const f: PatientFile = {
    id: newSessionId(),
    patientId,
    name,
    kind,
    atLabel: "Today",
    size: "—",
    source: "Demo upload (no file transmitted)",
    sessionAdded: true,
  };
  store.update((files) => [f, ...files]);
  recordAuditEntry({
    kind: "upload_file",
    subjectType: "patient file",
    subjectLabel: name,
    patientName,
    reviewed: true,
  });
  return { ok: true, message: "File entry added. (demo — nothing was uploaded)" };
}
