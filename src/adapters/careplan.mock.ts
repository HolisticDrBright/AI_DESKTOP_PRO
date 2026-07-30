"use client";

/**
 * Care Plan (MOCK): active protocols with review/approval state. Supplement
 * details live in the supplements workspace; nutrition in the Passio-bounded
 * nutrition adapter. Approval flows reuse the shared action/audit layer.
 */
import type { Tone } from "./types";
import { createSessionStore, newSessionId } from "./session-kv";

export interface ProtocolItem {
  label: string;
  detail: string;
  kind: "supplement" | "nutrition" | "lifestyle" | "monitoring";
  schedule?: string;
  status?: "active" | "planned" | "complete";
}

export interface ProtocolPhase {
  name: string;
  duration: string;
  status: "complete" | "current" | "upcoming";
  objective: string;
}

export interface ProtocolMonitor {
  marker: string;
  baseline: string;
  target: string;
  nextCheck: string;
  status: "on-track" | "due" | "watch";
}

export interface ProtocolSafetyItem {
  label: string;
  detail: string;
  state: "cleared" | "monitor" | "needs-review";
}

export interface CarePlanProtocol {
  id: string;
  name: string;
  phase: string;
  status: "active" | "pending-approval" | "completed";
  tone: Tone;
  adherencePct: number | null;
  startedLabel: string;
  nextReviewLabel: string;
  items: ProtocolItem[];
  linkedTemplate?: string;
  summary: string;
  practitioner: string;
  version: number;
  approvedLabel: string;
  goals: string[];
  phases: ProtocolPhase[];
  monitoring: ProtocolMonitor[];
  safety: ProtocolSafetyItem[];
  successCriteria: string[];
  stopCriteria: string[];
  linkedNutritionPlan?: string;
  linkedLabs: string[];
  history: { date: string; event: string; by: string }[];
}

