if (typeof window !== 'undefined') throw new Error('commerce connectors are server-only');
import { createHash } from 'node:crypto';
import { SendEmailCommand } from '@aws-sdk/client-sesv2';
import { boundedJson } from '../program-checkout-stripe';
import { ProcessorError } from '../program-checkout-processor';
import { createAesGcmClaimSealer, type ClaimDeliveryProvider, type ClaimSealer, type DeliveryMessage, type ProviderReply, type PurchaserContact, type PurchaserContactAuthority } from '../program-claim-delivery';
import type { ProgramCheckoutLedger } from '../program-checkout-ledger';

/**
 * The source connectors the reviewed commerce runtime composes. Each takes its client or fetch by
 * injection; nothing here reads a secret store, creates a resource or contacts a provider by itself.
 *
 *   - Purchaser contact authority (Stripe test mode): the email the processor's hosted checkout
 *     collected for THIS order's session, read back from the processor, never from the browser. The
 *     session must be the order's own (its client reference and metadata name the order) and in
 *     test mode. It is used only while Brandon's decision "the processor-collected email may receive
 *     the code" is recorded as decided; the runtime does not construct it otherwise.
 *   - Email delivery (SES v2): one message per delivery attempt with a deterministic Message-ID built
 *     from the delivery's idempotency key, so a retry after an unknown outcome repeats the SAME
 *     message (same code, same id) and receiving systems can recognise it. SES itself offers no
 *     idempotency key: a retried send can arrive twice, and acceptance is not proof of arrival.
 *   - Claim sealing: AES-256-GCM under the host-injected 32-byte key, named by the target's versioned
 *     key reference. A code sealed under another reference is not opened; rotation means reissue.
 */

const STRIPE_API = 'https://api.stripe.com/v1';
const DEADLINE_MS = 15_000;
const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,180}\.[A-Za-z]{2,24}$/;
type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export function createStripePurchaserContactAuthority(deps: { secretKey: string; apiVersion: string; orders: Pick<ProgramCheckoutLedger, 'readOrder'>; fetch: Fetch }): PurchaserContactAuthority {
  if (!/^(?:sk|rk)_test_[A-Za-z0-9]{8,}$/.test(deps.secretKey)) throw new Error('stripe_test_key_required');
  return {
    async contactFor(orderId: string): Promise<PurchaserContact> {
      let order;
      try { order = await deps.orders.readOrder(orderId); } catch { return { kind: 'unavailable', reason: 'service_unavailable' }; }
      const sessionRef = order?.processor?.sessionRef;
      if (!order || !sessionRef || !/^cs_test_[A-Za-z0-9]{8,200}$/.test(sessionRef)) return { kind: 'unavailable', reason: 'no_contact' };
      const deadline = Date.now() + DEADLINE_MS, signal = AbortSignal.timeout(DEADLINE_MS);
      let json: Record<string, unknown>;
      try {
        const response = await deps.fetch(`${STRIPE_API}/checkout/sessions/${sessionRef}`, {
          method: 'GET', redirect: 'error', cache: 'no-store', signal,
          headers: { authorization: `Bearer ${deps.secretKey}`, 'stripe-version': deps.apiVersion, accept: 'application/json' },
        });
        if (response.status === 404) return { kind: 'unavailable', reason: 'no_contact' };
        if (!response.ok) return { kind: 'unavailable', reason: 'service_unavailable' };
        json = await boundedJson(response, deadline, signal);
      } catch (error) {
        return { kind: 'unavailable', reason: error instanceof ProcessorError || error instanceof Error ? 'service_unavailable' : 'service_unavailable' };
      }
      const metadata = (json.metadata ?? {}) as Record<string, unknown>;
      if (json.id !== sessionRef || json.livemode !== false || json.client_reference_id !== orderId || metadata.order_id !== orderId) return { kind: 'unavailable', reason: 'no_contact' };
      const email = (json.customer_details as { email?: unknown } | null | undefined)?.email;
      if (typeof email !== 'string' || !EMAIL.test(email.trim())) return { kind: 'unavailable', reason: 'no_contact' };
      return { kind: 'address', address: email.trim(), authority: 'payment_processor' };
    },
  };
}

export type SesSend = (command: SendEmailCommand) => Promise<{ MessageId?: string }>;

/** RFC 5322 header value with no line break or non-ASCII; anything else is refused before sending. */
const headerSafe = (value: string) => /^[\x20-\x7E]{1,998}$/.test(value);

export function createSesClaimDeliveryProvider(deps: { send: SesSend; fromAddress: string; configurationSet: string | null; messageIdDomain: string }): ClaimDeliveryProvider {
  return {
    async send(message: DeliveryMessage): Promise<ProviderReply> {
      if (!EMAIL.test(message.to) || !headerSafe(message.subject) || !headerSafe(message.idempotencyKey)) return { outcome: 'refused', detail: 'message_refused' };
      const messageId = `<${createHash('sha256').update(message.idempotencyKey).digest('hex').slice(0, 40)}@${deps.messageIdDomain}>`;
      const raw = [
        `From: ${deps.fromAddress}`, `To: ${message.to}`, `Subject: ${message.subject}`, `Message-ID: ${messageId}`,
        'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit', '', message.text.replace(/\r?\n/g, '\r\n'),
      ].join('\r\n');
      const command = new SendEmailCommand({
        FromEmailAddress: deps.fromAddress, Destination: { ToAddresses: [message.to] },
        Content: { Raw: { Data: new TextEncoder().encode(raw) } },
        ...(deps.configurationSet ? { ConfigurationSetName: deps.configurationSet } : {}),
      });
      let reply;
      try { reply = await deps.send(command); }
      catch (error) {
        const name = (error as { name?: string })?.name ?? '';
        // A definite refusal before acceptance: the address or the message was rejected, nothing was sent.
        if (['MessageRejected', 'MailFromDomainNotVerifiedException', 'AccountSuspendedException', 'SendingPausedException', 'BadRequestException', 'NotFoundException'].includes(name)) return { outcome: 'refused', detail: name };
        // Anything else leaves the outcome unknown; the delivery is retried under the same key and Message-ID.
        throw error;
      }
      if (typeof reply.MessageId !== 'string' || !reply.MessageId) throw new Error('ses_reply_malformed');
      return { outcome: 'accepted', providerRef: reply.MessageId.slice(0, 200) };
    },
  };
}

/** The reviewed sealer: the host-injected key under the target's key reference. */
export function createKeyedClaimSealer(key: Buffer, keyRef: string): ClaimSealer & { keyRef: string } {
  if (!/^claim-sealer:[a-z0-9-]{1,64}\/v[1-9][0-9]{0,3}$/.test(keyRef)) throw new Error('claim_sealer_key_ref_invalid');
  return createAesGcmClaimSealer(key, keyRef);
}
