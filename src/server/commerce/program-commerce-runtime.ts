if (typeof window !== "undefined") {
  throw new Error("commerce/program-commerce-runtime is server-only.");
}
import { createHash } from "node:crypto";
import type { CurriculumBinding } from "../../contracts/programOffers";
import { isContractFixtureAllowed } from "../runtime/contractFixture";
import { createFictionalProgramOfferLedger, type ProgramOfferLedger } from "./program-offer-ledger";

/**
 * Which offer ledger this Desktop process may talk to.
 *
 *   - Under the local contract fixture (the only posture in which this process is unambiguously a
 *     test harness), the in-process fictional ledger: nothing durable, nothing hosted.
 *   - Otherwise: none. The SQL ledger (program-offer-ledger-sql.ts) belongs behind the clinical
 *     service, against the BLOCKED candidate, and no transport from this process to it is reviewed
 *     or configured. The routes answer `commerce_disabled`, the Studio editor and the funnel pages
 *     say so, and nothing is defaulted into availability.
 *
 * The fictional ledger reads the curriculum from a registry this process fills from the Studio's
 * own read of the published version. Its digest is a canonical-JSON digest of the published phases,
 * which is a FICTIONAL stand-in for the SQL digest (the two serialize differently); it is what the
 * fixture binds to and is never compared with a hosted value.
 */
export type ProgramOfferLedgerSelection =
  | { kind: "disabled"; reason: "commerce_disabled" }
  | { kind: "fictional"; ledger: ProgramOfferLedger; registerCurriculum: (organizationId: string, programId: string, current: CurriculumBinding | null) => void };

const registry = new Map<string, { programId: string; current: CurriculumBinding | null }>();
const key = (organizationId: string, programId: string) => `${organizationId}\u0000${programId}`;
let fictional: ReturnType<typeof createFictionalProgramOfferLedger> | null = null;

function fictionalLedger() {
  fictional ??= createFictionalProgramOfferLedger({ curriculum: async (organizationId, programId) => registry.get(key(organizationId, programId)) ?? null });
  return fictional;
}

export function selectProgramOfferLedger(env: Record<string, string | undefined> = process.env): ProgramOfferLedgerSelection {
  if (!isContractFixtureAllowed(env as never)) return { kind: "disabled", reason: "commerce_disabled" };
  return {
    kind: "fictional",
    ledger: fictionalLedger(),
    registerCurriculum: (organizationId, programId, current) => { registry.set(key(organizationId, programId), { programId, current }); },
  };
}

/** Test-only: forget every fictional offer and registered curriculum. */
export function __resetProgramCommerceRuntime(): void {
  fictional?.reset();
  registry.clear();
}

/** The fictional digest of a published patient-facing program: canonical JSON of its phases, or null when none is authored. */
export function fictionalCurriculumDigest(consumerProgram: unknown): string | null {
  if (!consumerProgram || typeof consumerProgram !== "object" || Array.isArray(consumerProgram)) return null;
  const phases = (consumerProgram as { phases?: unknown }).phases;
  if (!Array.isArray(phases) || phases.length === 0) return null;
  return createHash("sha256").update(JSON.stringify(phases)).digest("hex");
}

/** A stable, fictional person id for the signed-in practitioner under the fixture: a digest of the session email in uuid form, never a real identity. */
export function fictionalPersonId(email: string): string {
  const hex = createHash("sha256").update("fictional-person:" + email.trim().toLowerCase()).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
