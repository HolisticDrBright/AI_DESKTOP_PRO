import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import { resetBackend, STUB_BASE } from "./support/backend";

test.skip(!process.env.E2E_LIVE, "live-mode suite: set E2E_LIVE=1 with a clinical build + backend");
test.describe.configure({ mode: "serial" });
test.beforeAll(resetBackend);

const jsonl = (rows: unknown[]) => Buffer.from(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function phase9fFixture() {
  const clinical = jsonl([{
    product_research_id: "PRH-0001",
    identity_confidence: "exact",
    research_disposition: "exact_identity_candidate",
    clinically_approved: false,
    practitioner_verified: false,
    imported: false,
    supplement_facts_complete: false,
    label_verification_candidate: true,
    unresolved_reasons: ["physical_label_required"],
  }]);
  const commercial = jsonl([{
    product_research_id: "PRH-0001",
    affiliate_url: "https://example.invalid/product",
  }]);
  const evidence = jsonl([{
    source_id: "EV9F-00001",
    product_research_id: "PRH-0001",
    url: "https://example.invalid/label",
    authority_tier: 1,
    archived: true,
    artifact_relative_path: "evidence/PRH-0001/label.json",
    sha256: "a".repeat(64),
    url_only_evidence: false,
  }]);
  const artifacts = jsonl([{
    artifact_id: "ART-00001",
    product_research_id: "PRH-0001",
    relative_path: "evidence/PRH-0001/label.json",
    filename: "label.json",
    extension: "json",
    bytes: 128,
    sha256: "a".repeat(64),
    source_id: "EV9F-00001",
    source_url: "https://example.invalid/label",
    authority_tier: 1,
    supports_fields: ["identity"],
    archived_utc: "2026-08-04T00:00:00Z",
  }]);
  const conflicts = jsonl([{
    conflict_id: "CP-00001",
    product_research_id: "PRH-0001",
    field: "serving_size",
    existing_value: "one capsule",
    incoming_value: "two capsules",
    practitioner_decision_required: true,
    resolved_by_research: false,
  }]);
  const names = {
    clinical: "product-label-enrichment-v2.jsonl",
    commercial: "commercial-links-v2.jsonl",
    evidence: "evidence-sources-v2.jsonl",
    artifacts: "evidence-artifact-index.jsonl",
    conflicts: "conflict-resolution-packets.jsonl",
  };
  const manifest = Buffer.from(JSON.stringify({
    package: "Synthetic Phase 9F browser proof",
    phase: "9F",
    version: "2.0",
    created_utc: "2026-08-04T00:00:00Z",
    source_files: [{ path: "synthetic-source", sha256: "b".repeat(64) }],
    output_files: [
      { file: names.clinical, sha256: sha256(clinical) },
      { file: names.commercial, sha256: sha256(commercial) },
      { file: names.evidence, sha256: sha256(evidence) },
      { file: names.artifacts, sha256: sha256(artifacts) },
      { file: names.conflicts, sha256: sha256(conflicts) },
      { file: "qa-report-v2.txt", sha256: "c".repeat(64) },
    ],
    counts: {
      total_records: 1,
      commercial_records: 1,
      evidence_source_records: 1,
      evidence_artifacts: 1,
      conflict_packets: 1,
      records_with_complete_supplement_facts: 0,
      supplement_facts_complete: 0,
      label_verification_candidates: 1,
      by_identity_confidence: { exact: 1 },
      by_source_authority_tier: { "1": 1 },
    },
    governance: {
      clinically_approved: false,
      practitioner_verified: false,
      labels_verified: false,
      imported_anywhere: false,
    },
  }));
  return { manifest, clinical, commercial, evidence, artifacts, conflicts, names };
}

async function selectFile(page: import("@playwright/test").Page, testId: string, name: string, buffer: Buffer) {
  await page.getByTestId(testId).setInputFiles({ name, mimeType: "application/json", buffer });
}

test("Phase 9F requires the supplemental files and a manual practitioner attestation", async ({ page }) => {
  const fx = phase9fFixture();
  await page.goto("/settings/imports?tab=research_handoff");
  await selectFile(page, "prh-manifest", "handoff-manifest-v2.json", fx.manifest);
  await selectFile(page, "prh-clinical", fx.names.clinical, fx.clinical);
  await selectFile(page, "prh-commercial", fx.names.commercial, fx.commercial);
  await selectFile(page, "prh-evidence", fx.names.evidence, fx.evidence);

  await expect(page.getByTestId("prh-submit")).toBeDisabled();
  await expect(page.getByText("Phase 9F requires both the evidence artifact index and conflict packets.")).toBeVisible();
  await page.getByTestId("prh-attest-checkbox").check();
  await expect(page.getByTestId("prh-submit")).toBeDisabled();

  await selectFile(page, "prh-artifacts", fx.names.artifacts, fx.artifacts);
  await selectFile(page, "prh-conflicts", fx.names.conflicts, fx.conflicts);
  await expect(page.getByTestId("prh-submit")).toBeEnabled();
});

test("Phase 9F creates five idempotent preview-only batches through the governed route", async ({ page, request }) => {
  const fx = phase9fFixture();
  await page.goto("/settings/imports?tab=research_handoff");
  await selectFile(page, "prh-manifest", "handoff-manifest-v2.json", fx.manifest);
  await selectFile(page, "prh-clinical", fx.names.clinical, fx.clinical);
  await selectFile(page, "prh-commercial", fx.names.commercial, fx.commercial);
  await selectFile(page, "prh-evidence", fx.names.evidence, fx.evidence);
  await selectFile(page, "prh-artifacts", fx.names.artifacts, fx.artifacts);
  await selectFile(page, "prh-conflicts", fx.names.conflicts, fx.conflicts);
  await page.getByTestId("prh-attest-checkbox").check();
  await page.getByTestId("prh-submit").click();

  const success = page.getByTestId("prh-preview-success");
  await expect(success).toBeVisible();
  await expect(success).toContainText("No governed content changed");
  await expect(success).toContainText("Archived artifact references 1. Conflict packets 1.");
  await expect(page.getByTestId("prh-batch-clinical")).not.toBeEmpty();
  await expect(page.getByTestId("prh-batch-evidence")).not.toBeEmpty();
  await expect(page.getByTestId("prh-batch-commercial")).not.toBeEmpty();
  await expect(page.getByTestId("prh-batch-artifacts")).not.toBeEmpty();
  await expect(page.getByTestId("prh-batch-conflicts")).not.toBeEmpty();

  const artifactBatchId = await page.getByTestId("prh-batch-artifacts").textContent();
  const refused = await request.post(`${STUB_BASE}/rest/v1/rpc/commit_knowledge_import`, {
    headers: { authorization: "Bearer stub-token", "content-type": "application/json" },
    data: { _batch_id: artifactBatchId },
  });
  expect(refused.status()).toBeGreaterThanOrEqual(400);
  expect((await refused.json()).code).toBe("55000");

  await page.getByTestId("prh-submit").click();
  await expect(success).toContainText("existing — idempotent retry");
  await expect(page.getByText("Preview only. Nothing is verified, approved, activated, or attached.")).toBeVisible();
});
