import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { EducationLedgerError, type DeliveryRecord, type ProgramEducationLedger, type SealedCode } from './program-education-ledger';

/**
 * Delivery of a claim's one-time code, as source for review. The threat it answers: a purchase is
 * paid by someone the site does not know yet; access must reach that person and nobody else, survive
 * a crash between payment and delivery, and never leave the code lying in a table, a log, a URL or a
 * status reply. Three seams, each narrow and each disabled outside the local fixture:
 *
 *   ClaimSealer                   seals a code at settlement and opens it only here, at the moment of
 *                                 sending; the ledger stores the sealed form and erases it once delivery
 *                                 is accepted, fails for good, or the claim stops being usable. A digest
 *                                 cannot be turned back into a code, so the sealed form is what makes a
 *                                 retry after a crash possible. Hosted: a KMS key whose decrypt
 *                                 permission only the delivery worker's role holds (Codex wires it).
 *   PurchaserContactAuthority     the only source of the recipient: the contact the payment processor
 *                                 holds for this order, read at send time and never stored here. A
 *                                 browser-supplied address, an order number or a success URL never
 *                                 chooses a recipient. Whether the processor's collected address is
 *                                 "verified enough" is a policy decision named for review.
 *   ClaimDeliveryProvider         sends one generic transactional message under a stable idempotency key
 *                                 per delivery, so a retry after a lost receipt cannot send a second
 *                                 usable code. Acceptance by the provider is not proof of arrival.
 *
 * The message names no program, curriculum, lab, diagnosis or protocol: "your access code" and the
 * code. Every attempt is recorded (accepted, failed, outcome unknown) against the attempt count the
 * worker read; a lost race with another worker is reported, never double-sent; attempts are bounded.
 */
export interface ClaimSealer {
  seal(code: string, claimId: string): Promise<SealedCode>;
  unseal(sealed: SealedCode, claimId: string): Promise<string>;
}
export type PurchaserContact = { kind: 'address'; address: string; authority: 'payment_processor' } | { kind: 'unavailable'; reason: 'no_contact' | 'service_unavailable' };
export interface PurchaserContactAuthority { contactFor(orderId: string): Promise<PurchaserContact> }
export type DeliveryMessage = { idempotencyKey: string; to: string; subject: string; text: string };
export type ProviderReply = { outcome: 'accepted'; providerRef: string } | { outcome: 'refused'; detail: string };
/** A throw means the outcome is unknown. */
export interface ClaimDeliveryProvider { send(message: DeliveryMessage): Promise<ProviderReply> }

export const DELIVERY_SUBJECT = 'Your access code';
export function deliveryText(code: string, expiresAt: string): string {
  const date = new Date(expiresAt).toISOString().slice(0, 10);
  return [
    'Here is your one-time access code:', '', code, '',
    'Enter it in the app while signed in to your own account to open what you purchased. It can be used once, and it expires on ' + date + ' (UTC).', '',
    'If you did not make this purchase, you can ignore this message.',
  ].join('\n');
}
export const deliveryKeyFor = (deliveryId: string) => `claim-delivery:${deliveryId}`;

export type DeliveryResult = { deliveryId: string; state: DeliveryRecord['state'] | 'lost_race' | 'error'; detail: string };
export type DeliveryPass = { ok: true; results: DeliveryResult[] } | { ok: false; reason: 'deliveries_unavailable' };

export function createClaimDelivery(deps: { ledger: ProgramEducationLedger; sealer: ClaimSealer; contacts: PurchaserContactAuthority; provider: ClaimDeliveryProvider; now?: () => Date }) {
  const now = deps.now ?? (() => new Date());
  const retryAt = (attempts: number) => new Date(now().getTime() + Math.min(60, 2 ** attempts) * 60_000).toISOString();
  async function record(delivery: DeliveryRecord, outcome: { state: 'accepted' | 'failed' | 'provider_unknown'; providerRef?: string; detail: string }): Promise<DeliveryResult> {
    try {
      const after = await deps.ledger.recordDelivery(delivery.deliveryId, delivery.attempts, { ...outcome, nextAttemptAt: outcome.state === 'provider_unknown' ? retryAt(delivery.attempts + 1) : null, at: now().toISOString() });
      return { deliveryId: delivery.deliveryId, state: after.state, detail: after.lastOutcome ?? outcome.detail };
    } catch (error) {
      if (error instanceof EducationLedgerError && (error.category === 'revision_stale' || error.category === 'transition_refused')) return { deliveryId: delivery.deliveryId, state: 'lost_race', detail: 'another worker recorded this attempt' };
      return { deliveryId: delivery.deliveryId, state: 'error', detail: 'attempt not recorded' };
    }
  }
  return {
    async deliverDue(limit = 25): Promise<DeliveryPass> {
      let due: DeliveryRecord[];
      try { due = await deps.ledger.dueDeliveries(now().toISOString(), limit); } catch { return { ok: false, reason: 'deliveries_unavailable' }; }
      const results: DeliveryResult[] = [];
      for (const delivery of due) {
        if (!delivery.sealed) { results.push({ deliveryId: delivery.deliveryId, state: 'error', detail: 'nothing sealed to send' }); continue; }
        let contact: PurchaserContact;
        try { contact = await deps.contacts.contactFor(delivery.orderId); } catch { contact = { kind: 'unavailable', reason: 'service_unavailable' }; }
        if (contact.kind === 'unavailable') {
          results.push(await record(delivery, contact.reason === 'no_contact' ? { state: 'failed', detail: 'no purchaser contact from the payment processor' } : { state: 'provider_unknown', detail: 'purchaser contact could not be read' }));
          continue;
        }
        let code: string;
        try { code = await deps.sealer.unseal(delivery.sealed, delivery.claimId); }
        catch { results.push(await record(delivery, { state: 'provider_unknown', detail: 'sealed code could not be opened' })); continue; }
        let reply: ProviderReply;
        try { reply = await deps.provider.send({ idempotencyKey: deliveryKeyFor(delivery.deliveryId), to: contact.address, subject: DELIVERY_SUBJECT, text: deliveryText(code, delivery.claimExpiresAt) }); }
        catch { results.push(await record(delivery, { state: 'provider_unknown', detail: 'provider outcome unknown' })); continue; }
        results.push(await record(delivery, reply.outcome === 'accepted' ? { state: 'accepted', providerRef: reply.providerRef, detail: 'accepted by the provider (not proof of arrival)' } : { state: 'failed', detail: 'provider refused: ' + reply.detail.slice(0, 120) }));
      }
      return { ok: true, results };
    },
  };
}

