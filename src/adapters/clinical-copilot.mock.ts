"use client";

import { createSessionStore } from "./session-kv";
import { USE_LIVE_API } from "./mode";
import {
  getApprovedPathway,
  type KnowledgeConcern,
} from "./clinical-knowledge.mock";

export type CopilotConcern = KnowledgeConcern;

export type CopilotAnswer = "yes" | "no" | "unknown" | string;

export interface CopilotQuestion {
  id: string;
  label: string;
  reason: string;
  required: boolean;
  options: { value: string; label: string }[];
}

export interface CopilotSource {
  id: string;
  label: string;
  version: string;
  status: "practitioner-authored" | "patient-record" | "catalog";
}

export interface CopilotLabCandidate {
  panelId: string;
  name: string;
  vendor: string;
  rationale: string;
  missingBeforeOrder: string[];
  sourceIds: string[];
}

export interface CopilotProductCandidate {
  id: string;
  productName: string;
  brand: string;
  role: string;
  eligibility: "eligible-after-review" | "insufficient-information" | "blocked";
  eligibilityReason: string;
  labelStatus: "pending-exact-label-verification";
  sourceIds: string[];
}

export interface CopilotResult {
  id: string;
  createdAt: string;
  concern: CopilotConcern;
  title: string;
  summary: string;
  considerations: { label: string; rationale: string; urgency: "routine" | "priority" | "urgent" }[];
  followUpQuestions: string[];
  labs: CopilotLabCandidate[];
  products: CopilotProductCandidate[];
  nutritionDraft?: string;
  lifestyleDrafts: string[];
  interactionChecks: string[];
  missingInformation: string[];
  safetyBlocks: string[];
  sources: CopilotSource[];
  knowledgeVersion: string;
}

export interface CopilotPatientSession {
  concern: CopilotConcern;
  symptoms: string[];
  answers: Record<string, CopilotAnswer>;
  result?: CopilotResult;
  reviewed: boolean;
  verifiedProductIds: string[];
  createdProtocolId?: string;
}

const initialPatientSession = (): CopilotPatientSession => ({
  concern: "thyroid",
  symptoms: [],
  answers: {},
  reviewed: false,
  verifiedProductIds: [],
});

const store = createSessionStore<Record<string, CopilotPatientSession>>(
  "aidp:demo:clinical-copilot",
  {},
);

export const CONCERNS: {
  id: CopilotConcern;
  label: string;
  description: string;
  symptoms: string[];
}[] = [
  {
    id: "thyroid",
    label: "Thyroid health",
    description: "Function, autoimmunity, symptoms, and treatment-context review.",
    symptoms: ["Fatigue", "Cold intolerance", "Weight change", "Hair loss", "Palpitations", "Neck swelling"],
  },
  {
    id: "digestive",
    label: "Gut & digestive",
    description: "Symptoms, red flags, pathogen testing, diet, and gut-support context.",
    symptoms: ["Bloating", "Reflux", "Constipation", "Diarrhea", "Abdominal pain", "Food reactions"],
  },
  {
    id: "cardiometabolic",
    label: "Cardiometabolic",
    description: "Glucose regulation, inflammation, lipids, and cardiovascular risk context.",
    symptoms: ["Post-meal fatigue", "Cravings", "Weight gain", "High blood pressure", "Poor circulation", "Chest symptoms"],
  },
  {
    id: "adrenal",
    label: "Adrenal / HPA axis",
    description: "Cortisol rhythm, stimulant exposure, sleep, anxiety, and hormone context.",
    symptoms: ["Low morning energy", "Anxiety", "Afternoon crash", "Wired at night", "Night waking", "Caffeine dependence"],
  },
  {
    id: "autoimmune",
    label: "Autoimmune",
    description: "Symptom pattern, established diagnoses, triggers, gut context, and safety review.",
    symptoms: ["Joint pain", "Rash", "Fatigue", "Dryness", "Neurologic symptoms", "Food reactions"],
  },
  {
    id: "environmental",
    label: "Mold / environmental",
    description: "Exposure history, remediation, symptom pattern, and testing context.",
    symptoms: ["Musty exposure", "Brain fog", "Sinus symptoms", "Fatigue", "Headache", "Breathing symptoms"],
  },
];