const SEED_PLANS: Record<string, CarePlanProtocol[]> = {
  "p-78435": [
    {
      id: "cp-sleep2",
      name: "Sleep & recovery protocol",
      phase: "Phase 2 of 3",
      status: "active",
      tone: "positive",
      adherencePct: 84,
      startedLabel: "Jun 24",
      nextReviewLabel: "Aug 5",
      summary: "Improve sleep continuity and autonomic recovery while testing one change at a time.",
      practitioner: "Dr. Sarah Mitchell",
      version: 3,
      approvedLabel: "Approved Jun 24, 2026",
      goals: ["Increase deep sleep toward 80 min/night", "Reduce sleep-onset time below 20 min", "Restore morning energy to 7/10 or better"],
      phases: [
        { name: "Baseline", duration: "2 weeks", status: "complete", objective: "Establish wearable and symptom baselines" },
        { name: "Circadian reset", duration: "6 weeks", status: "current", objective: "Anchor light, caffeine, and wind-down timing" },
        { name: "Consolidation", duration: "4 weeks", status: "upcoming", objective: "Keep only interventions with measurable benefit" },
      ],
      items: [
        { label: "Morning outdoor light", detail: "10 minutes outdoors within 1 hour of waking", kind: "lifestyle", schedule: "Daily · 7:00 AM", status: "active" },
        { label: "Magnesium glycinate 300 mg", detail: "Practitioner-approved product; monitor tolerance", kind: "supplement", schedule: "Daily · 1 hour before bed", status: "active" },
        { label: "Caffeine cutoff", detail: "No caffeine after noon", kind: "nutrition", schedule: "Daily · 12:00 PM", status: "active" },
        { label: "Wind-down block", detail: "Screens off and lights dimmed for 30 minutes", kind: "lifestyle", schedule: "Nightly · 9:30 PM", status: "active" },
      ],
      linkedTemplate: "Sleep & recovery care plan",
      linkedNutritionPlan: "Anti-inflammatory base week",
      linkedLabs: ["AM cortisol · reviewed Jun 20", "25-OH vitamin D · recheck Aug 1"],
      monitoring: [
        { marker: "Deep sleep (30-day average)", baseline: "58 min", target: "≥ 80 min", nextCheck: "Weekly", status: "on-track" },
        { marker: "Sleep onset", baseline: "31 min", target: "< 20 min", nextCheck: "Weekly", status: "on-track" },
        { marker: "25-OH vitamin D", baseline: "24 ng/mL", target: "Practitioner configured", nextCheck: "Aug 1", status: "due" },
      ],
      safety: [
        { label: "Medication interaction review", detail: "No active conflicts found in the recorded medication list", state: "cleared" },
        { label: "Magnesium tolerance", detail: "Monitor GI tolerance and adjust only after practitioner review", state: "monitor" },
        { label: "Missing information", detail: "Confirm current pregnancy/nursing status at next visit", state: "needs-review" },
      ],
      successCriteria: ["Deep sleep improves for 3 consecutive weeks", "Morning energy improves without stimulant escalation", "Patient reports protocol is sustainable"],
      stopCriteria: ["New or worsening adverse effects", "Confusion, fainting, or other urgent symptoms", "Practitioner discontinues or supersedes this version"],
      history: [
        { date: "Jun 24", event: "Version 3 approved and activated", by: "Dr. Sarah Mitchell" },
        { date: "Jun 20", event: "Morning-light intervention added after lab review", by: "Dr. Sarah Mitchell" },
        { date: "Jun 10", event: "Patient baseline submitted", by: "Alexandra Morgan" },
      ],
    },
    {
      id: "cp-inflam",
      name: "Inflammation reduction",
      phase: "Phase 1",
      status: "active",
      tone: "action",
      adherencePct: 78,
      startedLabel: "May 20",
      nextReviewLabel: "Jul 29",
      summary: "Reduce inflammatory burden through food pattern, movement, and monitored omega-3 support.",
      practitioner: "Dr. Sarah Mitchell",
      version: 2,
      approvedLabel: "Approved May 20, 2026",
      goals: ["Improve omega-3 index", "Lower hs-CRP trend", "Maintain a practical Mediterranean-pattern diet"],
      phases: [
        { name: "Foundation", duration: "8 weeks", status: "current", objective: "Establish nutrition, movement, and supplement consistency" },
        { name: "Reassessment", duration: "2 weeks", status: "upcoming", objective: "Review biomarkers and retain only useful interventions" },
      ],
      items: [
        { label: "Omega-3 (EPA+DHA) 2 g/day", detail: "Practitioner-approved product with the largest meal", kind: "supplement", schedule: "Daily · dinner", status: "active" },
        { label: "Mediterranean-pattern meals", detail: "Follow the linked anti-inflammatory meal plan", kind: "nutrition", schedule: "Daily", status: "active" },
        { label: "Zone-2 movement", detail: "Three 30-minute sessions weekly", kind: "lifestyle", schedule: "Mon · Wed · Sat", status: "active" },
      ],
      linkedNutritionPlan: "Anti-inflammatory base week",
      linkedLabs: ["Omega-3 index · 4.8% baseline", "hs-CRP · trending down"],
      monitoring: [
        { marker: "Omega-3 index", baseline: "4.8%", target: "Practitioner configured", nextCheck: "Aug 12", status: "on-track" },
        { marker: "hs-CRP", baseline: "2.8 mg/L", target: "Trend downward", nextCheck: "Aug 12", status: "watch" },
      ],
      safety: [
        { label: "Anticoagulant review", detail: "Recheck if medication list changes", state: "monitor" },
        { label: "Product approval", detail: "Exact product and formulation reviewed", state: "cleared" },
      ],
      successCriteria: ["Biomarker trend improves", "Nutrition adherence remains ≥ 75%", "No treatment-limiting adverse effects"],
      stopCriteria: ["Bleeding concern or new anticoagulant", "New intolerance", "Practitioner supersedes this version"],
      history: [
        { date: "May 20", event: "Version 2 approved", by: "Dr. Sarah Mitchell" },
        { date: "May 18", event: "Nutrition plan linked", by: "Rachel Kim, RD" },
      ],
    },
  ],
  "p-64201": [
    {
      id: "cp-metab",
      name: "Metabolic flexibility protocol",
      phase: "Phase 1 of 2",
      status: "active",
      tone: "action",
      adherencePct: 71,
      startedLabel: "Jul 5",
      nextReviewLabel: "Aug 2",
      summary: "Support glucose stability through meal structure, post-meal movement, and monitored supplementation.",
      practitioner: "Dr. Sarah Mitchell",
      version: 1,
      approvedLabel: "Approved Jul 5, 2026",
      goals: ["Reduce post-meal glucose excursions", "Improve protein consistency", "Build sustainable movement after dinner"],
      phases: [{ name: "Foundation", duration: "8 weeks", status: "current", objective: "Establish consistent daily anchors" }],
      items: [
        { label: "Post-dinner walk", detail: "20 minutes within 30 minutes of finishing", kind: "lifestyle", schedule: "Daily · after dinner", status: "active" },
        { label: "Protein anchor at breakfast", detail: "Target at least 30 g", kind: "nutrition", schedule: "Daily · breakfast", status: "active" },
        { label: "Omega-3 3 g/day", detail: "Split practitioner-approved doses", kind: "supplement", schedule: "Breakfast + dinner", status: "active" },
      ],
      linkedNutritionPlan: "Metabolic foundation",
      linkedLabs: ["HbA1c · reviewed Jul 2", "Fasting insulin · reviewed Jul 2"],
      monitoring: [{ marker: "Post-meal glucose", baseline: "Variable", target: "Practitioner configured", nextCheck: "Weekly", status: "watch" }],
      safety: [{ label: "Medication reconciliation", detail: "Current medication list reviewed Jul 5", state: "cleared" }],
      successCriteria: ["Post-meal trend stabilizes", "Plan adherence remains ≥ 75%"],
      stopCriteria: ["Symptomatic hypoglycemia", "Practitioner discontinues plan"],
      history: [{ date: "Jul 5", event: "Version 1 approved", by: "Dr. Sarah Mitchell" }],
    },
  ],
  "p-59318": [
    {
      id: "cp-iron",
      name: "Iron repletion protocol",
      phase: "Phase 1 (drafted)",
      status: "pending-approval",
      tone: "warning",
      adherencePct: null,
      startedLabel: "Drafted Jul 15",
      nextReviewLabel: "Awaiting practitioner approval",
      summary: "Draft iron-repletion plan generated for practitioner review; nothing is active or patient-facing yet.",
      practitioner: "Unassigned reviewer",
      version: 1,
      approvedLabel: "Not approved",
      goals: ["Confirm cause and appropriateness before treatment", "Restore ferritin safely", "Track CBC response"],
      phases: [
        { name: "Clinical review", duration: "Before start", status: "current", objective: "Resolve safety and missing-information gates" },
        { name: "Repletion", duration: "4 weeks", status: "upcoming", objective: "Begin only after explicit practitioner approval" },
      ],
      items: [
        { label: "Iron bisglycinate 25 mg", detail: "Draft only · alternate-day, away from coffee/tea", kind: "supplement", schedule: "Pending approval", status: "planned" },
        { label: "Vitamin C 250 mg", detail: "Draft only · with each iron dose", kind: "supplement", schedule: "Pending approval", status: "planned" },
        { label: "Recheck gate", detail: "Ferritin + CBC before phase 2", kind: "monitoring", schedule: "Week 4", status: "planned" },
      ],
      linkedTemplate: "Iron repletion protocol",
      linkedLabs: ["Ferritin · 9 ng/mL", "CBC · source reviewed"],
      monitoring: [{ marker: "Ferritin + CBC", baseline: "Ferritin 9 ng/mL", target: "Practitioner configured", nextCheck: "Before phase 2", status: "due" }],
      safety: [
        { label: "Cause not established", detail: "Evaluate source of iron loss before activation", state: "needs-review" },
        { label: "Interaction review", detail: "Medication and supplement timing requires review", state: "needs-review" },
      ],
      successCriteria: ["Practitioner confirms indication", "CBC and ferritin respond without adverse effects"],
      stopCriteria: ["Intolerance", "Unexpected CBC change", "Practitioner rejects draft"],
      history: [{ date: "Jul 15", event: "Draft created from reviewed lab signal", by: "Clinical decision support" }],
    },
  ],
};

