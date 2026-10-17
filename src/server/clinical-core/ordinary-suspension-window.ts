import type { DesktopCompatibilityRequest } from "./aws-desktop-compatibility";

/**
 * The ordinary-suspension window (BLOCKED source candidate workforce-ordinary-suspension-window.sql).
 *
 * The owner's rule: when a clinic is suspended (not compromised), a practitioner session already valid at the
 * suspension may continue only until that token's own expiry, a refreshed or new token does not inherit it, and nothing
 * extends it. The database applies the rule; this module only carries its evidence there:
 *   - the verified ID token's `iat` and `exp`, read from the API Gateway JWT authorizer's verified claims, never from a
 *     header, body or the browser;
 *   - whether the operation reads or writes, from a fixed list (a read is a STABLE function with no write or lock).
 *
 * `blocked` (the default): the services keep calling the seven-argument entry, exactly as deployed. `qualification`
 * calls the ten-argument entry, which exists only once the candidate is applied. Moving it is Codex work after review.
 */
export const ORDINARY_SUSPENSION_WINDOW_RELEASE: "blocked" | "qualification" = "blocked";
export const ORDINARY_SUSPENSION_WINDOW_SHA256 = "94b25a4a7557f4256e6b678c8d338160afcf98371787aadd90a88c2154b3f90b";
export const ORDINARY_SUSPENSION_WINDOW_ROLLBACK_SHA256 = "efd8665c81b90599913074721818b6cbdc6c45fc47df54318da1c6cb51184466";
/** prosrc SHA-256 the candidate pins: the seven- and ten-argument entries and the private admission function. */
export const ORDINARY_SUSPENSION_WINDOW_PROSRC = {
  seven: "359837b0d0f46046fae4ea842ddef0b02d9cb284294ac76b30bc442c126370d1",
  ten: "f1f07d424d6f1b2da2fbf3a381b3e0eba90a13f24712bacb753ccb4cecf2933d",
  admit: "8ccbfd1375c1e11ce1205140219fc56ccfbf87da186d905b991e418f94252b32",
  parent: "3ee98d29830ee366a1c670c236cbf018b710eb7dbbc48d3ee090e7d66c36097b",
} as const;

export type TokenWindow = { issuedAt: number; expiresAt: number };

/**
 * The verified token's `iat` and `exp` (NumericDate seconds; the authorizer delivers claims as strings or numbers), or
 * null when either is missing or malformed. The bounds are the database's own: a lifetime of 5 minutes to 1 day. The
 * database checks them again with its own clock; nothing here is trusted for the decision.
 */
export function tokenWindowFromClaims(claims: Record<string, unknown> | undefined): TokenWindow | null {
  const seconds = (value: unknown) => {
    const text = typeof value === "number" ? String(value) : typeof value === "string" ? value : "";
    return /^[1-9][0-9]{0,11}$/.test(text) ? Number(text) : null;
  };
  const issuedAt = seconds(claims?.iat), expiresAt = seconds(claims?.exp);
  if (issuedAt === null || expiresAt === null || expiresAt <= issuedAt || expiresAt - issuedAt < 300 || expiresAt - issuedAt > 86_400) return null;
  return { issuedAt, expiresAt };
}

/**
 * The production Desktop operations that only read: each maps to one STABLE SQL function with no write and no row lock
 * (pinned against the schema by ordinary-suspension-window.database.test.ts), or to a table read. Everything else is a
 * write. In a suspended clinic a read is admitted read-only within the window; a write is held.
 */
export const PRODUCTION_DESKTOP_READ_RPCS: ReadonlySet<string> = new Set([
  "check_protocol_interactions", "compare_protocol_template_versions", "get_desktop_calendar", "get_desktop_encounter",
  "get_desktop_lens_evaluation", "get_desktop_note", "get_desktop_patient_timeline", "get_knowledge_import_preview",
  "get_patient_app_intake", "get_patient_overview", "get_patient_protocol", "get_patient_relationships",
  "get_product_catalog", "get_product_label_detail", "get_protocol_template_detail", "get_reasoning_workspace",
  "get_research_handoff_review", "list_audit_events", "list_desktop_lens_domains", "list_desktop_lens_knowledge_sources",
  "list_desktop_lens_paradigms", "list_desktop_patient_encounters", "list_desktop_question_answers",
  "list_label_commercial_links", "list_my_organizations", "list_org_members", "list_patient_lab_observations",
  "list_protocol_commercial_links", "list_protocol_templates", "list_review_queue", "search_protocol_catalog",
]);

export function productionDesktopAccess(request: DesktopCompatibilityRequest): "read" | "write" {
  if (request.kind === "select") return "read";
  return PRODUCTION_DESKTOP_READ_RPCS.has(request.functionName) ? "read" : "write";
}