const yesNoUnknown = [
  { value: "", label: "Select an answer" },
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
  { value: "unknown", label: "Unknown / needs confirmation" },
];

const commonQuestions: CopilotQuestion[] = [
  {
    id: "urgent-red-flags",
    label: "Any severe or rapidly worsening symptoms, chest pain, fainting, new neurologic deficit, severe breathing difficulty, or suicidal thoughts?",
    reason: "Urgent symptoms must bypass routine decision support.",
    required: true,
    options: yesNoUnknown,
  },
  {
    id: "medications-confirmed",
    label: "Is the current medication and supplement list reconciled?",
    reason: "Interaction and duplication checks require a current list.",
    required: true,
    options: yesNoUnknown,
  },
  {
    id: "allergies-confirmed",
    label: "Are allergies and prior adverse reactions confirmed?",
    reason: "Product eligibility cannot be established without this safety information.",
    required: true,
    options: yesNoUnknown,
  },
  {
    id: "pregnancy-status",
    label: "Is pregnancy, nursing, pediatric, or fertility-treatment status relevant?",
    reason: "These contexts can materially change testing and intervention eligibility.",
    required: true,
    options: yesNoUnknown,
  },
];

const concernQuestions: Record<CopilotConcern, CopilotQuestion[]> = {
  thyroid: [
    {
      id: "thyroid-antibodies",
      label: "Are elevated thyroid antibodies or Hashimoto's already documented?",
      reason: "This separates autoimmune-pattern support from non-autoimmune thyroid pathways.",
      required: true,
      options: yesNoUnknown,
    },
    {
      id: "thyroid-medication",
      label: "Is the patient currently using thyroid medication?",
      reason: "Medication timing, dose, and prescriber coordination affect interpretation and product eligibility.",
      required: true,
      options: yesNoUnknown,
    },
  ],
  digestive: [
    {
      id: "gi-alarm-features",
      label: "Any GI bleeding, persistent vomiting, progressive swallowing difficulty, unexplained weight loss, fever, or severe focal pain?",
      reason: "Alarm features need conventional diagnostic evaluation before routine gut protocols.",
      required: true,
      options: yesNoUnknown,
    },
    {
      id: "gi-testing",
      label: "Has a comprehensive stool test been completed in the last 12 months?",
      reason: "Targeted pathogen treatment should be based on current findings where appropriate.",
      required: true,
      options: yesNoUnknown,
    },
  ],
  cardiometabolic: [
    {
      id: "glucose-medication",
      label: "Is the patient using insulin, a sulfonylurea, GLP-1 medicine, or another glucose-lowering drug?",
      reason: "Treatment changes can create hypoglycemia or medication-adjustment risk.",
      required: true,
      options: yesNoUnknown,
    },
    {
      id: "anticoagulant",
      label: "Is the patient using an anticoagulant or antiplatelet medication?",
      reason: "This affects eligibility for several cardiovascular and omega-3 candidates.",
      required: true,
      options: yesNoUnknown,
    },
  ],
  adrenal: [
    {
      id: "anxiety-present",
      label: "Is clinically significant anxiety, panic, agitation, or stimulant sensitivity present?",
      reason: "The practice pathway avoids stimulating glandular products when anxiety is present.",
      required: true,
      options: yesNoUnknown,
    },
    {
      id: "cortisol-tested",
      label: "Is a recent diurnal cortisol pattern available?",
      reason: "Morning and nighttime cortisol patterns should not be inferred from fatigue alone.",
      required: true,
      options: yesNoUnknown,
    },
  ],
  autoimmune: [
    {
      id: "autoimmune-established",
      label: "Is there an established autoimmune diagnosis or specialist evaluation?",
      reason: "Reactivity panels and symptoms do not independently establish an autoimmune diagnosis.",
      required: true,
      options: yesNoUnknown,
    },
    {
      id: "immune-medications",
      label: "Is the patient using an immunosuppressant, biologic, anticoagulant, or transplant medication?",
      reason: "This requires coordination and blocks unsupervised supplement selection.",
      required: true,
      options: yesNoUnknown,
    },
  ],
  environmental: [
    {
      id: "active-exposure",
      label: "Is ongoing water damage or suspected mold exposure still present?",
      reason: "Supportive care should not substitute for exposure assessment and remediation.",
      required: true,
      options: yesNoUnknown,
    },
    {
      id: "breathing-red-flags",
      label: "Any severe wheeze, low oxygen, coughing blood, chest pain, or acute breathing decline?",
      reason: "Acute respiratory findings require appropriate medical evaluation.",
      required: true,
      options: yesNoUnknown,
    },
  ],
};

