/**
 * Phase 9E-B — Product Research Handoff filter + status vocabulary.
 *
 * Extracted from the panel component so unit tests can import the
 * constants without pulling JSX through the vitest transformer.
 */

export type FilterKey =
  | "source_package"
  | "prh_id"
  | "identity_exact"
  | "identity_probable"
  | "identity_ambiguous"
  | "identity_unmatched"
  | "strong_identifier_present"
  | "strong_identifier_absent"
  | "candidate"
  | "supplement_facts_complete"
  | "missing_facts"
  | "conflicting_fields"
  | "restricted"
  | "evidence_not_archived"
  | "physical_label_required"
  | "commercial_match_pending"
  | "audited_sample";

export const PRH_FILTERS: Array<{ key: FilterKey; label: string }> = [
  { key: "source_package", label: "Source package" },
  { key: "prh_id", label: "Product Research ID" },
  { key: "identity_exact", label: "Identity: exact" },
  { key: "identity_probable", label: "Identity: probable" },
  { key: "identity_ambiguous", label: "Identity: ambiguous" },
  { key: "identity_unmatched", label: "Identity: unmatched" },
  { key: "strong_identifier_present", label: "Strong identifier present" },
  { key: "strong_identifier_absent", label: "Strong identifier absent" },
  { key: "candidate", label: "Label-verification candidate" },
  { key: "supplement_facts_complete", label: "Supplement Facts complete" },
  { key: "missing_facts", label: "Missing facts" },
  { key: "conflicting_fields", label: "Conflicting fields" },
  { key: "restricted", label: "Restricted category" },
  { key: "evidence_not_archived", label: "Evidence not archived" },
  { key: "physical_label_required", label: "Physical-label required" },
  { key: "commercial_match_pending", label: "Commercial match pending" },
  { key: "audited_sample", label: "Independently audited sample" },
];

export const PRH_STATUS_LABELS: Record<
  "previewed" | "unresolved" | "candidate" | "verified" | "approved" | "matched",
  string
> = {
  previewed: "Previewed",
  unresolved: "Unresolved",
  candidate: "Candidate for review",
  verified: "Practitioner verified",
  approved: "Clinically approved",
  matched: "Commercially matched",
};