export interface ProtocolTemplate {
  id: string;
  name: string;
  category: string;
  description: string;
  builtIn: boolean;
  sourceLabel: string;
  content: Pick<
    CarePlanProtocol,
    | "summary"
    | "goals"
    | "phases"
    | "items"
    | "monitoring"
    | "safety"
    | "successCriteria"
    | "stopCriteria"
    | "linkedNutritionPlan"
    | "linkedLabs"
  >;
}

function templateContent(protocol: CarePlanProtocol): ProtocolTemplate["content"] {
  return {
    summary: protocol.summary,
    goals: [...protocol.goals],
    phases: protocol.phases.map((phase) => ({ ...phase })),
    items: protocol.items.map((item) => ({ ...item })),
    monitoring: protocol.monitoring.map((item) => ({ ...item })),
    safety: protocol.safety.map((item) => ({ ...item })),
    successCriteria: [...protocol.successCriteria],
    stopCriteria: [...protocol.stopCriteria],
    linkedNutritionPlan: protocol.linkedNutritionPlan,
    linkedLabs: [...protocol.linkedLabs],
  };
}

const moldTemplate: ProtocolTemplate = {
  id: "pt-mold-biotoxin",
  name: "Mold / biotoxin support protocol",
  category: "Environmental health",
  description: "A phased, editable structure for exposure review, foundational support, patient-specific interventions, monitoring, and reassessment.",
  builtIn: true,
  sourceLabel: "Practice starter template",
  content: {
    summary: "A staged environmental-health protocol that prioritizes exposure assessment, tolerability, individualized interventions, and objective reassessment.",
    goals: [
      "Clarify current exposure and remediation status",
      "Establish a tolerable foundational routine",
      "Individualize herbs and supplements after medication and safety review",
      "Track symptoms and agreed objective measures over time",
    ],
    phases: [
      { name: "Exposure review", duration: "Patient-specific", status: "current", objective: "Document exposure history, environment, red flags, and remediation plan" },
      { name: "Foundation", duration: "2–4 weeks", status: "upcoming", objective: "Establish hydration, nutrition, elimination, sleep, and tolerability baselines" },
      { name: "Targeted support", duration: "Practitioner configured", status: "upcoming", objective: "Introduce only reviewed patient-specific interventions one change at a time" },
      { name: "Reassessment", duration: "At review gate", status: "upcoming", objective: "Compare symptoms, adherence, safety, and agreed measurements before advancing" },
    ],
    items: [
      { label: "Exposure and remediation plan", detail: "Document active exposure controls and referrals; protocol support does not replace remediation", kind: "lifestyle", schedule: "Review at each phase", status: "planned" },
      { label: "Hydration and bowel regularity", detail: "Patient-specific foundation and tolerance tracking", kind: "nutrition", schedule: "Daily", status: "planned" },
      { label: "Binder — select product", detail: "Placeholder only; choose exact product, timing, and dose after medication and contraindication review", kind: "supplement", schedule: "Practitioner configured", status: "planned" },
      { label: "Antioxidant support — select product", detail: "Placeholder for an approved patient-specific product and rationale", kind: "supplement", schedule: "Practitioner configured", status: "planned" },
      { label: "Herbal support — select formula", detail: "Placeholder for reviewed herbs; document ingredients, interactions, dose, and stop criteria", kind: "supplement", schedule: "Practitioner configured", status: "planned" },
    ],
    monitoring: [
      { marker: "Symptom and tolerance check-in", baseline: "Record before start", target: "Individualized", nextCheck: "Weekly during changes", status: "due" },
      { marker: "Medication and supplement reconciliation", baseline: "Confirm current list", target: "No unresolved interactions", nextCheck: "Before activation", status: "due" },
      { marker: "Environment / remediation status", baseline: "Document", target: "Exposure plan established", nextCheck: "Each phase", status: "watch" },
    ],
    safety: [
      { label: "Medical red-flag review", detail: "Escalate urgent, severe, or unexplained symptoms for appropriate medical evaluation", state: "needs-review" },
      { label: "Medication and interaction review", detail: "Required before activating binders, herbs, or supplements", state: "needs-review" },
      { label: "Pregnancy, nursing, and pediatric status", detail: "Confirm before selecting any intervention", state: "needs-review" },
      { label: "Exposure source", detail: "Supportive care must not be presented as a substitute for addressing ongoing exposure", state: "monitor" },
    ],
    successCriteria: [
      "Patient can follow the plan without treatment-limiting effects",
      "Exposure and remediation actions are documented",
      "Symptoms and agreed measures move in a favorable direction",
      "Only interventions with a clear rationale are retained",
    ],
    stopCriteria: [
      "New or worsening adverse effects",
      "Severe constipation, dehydration, medication interference, or intolerance",
      "Urgent symptoms or a new finding requiring medical evaluation",
      "Practitioner pauses, replaces, or supersedes this protocol version",
    ],
    linkedNutritionPlan: "Choose or create a patient-specific nutrition plan",
    linkedLabs: ["Add reviewed laboratory sources and dates"],
  },
};

