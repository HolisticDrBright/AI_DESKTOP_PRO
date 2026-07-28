"use client";

import { createSessionStore } from "./session-kv";

export type KnowledgeConcern =
  | "thyroid"
  | "digestive"
  | "cardiometabolic"
  | "adrenal"
  | "autoimmune"
  | "environmental";

export type KnowledgeVersionStatus = "draft" | "approved" | "superseded" | "retired";

export interface KnowledgePathwayContent {
  differentiatingQuestions: string[];
  labStrategy: { panel: string; vendor: string; purpose: string }[];
  productCandidates: { name: string; brand: string; role: string }[];
  nutrition: string[];
  lifestyle: string[];
  safetyStops: string[];
}

export interface KnowledgePathwayVersion {
  id: string;
  version: number;
  status: KnowledgeVersionStatus;
  changeSummary: string;
  createdAt: string;
  createdBy: string;
  approvedAt?: string;
  approvedBy?: string;
  sourceRefs: string[];
  content: KnowledgePathwayContent;
}

export interface KnowledgePathway {
  id: string;
  code: KnowledgeConcern;
  name: string;
  domain: string;
  description: string;
  versions: KnowledgePathwayVersion[];
}

const today = "2026-07-27T17:00:00.000Z";

const seeds: KnowledgePathway[] = [
  {
    id: "kp-thyroid",
    code: "thyroid",
    name: "Thyroid classification pathway",
    domain: "Endocrine",
    description: "Separates autoimmune-pattern, non-autoimmune, medication, structural, and urgent thyroid contexts.",
    versions: [{
      id: "kp-thyroid-v1", version: 1, status: "approved", changeSummary: "Initial governed pathway",
      createdAt: today, createdBy: "Dr. Brandon Bright", approvedAt: today, approvedBy: "Dr. Brandon Bright",
      sourceRefs: ["Practice-authored thyroid protocol", "Vibrant America Full Thyroid Panel documentation"],
      content: {
        differentiatingQuestions: ["Are thyroid antibodies documented?", "Is thyroid medication reconciled?", "Any palpitations, neck swelling, or swallowing change?"],
        labStrategy: [{ panel: "Full Thyroid Panel", vendor: "Vibrant America", purpose: "Classify function and antibody status before choosing a pathway." }],
        productCandidates: [
          { name: "Thyro Immune", brand: "Designs for Health", role: "Autoimmune-thyroid candidate after review" },
          { name: "ThyroPep", brand: "Integrative Peptides", role: "Non-autoimmune pathway candidate" },
          { name: "Thyrotain", brand: "Ortho Molecular Products", role: "Nutrient-support candidate" },
        ],
        nutrition: ["AIP-pattern trial with adequacy review and structured reintroduction when autoimmune thyroid context is confirmed."],
        lifestyle: ["Device-reviewed red-light exposure plan only after structural and medication context is confirmed."],
        safetyStops: ["Urgent symptoms", "Unassessed palpitations", "Unassessed neck mass or swallowing change", "Pregnancy/pediatric context not documented"],
      },
    }],
  },
  {
    id: "kp-digestive",
    code: "digestive",
    name: "Digestive symptoms and stool testing",
    domain: "Gastrointestinal",
    description: "Uses alarm-feature screening before a targeted stool-test and result-directed plan.",
    versions: [{
      id: "kp-digestive-v1", version: 1, status: "approved", changeSummary: "Initial governed pathway",
      createdAt: today, createdBy: "Dr. Brandon Bright", approvedAt: today, approvedBy: "Dr. Brandon Bright",
      sourceRefs: ["Practice-authored digestive protocol", "GI-MAP documentation", "Gut Zoomer documentation"],
      content: {
        differentiatingQuestions: ["Any GI bleeding, progressive dysphagia, unexplained weight loss, fever, or severe focal pain?", "Recent antibiotics, antimicrobials, travel, or infection?", "What is the stool pattern and relationship to meals?"],
        labStrategy: [
          { panel: "GI-MAP Stool", vendor: "Diagnostic Solutions", purpose: "Pathogen and digestive-marker review when clinically appropriate." },
          { panel: "Gut Zoomer", vendor: "Vibrant Wellness", purpose: "Alternative broad gut review when there is a defined clinical question." },
        ],
        productCandidates: [{ name: "Result-directed gut support", brand: "Approved practice catalog", role: "Chosen only after findings and contraindications are reviewed" }],
        nutrition: ["Choose a targeted diet after symptom pattern, adequacy, and red flags are reviewed."],
        lifestyle: ["Track meals, symptoms, stool pattern, sleep, and medication timing before changing multiple variables."],
        safetyStops: ["GI alarm features", "Severe dehydration", "No current medication/allergy review", "Product selection before relevant results"],
      },
    }],
  },
  {
    id: "kp-cardiometabolic",
    code: "cardiometabolic",
    name: "Cardiometabolic risk pathway",
    domain: "Cardiometabolic",
    description: "Combines glycemia, lipids, inflammation, circulation, medications, family history, and exercise capacity.",
    versions: [{
      id: "kp-cardiometabolic-v1", version: 1, status: "approved", changeSummary: "Initial governed pathway",
      createdAt: today, createdBy: "Dr. Brandon Bright", approvedAt: today, approvedBy: "Dr. Brandon Bright",
      sourceRefs: ["Practice-authored cardiometabolic protocol", "AHA/ACC clinical knowledge registry"],
      content: {
        differentiatingQuestions: ["Any chest symptoms or reduced exercise tolerance?", "Current glucose-lowering, anticoagulant, or antiplatelet therapy?", "Family history of premature cardiovascular disease?"],
        labStrategy: [
          { panel: "Advanced Cardiometabolic", vendor: "Boston Heart", purpose: "Clarify ApoB, Lp(a), particle-level risk, and treatment context." },
          { panel: "A1c, fasting glucose and insulin", vendor: "Practice lab catalog", purpose: "Assess glycemic trend and insulin sensitivity." },
        ],
        productCandidates: [
          { name: "Resolve+", brand: "Healthgevity", role: "Inflammation-support candidate" },
          { name: "ProOmega 2000", brand: "Nordic Naturals", role: "Omega-3 candidate after bleeding-risk review" },
          { name: "BergaCore Plus", brand: "Practitioner catalog", role: "Lipid-support candidate" },
        ],
        nutrition: ["Minimally processed, protein- and fiber-aware plan with carbohydrate level individualized to findings and preferences."],
        lifestyle: ["Progressive resistance, aerobic base, balance, sleep, and recovery plan."],
        safetyStops: ["Unassessed chest symptoms", "Medication interaction risk unresolved", "Pregnancy context unresolved", "Acute inflammatory illness confounding hs-CRP"],
      },
    }],
  },
  {
    id: "kp-adrenal",
    code: "adrenal",
    name: "HPA-axis and cortisol rhythm",
    domain: "Endocrine",
    description: "Prevents symptom-only adrenal labels and differentiates anxiety, sleep, stimulant, and measured cortisol patterns.",
    versions: [{
      id: "kp-adrenal-v1", version: 1, status: "approved", changeSummary: "Initial governed pathway",
      createdAt: today, createdBy: "Dr. Brandon Bright", approvedAt: today, approvedBy: "Dr. Brandon Bright",
      sourceRefs: ["Practice-authored adrenal/HPA-axis protocol", "DUTCH collection documentation"],
      content: {
        differentiatingQuestions: ["Is anxiety, panic, agitation, or stimulant sensitivity present?", "Is a timed cortisol pattern available?", "Have anemia, thyroid disease, sleep apnea, medications, and mood conditions been assessed?"],
        labStrategy: [{ panel: "DUTCH Complete", vendor: "Precision Analytical", purpose: "Review diurnal cortisol and hormone metabolites with collection context." }],
        productCandidates: [
          { name: "Adapten-All", brand: "Ortho Molecular Products", role: "Non-glandular candidate when anxiety is present" },
          { name: "Adren-All", brand: "Ortho Molecular Products", role: "Candidate only when anxiety/stimulant sensitivity is absent" },
          { name: "Cortisol Manager", brand: "Integrative Therapeutics", role: "Nighttime pattern candidate only after confirmation" },
        ],
        nutrition: ["Avoid stimulant substitution; create a sustainable morning meal and hydration plan."],
        lifestyle: ["Caffeine reduction, morning light, consistent sleep timing, and workload/recovery review."],
        safetyStops: ["Cortisol pattern inferred from symptoms alone", "Anxiety status unknown", "Medication/hormone timing unknown", "Acute psychiatric or cardiovascular symptoms"],
      },
    }],
  },
  {
    id: "kp-autoimmune",
    code: "autoimmune",
    name: "Autoimmune context and trigger review",
    domain: "Inflammatory / immune",
    description: "Keeps diagnosis, disease activity, specialist care, triggers, gut context, and medication safety distinct.",
    versions: [{
      id: "kp-autoimmune-v1", version: 1, status: "approved", changeSummary: "Initial governed pathway",
      createdAt: today, createdBy: "Dr. Brandon Bright", approvedAt: today, approvedBy: "Dr. Brandon Bright",
      sourceRefs: ["Practice-authored autoimmune protocol", "Cyrex panel documentation"],
      content: {
        differentiatingQuestions: ["What diagnosis is established and by whom?", "Which objective disease-activity measures are followed?", "Any biologic, immunosuppressant, transplant medication, or anticoagulant?"],
        labStrategy: [{ panel: "Autoimmune Reactivity Screen", vendor: "Cyrex Laboratories", purpose: "Adjunct only with a specific question and documented follow-up plan." }],
        productCandidates: [{ name: "Result-directed immune and gut support", brand: "Approved practice catalog", role: "Draft only after diagnosis and medication coordination" }],
        nutrition: ["AIP-pattern trial with defined duration, adequacy review, outcomes, and structured reintroduction."],
        lifestyle: ["Review sleep, infection, stress, activity tolerance, environmental exposure, and specialist plan."],
        safetyStops: ["Immune-modifying medication without specialist coordination", "Symptoms treated as a diagnosis", "Pregnancy context unresolved", "Urgent neurologic or systemic symptoms"],
      },
    }],
  },
  {
    id: "kp-environmental",
    code: "environmental",
    name: "Mold and environmental exposure",
    domain: "Toxicologic / environmental",
    description: "Places exposure assessment and remediation before testing or supportive product drafts.",
    versions: [{
      id: "kp-environmental-v1", version: 1, status: "approved", changeSummary: "Initial governed pathway",
      createdAt: today, createdBy: "Dr. Brandon Bright", approvedAt: today, approvedBy: "Dr. Brandon Bright",
      sourceRefs: ["Practice-authored mold protocol", "Vibrant America Mycotoxins documentation"],
      content: {
        differentiatingQuestions: ["Is active water damage or suspected exposure still present?", "Is there symptom improvement away from the environment?", "What pulmonary, allergic, infectious, neurologic, medication, and sleep explanations were assessed?"],
        labStrategy: [{ panel: "Mycotoxins Panel", vendor: "Vibrant America", purpose: "Use only with exposure context, pre-test counseling, and documented limitations." }],
        productCandidates: [
          { name: "Ultra Binder", brand: "Quicksilver Scientific", role: "Binder candidate after eligibility review" },
          { name: "Biocidin LSF", brand: "Biocidin Botanicals", role: "Botanical candidate after interaction review" },
          { name: "Liver Sauce", brand: "Quicksilver Scientific", role: "Support candidate after exact-label review" },
        ],
        nutrition: ["Support adequate intake and bowel regularity; do not frame food restriction as exposure remediation."],
        lifestyle: ["Document exposure controls, professional assessment, remediation, and referral steps."],
        safetyStops: ["Acute respiratory red flags", "Exposure source not assessed", "Supportive care substituted for remediation", "Product eligibility incomplete"],
      },
    }],
  },
];