const symptomQuestions: Record<string, CopilotQuestion> = {
  Palpitations: {
    id: "palpitations-context",
    label: "Have palpitations been medically evaluated, including rhythm and medication/stimulant review?",
    reason: "Palpitations can require evaluation outside a thyroid-focused pathway.",
    required: true,
    options: yesNoUnknown,
  },
  "Neck swelling": {
    id: "neck-swelling-context",
    label: "Has the neck swelling, mass, or swallowing change been examined?",
    reason: "Structural thyroid or neck symptoms require direct evaluation.",
    required: true,
    options: yesNoUnknown,
  },
  "Chest symptoms": {
    id: "chest-context",
    label: "Have the chest symptoms been medically evaluated?",
    reason: "Chest symptoms are not handled as a routine metabolic optimization question.",
    required: true,
    options: yesNoUnknown,
  },
  "Abdominal pain": {
    id: "abdominal-pain-context",
    label: "Is abdominal pain severe, focal, persistent, or associated with fever or bleeding?",
    reason: "This distinguishes routine symptom review from an alarm-feature pathway.",
    required: true,
    options: yesNoUnknown,
  },
  "Breathing symptoms": {
    id: "breathing-context",
    label: "Have persistent breathing symptoms been evaluated with appropriate pulmonary or environmental assessment?",
    reason: "Environmental attribution should not delay conventional evaluation.",
    required: true,
    options: yesNoUnknown,
  },
};

export function getAdaptiveQuestions(
  concern: CopilotConcern,
  symptoms: string[],
): CopilotQuestion[] {
  const extra = symptoms
    .map((symptom) => symptomQuestions[symptom])
    .filter((question): question is CopilotQuestion => Boolean(question));
  return [...commonQuestions, ...concernQuestions[concern], ...extra].filter(
    (question, index, rows) => rows.findIndex((row) => row.id === question.id) === index,
  );
}

function source(
  id: string,
  label: string,
  version: string,
  status: CopilotSource["status"],
): CopilotSource {
  return { id, label, version, status };
}

const knowledgeSource = source(
  "practice-knowledge",
  "Practitioner-authored protocol registry",
  "draft-2026.07",
  "practitioner-authored",
);
const productSource = source(
  "product-catalog",
  "Practice product catalog",
  "catalog-review-pending",
  "catalog",
);

function product(
  id: string,
  productName: string,
  brand: string,
  role: string,
  eligibility: CopilotProductCandidate["eligibility"],
  eligibilityReason: string,
): CopilotProductCandidate {
  return {
    id,
    productName,
    brand,
    role,
    eligibility,
    eligibilityReason,
    labelStatus: "pending-exact-label-verification",
    sourceIds: ["practice-knowledge", "product-catalog"],
  };
}

function missingSafety(answers: Record<string, CopilotAnswer>): string[] {
  const missing: string[] = [];
  if (answers["medications-confirmed"] !== "yes") missing.push("Current medication and supplement reconciliation");
  if (answers["allergies-confirmed"] !== "yes") missing.push("Allergies and prior adverse reactions");
  if (answers["pregnancy-status"] === "unknown" || !answers["pregnancy-status"]) {
    missing.push("Pregnancy, nursing, pediatric, and fertility-treatment status");
  }
  if (answers["pregnancy-status"] === "yes") {
    missing.push("Document the applicable pregnancy, nursing, pediatric, or fertility-treatment context before selecting products");
  }
  return missing;
}

