import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const migration = readFileSync(
  "infra/aws-clinical-core/migrations/20260903210000_synthetic_review_billing_workspaces.sql",
  "utf8",
);
const registration = readFileSync(
  "infra/aws-clinical-core/migrations/20260903211000_register_synthetic_review_billing.sql",
  "utf8",
);

describe("synthetic Review Queue and Billing workspaces", () => {
  test("projects persisted pending lab imports into the organization review queue", () => {
    expect(migration).toContain("create or replace function clinical_core.list_review_queue");
    expect(migration).toContain("from clinical_core.lab_import_events event");
    expect(migration).toContain("event.organization_id = _organization_id");
    expect(migration).toContain("patient.contains_phi = false");
    expect(migration).toContain("assert_synthetic_context");
  });

  test("keeps review-task resolution separate from accepting or rejecting a lab result", () => {
    expect(migration).toContain("create table clinical_core.synthetic_review_task_state");
    expect(migration).toContain("create table clinical_audit.synthetic_review_events");
    expect(migration).not.toMatch(/update\s+clinical_core\.lab_import_events/i);
    expect(migration).toContain("before update or delete on clinical_audit.synthetic_review_events");
  });

  test("returns the complete persisted-data Billing workspace while writes stay disabled", () => {
    for (const field of [
      "'summary'", "'invoices'", "'payments'", "'aging'", "'productSales'",
      "'inventory'", "'reconciliation'", "'pendingCardPayments'", "'webhookEvents'",
    ]) expect(migration).toContain(field);
    expect(migration).toContain("from clinical_core.synthetic_billing_invoices");
    expect(migration).toContain("from clinical_core.synthetic_billing_payments");
    expect(migration).toContain("synthetic_billing_write_disabled");
    expect(migration).toContain("livemode is distinct from true");
  });

  test("does not enable PHI or a payment processor", () => {
    expect(migration).not.toContain("PHI_ALLOWED=true");
    expect(migration).not.toContain("stripe.com");
    expect(migration).not.toContain("card_number");
  });

  test("routes only the exact reviewed operations and starts fail-closed", () => {
    expect(registration).toContain("clinical_compatibility.synthetic_review_billing_v1");
    expect(registration).toContain("('list_review_queue')");
    expect(registration).toContain("('resolve_review_queue_item')");
    expect(registration).toContain("('get_billing_workspace')");
    expect(registration).toContain("false, null, null");
    expect(registration).toContain("review_billing_operation_not_supported");
    expect(registration).not.toContain("enabled = true");
  });
});
