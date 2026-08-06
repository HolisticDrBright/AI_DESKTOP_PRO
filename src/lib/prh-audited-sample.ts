/**
 * Phase 9E-B — derive the independently-audited sample from the package
 * manifest.
 *
 * The audited set is NOT inferred from record text. The manifest is the
 * researcher's declared record of the independent verification: every
 * entry in `corrections_applied` names the record it corrected, and
 * `independent_verification.records_audited` declares how many records
 * the audit covered. The derivation is only trusted when the caller has
 * verified the manifest bytes against the SHA-256 stamped on the preview
 * batches — this module checks internal consistency, not authenticity.
 */

export type AuditedSampleResult =
  | { ok: true; auditedIds: string[]; recordsAudited: number }
  | { ok: false; reason: string };

export function deriveAuditedSample(manifestJson: unknown): AuditedSampleResult {
  if (manifestJson === null || typeof manifestJson !== "object" || Array.isArray(manifestJson)) {
    return { ok: false, reason: "manifest_not_object" };
  }
  const m = manifestJson as Record<string, unknown>;

  const iv = m.independent_verification;
  if (!iv || typeof iv !== "object" || Array.isArray(iv)) {
    return { ok: false, reason: "manifest_missing_independent_verification" };
  }
  const performed = (iv as Record<string, unknown>).performed;
  const recordsAudited = (iv as Record<string, unknown>).records_audited;
  if (performed !== true) {
    return { ok: false, reason: "independent_verification_not_performed" };
  }
  if (typeof recordsAudited !== "number" || !Number.isInteger(recordsAudited) || recordsAudited <= 0) {
    return { ok: false, reason: "records_audited_not_declared" };
  }

  const corrections = m.corrections_applied;
  if (!Array.isArray(corrections)) {
    return { ok: false, reason: "manifest_missing_corrections_applied" };
  }

  const ids = new Set<string>();
  for (const entry of corrections) {
    if (typeof entry !== "string") return { ok: false, reason: "correction_entry_not_string" };
    const match = entry.match(/\b(PRH-\d{4})\b/);
    if (!match) return { ok: false, reason: "correction_entry_names_no_record" };
    ids.add(match[1]);
  }

  if (ids.size !== recordsAudited) {
    // The declared audit size and the records the corrections actually
    // name disagree — refuse rather than guess which is right.
    return { ok: false, reason: "audited_count_mismatch" };
  }

  return { ok: true, auditedIds: [...ids].sort(), recordsAudited };
}
