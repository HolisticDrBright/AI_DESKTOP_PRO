/**
 * One switch that stops every model call.
 *
 * The right to send anything to the model vendor rests on two things that can end independently: the executed agreement
 * itself, and the separate provisioning act that turns off the vendor's default retention. Either can be revoked on a
 * day nobody is deploying, and on that day the correct behaviour is that no request leaves at all — not that a flag is
 * edited in a template and released hours later. So the authority to call travels with the credential: it is recorded
 * beside the key in the vendor secret, it is read on every call because no path caches the key, and revoking it is a
 * secret write that the next call already sees. There is no way to obtain the key without passing this gate.
 *
 * Fail-closed, in both directions: a recorded authority that is not active refuses regardless of anything else, and a
 * secret carrying no authority record at all may only be used while protected information is disabled, because then no
 * protected information can be in the request and the agreement is not what is permitting it.
 */
export const MODEL_VENDOR_AUTHORITY_RECORD = "model-vendor-authority/1" as const;

/** The field the vendor secret carries it in, beside the key it governs. */
export const MODEL_VENDOR_AUTHORITY_FIELD = "authority" as const;

export const MODEL_VENDOR_AUTHORITY_STATES = ["active", "suspended", "terminated"] as const;
export type ModelVendorAuthorityState = (typeof MODEL_VENDOR_AUTHORITY_STATES)[number];

/** Vendor-default retention is the absence of the modified term, so it is named rather than left to a missing field. */
export const MODEL_VENDOR_RETENTION_MODES = ["modified_zero_retention", "vendor_default"] as const;
export type ModelVendorRetentionMode = (typeof MODEL_VENDOR_RETENTION_MODES)[number];

export type ModelVendorAuthority = {
  record: typeof MODEL_VENDOR_AUTHORITY_RECORD;
  state: ModelVendorAuthorityState;
  retention: ModelVendorRetentionMode;
  /** Reference to the executed agreement this authority rests on. Never the agreement text. */
  agreement: string;
  /** The day the recorded state took effect. A future day is not yet in force. */
  effectiveAt: string;
};

export type ModelVendorAuthorityCategory =
  | "model_vendor_authority_malformed"
  | "model_vendor_authority_missing"
  | "model_vendor_authority_withdrawn"
  | "model_vendor_authority_not_in_force"
  | "model_vendor_retention_unconfirmed";

export class ModelVendorAuthorityRefusal extends Error {
  readonly category: ModelVendorAuthorityCategory;
  constructor(category: ModelVendorAuthorityCategory) {
    super(category);
    this.name = "ModelVendorAuthorityRefusal";
    this.category = category;
  }
}

const AGREEMENT = /^[A-Za-z0-9_:./-]{3,120}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Strict: an authority record that cannot be read is an authority that does not exist. */
export function parseModelVendorAuthority(value: unknown): ModelVendorAuthority {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ModelVendorAuthorityRefusal("model_vendor_authority_malformed");
  const row = value as Record<string, unknown>;
  const allowed = new Set(["record", "state", "retention", "agreement", "effectiveAt"]);
  if (Object.keys(row).some((key) => !allowed.has(key))) throw new ModelVendorAuthorityRefusal("model_vendor_authority_malformed");
  if (row.record !== MODEL_VENDOR_AUTHORITY_RECORD
    || typeof row.state !== "string" || !(MODEL_VENDOR_AUTHORITY_STATES as readonly string[]).includes(row.state)
    || typeof row.retention !== "string" || !(MODEL_VENDOR_RETENTION_MODES as readonly string[]).includes(row.retention)
    || typeof row.agreement !== "string" || !AGREEMENT.test(row.agreement)
    || typeof row.effectiveAt !== "string" || !DAY.test(row.effectiveAt) || !Number.isFinite(Date.parse(row.effectiveAt))) {
    throw new ModelVendorAuthorityRefusal("model_vendor_authority_malformed");
  }
  return {
    record: MODEL_VENDOR_AUTHORITY_RECORD,
    state: row.state as ModelVendorAuthorityState,
    retention: row.retention as ModelVendorRetentionMode,
    agreement: row.agreement,
    effectiveAt: row.effectiveAt,
  };
}

/** Throws unless a model call may be sent right now. Callers need no branch of their own. */
export function assertModelCallsPermitted(input: {
  authority: ModelVendorAuthority | null;
  phiAllowed: boolean;
  today?: string;
}): void {
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  if (!input.authority) {
    // No record: permitted only where no protected information can be in the request.
    if (input.phiAllowed) throw new ModelVendorAuthorityRefusal("model_vendor_authority_missing");
    return;
  }
  if (input.authority.state !== "active") throw new ModelVendorAuthorityRefusal("model_vendor_authority_withdrawn");
  if (input.authority.effectiveAt > today) throw new ModelVendorAuthorityRefusal("model_vendor_authority_not_in_force");
  if (input.phiAllowed && input.authority.retention !== "modified_zero_retention") {
    throw new ModelVendorAuthorityRefusal("model_vendor_retention_unconfirmed");
  }
}

/** The deployment's own answer, read at call time so a change needs no release. */
export function phiAllowedFromEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PHI_ALLOWED === "true";
}
