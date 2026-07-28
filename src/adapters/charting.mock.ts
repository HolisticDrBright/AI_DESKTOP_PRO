"use client";

import { createSessionStore, newSessionId } from "./session-kv";

export type ChartFieldType =
  | "long-text"
  | "short-text"
  | "number"
  | "scale"
  | "checkbox"
  | "select"
  | "checkbox-group"
  | "body-map"
  | "heading";

export interface ChartFieldDefinition {
  id: string;
  label: string;
  prompt?: string;
  type: ChartFieldType;
  required?: boolean;
  options?: string[];
}

export interface ChartTemplate {
  id: string;
  name: string;
  category: string;
  description: string;
  builtIn: boolean;
  fields: ChartFieldDefinition[];
}

export interface BodyMapPoint {
  x: number;
  y: number;
}

export interface BodyMapAnnotation {
  id: string;
  kind: "stroke" | "pain" | "acupuncture";
  color: string;
  size: number;
  points: BodyMapPoint[];
  label?: string;
}

export interface BodyMapValue {
  annotations: BodyMapAnnotation[];
}

export type ChartValue = string | boolean | string[] | BodyMapValue;

export interface ChartEntry {
  id: string;
  patientId: string;
  templateId: string;
  templateName: string;
  encounterDate: string;
  status: "draft" | "signed";
  author: string;
  updatedLabel: string;
  signedLabel?: string;
  copiedFrom?: { entryId: string; encounterDate: string };
  values: Record<string, ChartValue>;
}

const F = (
  id: string,
  label: string,
  type: ChartFieldType = "long-text",
  prompt?: string,
  required = false,
  options?: string[],
): ChartFieldDefinition => ({ id, label, type, prompt, required, options });

