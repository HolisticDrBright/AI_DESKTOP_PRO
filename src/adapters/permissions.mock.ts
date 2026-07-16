/**
 * MOCK role/permission matrix — the INTENDED policy, mirrored by the
 * database-layer enforcement (org membership roles + RLS write gates; see
 * supabase/migrations 0001/0002/0012). Shaped like a future
 * `api.permissions.getMatrix` tRPC query. This screen documents policy; the
 * backend enforces it.
 */

export type RoleId =
  | "owner"
  | "admin"
  | "practitioner"
  | "health-coach"
  | "dietitian"
  | "billing"
  | "reviewer";

export interface RoleDef {
  id: RoleId;
  label: string;
  note: string;
}

export const ROLES: RoleDef[] = [
  { id: "owner", label: "Owner", note: "Full control incl. org settings" },
  { id: "admin", label: "Admin", note: "Practice administration" },
  { id: "practitioner", label: "Practitioner", note: "Clinical care, assigned patients" },
  { id: "health-coach", label: "Health coach", note: "Care-team read lane when assigned" },
  { id: "dietitian", label: "Dietitian", note: "Care-team read lane when assigned" },
  { id: "billing", label: "Billing", note: "Financial surfaces only" },
  { id: "reviewer", label: "Read-only reviewer", note: "Audit/QA access, no writes" },
];

export interface CapabilityRow {
  capability: string;
  grants: Record<RoleId, boolean>;
  note?: string;
}

const g = (
  owner: boolean, admin: boolean, practitioner: boolean, coach: boolean,
  dietitian: boolean, billing: boolean, reviewer: boolean,
): Record<RoleId, boolean> => ({
  owner, admin, practitioner, "health-coach": coach, dietitian, billing, reviewer,
});

export const CAPABILITIES: CapabilityRow[] = [
  { capability: "View patient (assigned / org-admin lane)", grants: g(true, true, true, true, true, false, true), note: "Assignment-gated for care roles (can_access_patient)" },
  { capability: "Edit patient clinical data", grants: g(true, true, true, false, false, false, false), note: "Role-gated writes (migration 0012)" },
  { capability: "Review AI reasoning", grants: g(true, true, true, false, false, false, true), note: "Reviewer sees, cannot settle" },
  { capability: "Approve protocols", grants: g(true, true, true, false, false, false, false) },
  { capability: "Send patient messages", grants: g(true, true, true, true, true, false, false), note: "Always review-gated before send" },
  { capability: "Manage billing", grants: g(true, true, false, false, false, true, false) },
  { capability: "Manage claims", grants: g(true, true, false, false, false, true, false) },
  { capability: "Manage automations", grants: g(true, true, false, false, false, false, false) },
  { capability: "Export data", grants: g(true, true, true, false, false, false, false), note: "Scoped to accessible patients" },
  { capability: "Manage team", grants: g(true, true, false, false, false, false, false) },
  { capability: "View audit log", grants: g(true, true, true, false, false, false, true) },
];