const store = createSessionStore<{ pathways: KnowledgePathway[] }>(
  "aidp:demo:clinical-knowledge",
  { pathways: seeds },
);

export function useKnowledgePathways() {
  return store.use().pathways;
}

export function getKnowledgePathways() {
  return store.get().pathways;
}

export function getApprovedPathway(concern: KnowledgeConcern) {
  const pathway = store.get().pathways.find((item) => item.code === concern);
  const version = pathway?.versions.find((item) => item.status === "approved");
  return pathway && version ? { pathway, version } : null;
}

export function duplicateKnowledgeVersion(pathwayId: string) {
  store.update((state) => ({
    pathways: state.pathways.map((pathway) => {
      if (pathway.id !== pathwayId) return pathway;
      const source = pathway.versions.find((version) => version.status === "approved")
        ?? pathway.versions[0];
      if (!source) return pathway;
      const nextVersion = Math.max(...pathway.versions.map((version) => version.version)) + 1;
      return {
        ...pathway,
        versions: [
          {
            ...source,
            id: `${pathway.id}-v${nextVersion}`,
            version: nextVersion,
            status: "draft" as const,
            changeSummary: "Draft copied from the approved version",
            createdAt: new Date().toISOString(),
            createdBy: "Current practitioner",
            approvedAt: undefined,
            approvedBy: undefined,
            content: structuredClone(source.content),
            sourceRefs: [...source.sourceRefs],
          },
          ...pathway.versions,
        ],
      };
    }),
  }));
}

export function updateKnowledgeDraft(
  pathwayId: string,
  versionId: string,
  patch: Partial<Pick<KnowledgePathwayVersion, "changeSummary" | "sourceRefs" | "content">>,
) {
  store.update((state) => ({
    pathways: state.pathways.map((pathway) => pathway.id !== pathwayId ? pathway : {
      ...pathway,
      versions: pathway.versions.map((version) =>
        version.id === versionId && version.status === "draft" ? { ...version, ...patch } : version),
    }),
  }));
}

export function approveKnowledgeVersion(pathwayId: string, versionId: string) {
  store.update((state) => ({
    pathways: state.pathways.map((pathway) => pathway.id !== pathwayId ? pathway : {
      ...pathway,
      versions: pathway.versions.map((version) => {
        if (version.id === versionId && version.status === "draft") {
          return {
            ...version,
            status: "approved" as const,
            approvedAt: new Date().toISOString(),
            approvedBy: "Current administrator",
          };
        }
        if (version.status === "approved") return { ...version, status: "superseded" as const };
        return version;
      }),
    }),
  }));
}

export function resetKnowledgeDemo() {
  store.set({ pathways: seeds });
}
