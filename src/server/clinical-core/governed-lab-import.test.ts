import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(process.cwd(), "supabase/migrations/20260818230640_governed_lab_result_import.sql"),
  "utf8",
);
const hashBoundarySql = readFileSync(
  join(process.cwd(), "supabase/migrations/20260818232031_signed_lab_payload_hash_boundary.sql"),
  "utf8",
);
const jsonbKeyValidationSql = readFileSync(
  join(process.cwd(), "supabase/migrations/20260818233621_lab_result_jsonb_key_validation.sql"),
  "utf8",
);
const jsonbPrecedenceSql = readFileSync(
  join(process.cwd(), "supabase/migrations/20260818233724_lab_result_jsonb_operand_precedence.sql"),
  "utf8",
);

describe("governed patient-app lab import migration", () => {
  it("uses a separate consent scope and a service-role-only ingress", () => {
    expect(sql).toContain("'lab_results_import'");
    expect(sql).toContain("lab results import consent is not granted");
    expect(sql).toMatch(/record_sync_lab_result[\s\S]*from public, anon, authenticated/);
    expect(sql).toMatch(/record_sync_lab_result[\s\S]*to service_role/);
  });

  it("deduplicates at the sync and chart boundaries", () => {
    expect(sql).toContain("exception when unique_violation");
    expect(sql).toContain("biomarker_observations_alp_source_uniq");
    expect(sql).toContain("on conflict (organization_id, patient_id, source, source_record_id)");
  });

  it("requires clinician acceptance before staging an unreviewed marker", () => {
    expect(sql).toContain("private.materialize_sync_lab_result");
    expect(sql).toContain("perform private.require_clinical_actor");
    expect(sql).toContain("'unreviewed', 'alp_patient_sync'");
    expect(sql).toContain("Review imported lab marker");
  });

  it("preserves signed source provenance without logging values in audit metadata", () => {
    expect(sql).toContain("'providerEventId',_e.provider_event_id");
    expect(sql).toContain("'signatureKeyId',_e.signature_key_id");
    expect(sql).toContain("'externalResourceId',_e.external_resource_id");
    expect(sql).not.toMatch(/jsonb_build_object\([^)]*result,value/);
  });

  it("validates a deterministic payload hash without exposing a bypass RPC", () => {
    expect(hashBoundarySql).toContain("private.sync_canonical_json");
    expect(hashBoundarySql).toContain("private.sha256_hex(private.sync_canonical_json(_payload))");
    expect(hashBoundarySql).toMatch(/record_sync_lab_result_pgtext[\s\S]*from public, anon, authenticated, service_role/);
    expect(hashBoundarySql).toMatch(/record_sync_lab_result[\s\S]*to service_role/);
  });

  it("validates exact JSON keys without ambiguous operator resolution", () => {
    expect(jsonbKeyValidationSql).toContain("::text[]");
    expect(jsonbPrecedenceSql).toContain("((_payload->'source') - array");
    expect(jsonbPrecedenceSql).toContain("((_payload#>'{result,referenceRange}') - array");
  });
});
