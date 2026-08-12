/**
 * Phase 10B.2 — the bounded synthetic staging gate.
 *
 * SERVER-ONLY. This is the last thing that runs before a real external
 * request could be made, and its job is to refuse.
 *
 * WHY A SECOND GATE, WHEN THE DATABASE ALREADY HAS ONE.
 * `evaluate_copilot_staging_gate` is the authority on the governed
 * records: it reads the registry, the activation row, the attestation, and
 * the budget under RLS, and no application code can talk it out of a
 * refusal. But three of this phase's conditions are not facts about rows:
 *
 *   - the PROCESS must be pointed at the staging project, which the
 *     database cannot see (it only knows it was asked);
 *   - the OUTBOUND ENVELOPE must carry no direct identifiers, which is a
 *     property of a payload that exists only in this process;
 *   - the KILL SWITCH must have been exercised recently enough to be known
 *     working, which is a property of an operator drill, not of a row.
 *
 * So the order is: database verdict FIRST (it is the authority), then the
 * three process-side checks, then reservation. Every refusal is a PHI-safe
 * category. Nothing here resolves a secret or opens a socket; both happen
 * strictly after `evaluateStagingGate` returns `allowed`.
 */
if (typeof window !== "undefined") {
  throw new Error("copilot/staging-gate is server-only.");
}

import type { MinimizedEnvelope } from "./data-minimizer";
import { resolveGovernedModel } from "./model-allowlist";

/** The staging Supabase project. Named, so "some backend" cannot pass. */
export const STAGING_PROJECT_REF = "urcjiehlxoehievobezf";

/**
 * How recently the kill switch must have been exercised for a live run to
 * be authorized. A control nobody has pulled is a control nobody knows
 * works.
 */
export const KILL_SWITCH_DRILL_MAX_AGE_MS = 30 * 60_000;

export type StagingGateRefusal =
  // process-side
  | "posture_not_staging_project"
  | "backend_not_configured"
  | "envelope_carries_direct_identifier"
  | "kill_switch_not_recently_tested"
  | "model_not_governed"
  // mirrored from the database verdict
  | "governed_records_refused";

export type DatabaseGateVerdict = {
  allowed: boolean;
  refusal: string | null;
  gates: Array<{ gate: string; pass: boolean }>;
  environment: string | null;
  approvedUse: string | null;
  approvedModel: string | null;
  killSwitchEngaged: boolean;
  callsRemaining: number;
  tokensRemaining: number;
  costCentsRemaining: number;
};

export type StagingGateInput = {
  /** The verdict from `evaluate_copilot_staging_gate`. The authority. */
  database: DatabaseGateVerdict;
  /** `CLINICAL_SUPABASE_URL` for this process. */
  backendUrl: string | null | undefined;
  /** The exact model identifier the run intends to send. */
  model: string;
  /** The payload that would actually go out. */
  envelope: MinimizedEnvelope;
  /** When the kill switch was last engaged AND released, epoch ms. */
  killSwitchLastTestedAt: number | null;
  now?: number;
};

export type StagingGateVerdict =
  | { allowed: true; detail: string }
  | { allowed: false; refusal: StagingGateRefusal; detail: string };

/**
 * Fields whose PRESENCE in an outbound envelope means a direct identifier
 * escaped the minimizer. The minimizer whitelists, so this should be
 * unreachable — which is the reason to check it here rather than trust it.
 * A whitelist and a blacklist disagreeing is a bug worth catching before
 * the bytes leave the process, not after.
 */
const DIRECT_IDENTIFIER_KEYS = [
  "firstName", "lastName", "name", "fullName", "email", "phone", "address",
  "mrn", "dateOfBirth", "dob", "ssn", "patientId", "userId", "externalId",
];

/** Values that look like a direct identifier regardless of their key. */
const DIRECT_IDENTIFIER_PATTERNS: Array<[string, RegExp]> = [
  ["email address", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ["us phone number", /\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/],
  ["us ssn", /\b\d{3}-\d{2}-\d{4}\b/],
  ["full date of birth", /\b(19|20)\d{2}-\d{2}-\d{2}\b/],
];

export function findDirectIdentifiers(envelope: MinimizedEnvelope): string[] {
  const found: string[] = [];
  const serialized = JSON.stringify(envelope);
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (DIRECT_IDENTIFIER_KEYS.includes(k)) found.push(`key:${k}`);
        walk(v);
      }
    }
  };
  walk(envelope);
  for (const [label, pattern] of DIRECT_IDENTIFIER_PATTERNS) {
    if (pattern.test(serialized)) found.push(`value:${label}`);
  }
  return [...new Set(found)];
}

export function evaluateStagingGate(input: StagingGateInput): StagingGateVerdict {
  const now = input.now ?? Date.now();

  // 1. The governed records are the authority and are consulted first. If
  //    they refuse, nothing this process believes can override it.
  if (!input.database.allowed) {
    return {
      allowed: false,
      refusal: "governed_records_refused",
      detail: `The governed records refused at gate "${input.database.refusal ?? "unknown"}".`,
    };
  }

  // 2. The process must be pointed at the staging project. The database
  //    cannot verify this: it only knows it was asked, not by whom.
  const backend = String(input.backendUrl ?? "").trim();
  if (!backend) {
    return {
      allowed: false,
      refusal: "backend_not_configured",
      detail: "No clinical backend is configured for this process.",
    };
  }
  let host: string;
  try {
    host = new URL(backend).hostname.toLowerCase();
  } catch {
    return {
      allowed: false,
      refusal: "backend_not_configured",
      detail: "The configured clinical backend URL is not a valid URL.",
    };
  }
  if (!host.includes(STAGING_PROJECT_REF)) {
    return {
      allowed: false,
      refusal: "posture_not_staging_project",
      detail:
        "This process is not pointed at the synthetic staging project. " +
        "A bounded external verification runs against staging or not at all.",
    };
  }

  // 3. The model must be governed here as well as approved there. The
  //    activation row could name a model this build cannot price or
  //    parameterise correctly.
  if (!resolveGovernedModel(input.model).ok) {
    return {
      allowed: false,
      refusal: "model_not_governed",
      detail: "The approved model is not on this build's governed allowlist.",
    };
  }

  // 4. The bytes that would actually go out carry no direct identifier.
  const leaks = findDirectIdentifiers(input.envelope);
  if (leaks.length > 0) {
    return {
      allowed: false,
      refusal: "envelope_carries_direct_identifier",
      // The categories are named; the values never are.
      detail: `The outbound envelope carries ${leaks.length} direct-identifier signal(s): ${leaks.join(", ")}.`,
    };
  }

  // 5. The kill switch must be known working, not merely present.
  if (
    input.killSwitchLastTestedAt == null ||
    now - input.killSwitchLastTestedAt > KILL_SWITCH_DRILL_MAX_AGE_MS
  ) {
    return {
      allowed: false,
      refusal: "kill_switch_not_recently_tested",
      detail:
        "The kill switch has not been exercised within the required window. " +
        "Engage and release it, then retry.",
    };
  }

  return {
    allowed: true,
    detail:
      "Bounded synthetic staging verification is authorized: governed records, " +
      "staging posture, minimized envelope, governed model, and a tested kill switch.",
  };
}
