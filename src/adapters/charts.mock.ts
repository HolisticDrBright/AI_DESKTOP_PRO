// Dynamic charting engine (Phase 1, front-end mock).
//
// A chart is rendered from a *template* — an ordered list of typed field blocks.
// The same engine that renders the built-in "Dr. B Acupuncture" template below is
// what a future drag-and-drop template builder would emit, so nothing here is
// specific to acupuncture beyond the seed data.

export type ChartFieldType =
  | "checkbox-row" // inline wrapping row of checkboxes
  | "checkbox-grid" // titled multi-column checkbox group (TCM organ systems, pain qualities, pulse)
  | "checkbox-text-list" // rows of [checkbox] + [text input] (acupuncture points / modalities)
  | "slider" // 0–10 clinical scale (pain, energy, stress)
  | "textarea" // free-text SOAP section (scribe-targetable)
  | "body-diagram"; // drawable body / ashi-point figure set

interface BaseField {
  id: string;
  label: string;
  type: ChartFieldType;
  /** Optional helper line under the label. */
  hint?: string;
}

export interface CheckboxRowField extends BaseField {
  type: "checkbox-row";
  options: string[];
}

export interface CheckboxGridField extends BaseField {
  type: "checkbox-grid";
  options: string[];
  /** Preferred column count on wide screens (default 3). */
  columns?: 2 | 3;
}

export interface CheckboxTextListField extends BaseField {
  type: "checkbox-text-list";
  options: string[];
}

export interface SliderField extends BaseField {
  type: "slider";
  min: number;
  max: number;
}

export interface TextareaField extends BaseField {
  type: "textarea";
  rows?: number;
  /** When true, the AI Scribe can dictate into this section. */
  scribe?: boolean;
}

export type BodyPose = "front" | "back" | "left" | "right";

export interface BodyDiagramField extends BaseField {
  type: "body-diagram";
  poses: BodyPose[];
}

export type ChartField =
  | CheckboxRowField
  | CheckboxGridField
  | CheckboxTextListField
  | SliderField
  | TextareaField
  | BodyDiagramField;

export interface ChartTemplate {
  id: string;
  name: string;
  discipline: string;
  fields: ChartField[];
}

// ── Serialisable field values ────────────────────────────────────────────────

/** One freehand mark on a body diagram, in normalised 0–1 surface space. */
export interface Stroke {
  color: string;
  size: number;
  /** Flat [x0, y0, x1, y1, …] point list. A single point renders as a dot. */
  points: number[];
}

export type CheckboxValue = string[];
export type CheckboxTextValue = Record<string, { checked: boolean; text: string }>;
export type SliderValue = number;
export type TextValue = string;
export type BodyDiagramValue = Stroke[];

export type ChartValue =
  | CheckboxValue
  | CheckboxTextValue
  | SliderValue
  | TextValue
  | BodyDiagramValue;

export type ChartValues = Record<string, ChartValue>;

export type ChartStatus = "draft" | "signed";

export interface ChartEntry {
  id: string;
  patientId: string;
  templateId: string;
  /** ISO date of the encounter. */
  date: string;
  title: string;
  author: string;
  status: ChartStatus;
  /** Whether the practitioner starred this note. */
  starred: boolean;
  values: ChartValues;
}

// ── Seed data: the Dr. B Acupuncture template ────────────────────────────────

