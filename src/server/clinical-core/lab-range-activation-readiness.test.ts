import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, test } from "vitest";
import { assessLabRangeActivation, preparedReleaseBytes, type ActivationEvidence } from "./lab-range-activation-readiness";
import type { PreciseLabRangeRelease } from "./lab-range-population";

const now = Date.parse("2026-09-14T12:00:00Z");
const keys = generateKeyPairSync("ed25519");
const other = generateKeyPairSync("ed25519");
const sourceId = "22222222-2222-4222-8222-222222222222";
function release(): PreciseLabRangeRelease {
  return { schemaVersion: "lab-ranges/2", version: "synthetic/2", expiresAt: "2027-01-01T00:00:00Z", ranges: [{
    id: "11111111-1111-4111-8111-111111111111", canonicalName: "Fictional", aliases: ["Fixture"], unit: "widgets/L",
    rangeKind: "functional_target", min: 10, max: 20,
    population: { label: "Synthetic adult", age: { unit: "years", min: 18, max: 65, minInclusive: true, maxInclusive: false },
      sexes: ["male"], pregnancyStatuses: ["not_applicable"], cyclePhases: null, reproductiveStages: null,
      contraceptions: null, pregnancyTrimesters: null, assayIds: null },
    source: { id: sourceId, version: "synthetic/1", url: "https://example.invalid/reference",
      packageSha256: "a".repeat(64), recordId: "synthetic-row", recordSha256: "b".repeat(64), verification: "V",
      verifiedBy: "Synthetic reviewer", verifiedOn: "2026-09-01", verifiedAgainst: "Fictional test interval only" },
    reviewedBy: "Synthetic reviewer", reviewedAt: "2026-09-01T00:00:00Z",
  }] };
}
function evidence(prepared = release(), key = keys): ActivationEvidence {
  const { payload, payloadSha256 } = preparedReleaseBytes(prepared);
  return {
    signedEnvelope: { payload, signature: sign(null, Buffer.from(payload), key.privateKey).toString("base64") },
    trustedSha256: payloadSha256, publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    holds: [{ id: "hold-1", sourceId, reason: "Synthetic hold", status: "released", placedBy: "Reviewer", placedAt: "2026-09-01T00:00:00Z", releasedBy: "Reviewer", releasedAt: "2026-09-02T00:00:00Z" }],
    safetyRegression: { status: "approved", approvedBy: "Safety reviewer", approvedAt: "2026-09-03T00:00:00Z", payloadSha256, evidenceSha256: "c".repeat(64) },
    syntheticAcceptance: { evidenceSha256: "d".repeat(64), runAt: "2026-09-03T00:00:00Z", payloadSha256, phiAllowed: false },
  };
}
describe("lab range activation readiness", () => {
  test("reports ready only when every gate binds to the exact prepared bytes, and never activates", () => {
    const report = assessLabRangeActivation(release(), evidence(), now);
    expect(report).toMatchObject({ status: "ready_for_authorized_operator", blockers: [], ranges: 1, sources: 1, activationPerformed: false });
    expect(report.payloadSha256).toBe(createHash("sha256").update(JSON.stringify(release())).digest("hex"));
  });
  test("blocks on missing, foreign, mismatched or forged signatures", () => {
    const missing = { ...evidence(), signedEnvelope: null };
    expect(assessLabRangeActivation(release(), missing, now).blockers).toContain("signature_missing");
    expect(assessLabRangeActivation(release(), evidence(release(), other), now).blockers).toContain("signature_invalid");
    const changed = release(); changed.ranges[0]!.max = 21;
    expect(assessLabRangeActivation(changed, evidence(), now).blockers).toEqual(expect.arrayContaining(["trusted_hash_does_not_match_prepared_release", "safety_regression_approval_for_different_release", "synthetic_acceptance_for_different_release"]));
    const swapped = evidence(); swapped.signedEnvelope = { ...swapped.signedEnvelope!, payload: JSON.stringify(changed) };
    expect(assessLabRangeActivation(release(), swapped, now).blockers).toContain("signed_payload_differs_from_prepared_release");
  });
  test("an open hold on the release or a shipped source blocks; a hold on another source does not", () => {
    const open = evidence(); open.holds = [{ id: "hold-2", sourceId, reason: "Contested", status: "open", placedBy: "Reviewer", placedAt: "2026-09-05T00:00:00Z" }];
    expect(assessLabRangeActivation(release(), open, now).blockers).toEqual(["open_hold:hold-2"]);
    const global = evidence(); global.holds = [{ id: "hold-3", sourceId: null, reason: "Release freeze", status: "open", placedBy: "Owner", placedAt: "2026-09-05T00:00:00Z" }];
    expect(assessLabRangeActivation(release(), global, now).status).toBe("activation_blocked");
    const unrelated = evidence(); unrelated.holds = [{ id: "hold-4", sourceId: "33333333-3333-4333-8333-333333333333", reason: "Other package", status: "open", placedBy: "Owner", placedAt: "2026-09-05T00:00:00Z" }];
    expect(assessLabRangeActivation(release(), unrelated, now).status).toBe("ready_for_authorized_operator");
    const unreviewedRelease = { ...open.holds[0]!, status: "released" as const };
    expect(assessLabRangeActivation(release(), { ...evidence(), holds: [unreviewedRelease] }, now).blockers).toEqual(["evidence_invalid"]);
  });
  test("requires approved, same-payload, non-future safety regression and synthetic acceptance evidence", () => {
    const pending = evidence(); pending.safetyRegression = { ...pending.safetyRegression!, status: "pending" };
    expect(assessLabRangeActivation(release(), pending, now).blockers).toEqual(["safety_regression_pending"]);
    const future = evidence(); future.syntheticAcceptance = { ...future.syntheticAcceptance!, runAt: "2026-12-01T00:00:00Z" };
    expect(assessLabRangeActivation(release(), future, now).blockers).toEqual(["synthetic_acceptance_future_dated"]);
    const none = evidence(); none.safetyRegression = null; none.syntheticAcceptance = null;
    expect(assessLabRangeActivation(release(), none, now).blockers).toEqual(["safety_regression_approval_missing", "synthetic_acceptance_missing"]);
    expect(() => assessLabRangeActivation(release(), { ...evidence(), syntheticAcceptance: { ...evidence().syntheticAcceptance!, phiAllowed: true } }, now)).not.toThrow();
    expect(assessLabRangeActivation(release(), { ...evidence(), syntheticAcceptance: { ...evidence().syntheticAcceptance!, phiAllowed: true } }, now).blockers).toEqual(["evidence_invalid"]);
  });
  test("refuses invalid, expired, empty or future-dated releases without reading evidence", () => {
    expect(assessLabRangeActivation({ schemaVersion: "lab-ranges/1" }, evidence(), now).blockers).toEqual(["prepared_release_invalid"]);
    const empty = { ...release(), ranges: [] };
    expect(assessLabRangeActivation(empty, evidence(empty), now).blockers).toContain("release_has_no_ranges");
    const expired = { ...release(), expiresAt: "2026-01-01T00:00:00Z" };
    expect(assessLabRangeActivation(expired, evidence(expired), now).blockers).toContain("release_expired");
    const future = release(); future.ranges[0]!.reviewedAt = "2026-12-01T00:00:00Z";
    expect(assessLabRangeActivation(future, evidence(future), now).blockers).toContain("future_dated_review_evidence");
  });
});
