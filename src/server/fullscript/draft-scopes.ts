/** Fullscript technical reference, checked 2026-10-09. Reviewed provider
 * bindings also retain clinic:read for clinic identity verification. A token
 * granting only clinic:read/write cannot reconcile a supplement draft.
 * https://fullscript.dev/technical-reference/treatment-plans
 * https://fullscript.dev/technical-reference/metadata
 */
export const FULLSCRIPT_DRAFT_SCOPES = Object.freeze([
  'clinic:read', 'clinic:write', 'catalog:read', 'patients:treatment_plan_history',
] as const);
