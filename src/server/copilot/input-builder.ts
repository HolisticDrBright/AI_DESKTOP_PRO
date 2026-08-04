/**
 * Phase 10A — deterministic input builder.
 *
 * SERVER-ONLY. Builds the run's input snapshot from verified sources only.
 * Every field carries its source type, source id, version, date range,
 * completeness, conflict flag, and review state. Unknown stays unknown.
 *
 * Nothing here fabricates a health score, missing observation, causal
 * relationship, probability, diagnosis, interaction, dose, or product fact.
 */
if (typeof window !== "undefined") {
  throw new Error("copilot/input-builder is server-only.");
}

import { createHash } from "node:crypto";
import type { CopilotInputSnapshot } from "./safety";

export type CopilotInputRecord = {
  inputKind:
    | "demographics"
    | "goals"
    | "symptoms"
    | "encounter"
    | "medication"
    | "allergy"
    | "diagnosis"
    | "lab_result"
    | "wearable_observation"
    | "current_protocol"
    | "adherence"
    | "nutrition_plan"
    | "transcript_revision"
    | "differential_answer"
    | "knowledge_reference"
    | "product_label"
    | "protocol_template"
    | "diet_template";
  sourceRefType: string;
  sourceRefId: string;
  sourceVersion: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  completeness: "complete" | "partial" | "missing";
  hasConflict: boolean;
  reviewState: string | null;
};

export function hashInputSnapshot(snapshot: CopilotInputSnapshot, records: CopilotInputRecord[]): string {
  return createHash("sha256")
    .update(JSON.stringify({ snapshot, records }))
    .digest("hex");
}

/**
 * Deterministic empty-snapshot builder — the version this PR ships. Real
 * fetch bodies land in Phase 10B once each source's read RPCs are wired.
 * The safety core still runs on an empty snapshot and produces the correct
 * "missing_*" items so the workspace never displays a false negative.
 */
export function buildEmptySnapshot(): {
  snapshot: CopilotInputSnapshot;
  records: CopilotInputRecord[];
} {
  const snapshot: CopilotInputSnapshot = {
    demographics: {
      ageYears: null,
      sex: null,
      isPregnant: null,
      isLactating: null,
      isPediatric: null,
    },
    medications: [],
    allergies: [],
    labs: [],
    currentProtocols: [],
    transcriptRevisions: [],
    interactionReferences: [],
    restrictedFlagsPresent: [],
    sourceStaleness: {
      lastImportAt: null,
      lastEncounterAt: null,
      lastLabAt: null,
    },
    productLabelsInUse: [],
    dosageMentions: [],
  };
  return { snapshot, records: [] };
}