const ORGAN_SYSTEMS: Record<string, string[]> = {
  "Lung & Large Intestine": [
    "Allergies", "Arm/wrist/elbow pain", "Asthma/Bronchitis", "Constipation",
    "Cough/Sneeze/Phlegm", "Eczema/Psoriasis/Rash", "Flatulence", "Frequent Colds",
    "Frontal/Sinus HA", "Grief/Sadness", "Lethargy/Fatigue", "Loose Stool", "Mucus",
    "Nasal Problems", "Shoulder Pain", "Sinusitis", "Smell Problems",
    "Stiff Joints/Neck", "Sweating Problems", "Weak Voice", "Wheezing/SOB",
  ],
  "Kidney & Bladder": [
    "Adrenal Weakness", "Back/Hip/Knee Pain", "UTI", "Brittle Bones", "Cold Hands/Feet",
    "Dark/Puffy around Eyes", "Depression/Fear", "Edema/Water Retention", "Hot Flashes",
    "Impotence/Libido", "Infertility/Sterility", "Lethargy/Fatigue", "Loss/Thinning Hair",
    "Night Sweats", "Poor Memory", "Premature Gray", "Sciatica/Back Pain",
    "Sore Throat in AM", "Tight Hamstrings", "Tinnitus", "Urine Problems",
  ],
  "Liver & Gallbladder": [
    "Anger/Irritability", "Breast Tenderness", "Brittle/Course Nails/Hair", "Bruising",
    "Depression", "Distention/Bloating", "Eye/Vision Problems", "Flatulence", "Headaches",
    "Hemorrhoids", "Indigestion", "IBS", "IT Band Tightness", "Lack of Flexibility",
    "Menstrual Irreg", "Migraines", "Nausea/Vomiting", "PMS", "Stiff Neck/Shoulders",
    "Tension/Cramps", "Tinnitus",
  ],
  "Heart & Small Intestine": [
    "Abdominal Pain", "Anemia", "Anxiety/Dread", "Digestive Troubles",
    "Dream Disturbed Sleep", "Heart Problems", "Hot Flashes", "Hot/Painful Joints",
    "Lack of Joy/humor", "Mouth Sores", "Neck Pain", "Poor Circulation", "Restlessness",
    "Sleep Problems", "Tongue/Speech", "Upper Back Pain", "Urine Problems",
  ],
  "Spleen & Stomach": [
    "Abdominal Pain", "Aching/Heavy Limbs", "Anemia", "Appetite/Digestive Prob",
    "Belching", "Bruise Easily", "Colic/Indigestion", "Difficulty Focusing",
    "Distension/Bloating", "Headaches", "Heaviness at head", "Hemorrhoids", "Hiccups",
    "IBS", "Lethargy/Fatigue", "Loose Stools", "Muscle Weakness", "Nausea/Vomiting",
    "Poor Memory", "Prolapse", "Worry/Overthinking",
  ],
};

const ACUPUNCTURE_TEMPLATE: ChartTemplate = {
  id: "tpl-acupuncture",
  name: "Dr. B Acupuncture",
  discipline: "Acupuncture / TCM",
  fields: [
    {
      id: "subjective-quick",
      label: "Subjective",
      type: "checkbox-row",
      options: [
        "Improved", "No change", "Pain/discomfort", "Tension/Stiffness",
        "Numbness/tingling", "Headache/Migraine", "Poor Sleep", "Digestive Issues",
      ],
    },
    { id: "subjective", label: "SUBJECTIVE", type: "textarea", rows: 4, scribe: true },
    { id: "energy", label: "Energy", type: "slider", min: 0, max: 10 },
    { id: "stress", label: "Stress", type: "slider", min: 0, max: 10 },
    ...Object.entries(ORGAN_SYSTEMS).map(
      ([label, options]): CheckboxGridField => ({
        id: `organ-${label.toLowerCase().replace(/[^a-z]+/g, "-")}`,
        label,
        type: "checkbox-grid",
        columns: 3,
        options,
      }),
    ),
    { id: "objective", label: "OBJECTIVE", type: "textarea", rows: 4, scribe: true },
    { id: "physical-exam", label: "PHYSICAL EXAM", type: "textarea", rows: 4, scribe: true },
    {
      id: "body-chart",
      label: "Body Chart",
      type: "body-diagram",
      hint: "Draw pain, findings, or markings directly on the figures.",
      poses: ["left", "back", "front", "right"],
    },
    { id: "pain-area-1", label: "Pain Area #1", type: "textarea", rows: 3, scribe: true },
    {
      id: "pain-qualities",
      label: "PAIN",
      type: "checkbox-grid",
      columns: 3,
      options: [
        "Chronic", "Acute", "Dull", "Aching", "Hollow", "Heavy Colicky", "Pulling",
        "Distending", "Sharp", "Stabbing", "Spasmatic", "Sore", "Hypertonic",
        "Throbbing", "Stiff", "Tight", "Parasthesia", "Inflammation", "Swelling",
        "Bruising", "Edema", "Masses",
      ],
    },
    { id: "pain-current", label: "Pain Current", type: "slider", min: 0, max: 10 },
    { id: "pain-average", label: "Pain Average", type: "slider", min: 0, max: 10 },
    { id: "pain-worst", label: "Pain Worst", type: "slider", min: 0, max: 10 },
    { id: "pain-area-2", label: "Pain Area #2", type: "textarea", rows: 3, scribe: true },
    {
      id: "pulse",
      label: "Pulse",
      type: "checkbox-grid",
      columns: 3,
      options: [
        "Strong", "Weak", "Slow", "Fast", "Slippery", "Wiry", "Thin",
        "Superficial/Floating", "Large", "Deep",
      ],
    },
    { id: "assessment", label: "Assessment", type: "textarea", rows: 4, scribe: true },
    { id: "treatment-plan", label: "Treatment Plan", type: "textarea", rows: 4, scribe: true },
    {
      id: "ashi-points",
      label: "Ashi Points",
      type: "body-diagram",
      hint: "Mark tender ashi points and needle locations.",
      poses: ["left", "back", "front", "right"],
    },
    {
      id: "points-modalities",
      label: "Points/Modalities",
      type: "checkbox-text-list",
      options: [
        "Du", "Ren", "LV", "GB", "HE", "SI", "PC", "TH", "SP", "ST", "LU", "LI",
        "BL", "KI", "Extra Points", "Auricular", "Cupping", "Percussion",
        "Hypnotherapy", "Rife Frequencies", "Quantum Neurology",
      ],
    },
  ],
};