const BUILT_IN_PROTOCOL_TEMPLATES: ProtocolTemplate[] = [
  moldTemplate,
  {
    id: "pt-sleep-recovery",
    name: "Sleep & recovery protocol",
    category: "Sleep",
    description: "Circadian anchors, sleep routine, monitored supplementation, and wearable review gates.",
    builtIn: true,
    sourceLabel: "Derived from an approved practice protocol",
    content: templateContent(SEED_PLANS["p-78435"][0]),
  },
  {
    id: "pt-metabolic-foundation",
    name: "Metabolic foundation protocol",
    category: "Metabolic",
    description: "Meal structure, post-meal movement, patient-specific supplements, and glucose monitoring.",
    builtIn: true,
    sourceLabel: "Practice starter template",
    content: templateContent(SEED_PLANS["p-64201"][0]),
  },
  {
    id: "pt-iron-repletion",
    name: "Iron repletion protocol",
    category: "Nutrient repletion",
    description: "Review-gated repletion structure with cause assessment and laboratory recheck gates.",
    builtIn: true,
    sourceLabel: "Practice starter template",
    content: templateContent(SEED_PLANS["p-59318"][0]),
  },
];

interface CarePlanSessionState {
  protocols: Record<string, CarePlanProtocol>;
  customTemplates: ProtocolTemplate[];
}