export const BUILT_IN_CHART_TEMPLATES: ChartTemplate[] = [
  {
    id: "chart-soap-followup",
    name: "SOAP follow-up",
    category: "Progress note",
    description: "A concise follow-up note organized by subjective, objective, assessment, and plan.",
    builtIn: true,
    fields: [
      F("subjective", "Subjective", "long-text", "Symptoms, concerns, adherence, and changes reported by the patient.", true),
      F("objective", "Objective", "long-text", "Vitals, exam findings, measurements, labs, and other observed data."),
      F("assessment", "Assessment", "long-text", "Practitioner assessment and clinical reasoning.", true),
      F("plan", "Plan", "long-text", "Plan changes, orders, follow-up, education, and rationale.", true),
      F("response", "Response since last visit", "select", undefined, false, ["Improved", "Stable", "Mixed", "Worsened", "Not assessed"]),
      F("symptom-score", "Primary symptom severity", "scale", "0 = none, 10 = most severe"),
    ],
  },
  {
    id: "chart-initial-consult",
    name: "Comprehensive initial consultation",
    category: "Initial visit",
    description: "Full intake structure for a new patient consultation.",
    builtIn: true,
    fields: [
      F("chief-concern", "Chief concern and goals", "long-text", undefined, true),
      F("history", "History of present concern", "long-text", "Onset, course, triggers, relieving factors, and previous care.", true),
      F("medical-history", "Medical and surgical history"),
      F("medications", "Medications, supplements, and allergies"),
      F("systems", "Review of systems"),
      F("lifestyle", "Nutrition, sleep, movement, stress, and environment"),
      F("assessment", "Assessment and differential considerations", "long-text", undefined, true),
      F("plan", "Initial plan and shared decisions", "long-text", undefined, true),
    ],
  },
  {
    id: "chart-functional-followup",
    name: "Functional medicine follow-up",
    category: "Progress note",
    description: "Tracks systems, interventions, response, barriers, and next-step priorities.",
    builtIn: true,
    fields: [
      F("interval", "Interval history and what changed", "long-text", undefined, true),
      F("systems", "Systems review and symptom pattern"),
      F("interventions", "Interventions since last visit"),
      F("response", "Response and adherence"),
      F("barriers", "Barriers, adverse effects, or concerns"),
      F("clinical", "Clinical interpretation", "long-text", undefined, true),
      F("plan", "Updated plan", "long-text", undefined, true),
      F("readiness", "Readiness for next phase", "select", undefined, false, ["Ready", "Continue current phase", "Modify first", "Pause"]),
    ],
  },
  {
    id: "chart-lab-review",
    name: "Lab review",
    category: "Lab review",
    description: "Documents reviewed sources, key findings, context, decisions, and follow-up.",
    builtIn: true,
    fields: [
      F("sources", "Panels and source dates reviewed", "long-text", undefined, true),
      F("findings", "Key findings and trends", "long-text", undefined, true),
      F("context", "Clinical context and limitations"),
      F("assessment", "Practitioner interpretation", "long-text", undefined, true),
      F("actions", "Actions, orders, and monitoring plan", "long-text", undefined, true),
      F("education", "Patient education and shared decisions"),
    ],
  },
  {
    id: "chart-treatment",
    name: "Treatment / procedure note",
    category: "Procedure",
    description: "Documents indication, consent, treatment details, response, and aftercare.",
    builtIn: true,
    fields: [
      F("indication", "Indication", "long-text", undefined, true),
      F("consent", "Consent confirmed", "checkbox", undefined, true),
      F("details", "Treatment or procedure details", "long-text", undefined, true),
      F("response", "Immediate response and observations"),
      F("aftercare", "Aftercare and follow-up instructions", "long-text", undefined, true),
    ],
  },
  {
    id: "chart-pain-body-map",
    name: "Pain assessment & body map",
    category: "Pain / musculoskeletal",
    description: "Fast pain characterization with severity sliders and an annotatable body map.",
    builtIn: true,
    fields: [
      F("pain-heading", "Pain presentation", "heading"),
      F("pain-location", "Primary pain area", "short-text", "Location, side, and radiation pattern.", true),
      F("pain-quality", "Pain qualities", "checkbox-group", undefined, false, ["Aching", "Burning", "Dull", "Sharp", "Stabbing", "Throbbing", "Tingling", "Numbness", "Tight", "Swelling"]),
      F("pain-current", "Pain now", "scale", "0 = none, 10 = worst imaginable"),
      F("pain-average", "Average pain", "scale", "0 = none, 10 = worst imaginable"),
      F("pain-worst", "Worst pain", "scale", "0 = none, 10 = worst imaginable"),
      F("pain-map", "Body map", "body-map", "Draw pain patterns or place labeled points on the body chart."),
      F("pain-impact", "Functional impact and aggravating / relieving factors", "long-text"),
      F("pain-assessment", "Assessment and plan", "long-text", undefined, true),
    ],
  },
  {
    id: "chart-acupuncture",
    name: "Acupuncture treatment note",
    category: "Acupuncture / TCM",
    description: "TCM assessment, treatment modalities, point selection, and annotated ashi-point mapping.",
    builtIn: true,
    fields: [
      F("acu-subjective", "Subjective and interval response", "long-text", undefined, true),
      F("acu-symptoms", "Current presentation", "checkbox-group", undefined, false, ["Pain / discomfort", "Tension / stiffness", "Numbness / tingling", "Headache / migraine", "Poor sleep", "Digestive symptoms", "Stress / anxiety", "Fatigue"]),
      F("acu-energy", "Energy", "scale", "0 = depleted, 10 = excellent"),
      F("acu-stress", "Stress", "scale", "0 = none, 10 = extreme"),
      F("acu-tongue", "Tongue findings", "long-text"),
      F("acu-pulse", "Pulse qualities", "checkbox-group", undefined, false, ["Strong", "Weak", "Slow", "Fast", "Slippery", "Wiry", "Thin", "Deep", "Superficial / floating"]),
      F("acu-assessment", "TCM assessment / pattern", "long-text", undefined, true),
      F("acu-modalities", "Modalities used", "checkbox-group", undefined, false, ["Acupuncture", "Auricular", "Cupping", "Gua sha", "Moxibustion", "Electroacupuncture", "Tui na", "Heat", "Percussion"]),
      F("acu-points", "Acupuncture points and ashi map", "body-map", "Place labeled acupuncture or ashi points; draw treated pain regions."),
      F("acu-details", "Point prescription, technique, and treatment details", "long-text", undefined, true),
      F("acu-response", "Immediate response and aftercare", "long-text"),
    ],
  },
  {
    id: "chart-freeform",
    name: "Freeform progress note",
    category: "Progress note",
    description: "A simple narrative note for brief or specialized visits.",
    builtIn: true,
    fields: [F("note", "Clinical note", "long-text", "Document the visit, assessment, and plan.", true)],
  },
];

const SEED_ENTRIES: Record<string, ChartEntry[]> = {
  "p-78435": [
    {
      id: "chart-entry-avery-followup",
      patientId: "p-78435",
      templateId: "chart-soap-followup",
      templateName: "SOAP follow-up",
      encounterDate: "2026-07-09",
      status: "signed",
      author: "Dr. Sarah Mitchell",
      updatedLabel: "Jul 9, 2026 · 10:42 AM",
      signedLabel: "Signed Jul 9, 2026 · 10:46 AM",
      values: {
        subjective: "Reports more consistent sleep timing and fewer overnight awakenings. Morning energy is improving, with occasional afternoon fatigue.",
        objective: "Reviewed sleep diary and wearable trend. Average sleep duration increased; no new adverse effects reported.",
        assessment: "Sleep regularity is improving. Afternoon fatigue remains an active monitoring target.",
        plan: "Continue current sleep schedule and morning light routine. Review fatigue pattern and repeat agreed markers at the next interval.",
        response: "Improved",
        "symptom-score": "4",
      },
    },
    {
      id: "chart-entry-avery-labs",
      patientId: "p-78435",
      templateId: "chart-lab-review",
      templateName: "Lab review",
      encounterDate: "2026-06-12",
      status: "signed",
      author: "Dr. Sarah Mitchell",
      updatedLabel: "Jun 12, 2026 · 2:18 PM",
      signedLabel: "Signed Jun 12, 2026 · 2:24 PM",
      values: {
        sources: "Reviewed the imported chemistry and nutrient panel with source ranges visible in the Labs workspace.",
        findings: "Inflammatory marker trend is improving. Vitamin D remains below the configured practice target.",
        context: "Interpretation considered reported adherence, seasonal exposure, and the laboratory reference interval.",
        assessment: "Direction is encouraging; continued monitoring is appropriate before advancing the plan.",
        actions: "Continue the current phase and repeat the agreed markers before the next plan review.",
        education: "Discussed that optimal ranges do not replace laboratory reference ranges or clinical judgment.",
      },
    },
  ],
};

