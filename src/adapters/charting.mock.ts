/**
 * MOCK dynamic charting model + template library.
 *
 * A practitioner chart is a *composable* clinical note: a template describes an
 * ordered list of sections, each holding typed fields (checkbox groups,
 * 0–10 sliders, draw-on body diagrams, free-text SOAP boxes, acupoint lists).
 * The UI renders any template generically, so a practice can shape the note to
 * its modality without a code change — the same idea that makes Jane's charting
 * feel bespoke.
 *
 * This is synthetic, client-safe config shaped like a future
 * `api.charting.template` / `api.charting.entries` query. Live persistence
 * (chart entries + signatures) will replace the demo session store in
 * `charting-store.ts`; the field/template shapes below stay the same.
 *
 * Nothing here is a medical record: a chart entry only becomes part of the
 * record when a practitioner reviews and signs it (status `signed`).
 */

export type ChartFieldType =
  | "subjective-tags"
  | "textarea"
  | "text"
  | "slider"
  | "checkbox-group"
  | "point-list"
  | "body-chart";

interface FieldBase {
  /** Stable key within a template; becomes the value key on an entry. */
  id: string;
  type: ChartFieldType;
  label?: string;
}

/** Inline row of quick-select tags (Jane's "Subjective" checkbox strip). */
export interface SubjectiveTagsField extends FieldBase {
  type: "subjective-tags";
  options: string[];
}

export interface TextareaField extends FieldBase {
  type: "textarea";
  placeholder?: string;
  /** Marks a box the AI scribe can target when structuring a transcript. */
  soap?: "subjective" | "objective" | "assessment" | "plan";
}

export interface TextField extends FieldBase {
  type: "text";
  placeholder?: string;
}

/** 0–10 clinical scale (pain, energy, stress). */
export interface SliderField extends FieldBase {
  type: "slider";
  min: number;
  max: number;
}

/** Columned checkbox grid (organ-system symptom groups, pulse qualities). */
export interface CheckboxGroupField extends FieldBase {
  type: "checkbox-group";
  options: string[];
  columns?: 1 | 2 | 3;
}

/** Checkbox + free-text rows (acupuncture points / modalities). */
export interface PointListField extends FieldBase {
  type: "point-list";
  rows: string[];
}

/** Draw-on body diagram: freehand marks + labelled acupoint pins. */
export interface BodyChartField extends FieldBase {
  type: "body-chart";
  /** Which silhouettes to show. */
  views: BodyView[];
}

export type BodyView = "front" | "back";

export type ChartField =
  | SubjectiveTagsField
  | TextareaField
  | TextField
  | SliderField
  | CheckboxGroupField
  | PointListField
  | BodyChartField;

export interface ChartSection {
  id: string;
  title?: string;
  fields: ChartField[];
}

export interface ChartTemplate {
  id: string;
  name: string;
  sections: ChartSection[];
}

/* ---- value shapes (what an entry stores per field) --------------------- */

/** Normalized 0..1 coordinates so a drawing is resolution-independent. */
export type BodyOp =
  | { kind: "stroke"; view: BodyView; color: string; width: number; pts: [number, number][] }
  | { kind: "point"; view: BodyView; color: string; x: number; y: number; label: string };

export interface BodyChartValue {
  ops: BodyOp[];
}

export type PointListValue = Record<string, { checked: boolean; text: string }>;

export type ChartFieldValue =
  | string
  | number
  | string[]
  | BodyChartValue
  | PointListValue
  | undefined;

export type ChartValues = Record<string, ChartFieldValue>;

export interface ChartEntry {
  id: string;
  patientId: string;
  templateId: string;
  title: string;
  /** ISO date of the visit this note documents. */
  date: string;
  author: string;
  status: "draft" | "signed";
  values: ChartValues;
  /** Raw AI-scribe transcript, when one was captured. Never a record on its own. */
  transcript?: string;
  createdAt: string;
  updatedAt: string;
  signedAt?: string;
}

/* ---- the flagship acupuncture / holistic SOAP template ----------------- */

