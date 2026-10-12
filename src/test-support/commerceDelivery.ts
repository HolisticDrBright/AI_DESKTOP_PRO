import { codeFromMessage, createClaimDelivery, createFictionalClaimSealer, createFictionalContactAuthority, createFictionalDeliveryProvider } from '../server/commerce/program-claim-delivery';
import type { ProgramEducationLedger } from '../server/commerce/program-education-ledger';

/**
 * Test support: the fictional delivery seams around an education ledger, and the purchaser's view of
 * them. `codeFor(orderId)` records the contact the fictional hosted page would have collected for the
 * order, runs one delivery pass, and returns the code from the message that reached that address,
 * which is the only way a purchaser ever learns it. Tests never read a code from settlement.
 */
export const purchaserAddress = (orderId: string) => `purchaser+${orderId.slice(0, 8)}@fictional.example`;
export function fictionalDelivery(ledger: ProgramEducationLedger, now?: () => Date) {
  const sealer = createFictionalClaimSealer();
  const contacts = createFictionalContactAuthority();
  const provider = createFictionalDeliveryProvider();
  const delivery = createClaimDelivery({ ledger, sealer, contacts, provider, now });
  return {
    sealer, contacts, provider, delivery,
    async codeFor(orderId: string): Promise<string> {
      if (!contacts.contacts.has(orderId)) contacts.contacts.set(orderId, purchaserAddress(orderId));
      await delivery.deliverDue();
      const message = [...provider.mailbox].reverse().find(m => m.to === purchaserAddress(orderId));
      if (!message) throw new Error('no message reached the purchaser for ' + orderId);
      return codeFromMessage(message);
    },
  };
}
