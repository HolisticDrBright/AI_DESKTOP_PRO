import { describe, expect, test } from "vitest";
import { buildEmptySnapshot } from "./input-builder";
import { assembleRetrieval } from "./retrieval";
import { buildMinimizedEnvelope, envelopeAllowedFields } from "./data-minimizer";

function baseInput() {
  return {
    runType: "practitioner_brief" as const,
    lens: "western",
    ruleSetVersion: "v1",
    promptVersion: "v1",
    outputSchemaVersion: "v1",
    snapshot: buildEmptySnapshot().snapshot,
    retrieval: assembleRetrieval({
      approvedKnowledgeReferenceIds: ["kr-a", "kr-b"],
      verifiedLabelIds: [],
      approvedProtocolTemplateIds: [],
      approvedDietTemplateIds: [],
    }),
  };
}

describe("data-minimizer — envelope whitelist", () => {
  test("only the declared whitelist fields appear in the envelope JSON", () => {
    const env = buildMinimizedEnvelope(baseInput());
    const allowed = envelopeAllowedFields();
    for (const key of Object.keys(env)) {
      expect(allowed.has(key), `envelope key not on whitelist: ${key}`).toBe(true);
    }
  });

  test("PII fields never appear even if snuck into the snapshot", () => {
    const input = baseInput();
    // A caller upstream might mistakenly attach PII on the snapshot. The
    // envelope must drop it structurally.
    (input.snapshot as Record<string, unknown>).firstName = "Avery";
    (input.snapshot as Record<string, unknown>).lastName = "Demo";
    (input.snapshot as Record<string, unknown>).mrn = "P10A-XYZ";
    (input.snapshot as Record<string, unknown>).email = "avery@example.com";
    (input.snapshot as Record<string, unknown>).phone = "555-0100";
    (input.snapshot as Record<string, unknown>).address = "123 Main";
    const env = buildMinimizedEnvelope(input);
    const json = JSON.stringify(env);
    expect(json).not.toMatch(/Avery|Demo|P10A-XYZ|avery@example|555-0100|Main/);
  });

  test("commercial fields never appear even if attached", () => {
    const input = baseInput();
    (input.snapshot as Record<string, unknown>).affiliateUrl = "https://aff/ex";
    (input.snapshot as Record<string, unknown>).discountCode = "PROMO";
    (input.snapshot as Record<string, unknown>).price = 99.99;
    (input.snapshot as Record<string, unknown>).commercialRank = 1;
    (input.snapshot as Record<string, unknown>).promotionalCopy = "Best seller";
    const env = buildMinimizedEnvelope(input);
    const json = JSON.stringify(env);
    for (const banned of ["aff/", "PROMO", "99.99", "commercialRank", "Best seller"]) {
      expect(json, `envelope leaked commercial field: ${banned}`).not.toContain(banned);
    }
  });

  test("raw files, transcripts, and unrelated chart history never appear", () => {
    const input = baseInput();
    input.snapshot.transcriptRevisions = [
      { id: "t1", content: "Patient reports headaches for the last three weeks." },
    ];
    (input.snapshot as Record<string, unknown>).rawFileBlob = "PDF-bytes-here";
    (input.snapshot as Record<string, unknown>).unrelatedChartHistory = "old encounters";
    const env = buildMinimizedEnvelope(input);
    const json = JSON.stringify(env);
    expect(json).not.toMatch(/headaches|PDF-bytes|unrelated|old encounters/);
  });

  test("internal audit metadata and secrets never appear", () => {
    const input = baseInput();
    (input.snapshot as Record<string, unknown>).auditEvent = "run-created";
    (input.snapshot as Record<string, unknown>).serviceRoleToken = "sk-service-role-abc";
    const env = buildMinimizedEnvelope(input);
    const json = JSON.stringify(env);
    expect(json).not.toMatch(/audit|service-role|sk-service|serviceRoleToken/);
  });

  test("envelope hash is deterministic for identical inputs", () => {
    const a = buildMinimizedEnvelope(baseInput());
    const b = buildMinimizedEnvelope(baseInput());
    expect(a.envelopeSha256).toBe(b.envelopeSha256);
    expect(a.envelopeSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("allowedCitationIds are sorted for determinism", () => {
    const input = baseInput();
    input.retrieval = assembleRetrieval({
      approvedKnowledgeReferenceIds: ["kr-z", "kr-a"],
      verifiedLabelIds: ["lbl-m"],
      approvedProtocolTemplateIds: [],
      approvedDietTemplateIds: [],
    });
    const env = buildMinimizedEnvelope(input);
    expect(env.allowedCitationIds).toEqual([...env.allowedCitationIds].sort());
  });
});