const LUNG_LI = [
  "Allergies", "Arm/wrist/elbow pain", "Asthma/Bronchitis", "Constipation",
  "Cough/Sneeze/Phlegm", "Eczema/Psoriasis/Rash", "Flatulence", "Frequent Colds",
  "Frontal/Sinus HA", "Grief/Sadness", "Lethargy/Fatigue", "Loose Stool",
  "Mucus", "Nasal Problems", "Shoulder Pain", "Sinusitis", "Smell Problems",
  "Stiff Joints/Neck", "Sweating Problems", "Weak Voice", "Wheezing/SOB",
];

const KIDNEY_BL = [
  "Adrenal Weakness", "Back/Hip/Knee Pain", "UTI", "Brittle Bones",
  "Cold Hands/Feet", "Dark/Puffy around Eyes", "Depression/Fear",
  "Edema/Water Retention", "Hot Flashes", "Impotence/Libido",
  "Infertility/Sterility", "Lethargy/Fatigue", "Loss/Thinning Hair",
  "Night Sweats", "Poor Memory", "Premature Gray", "Sciatica/Back Pain",
  "Sore Throat in AM", "Tight Hamstrings", "Tinnitus", "Urine Problems",
];

const LIVER_GB = [
  "Anger/Irritability", "Breast Tenderness", "Brittle/Coarse Nails/Hair",
  "Bruising", "Depression", "Distention/Bloating", "Eye/Vision Problems",
  "Flatulence", "Headaches", "Hemorrhoids", "Indigestion", "IBS",
  "IT Band Tightness", "Lack of Flexibility", "Menstrual Irreg", "Migraines",
  "Nausea/Vomiting", "PMS", "Stiff Neck/Shoulders", "Tension/Cramps", "Tinnitus",
];

const HEART_SI = [
  "Abdominal Pain", "Anemia", "Anxiety/Dread", "Digestive Troubles",
  "Dream Disturbed Sleep", "Heart Problems", "Hot Flashes", "Hot/Painful Joints",
  "Lack of Joy/humor", "Mouth Sores", "Neck Pain", "Poor Circulation",
  "Restlessness", "Sleep Problems", "Tongue/Speech", "Upper Back Pain",
  "Urine Problems",
];

const SPLEEN_ST = [
  "Abdominal Pain", "Aching/Heavy Limbs", "Anemia", "Appetite/Digestive Prob",
  "Belching", "Bruise Easily", "Colic/Indigestion", "Difficulty Focusing",
  "Distension/Bloating", "Headaches", "Heaviness at head", "Hemorrhoids",
  "Hiccups", "IBS", "Lethargy/Fatigue", "Loose Stools", "Muscle Weakness",
  "Nausea/Vomiting", "Poor Memory", "Prolapse", "Worry/Overthinking",
];

const PAIN_QUALITIES = [
  "Chronic", "Acute", "Dull", "Aching", "Hollow", "Heavy Colicky", "Pulling",
  "Distending", "Sharp", "Stabbing", "Spasmatic", "Sore", "Hypertonic",
  "Throbbing", "Stiff", "Tight", "Parasthesia", "Inflammation", "Swelling",
  "Bruising", "Edema", "Masses",
];

const PULSE_QUALITIES = [
  "Strong", "Weak", "Slow", "Fast", "Slippery", "Wiry", "Thin",
  "Superficial/Floating", "Large", "Deep",
];

const POINTS_MODALITIES = [
  "Du", "Ren", "LV", "GB", "HE", "SP", "ST", "LU", "LI", "BL", "KI",
  "Extra Points", "Auricular", "Cupping", "Percussion", "Hypnotherapy",
  "Rife Frequencies", "Quantum Neurology",
];

