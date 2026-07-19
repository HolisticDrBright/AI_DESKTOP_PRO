/**
 * Care Plan (MOCK): active protocols with review/approval state. Supplement
 * details live in the supplements workspace; nutrition in the Passio-bounded
 * nutrition adapter. Approval flows reuse the shared action/audit layer.
 */
import type { Tone } from "./types";

export interface ProtocolItem {
  label: string;
  detail: string;
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
}

const PLANS: Record<string, CarePlanProtocol[]> = {
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
      items: [
        { label: "Morning outdoor light", detail: "10 min within 1 h of waking" },
        { label: "Magnesium glycinate 300 mg", detail: "Evening, 1 h before bed" },
        { label: "Caffeine cutoff", detail: "None after 12:00 PM" },
        { label: "Wind-down block", detail: "Screens off 30 min before bed" },
      ],
      linkedTemplate: "Sleep & recovery care plan",
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
      items: [
        { label: "Omega-3 (EPA+DHA) 2 g/d", detail: "With the largest meal" },
        { label: "Mediterranean-pattern meals", detail: "See linked meal plan" },
        { label: "Zone-2 movement", detail: "3 × 30 min weekly" },
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
      items: [
        { label: "Post-dinner walk", detail: "20 min, within 30 min of finishing" },
        { label: "Protein anchor at breakfast", detail: "≥ 30 g" },
        { label: "Omega-3 3 g/d", detail: "Split doses" },
      ],
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
      items: [
        { label: "Iron bisglycinate 25 mg", detail: "Alternate-day, away from coffee/tea" },
        { label: "Vitamin C 250 mg", detail: "With each iron dose" },
        { label: "Recheck gate", detail: "Ferritin + CBC before phase 2" },
      ],
      linkedTemplate: "Iron repletion protocol",
    },
  ],
};

export function getCarePlan(patientId: string): CarePlanProtocol[] {
  return PLANS[patientId] ?? [];
}
