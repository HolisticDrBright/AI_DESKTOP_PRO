if (typeof window !== "undefined") {
  throw new Error("commerce/program-commerce-runtime is server-only.");
}
import { createHash } from "node:crypto";
import type { CurriculumBinding } from "../../contracts/programOffers";
import { isContractFixtureAllowed } from "../runtime/contractFixture";
import { createFictionalProgramOfferLedger, type ProgramOfferLedger } from "./program-offer-ledger";
import { createFictionalCheckoutLedger } from "./program-checkout-ledger";
import { createFictionalCheckoutProcessor } from "./program-checkout-processor";
import { createProgramCheckout } from "./program-checkout";
import { createFictionalEducationLedger } from "./program-education-ledger";
import { createProgramSettlement } from "./program-settlement";
import { createCommerceWorker } from "./program-commerce-worker";
import { createClaimDelivery, createFictionalClaimSealer, createFictionalContactAuthority, createFictionalDeliveryProvider } from "./program-claim-delivery";
import { publicSiteOrigin } from "../../lib/publicSite";

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
  | { kind: "fictional"; ledger: ProgramOfferLedger; registerCurriculum: (organizationId: string, programId: string, current: CurriculumBinding | null, content?: { title: string; phases: unknown[] } | null) => void };

/**
 * The fixture's in-memory state, held once per PROCESS. Next builds pages and route handlers as
 * separate module graphs, so a plain module-level singleton would give the purchase page, the return
 * page and the checkout route three different fictional ledgers; the mounted journey found the
 * return page unable to see an order the checkout route had just admitted. Nothing here exists
 * outside the contract fixture: every accessor below is reached only after its boundary check.
 */
type FictionalRuntimeState = {
  registry: Map<string, { programId: string; current: CurriculumBinding | null }>;
  /** The published content behind a registered binding, by version id, for the fixture's exact-version curriculum read. */
  contents: Map<string, { title: string; phases: unknown[]; sourceDigest: string }>;
  fictional: ReturnType<typeof createFictionalProgramOfferLedger> | null;
  fictionalCheckout: Extract<ProgramCheckoutSelection, { kind: "fictional" }> | null;
  /** Fixture-only outage switch for the journey fixture's catalog-outage case; never set outside a test. */
  fixtureFaults: { offers: boolean };
};
const STATE_KEY = Symbol.for("alp.commerce.fictional-runtime");
const state: FictionalRuntimeState = ((globalThis as unknown as Record<symbol, FictionalRuntimeState | undefined>)[STATE_KEY] ??=
  { registry: new Map(), contents: new Map(), fictional: null, fictionalCheckout: null, fixtureFaults: { offers: false } });
const registry = state.registry;
const contents = state.contents;
const key = (organizationId: string, programId: string) => `${organizationId}\u0000${programId}`;
export function __setFixtureOfferOutage(down: boolean): void { state.fixtureFaults.offers = down; }

function fictionalLedger() {
  state.fictional ??= createFictionalProgramOfferLedger({
    curriculum: async (organizationId, programId) => registry.get(key(organizationId, programId)) ?? null,
    faults: { before: () => { if (state.fixtureFaults.offers) throw new Error("fixture catalog outage"); } },
  });
  return state.fictional;
}

export function selectProgramOfferLedger(env: Record<string, string | undefined> = process.env): ProgramOfferLedgerSelection {
  if (!isContractFixtureAllowed(env as never)) return { kind: "disabled", reason: "commerce_disabled" };
  return {
    kind: "fictional",
    ledger: fictionalLedger(),
    registerCurriculum: (organizationId, programId, current, content) => {
      registry.set(key(organizationId, programId), { programId, current });
      if (current && content) contents.set(current.versionId, { title: content.title, phases: content.phases, sourceDigest: current.sourceDigest });
    },
  };
}

/** Test-only: forget every fictional offer and registered curriculum. */
export function __resetProgramCommerceRuntime(): void {
  state.fixtureFaults.offers = false;
  state.fictional?.reset();
  registry.clear();
  state.fictionalCheckout?.ledger.reset();
  state.fictionalCheckout?.education.reset();
  state.fictionalCheckout = null;
  contents.clear();
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

/**
 * Which checkout this Desktop process may run: the fictional boundary (fictional ledger and
 * processor, in memory) under the local contract fixture only; otherwise none. The Stripe transport
 * (program-checkout-stripe.ts) and the SQL ledger (program-checkout-ledger-sql.ts) are source for the
 * clinical service's reviewed wiring; nothing in this process constructs them, so outside the fixture
 * every start answers `checkout_unconfigured` and every webhook answers 503.
 */
export type ProgramCheckoutSelection =
  | { kind: "disabled"; reason: "checkout_unconfigured" }
  | { kind: "fictional"; checkout: ReturnType<typeof createProgramCheckout>; expected: { accountRef: string; apiVersion: string }; processor: ReturnType<typeof createFictionalCheckoutProcessor>; ledger: ReturnType<typeof createFictionalCheckoutLedger>; worker: ReturnType<typeof createCommerceWorker>; education: ReturnType<typeof createFictionalEducationLedger>; settlement: ReturnType<typeof createProgramSettlement>; /** The fixture's claim delivery, its purchaser contacts (what the fictional hosted page collected) and the mailbox a purchaser reads. */ delivery: ReturnType<typeof createClaimDelivery>; contacts: ReturnType<typeof createFictionalContactAuthority>; mailbox: ReturnType<typeof createFictionalDeliveryProvider>["mailbox"]; provider: ReturnType<typeof createFictionalDeliveryProvider> };

/** The fixture's return origin: the configured public origin, else a fictional https origin so the fixture can exercise returns. */
export const FIXTURE_RETURN_ORIGIN = "https://clinic.fictional.example";

export function selectProgramCheckout(env: Record<string, string | undefined> = process.env): ProgramCheckoutSelection {
  if (!isContractFixtureAllowed(env as never)) return { kind: "disabled", reason: "checkout_unconfigured" };
  if (!state.fictionalCheckout) {
    const ledger = createFictionalCheckoutLedger();
    const processor = createFictionalCheckoutProcessor();
    const checkout = createProgramCheckout({ offers: fictionalLedger(), ledger, processor, publicOrigin: publicSiteOrigin(env) ?? FIXTURE_RETURN_ORIGIN });
    const education = createFictionalEducationLedger({ orders: ledger, content: async binding => contents.get(binding.versionId) ?? null });
    // Fixture seams only: a sealer whose key lives in this process, the contacts the fictional hosted page collected, and a mailbox.
    const sealer = createFictionalClaimSealer();
    const contacts = createFictionalContactAuthority();
    const provider = createFictionalDeliveryProvider();
    const settlement = createProgramSettlement({ ledger: education, curriculumContent: async binding => contents.get(binding.versionId) ?? null, expectedAccountRef: processor.accountRef, sealer });
    const delivery = createClaimDelivery({ ledger: education, sealer, contacts, provider });
    // The webhook only admits; this worker is what processes admitted work. Under the fixture a test or a local operator runs its pass; a host schedules it in production.
    const worker = createCommerceWorker({ ledger, checkout, settlement, delivery });
    state.fictionalCheckout = { kind: "fictional", checkout, expected: { accountRef: processor.accountRef, apiVersion: "2025-08-27.basil" }, processor, ledger, worker, education, settlement, delivery, contacts, mailbox: provider.mailbox, provider };
  }
  return state.fictionalCheckout;
}