const store = createSessionStore<CarePlanSessionState>("aidp:demo:care-plan", {
  protocols: {},
  customTemplates: [],
});

function mergePlans(patientId: string, state: CarePlanSessionState): CarePlanProtocol[] {
  const seeded = (SEED_PLANS[patientId] ?? []).map((protocol) => state.protocols[protocol.id] ?? protocol);
  const seededIds = new Set(seeded.map((protocol) => protocol.id));
  const created = Object.values(state.protocols).filter(
    (protocol) => protocol.id.startsWith(`${patientId}:`) && !seededIds.has(protocol.id),
  );
  return [...created, ...seeded];
}

export function getCarePlan(patientId: string): CarePlanProtocol[] {
  return mergePlans(patientId, store.get());
}

export function useCarePlan(patientId: string): CarePlanProtocol[] {
  return mergePlans(patientId, store.use());
}

export function useProtocolTemplates(): ProtocolTemplate[] {
  return [...store.use().customTemplates, ...BUILT_IN_PROTOCOL_TEMPLATES];
}

export function createProtocolFromTemplate(patientId: string, templateId: string): CarePlanProtocol | null {
  const template = [...store.get().customTemplates, ...BUILT_IN_PROTOCOL_TEMPLATES].find((item) => item.id === templateId);
  if (!template) return null;
  const protocol: CarePlanProtocol = {
    id: `${patientId}:${newSessionId()}`,
    name: template.name,
    phase: template.content.phases[0]?.name ?? "Draft",
    status: "pending-approval",
    tone: "warning",
    adherencePct: null,
    startedLabel: "Drafted this session",
    nextReviewLabel: "Set review date",
    linkedTemplate: template.name,
    practitioner: "Dr. Sarah Mitchell",
    version: 1,
    approvedLabel: "Not approved",
    history: [{ date: "Today", event: `Draft created from ${template.name}`, by: "Dr. Sarah Mitchell" }],
    ...templateContent({
      id: "template",
      name: template.name,
      phase: "Draft",
      status: "pending-approval",
      tone: "warning",
      adherencePct: null,
      startedLabel: "",
      nextReviewLabel: "",
      practitioner: "",
      version: 1,
      approvedLabel: "",
      history: [],
      ...template.content,
    }),
  };
  store.update((state) => ({ ...state, protocols: { ...state.protocols, [protocol.id]: protocol } }));
  return protocol;
}

