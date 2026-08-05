/**
 * Phase 10B.1 — provider request envelope builder (data minimizer).
 *
 * SERVER-ONLY. Given the RLS-scoped input snapshot + the governed
 * retrieval envelope + the run type + the lens, this module produces the
 * minimum-necessary envelope that a provider is allowed to see.
 *
 * The exclusion rules are enforced structurally by whitelisting each field
 * the envelope may carry. Anything not on the whitelist is dropped. Unit
 * tests inject snapshots containing every banned category and assert the
 * envelope hash is unchanged.
 *
 * Never includes:
 *   - names, email addresses, phone numbers, addresses, external ids
 *   - affiliate links, commissions, prices, commercial ranks, promo copy
 *   - unapproved references
 *   - unverified labels
 *   - unapproved protocol templates
 *   - raw files (only extracted structured facts)
 *   - unrelated chart history
 *   - internal audit metadata
 *   - secrets or service-role credentials
 */
if (typeof window !== "undefined") {
  throw new Error("copilot/data-minimizer is server-only.");
}

import { createHash } from "node:crypto";
import type { CopilotInputSnapshot } from "./safety";
import type { GovernedRetrievalEnvelope } from "./retrieval";
import type { CopilotRunType } from "./provider";

export type MinimizedEnvelope = {
  runType: CopilotRunType;
  lens: string;
  ruleSetVersion: string;
  promptVersion: string;
  outputSchemaVersion: string;
  demographics: {
    ageYears: number | null;
    sex: string | null;
    isPregnant: boolean | null;
    isLactating: boolean | null;
    isPediatric: boolean | null;
  };
  activeMedications: Array<{ id: string; name: string; dose: string | null; frequency: string | null }>;
  activeAllergies: Array<{ id: string; severity: string | null }>;
  labs: Array<{ id: string; name: string | null }>;
  currentProtocols: Array<{ id: string }>;
  restrictedFlagsPresent: string[];
  allowedCitationIds: string[];
  envelopeSha256: string;
};

/**
 * Every field name that MAY appear in the outgoing envelope. Any snapshot
 * key not on this whitelist is dropped. This is the structural
 * enforcement point for data-minimization.
 */
const ENVELOPE_WHITELIST = new Set([
  "runType",
  "lens",
  "ruleSetVersion",
  "promptVersion",
  "outputSchemaVersion",
  "demographics",
  "activeMedications",
  "activeAllergies",
  "labs",
  "currentProtocols",
  "restrictedFlagsPresent",
  "allowedCitationIds",
  "envelopeSha256",
] as const);

/**
 * Every field on the ENVELOPE whitelist is one that has been reviewed for
 * clinical necessity + minimum-disclosure. Any new field must be added
 * here AND to `MinimizedEnvelope` AND covered by a unit test.
 */
export function envelopeAllowedFields(): ReadonlySet<string> {
  return ENVELOPE_WHITELIST;
}

/**
 * Build the minimized envelope. Every branch is deterministic; the same
 * input produces the same envelope + hash.
 */
export function buildMinimizedEnvelope(input: {
  runType: CopilotRunType;
  lens: string;
  ruleSetVersion: string;
  promptVersion: string;
  outputSchemaVersion: string;
  snapshot: CopilotInputSnapshot;
  retrieval: GovernedRetrievalEnvelope;
}): MinimizedEnvelope {
  const envelope: Omit<MinimizedEnvelope, "envelopeSha256"> = {
    runType: input.runType,
    lens: input.lens,
    ruleSetVersion: input.ruleSetVersion,
    promptVersion: input.promptVersion,
    outputSchemaVersion: input.outputSchemaVersion,
    demographics: {
      ageYears: input.snapshot.demographics.ageYears,
      sex: input.snapshot.demographics.sex,
      isPregnant: input.snapshot.demographics.isPregnant,
      isLactating: input.snapshot.demographics.isLactating,
      isPediatric: input.snapshot.demographics.isPediatric,
    },
    activeMedications: input.snapshot.medications.map((m) => {
      const r = m as Record<string, unknown>;
      return {
        id: String(r.id ?? ""),
        name: typeof r.name === "string" ? r.name : "",
        dose: typeof r.dose === "string" ? r.dose : null,
        frequency: typeof r.frequency === "string" ? r.frequency : null,
      };
    }),
    activeAllergies: input.snapshot.allergies.map((a) => {
      const r = a as Record<string, unknown>;
      return {
        id: String(r.id ?? ""),
        severity: typeof r.severity === "string" ? r.severity : null,
      };
    }),
    labs: input.snapshot.labs.map((l) => {
      const r = l as Record<string, unknown>;
      return {
        id: String(r.id ?? ""),
        name: typeof r.name === "string" ? r.name : null,
      };
    }),
    currentProtocols: input.snapshot.currentProtocols.map((p) => {
      const r = p as Record<string, unknown>;
      return { id: String(r.id ?? "") };
    }),
    restrictedFlagsPresent: [...(input.snapshot.restrictedFlagsPresent ?? [])],
    allowedCitationIds: [...input.retrieval.allowedCitationIds].sort(),
  };
  const envelopeSha256 = createHash("sha256")
    .update(JSON.stringify(envelope))
    .digest("hex");
  return { ...envelope, envelopeSha256 };
}
