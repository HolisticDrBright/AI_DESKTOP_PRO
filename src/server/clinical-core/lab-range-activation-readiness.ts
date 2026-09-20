import { createHash } from "node:crypto";
import { z } from "zod";
import { preciseLabRangeReleaseSchema, type PreciseLabRangeRelease } from "./lab-range-population";
import { verifyLabRangeRelease } from "./lab-range-release";

/** Activation readiness for a prepared `lab-ranges/2` release.
 *
 * This tool never activates anything. It reports whether every gate the
 * six-phase ledger requires has evidence bound to the exact prepared bytes:
 * an authorized Ed25519 signature over those bytes, a released hold register,
 * a safety-regression approval and synthetic acceptance evidence for the same
 * payload hash. Any missing or mismatched item is a blocker. The best possible
 * outcome is "ready for the authorized operator", never "activated". */
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const text = (max: number) => z.string().trim().min(1).max(max);
const datetime = z.string().datetime();
const holdSchema = z.object({
  id: text(160), sourceId: z.string().uuid().nullable(), reason: text(1000),
  status: z.enum(["open", "released"]), placedBy: text(160), placedAt: datetime,
  releasedBy: text(160).optional(), releasedAt: datetime.optional(),
}).strict().refine(h => h.status === "open" || (h.releasedBy !== undefined && h.releasedAt !== undefined), "release_requires_reviewer");
const approvalSchema = z.object({ status: z.enum(["approved", "rejected", "pending"]), approvedBy: text(160), approvedAt: datetime, payloadSha256: sha, evidenceSha256: sha,
  /** Copied from the regression report; only a `full` run (every artifact supplied, no check skipped) qualifies a release. */
  coverage: z.enum(["full", "partial"]).optional() }).strict();
export const activationEvidenceSchema = z.object({
  signedEnvelope: z.object({ payload: z.string().max(2_000_000), signature: z.string().max(128) }).strict().nullable(),
  trustedSha256: sha.nullable(),
  publicKeyPem: z.string().max(4000).nullable(),
  holds: z.array(holdSchema).max(500),
  safetyRegression: approvalSchema.nullable(),
  syntheticAcceptance: z.object({ evidenceSha256: sha, runAt: datetime, payloadSha256: sha, phiAllowed: z.literal(false) }).strict().nullable(),
}).strict();
export type ActivationEvidence = z.infer<typeof activationEvidenceSchema>;
export type ActivationReadiness = {
  status: "activation_blocked" | "ready_for_authorized_operator";
  payloadSha256: string | null; version: string | null; ranges: number; sources: number;
  blockers: string[];
  /** Always true: the tool reports; the authorized operator pins. */
  activationPerformed: false;
};

export function assessLabRangeActivation(prepared: unknown, evidence: unknown, now = Date.now()): ActivationReadiness {
  const blockers: string[] = [];
  const blocked = (): ActivationReadiness => ({ status: "activation_blocked", payloadSha256: null, version: null, ranges: 0, sources: 0, blockers, activationPerformed: false });
  const parsedEvidence = activationEvidenceSchema.safeParse(evidence);
  if (!parsedEvidence.success) { blockers.push("evidence_invalid"); return blocked(); }
  const release = preciseLabRangeReleaseSchema.safeParse(prepared);
  if (!release.success) { blockers.push("prepared_release_invalid"); return blocked(); }
  const payload = JSON.stringify(release.data);
  const payloadSha256 = createHash("sha256").update(payload).digest("hex");
  const e = parsedEvidence.data;
  const sources = new Set(release.data.ranges.map(row => row.source.id));
  const result = (status: ActivationReadiness["status"]): ActivationReadiness =>
    ({ status, payloadSha256, version: release.data.version, ranges: release.data.ranges.length, sources: sources.size, blockers, activationPerformed: false });

  if (release.data.ranges.length === 0) blockers.push("release_has_no_ranges");
  if (Date.parse(release.data.expiresAt) <= now) blockers.push("release_expired");
  for (const row of release.data.ranges) {
    // The schema already requires verification "V"; future-dated evidence is
    // still a blocker because verification cannot postdate the assessment.
    if (Date.parse(row.reviewedAt) > now || Date.parse(row.source.verifiedOn) > now) { blockers.push("future_dated_review_evidence"); break; }
  }
  // 1. Signature: must be an authorized signer over exactly the prepared bytes.
  if (!e.signedEnvelope || !e.trustedSha256 || !e.publicKeyPem) blockers.push("signature_missing");
  else if (e.trustedSha256 !== payloadSha256) blockers.push("trusted_hash_does_not_match_prepared_release");
  else if (e.signedEnvelope.payload !== payload) blockers.push("signed_payload_differs_from_prepared_release");
  else { try { verifyLabRangeRelease(e.signedEnvelope, { sha256: e.trustedSha256, publicKeyPem: e.publicKeyPem }, now); } catch { blockers.push("signature_invalid"); } }
  // 2. Holds: any open hold on the release as a whole or on a shipped source blocks.
  for (const hold of e.holds) {
    if (hold.status !== "open") continue;
    if (hold.sourceId === null || sources.has(hold.sourceId)) blockers.push(`open_hold:${hold.id}`);
  }
  // 3. Safety regression approval bound to the same payload.
  if (!e.safetyRegression) blockers.push("safety_regression_approval_missing");
  else if (e.safetyRegression.status !== "approved") blockers.push(`safety_regression_${e.safetyRegression.status}`);
  else if (e.safetyRegression.payloadSha256 !== payloadSha256) blockers.push("safety_regression_approval_for_different_release");
  else if (Date.parse(e.safetyRegression.approvedAt) > now) blockers.push("safety_regression_approval_future_dated");
  else if (e.safetyRegression.coverage !== "full") blockers.push("safety_regression_coverage_not_full");
  // 4. Synthetic acceptance evidence for the same payload, PHI disabled.
  if (!e.syntheticAcceptance) blockers.push("synthetic_acceptance_missing");
  else if (e.syntheticAcceptance.payloadSha256 !== payloadSha256) blockers.push("synthetic_acceptance_for_different_release");
  else if (Date.parse(e.syntheticAcceptance.runAt) > now) blockers.push("synthetic_acceptance_future_dated");
  return result(blockers.length ? "activation_blocked" : "ready_for_authorized_operator");
}

/** Convenience for operators: the exact bytes a signer must sign. */
export function preparedReleaseBytes(prepared: PreciseLabRangeRelease): { payload: string; payloadSha256: string } {
  const payload = JSON.stringify(preciseLabRangeReleaseSchema.parse(prepared));
  return { payload, payloadSha256: createHash("sha256").update(payload).digest("hex") };
}