export function createBlankProtocol(patientId: string): CarePlanProtocol {
  const protocol: CarePlanProtocol = {
    id: `${patientId}:${newSessionId()}`,
    name: "Untitled protocol",
    phase: "Draft",
    status: "pending-approval",
    tone: "warning",
    adherencePct: null,
    startedLabel: "Drafted this session",
    nextReviewLabel: "Set review date",
    items: [],
    summary: "",
    practitioner: "Dr. Sarah Mitchell",
    version: 1,
    approvedLabel: "Not approved",
    goals: [],
    phases: [{ name: "Foundation", duration: "Practitioner configured", status: "current", objective: "Define the first phase objective" }],
    monitoring: [],
    safety: [{ label: "Safety review", detail: "Complete before approval", state: "needs-review" }],
    successCriteria: [],
    stopCriteria: [],
    linkedLabs: [],
    history: [{ date: "Today", event: "Blank protocol draft created", by: "Dr. Sarah Mitchell" }],
  };
  store.update((state) => ({ ...state, protocols: { ...state.protocols, [protocol.id]: protocol } }));
  return protocol;
}

export function saveProtocol(protocol: CarePlanProtocol): CarePlanProtocol {
  const current = store.get().protocols[protocol.id]
    ?? Object.values(SEED_PLANS).flat().find((item) => item.id === protocol.id);
  const next: CarePlanProtocol = {
    ...protocol,
    status: "pending-approval",
    tone: "warning",
    approvedLabel: "Not approved",
    version: current && current.status !== "pending-approval" ? current.version + 1 : protocol.version,
    history: [
      { date: "Today", event: current && current.status !== "pending-approval" ? "New draft version created" : "Draft updated", by: "Dr. Sarah Mitchell" },
      ...protocol.history,
    ],
  };
  store.update((state) => ({ ...state, protocols: { ...state.protocols, [next.id]: next } }));
  return next;
}

export interface CopilotProtocolDraftInput {
  name: string;
  summary: string;
  products: { label: string; detail: string }[];
  nutritionDraft?: string;
  lifestyleDrafts: string[];
  labs: { name: string; rationale: string }[];
  safetyBlocks: string[];
  missingInformation: string[];
  knowledgeVersion: string;
}