export function evaluateClinicalCopilot(
  patientId: string,
  patientName: string,
  session: CopilotPatientSession,
): CopilotResult {
  const registryEntry = getApprovedPathway(session.concern);
  const answers = session.answers;
  const safetyBlocks: string[] = [];
  const missingInformation = missingSafety(answers);
  if (!registryEntry) {
    safetyBlocks.push("No approved clinical pathway version is available for this concern.");
  }
  if (answers["urgent-red-flags"] === "yes") {
    safetyBlocks.push("Urgent symptoms reported. Pause routine copilot workflow and follow the practice escalation policy.");
  }
  if (answers["urgent-red-flags"] !== "no") {
    missingInformation.push("Explicit urgent-symptom screen");
  }

  const sources: CopilotSource[] = [
    source(`patient:${patientId}`, `${patientName} chart context`, "current-session snapshot", "patient-record"),
    registryEntry
      ? source(
          `pathway:${registryEntry.pathway.id}`,
          registryEntry.pathway.name,
          `v${registryEntry.version.version} · approved`,
          "practitioner-authored",
        )
      : knowledgeSource,
    productSource,
  ];
  const considerations: CopilotResult["considerations"] = [];
  const followUpQuestions: string[] = [];
  const labs: CopilotLabCandidate[] = [];
  const products: CopilotProductCandidate[] = [];
  const lifestyleDrafts: string[] = [];
  const interactionChecks = [
    "Reconcile active medications, supplements, allergies, and prior adverse reactions.",
    "Check ingredient duplication across every proposed product and the current regimen.",
    "Confirm product formulation, serving size, contraindications, and current manufacturer label.",
  ];
  let nutritionDraft: string | undefined;

  const currentEligibility = (): CopilotProductCandidate["eligibility"] =>
    safetyBlocks.length === 0 && missingInformation.length === 0
      ? "eligible-after-review"
      : "insufficient-information";
  const currentEligibilityReason = () =>
    currentEligibility() === "eligible-after-review"
      ? "Core safety history is present; practitioner review and exact-label verification are still required."
      : "Required safety information is incomplete or an escalation block is active.";

  if (session.concern === "thyroid") {
    considerations.push({
      label: answers["thyroid-antibodies"] === "yes" ? "Documented autoimmune thyroid context" : "Thyroid dysfunction requires classification",
      rationale: answers["thyroid-antibodies"] === "yes"
        ? "Recorded antibodies change the practice pathway, but do not replace full clinical correlation."
        : "Symptoms alone cannot distinguish autoimmune, primary, central, medication-related, or non-thyroid causes.",
      urgency: session.symptoms.includes("Palpitations") || session.symptoms.includes("Neck swelling") ? "priority" : "routine",
    });
    labs.push({
      panelId: "lp-vibrant-thyroid",
      name: "Full Thyroid Panel",
      vendor: "Vibrant America",
      rationale: "Clarify thyroid function and antibody status before selecting a thyroid-specific pathway.",
      missingBeforeOrder: ["Clinical indication", "Current thyroid medication and timing", "Vendor panel contents and eligibility"],
      sourceIds: ["patient:" + patientId, "practice-knowledge"],
    });
    followUpQuestions.push(
      "What is the exact timing of symptoms relative to thyroid medication, meals, sleep, and menstrual or hormonal changes?",
      "Are prior TSH, free hormone, reverse T3, and antibody results available with dates and reference ranges?",
    );
    if (answers["thyroid-antibodies"] === "yes") {
      products.push(product("thyro-immune", "Thyro Immune", "Designs for Health", "Autoimmune-thyroid support candidate", currentEligibility(), currentEligibilityReason()));
      nutritionDraft = "AIP-pattern elimination and structured reintroduction draft; dietitian/practitioner review required for adequacy and sustainability.";
    } else if (answers["thyroid-antibodies"] === "no") {
      products.push(
        product("thyro-pep", "ThyroPep", "Integrative Peptides", "Non-autoimmune thyroid pathway candidate", currentEligibility(), currentEligibilityReason()),
        product("thyrotain", "Thyrotain", "Ortho Molecular Products", "Thyroid nutrient-support candidate", currentEligibility(), currentEligibilityReason()),
      );
    } else {
      missingInformation.push("Thyroid antibody status before selecting an autoimmune or non-autoimmune product pathway");
    }
    lifestyleDrafts.push("Discuss a practitioner-reviewed light-exposure plan only after thyroid/neck contraindications and device instructions are confirmed.");
  }

  if (session.concern === "digestive") {
    const alarm = answers["gi-alarm-features"];
    if (alarm === "yes") safetyBlocks.push("GI alarm features reported. Route for appropriate diagnostic evaluation before routine protocol drafting.");
    considerations.push({
      label: "Digestive symptom pattern needs etiologic clarification",
      rationale: "Symptoms can overlap across infection, inflammation, motility, medication effects, malabsorption, and food intolerance.",
      urgency: alarm === "yes" ? "urgent" : "routine",
    });
    labs.push(
      {
        panelId: "lp-gimap",
        name: "GI-MAP Stool",
        vendor: "Diagnostic Solutions",
        rationale: "Practice pathway option for pathogen and digestive-marker review when clinically appropriate.",
        missingBeforeOrder: ["Alarm-feature review", "Recent antibiotics/antimicrobials", "Clinical indication"],
        sourceIds: ["patient:" + patientId, "practice-knowledge"],
      },
      {
        panelId: "lp-gut-zoomer",
        name: "Gut Zoomer",
        vendor: "Vibrant Wellness",
        rationale: "Alternative practice pathway for broad gut review; avoid duplicate testing without a specific rationale.",
        missingBeforeOrder: ["Choose one primary stool-testing strategy", "Vendor analytes and limitations"],
        sourceIds: ["practice-knowledge"],
      },
    );
    followUpQuestions.push(
      "What is the stool pattern, frequency, onset, and relationship to meals, travel, antibiotics, medications, and menstrual cycle?",
      "Which foods are being avoided, and is there evidence of inadequate intake or unintended weight loss?",
    );
    nutritionDraft = "Begin with a symptom- and adequacy-aware food record; select a targeted diet only after the pattern and nutritional risks are reviewed.";
    products.push(product(
      "result-directed-gi",
      "Result-directed gut support",
      "Practice catalog",
      "Placeholder until reviewed stool findings identify a clinically eligible pathway",
      "blocked",
      "No exact product should be selected before relevant findings and contraindications are reviewed.",
    ));
  }

  if (session.concern === "cardiometabolic") {
    if (session.symptoms.includes("Chest symptoms") && answers["chest-context"] !== "yes") {
      safetyBlocks.push("Chest symptoms lack documented evaluation. Pause routine optimization recommendations.");
    }
    considerations.push({
      label: "Cardiometabolic risk requires a multi-domain assessment",
      rationale: "Inflammation, glycemia, blood pressure, lipoproteins, body composition, sleep, medications, and family history should be assessed together.",
      urgency: session.symptoms.includes("Chest symptoms") ? "priority" : "routine",
    });
    labs.push(
      { panelId: "lp-apob", name: "Advanced Cardiometabolic", vendor: "Boston Heart", rationale: "Clarify ApoB, Lp(a), and particle-level risk when clinically indicated.", missingBeforeOrder: ["Family history", "Existing lipid treatment", "Clinical indication"], sourceIds: ["practice-knowledge"] },
      { panelId: "lp-a1c", name: "Hemoglobin A1c", vendor: "Quest Diagnostics", rationale: "Establish a glycemic trend alongside fasting glucose and insulin context.", missingBeforeOrder: ["Factors that may alter A1c interpretation"], sourceIds: ["practice-knowledge"] },
      { panelId: "lp-hscrp", name: "hs-CRP", vendor: "Quest Diagnostics", rationale: "Trend inflammation only in appropriate clinical context and avoid interpreting an acute illness value as baseline.", missingBeforeOrder: ["Current infection/injury status"], sourceIds: ["practice-knowledge"] },
    );
    products.push(
      product("resolve-plus", "Resolve+", "Healthgevity", "Inflammation-support candidate", currentEligibility(), currentEligibilityReason()),
      product(
        "pro-omega-2000",
        "ProOmega 2000",
        "Nordic Naturals",
        "Omega-3 candidate",
        answers["anticoagulant"] === "no" && currentEligibility() === "eligible-after-review" ? "eligible-after-review" : "insufficient-information",
        answers["anticoagulant"] === "no" && currentEligibility() === "eligible-after-review" ? currentEligibilityReason() : "Anticoagulant/antiplatelet status or another safety field is unresolved.",
      ),
      product("bergacore-plus", "BergaCore Plus", "Advanced Nutrition by Zahler", "Lipid-support candidate", currentEligibility(), currentEligibilityReason()),
    );
    followUpQuestions.push(
      "What is the family history of premature cardiovascular disease, diabetes, hypertension, and stroke?",
      "What medications, blood-pressure readings, waist trend, sleep pattern, and exercise capacity are documented?",
    );
    nutritionDraft = "Draft a minimally processed, protein- and fiber-aware cardiometabolic plan; carbohydrate level remains patient-specific.";
    lifestyleDrafts.push("Build a reviewed progressive movement plan spanning resistance, aerobic base, balance, and recovery.");
  }

  if (session.concern === "adrenal") {
    considerations.push({
      label: "Cortisol-pattern hypothesis requires timed measurement",
      rationale: "Fatigue, anxiety, and sleep disruption are nonspecific and should not be labeled adrenal dysfunction from symptoms alone.",
      urgency: "routine",
    });
    labs.push({
      panelId: "lp-dutch",
      name: "DUTCH Complete",
      vendor: "Precision Analytical",
      rationale: "Practice pathway for a diurnal cortisol and hormone-metabolite pattern when clinically appropriate.",
      missingBeforeOrder: ["Medication/hormone timing", "Sleep schedule", "Collection-day instructions"],
      sourceIds: ["practice-knowledge"],
    });
    if (answers["anxiety-present"] === "yes") {
      products.push(product("adapten-all", "Adapten-All", "Ortho Molecular Products", "Non-glandular pathway candidate", currentEligibility(), currentEligibilityReason()));
    } else if (answers["anxiety-present"] === "no") {
      products.push(product("adren-all", "Adren-All", "Ortho Molecular Products", "Practice adrenal-support candidate", currentEligibility(), currentEligibilityReason()));
    } else {
      missingInformation.push("Anxiety and stimulant-sensitivity status before selecting an adrenal-support candidate");
    }
    products.push(product("cortisol-manager", "Cortisol Manager", "Integrative Therapeutics", "Nighttime cortisol-pattern candidate only if confirmed", "insufficient-information", "Requires a reviewed nighttime cortisol pattern, medication check, and exact-label verification."));
    followUpQuestions.push(
      "What are waking time, sleep timing, caffeine dose/timing, work schedule, and the timing of the energy crash?",
      "Are anemia, thyroid dysfunction, sleep apnea, medication effects, mood disorders, and cardiometabolic causes reasonably assessed?",
    );
    lifestyleDrafts.push("Draft a caffeine/stimulant reduction plan with sleep timing and morning light anchors.");
  }

  if (session.concern === "autoimmune") {
    if (answers["immune-medications"] === "yes") {
      safetyBlocks.push("Immune-modifying or transplant medication reported. Coordinate any supplement plan with the treating specialist.");
    }
    considerations.push({
      label: "Immune symptoms require diagnosis-aware evaluation",
      rationale: "Symptoms and antibody reactivity do not independently establish disease activity, cause, or a treatment plan.",
      urgency: "priority",
    });
    labs.push({
      panelId: "lp-cyrex-autoimmune",
      name: "Autoimmune Reactivity Screen",
      vendor: "Cyrex Laboratories",
      rationale: "Potential adjunct only when a specific clinical question and follow-up plan are documented.",
      missingBeforeOrder: ["Specific clinical question", "Conventional evaluation status", "Panel limitations reviewed"],
      sourceIds: ["practice-knowledge"],
    });
    nutritionDraft = "AIP-pattern trial with adequacy review, defined duration, symptom measures, and structured reintroduction; not an indefinite restriction.";
    followUpQuestions.push(
      "Which diagnosis is established, by whom, and what objective disease-activity measures are being followed?",
      "What infections, medications, nutrient deficiencies, sleep disruption, and GI symptoms could be contributing or confounding?",
    );
  }

  if (session.concern === "environmental") {
    if (answers["breathing-red-flags"] === "yes") safetyBlocks.push("Acute respiratory red flags reported. Escalate before environmental protocol drafting.");
    considerations.push({
      label: "Exposure and remediation status comes before supportive care",
      rationale: "A urine result or symptom cluster does not by itself identify source, illness mechanism, or treatment response.",
      urgency: answers["breathing-red-flags"] === "yes" ? "urgent" : "priority",
    });
    labs.push({
      panelId: "lp-vibrant-mycotoxin",
      name: "Mycotoxins Panel",
      vendor: "Vibrant America",
      rationale: "Consider only with a documented exposure question, pre-test counseling, and a plan for interpreting limitations.",
      missingBeforeOrder: ["Exposure assessment", "Remediation status", "Pre-test counseling"],
      sourceIds: ["practice-knowledge"],
    });
    products.push(
      product("ultra-binder", "Ultra Binder", "Quicksilver Scientific", "Binder candidate", currentEligibility(), currentEligibilityReason()),
      product("biocidin-lsf", "Biocidin LSF", "Biocidin Botanicals", "Botanical candidate", currentEligibility(), currentEligibilityReason()),
      product("liver-sauce", "Liver Sauce", "Quicksilver Scientific", "Support candidate", currentEligibility(), currentEligibilityReason()),
    );
    followUpQuestions.push(
      "Is there documented water damage, visible growth, odor, professional inspection, or symptom improvement away from the environment?",
      "What pulmonary, allergic, infectious, neurologic, medication, and sleep explanations have been assessed?",
    );
    lifestyleDrafts.push("Document exposure controls and appropriate remediation/referral steps before presenting supportive care as a plan.");
  }

  const uniqueMissing = Array.from(new Set(missingInformation));
  const uniqueBlocks = Array.from(new Set(safetyBlocks));
  return {
    id: `copilot:${patientId}:${Date.now()}`,
    createdAt: new Date().toISOString(),
    concern: session.concern,
    title: `${CONCERNS.find((item) => item.id === session.concern)?.label ?? "Clinical"} review`,
    summary: uniqueBlocks.length
      ? "Routine recommendations are blocked until the safety concern is resolved."
      : "A deterministic, practitioner-authored pathway organized the available information into reviewable questions, lab candidates, and draft-only interventions.",
    considerations,
    followUpQuestions,
    labs,
    products,
    nutritionDraft,
    lifestyleDrafts,
    interactionChecks,
    missingInformation: uniqueMissing,
    safetyBlocks: uniqueBlocks,
    sources,
    knowledgeVersion: registryEntry
      ? `${registryEntry.pathway.code}/v${registryEntry.version.version} + rules/schema-1`
      : "no-approved-pathway + rules/schema-1",
  };
}

export function useCopilotSession(patientId: string): CopilotPatientSession {
  return store.use()[patientId] ?? initialPatientSession();
}

export function updateCopilotSession(
  patientId: string,
  updater: (current: CopilotPatientSession) => CopilotPatientSession,
) {
  store.update((all) => ({
    ...all,
    [patientId]: updater(all[patientId] ?? initialPatientSession()),
  }));
}

export function runClinicalCopilot(patientId: string, patientName: string): CopilotResult | null {
  if (USE_LIVE_API) return null;
  const current = store.get()[patientId] ?? initialPatientSession();
  const result = evaluateClinicalCopilot(patientId, patientName, current);
  updateCopilotSession(patientId, (session) => ({
    ...session,
    result,
    reviewed: false,
    verifiedProductIds: [],
    createdProtocolId: undefined,
  }));
  return result;
}

export function resetClinicalCopilot(patientId: string) {
  updateCopilotSession(patientId, () => initialPatientSession());
}
