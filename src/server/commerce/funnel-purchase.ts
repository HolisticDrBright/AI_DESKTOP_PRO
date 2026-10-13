if (typeof window !== "undefined") {
  throw new Error("commerce/funnel-purchase is server-only.");
}
import { unavailable, type PurchaseAvailability } from "../../contracts/programOffers";
import type { FunnelDefinition } from "../../funnels/schema";
import { resolveOfferAvailabilityLedger, type ProgramOfferLedgerSelection } from "./program-commerce-runtime";
import type { ProgramOfferLedger } from "./program-offer-ledger";

/**
 * The buy choice on a funnel page, answered on the server from the page's program binding and the
 * offer ledger this process may use. A visitor names nothing: the clinic and program come from the
 * definition, the terms from the ledger, and every absence is a specific hold the page prints. An
 * unbound page, a disabled ledger and a failed read are three different answers, none of them
 * "free" and none of them silent.
 */
export async function funnelPurchaseAvailability(funnel: Pick<FunnelDefinition, "programBinding">, given?: ProgramOfferLedgerSelection | { kind: "reviewed"; ledger: ProgramOfferLedger }): Promise<PurchaseAvailability> {
  const selection = given ?? await resolveOfferAvailabilityLedger();
  if (!funnel.programBinding) return unavailable("program_unbound");
  if (selection.kind === "disabled") return unavailable(selection.reason);
  try {
    return await selection.ledger.availability(funnel.programBinding.organizationId, funnel.programBinding.programId);
  } catch {
    return unavailable("commerce_unverifiable");
  }
}
