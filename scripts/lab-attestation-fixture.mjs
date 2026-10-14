// Fictional values shared by the loopback fixture backend (scripts/live-stub-server.mjs) and the browser journey
// (e2e/live-lab-attestation.spec.ts). Nothing here is a real report, patient or reading.
import { createHash } from "node:crypto";

export const LAB_ATTESTATION_PATIENT = "aaaaaaaa-1111-2222-3333-444444444401";
export const LAB_ATTESTATION_OBSERVATION = "30000000-0000-4000-8000-0000000000a1";
export const LAB_ATTESTATION_LEGACY_OBSERVATION = "30000000-0000-4000-8000-0000000000a2";
export const LAB_ATTESTATION_EVENT = "60000000-0000-4000-8000-0000000000a1";
export const LAB_ATTESTATION_LEGACY_EVENT = "60000000-0000-4000-8000-0000000000a2";
export const LAB_ATTESTATION_DRAWN = "2026-10-01T09:00:00.000Z";
/** A tiny PDF-shaped fictional report. Its digest is the one the fixture transfer "recorded". */
export const FICTIONAL_REPORT_BYTES = Buffer.from(
  "%PDF-1.4\n% FICTIONAL LAB REPORT - not a real patient, laboratory or result\n" +
  "% Marker: Ferritin  Value: 420  Unit: ng/mL  Drawn: 2026-10-01T09:00:00.000Z\n%%EOF\n", "utf8");
export const OTHER_FICTIONAL_REPORT_BYTES = Buffer.from("%PDF-1.4\n% FICTIONAL - a different report\n%%EOF\n", "utf8");
export const FICTIONAL_REPORT_SHA256 = createHash("sha256").update(FICTIONAL_REPORT_BYTES).digest("hex");