/* ------------------------------------------------------------ fictional seams, fixture only */

/** AES-256-GCM under a key that lives only in this process; the claim id is bound as associated data. Fixture only: the hosted sealer is a reviewed KMS key. */
export function createFictionalClaimSealer(fixed?: { key: Buffer; keyRef: string }): ClaimSealer & { keyRef: string } {
  // A fixed key exists only so a fixture host restarted on the same embedded database can open what it sealed before; the hosted key is a reviewed KMS key.
  if (fixed && (fixed.key.byteLength !== 32 || !/^fictional-sealer:[a-z0-9-]{1,64}$/.test(fixed.keyRef))) throw new Error('fictional sealer key must be 32 bytes under a fictional-sealer: reference');
  const key = fixed?.key ?? randomBytes(32);
  const keyRef = fixed?.keyRef ?? 'fictional-sealer:' + randomBytes(6).toString('hex');
  return {
    keyRef,
    async seal(code, claimId) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(claimId, 'utf8'));
      const ciphertext = Buffer.concat([cipher.update(code, 'utf8'), cipher.final()]);
      return { keyRef, iv: iv.toString('base64url'), ciphertext: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
    },
    async unseal(sealed, claimId) {
      if (sealed.keyRef !== keyRef) throw new Error('sealed under another key');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64url'));
      decipher.setAAD(Buffer.from(claimId, 'utf8'));
      decipher.setAuthTag(Buffer.from(sealed.tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, 'base64url')), decipher.final()]).toString('utf8');
    },
  };
}

/** The fixture's purchaser contacts: what the fictional hosted page collected, by order. */
export function createFictionalContactAuthority() {
  const contacts = new Map<string, string>();
  let failing = false;
  return {
    contacts,
    setFailing(value: boolean) { failing = value; },
    async contactFor(orderId: string): Promise<PurchaserContact> {
      if (failing) throw new Error('fictional contact outage');
      const address = contacts.get(orderId);
      return address ? { kind: 'address', address, authority: 'payment_processor' } : { kind: 'unavailable', reason: 'no_contact' };
    },
  };
}

/** A fictional provider with a mailbox; it deduplicates by idempotency key, as a real provider's key would. */
export function createFictionalDeliveryProvider() {
  const mailbox: DeliveryMessage[] = [];
  const byKey = new Map<string, string>();
  const faults: { next?: 'unknown' | 'refuse' | 'accept_then_lose_reply' } = {};
  return {
    mailbox, faults,
    async send(message: DeliveryMessage): Promise<ProviderReply> {
      const fault = faults.next; faults.next = undefined;
      if (fault === 'unknown') throw new Error('fictional provider timeout');
      if (fault === 'refuse') return { outcome: 'refused', detail: 'recipient rejected' };
      const kept = byKey.get(message.idempotencyKey);
      if (kept) return { outcome: 'accepted', providerRef: kept };
      const providerRef = 'msg_fictional_' + randomBytes(8).toString('hex');
      byKey.set(message.idempotencyKey, providerRef); mailbox.push(structuredClone(message));
      if (fault === 'accept_then_lose_reply') throw new Error('fictional provider reply lost');
      return { outcome: 'accepted', providerRef };
    },
  };
}

/** The code inside a delivered message, as the purchaser would read it. */
export function codeFromMessage(message: DeliveryMessage): string {
  const match = /^([A-Za-z0-9_-]{43,64})$/m.exec(message.text);
  if (!match) throw new Error('no code in the message');
  return match[1]!;
}