interface ChartingSessionState {
  entries: Record<string, ChartEntry>;
  customTemplates: ChartTemplate[];
}

const store = createSessionStore<ChartingSessionState>("aidp:demo:charting", {
  entries: {},
  customTemplates: [],
});

function seedFor(patientId: string): ChartEntry[] {
  return SEED_ENTRIES[patientId] ?? [];
}

function mergeEntries(patientId: string, state: ChartingSessionState): ChartEntry[] {
  const seeded = seedFor(patientId).map((entry) => state.entries[entry.id] ?? entry);
  const seedIds = new Set(seeded.map((entry) => entry.id));
  const created = Object.values(state.entries).filter(
    (entry) => entry.patientId === patientId && !seedIds.has(entry.id),
  );
  return [...created, ...seeded].sort((a, b) => b.encounterDate.localeCompare(a.encounterDate));
}

export function useChartEntries(patientId: string): ChartEntry[] {
  return mergeEntries(patientId, store.use());
}

export function useChartTemplates(): ChartTemplate[] {
  return [...store.use().customTemplates, ...BUILT_IN_CHART_TEMPLATES];
}

export function getChartTemplate(id: string): ChartTemplate | undefined {
  return [...store.get().customTemplates, ...BUILT_IN_CHART_TEMPLATES].find((t) => t.id === id);
}

export function createChartEntry(patientId: string, templateId: string, encounterDate: string): ChartEntry {
  const template = getChartTemplate(templateId) ?? BUILT_IN_CHART_TEMPLATES[0];
  const entry: ChartEntry = {
    id: newSessionId(),
    patientId,
    templateId: template.id,
    templateName: template.name,
    encounterDate,
    status: "draft",
    author: "Dr. Sarah Mitchell",
    updatedLabel: "Saved just now",
    values: Object.fromEntries(
      template.fields.map((field) => [
        field.id,
        field.type === "checkbox"
          ? false
          : field.type === "checkbox-group"
            ? []
            : field.type === "body-map"
              ? { annotations: [] }
              : field.type === "scale"
                ? "0"
                : "",
      ]),
    ),
  };
  store.update((state) => ({ ...state, entries: { ...state.entries, [entry.id]: entry } }));
  return entry;
}

export function updateChartEntry(id: string, patch: Partial<Pick<ChartEntry, "encounterDate" | "values">>): ChartEntry | null {
  const state = store.get();
  const existing = state.entries[id] ?? Object.values(SEED_ENTRIES).flat().find((entry) => entry.id === id);
  if (!existing || existing.status === "signed") return null;
  const next: ChartEntry = { ...existing, ...patch, updatedLabel: "Saved just now" };
  store.set({ ...state, entries: { ...state.entries, [id]: next } });
  return next;
}

export function signChartEntry(id: string): ChartEntry | null {
  const state = store.get();
  const existing = state.entries[id] ?? Object.values(SEED_ENTRIES).flat().find((entry) => entry.id === id);
  if (!existing || existing.status === "signed") return existing ?? null;
  const next: ChartEntry = {
    ...existing,
    status: "signed",
    signedLabel: "Signed this session",
    updatedLabel: "Signed this session",
  };
  store.set({ ...state, entries: { ...state.entries, [id]: next } });
  return next;
}

export function duplicateChartEntry(id: string, encounterDate: string): ChartEntry | null {
  const state = store.get();
  const existing = state.entries[id] ?? Object.values(SEED_ENTRIES).flat().find((entry) => entry.id === id);
  if (!existing) return null;
  const duplicate: ChartEntry = {
    ...existing,
    id: newSessionId(),
    encounterDate,
    status: "draft",
    signedLabel: undefined,
    updatedLabel: "Copied forward just now",
    copiedFrom: { entryId: existing.id, encounterDate: existing.encounterDate },
    values: { ...existing.values },
  };
  store.set({ ...state, entries: { ...state.entries, [duplicate.id]: duplicate } });
  return duplicate;
}

export function createCustomChartTemplate(input: {
  name: string;
  category: string;
  description: string;
  fields: ChartFieldDefinition[];
}): ChartTemplate {
  const template: ChartTemplate = {
    id: newSessionId(),
    builtIn: false,
    ...input,
    fields: input.fields.map((field) => ({ ...field, id: field.id || newSessionId() })),
  };
  store.update((state) => ({ ...state, customTemplates: [template, ...state.customTemplates] }));
  return template;
}