/**
 * Creates a review-gated patient protocol from an explicitly reviewed copilot
 * result. Only products whose current labels were separately verified by the
 * practitioner should be supplied in `products`.
 */
export function createProtocolFromCopilot(
  patientId: string,
  input: CopilotProtocolDraftInput,
): CarePlanProtocol {
  const protocol: CarePlanProtocol = {
    id: `${patientId}:${newSessionId()}`,
    name: input.name,
    phase: "Clinical review",
    status: "pending-approval",
    tone: "warning",
    adherencePct: null,
    startedLabel: "Drafted this session",
    nextReviewLabel: "Awaiting practitioner approval",
    summary: input.summary,
    practitioner: "Dr. Sarah Mitchell",
    version: 1,
    approvedLabel: "Not approved",
    goals: ["Confirm the clinical indication", "Resolve safety and missing-information gates", "Define measurable outcomes before activation"],
    phases: [
      { name: "Clinical review", duration: "Before activation", status: "current", objective: "Verify indication, exact products, interactions, monitoring, and patient instructions" },
      { name: "Foundation", duration: "Practitioner configured", status: "upcoming", objective: "Begin only the approved interventions, using one-change-at-a-time sequencing when appropriate" },
      { name: "Reassessment", duration: "At review gate", status: "upcoming", objective: "Compare outcomes, adherence, adverse effects, and objective data" },
    ],
    items: [
      ...input.products.map((item) => ({
        label: item.label,
        detail: item.detail,
        kind: "supplement" as const,
        schedule: "Dose and timing require practitioner entry",
        status: "planned" as const,
      })),
      ...(input.nutritionDraft ? [{
        label: "Nutrition plan draft",
        detail: input.nutritionDraft,
        kind: "nutrition" as const,
        schedule: "Practitioner configured",
        status: "planned" as const,
      }] : []),
      ...input.lifestyleDrafts.map((detail) => ({
        label: "Lifestyle intervention draft",
        detail,
        kind: "lifestyle" as const,
        schedule: "Practitioner configured",
        status: "planned" as const,
      })),
    ],
    monitoring: input.labs.map((lab) => ({
      marker: lab.name,
      baseline: "Not established",
      target: "Practitioner configured",
      nextCheck: "Review order/result status",
      status: "due" as const,
    })),
    safety: [
      ...input.safetyBlocks.map((detail) => ({ label: "Safety block", detail, state: "needs-review" as const })),
      ...input.missingInformation.map((detail) => ({ label: "Missing information", detail, state: "needs-review" as const })),
      { label: "Exact product labels", detail: "Included products were marked label-verified in the copilot, but dose, timing, contraindications, and interactions still require protocol approval.", state: "needs-review" },
    ],
    successCriteria: ["Practitioner defines patient-specific outcomes", "No unresolved safety issues", "Adherence and tolerance are reviewed at follow-up"],
    stopCriteria: ["New or worsening adverse effects", "A safety block or clinically important contradiction emerges", "Practitioner rejects or supersedes this draft"],
    linkedNutritionPlan: input.nutritionDraft,
    linkedLabs: input.labs.map((lab) => `${lab.name} · ${lab.rationale}`),
    history: [
      { date: "Today", event: `Draft created from governed copilot · ${input.knowledgeVersion}`, by: "Clinical decision support" },
    ],
  };
  store.update((state) => ({ ...state, protocols: { ...state.protocols, [protocol.id]: protocol } }));
  return protocol;
}

export function saveProtocolAsTemplate(protocol: CarePlanProtocol, name: string, description: string): ProtocolTemplate {
  const template: ProtocolTemplate = {
    id: newSessionId(),
    name,
    category: "Practice template",
    description,
    builtIn: false,
    sourceLabel: `Saved from ${protocol.name} v${protocol.version}`,
    content: templateContent(protocol),
  };
  store.update((state) => ({ ...state, customTemplates: [template, ...state.customTemplates] }));
  return template;
}