const TEMPLATES: ChartTemplate[] = [ACUPUNCTURE_TEMPLATE];

// A couple of prior signed notes so the chart list isn't empty on first load.
const SEED_ENTRIES: ChartEntry[] = [
  {
    id: "chart-0002",
    patientId: "*",
    templateId: "tpl-acupuncture",
    date: "2026-07-16",
    title: "Dr. B Acupuncture",
    author: "Brandon Bright",
    status: "draft",
    starred: true,
    values: {
      "subjective-quick": ["Pain/discomfort", "Poor Sleep"],
      energy: 5,
      stress: 6,
      "pain-current": 6,
      "pain-average": 5,
      "pain-worst": 8,
    },
  },
  {
    id: "chart-0001",
    patientId: "*",
    templateId: "tpl-acupuncture",
    date: "2026-07-02",
    title: "Dr. B Acupuncture",
    author: "Brandon Bright",
    status: "signed",
    starred: false,
    values: {
      "subjective-quick": ["Improved"],
      subjective: "Low back tension improved ~40% since last visit. Sleeping through the night.",
      energy: 7,
      stress: 4,
      "pain-current": 3,
      "pain-average": 4,
      "pain-worst": 6,
      assessment: "Kidney qi deficiency with LV qi stagnation, improving.",
      "treatment-plan": "Continue weekly x3, then reassess. Home: gentle stretching, magnesium PM.",
    },
  },
];

export function getChartTemplate(templateId = "tpl-acupuncture"): ChartTemplate {
  return TEMPLATES.find((t) => t.id === templateId) ?? ACUPUNCTURE_TEMPLATE;
}

export function listChartTemplates(): ChartTemplate[] {
  return TEMPLATES;
}

export function getChartEntries(patientId: string): ChartEntry[] {
  return SEED_ENTRIES.map((e) => ({ ...e, patientId }));
}

/** A blank draft for a new encounter, dated `today` (caller supplies the date). */
export function newChartDraft(patientId: string, date: string, author: string): ChartEntry {
  return {
    id: `chart-draft-${date}`,
    patientId,
    templateId: ACUPUNCTURE_TEMPLATE.id,
    date,
    title: ACUPUNCTURE_TEMPLATE.name,
    author,
    status: "draft",
    starred: false,
    values: {},
  };
}