export const ACUPUNCTURE_SOAP_TEMPLATE: ChartTemplate = {
  id: "acu-soap-v1",
  name: "Acupuncture SOAP",
  sections: [
    {
      id: "subjective",
      fields: [
        {
          id: "subjective_tags",
          type: "subjective-tags",
          options: [
            "Improved", "No change", "Pain/discomfort", "Tension/Stiffness",
            "Numbness/tingling", "Headache/Migraine", "Poor Sleep", "Digestive Issues",
          ],
        },
        {
          id: "subjective_note",
          type: "textarea",
          label: "Subjective",
          soap: "subjective",
          placeholder: "Patient's report in their own words…",
        },
        { id: "energy", type: "slider", label: "Energy", min: 0, max: 10 },
        { id: "stress", type: "slider", label: "Stress", min: 0, max: 10 },
      ],
    },
    {
      id: "systems",
      fields: [
        { id: "lung_li", type: "checkbox-group", label: "Lung & Large Intestine", options: LUNG_LI, columns: 3 },
        { id: "kidney_bl", type: "checkbox-group", label: "Kidney & Bladder", options: KIDNEY_BL, columns: 3 },
        { id: "liver_gb", type: "checkbox-group", label: "Liver & Gallbladder", options: LIVER_GB, columns: 3 },
        { id: "heart_si", type: "checkbox-group", label: "Heart & Small Intestine", options: HEART_SI, columns: 3 },
        { id: "spleen_st", type: "checkbox-group", label: "Spleen & Stomach", options: SPLEEN_ST, columns: 3 },
      ],
    },
    {
      id: "objective",
      fields: [
        { id: "objective_note", type: "textarea", label: "Objective", soap: "objective", placeholder: "Observed findings…" },
        { id: "physical_exam", type: "textarea", label: "Physical Exam", placeholder: "Palpation, ROM, orthopedic tests…" },
      ],
    },
    {
      id: "body_chart",
      fields: [
        { id: "body_chart", type: "body-chart", label: "Body Chart", views: ["front", "back"] },
      ],
    },
    {
      id: "pain",
      fields: [
        { id: "pain_area_1", type: "textarea", label: "Pain Area #1", placeholder: "Location & description…" },
        { id: "pain_qualities", type: "checkbox-group", label: "Pain", options: PAIN_QUALITIES, columns: 3 },
        { id: "pain_current", type: "slider", label: "Pain Current", min: 0, max: 10 },
        { id: "pain_average", type: "slider", label: "Pain Average", min: 0, max: 10 },
        { id: "pain_worst", type: "slider", label: "Pain Worst", min: 0, max: 10 },
        { id: "pain_area_2", type: "textarea", label: "Pain Area #2", placeholder: "Location & description…" },
      ],
    },
    {
      id: "pulse",
      fields: [
        { id: "pulse", type: "checkbox-group", label: "Pulse", options: PULSE_QUALITIES, columns: 3 },
      ],
    },
    {
      id: "ashi",
      fields: [
        { id: "ashi_points", type: "body-chart", label: "Ashi Points", views: ["front", "back"] },
      ],
    },
    {
      id: "assessment_plan",
      fields: [
        { id: "assessment", type: "textarea", label: "Assessment", soap: "assessment", placeholder: "TCM diagnosis / pattern differentiation…" },
        { id: "treatment_plan", type: "textarea", label: "Treatment Plan", soap: "plan", placeholder: "Points, frequency, home care…" },
      ],
    },
    {
      id: "points",
      fields: [
        { id: "points_modalities", type: "point-list", label: "Points/Modalities", rows: POINTS_MODALITIES },
      ],
    },
  ],
};

export const CHART_TEMPLATES: ChartTemplate[] = [ACUPUNCTURE_SOAP_TEMPLATE];

export function getChartTemplate(id?: string): ChartTemplate {
  return CHART_TEMPLATES.find((t) => t.id === id) ?? ACUPUNCTURE_SOAP_TEMPLATE;
}

/** Every field that the AI scribe can write structured text into, by SOAP slot. */
export function soapTargets(template: ChartTemplate): Record<
  "subjective" | "objective" | "assessment" | "plan",
  string | undefined
> {
  const map: Record<string, string> = {};
  for (const section of template.sections) {
    for (const field of section.fields) {
      if (field.type === "textarea" && field.soap) map[field.soap] = field.id;
    }
  }
  return {
    subjective: map.subjective,
    objective: map.objective,
    assessment: map.assessment,
    plan: map.plan,
  };
}
