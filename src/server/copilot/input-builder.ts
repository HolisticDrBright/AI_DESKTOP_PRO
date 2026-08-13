/**
 * Phase 10A — deterministic input builder.
 *
 * SERVER-ONLY. Builds the run's input snapshot from RLS-scoped verified
 * clinical sources — never from a commercial table, never from an unreviewed
 * label, never from a demo row. Unknown stays unknown; the safety core
 * interprets null as "missing" and fires the correct `missing_*` items.
 *
 * The real fetch calls the SECURITY DEFINER RPC `build_copilot_input_snapshot`
 * which itself re-checks auth + org membership + patient-belongs-to-org under
 * an empty search_path. Nothing here fabricates a health score, missing
 * observation, causal relationship, probability, diagnosis, interaction,
 * dose, or product fact.
 */
if (typeof window !== "undefined") {
  throw new Error("copilot/input-builder is server-only.");
}

import { createHash } from "node:crypto";
import { clinicalRpc } from "@/adapters/supabase-rest.server";
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

export type CopilotInputBundle = {
  snapshot: CopilotInputSnapshot;
  records: CopilotInputRecord[];
};

export function hashInputSnapshot(snapshot: CopilotInputSnapshot, records: CopilotInputRecord[]): string {
  return createHash("sha256")
    .update(JSON.stringify({ snapshot, records }))
    .digest("hex");
}

/**
 * Deterministic empty snapshot — retained for tests that exercise the safety
 * core without a network hop, and for the disabled-provider path when the
 * caller has already refused any external read.
 */
export function buildEmptySnapshot(): CopilotInputBundle {
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

type RpcCaller = <T>(fn: string, args: Record<string, unknown>, token?: string | null) => Promise<T>;

/**
 * Real patient-scoped input builder — invokes the RLS-scoped SECURITY DEFINER
 * RPC `build_copilot_input_snapshot`. On current staging every clinical
 * patient table is empty for this org, so the snapshot arrays come back
 * empty honestly — but the queries ran, and demographics are read from the
 * actual patient row (age from date_of_birth, sex from the patient_profiles
 * column). Never falls back to `buildEmptySnapshot()` on error — a failed
 * fetch is a failed run.
 *
 * `_call` is injected so unit tests can validate the request shape without
 * a network. The default is the real `clinicalRpc`.
 */
export async function buildPatientSnapshot(
  input: {
    organizationId: string;
    patientId: string;
    accessToken: string | null;
  },
  _call: RpcCaller = clinicalRpc,
): Promise<CopilotInputBundle> {
  if (!input.organizationId) throw new Error("organizationId is required.");
  if (!input.patientId) throw new Error("patientId is required.");
  const raw = await _call<{ snapshot: CopilotInputSnapshot; records: CopilotInputRecord[] }>(
    "build_copilot_input_snapshot",
    {
      _organization_id: input.organizationId,
      _patient_id: input.patientId,
    },
    input.accessToken,
  );
  if (!raw || typeof raw !== "object" || !("snapshot" in raw) || !("records" in raw)) {
    throw new Error("build_copilot_input_snapshot returned an unexpected shape.");
  }
  return { snapshot: raw.snapshot, records: raw.records ?? [] };
}
