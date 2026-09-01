import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

function migration(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("patient-approved family access", () => {
  it("keeps the legacy transition path scoped, two-party verified, and revocable", () => {
    const sql = migration("supabase/migrations/20260831120000_patient_relationship_access.sql");
    expect(sql).toContain("private.patient_relationship_scope_allowed");
    expect(sql).toContain("relationship.status='active'");
    expect(sql).toContain("relationship.access_expires_at>now()");
    expect(sql).toContain("_scope=any(relationship.granted_scopes)");
    expect(sql).toContain("patient_approved_at is not null and recipient_claimed_at is not null");
    expect(sql).toContain("patient.user_id=_uid");
    expect(sql).toContain("recipient_email_sha256");
    expect(sql).toContain("invitation_code_sha256");
    expect(sql).toContain("granted_scopes='{}'");
    expect(sql).not.toMatch(/alter\s+(?:function|policy)[\s\S]*private\.can_access_patient/i);
  });

  it("keeps the AWS production path unseeded and closed to direct table access", () => {
    const sql = migration(
      "infra/aws-clinical-core/production-migrations/20260831120000_production_patient_relationship_access.sql",
    );
    for (const table of ["clinical_core.patient_relationships", "clinical_audit.patient_relationship_events"]) {
      expect(sql).toContain(`alter table ${table} enable row level security`);
      expect(sql).toContain(`revoke all on ${table} from public,clinical_core_api`);
    }
    for (const contract of [
      "get_patient_relationships", "create_patient_relationship_invitation", "revoke_patient_relationship",
    ]) expect(sql).toContain(`function clinical_core.${contract}`);
    expect(sql).toContain("clinical_private.patient_relationship_scope_allowed");
    expect(sql).toContain("manual_secure_delivery_required");
    expect(sql).not.toMatch(/insert\s+into\s+clinical_core\.patient_relationships\s*\([^)]*\)\s*values\s*\([^_$]/i);
    expect(sql).not.toMatch(/grant\s+(?:all|select|insert|update|delete)\s+on[\s\S]*?\s+to\s+(?:public|clinical_core_api)/i);
  });
});
