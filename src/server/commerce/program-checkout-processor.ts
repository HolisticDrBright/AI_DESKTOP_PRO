import { createHash, randomBytes } from 'node:crypto';
import { encodeCreationRequest, processorSession, type ProcessorSession, type ProcessorSessionRequest } from '../../contracts/programCheckout';

/**
 * The processor the checkout boundary talks to: create a hosted, tokenized checkout session for an
 * admitted order from its saved creation request, retrieve the authoritative session object later,
 * and prove which account its credential belongs to. Two implementations exist: the fictional one
 * here, which behaves the way the processor's documentation describes (same key and same parameters
 * answer the first result; same key and different parameters is an idempotency error; keys are kept
 * for a retention window and then forgotten) with every transport failure as an injectable fault,
 * and the Stripe test-mode transport (program-checkout-stripe.ts), constructed only from a configured
 * test boundary and never configured in this source. ALP never sees a card number or a CVC through
 * either: the session URL is where the visitor enters them, on the processor's page.
 *
 * Failures are classified by what they prove about the creation:
 *   refused               a definitive refusal BEFORE any mutation (validation, authentication); nothing exists
 *   idempotency_mismatch  the key was used with other parameters; this source never sends other parameters, so it is held
 *   unavailable, timeout, lost_response, malformed_reply, redirect_reply
 *                         the outcome is unknown: a session may exist under the key
 */
export type ProcessorFailure = 'unavailable' | 'timeout' | 'refused' | 'malformed_reply' | 'redirect_reply' | 'lost_response' | 'idempotency_mismatch';
export class ProcessorError extends Error {
  constructor(readonly failure: ProcessorFailure) { super(failure); this.name = 'ProcessorError'; }
}
/** Only a refusal the processor gives before mutating anything proves no session exists. */
export const creationOutcomeKnown = (failure: ProcessorFailure) => failure === 'refused';

export interface ProgramCheckoutProcessor {
  /** The account the configuration names. Not evidence: `authority()` is. */
  readonly accountRef: string;
  /** The hosts the processor's hosted checkout pages live on; a redirect anywhere else is refused. */
  readonly checkoutHosts: readonly string[];
  /** How long the processor keeps an idempotency key; beyond it a replay may create a second session. */
  readonly idempotencyRetentionHours: number;
  /** The account the credential itself belongs to, as the processor reports it (credential-bound evidence), in test mode. */
  authority(): Promise<{ accountRef: string; livemode: false }>;
  /** Send the saved creation request, exactly as recorded, under its key. A replay of the same request answers the first session. */
  createSession(creation: ProcessorSessionRequest): Promise<ProcessorSession>;
  retrieveSession(sessionRef: string): Promise<ProcessorSession>;
}

export type FictionalProcessorFault = ProcessorFailure | 'live_object' | 'other_account' | 'amount_drift' | 'extra_metadata' | 'wrong_order';
export type FictionalProcessorOptions = {
  accountRef?: string;
  /** The account the credential really belongs to, when a test needs it to differ from the configured label. */
  credentialAccountRef?: string;
  now?: () => Date;
  retentionHours?: number;
  faults?: { createSession?: FictionalProcessorFault; retrieveSession?: FictionalProcessorFault; authority?: ProcessorFailure };
};

export type FictionalSessionOutcome = 'paid' | 'processing' | 'succeeded_async' | 'failed_async' | 'expired';

export function createFictionalCheckoutProcessor(options: FictionalProcessorOptions = {}) {
  const accountRef = options.accountRef ?? 'acct_FictionalAccount1';
  const credentialAccountRef = options.credentialAccountRef ?? accountRef;
  const now = options.now ?? (() => new Date());
  const retention = (options.retentionHours ?? 24) * 3_600_000;
  const sessions = new Map<string, ProcessorSession>();
  const keys = new Map<string, { digest: string; sessionRef: string; at: number }>();
  const requests: ProcessorSessionRequest[] = [];
  /** Every creation the processor actually performed (a replay answered from the key is not one). */
  const creations: ProcessorSessionRequest[] = [];
  const faults = { ...options.faults };
  const corrupt = (session: ProcessorSession, fault: FictionalProcessorFault | undefined): ProcessorSession => {
    switch (fault) {
      case 'live_object': return { ...session, livemode: true };
      case 'other_account': return { ...session, accountRef: 'acct_FictionalOther99' };
      case 'amount_drift': return { ...session, amountTotal: (session.amountTotal ?? 0) + 1 };
      case 'extra_metadata': return { ...session, metadata: { ...session.metadata, note: 'fictional' } };
      case 'wrong_order': return { ...session, clientReferenceId: '00000000-0000-4000-8000-000000000000', metadata: { order_id: '00000000-0000-4000-8000-000000000000' } };
      default: return session;
    }
  };
  const transport = (fault: FictionalProcessorFault | ProcessorFailure | undefined) => {
    if (fault && ['unavailable', 'timeout', 'refused', 'malformed_reply', 'redirect_reply', 'lost_response', 'idempotency_mismatch'].includes(fault)) throw new ProcessorError(fault as ProcessorFailure);
  };
  /** What the processor reports now: an open session past its expiry is expired; a missing field stays missing. */
  const observe = (stored: ProcessorSession): ProcessorSession => {
    const status = stored.status === 'open' && Date.parse(stored.expiresAt) <= now().getTime() ? 'expired' as const : stored.status;
    return { ...stored, status, url: status === 'open' ? stored.url ?? null : null };
  };
  const processor: ProgramCheckoutProcessor & {
    sessions: Map<string, ProcessorSession>; requests: ProcessorSessionRequest[]; creations: ProcessorSessionRequest[]; faults: typeof faults;
    settle(sessionRef: string, outcome: FictionalSessionOutcome): void;
  } = {
    accountRef, sessions, requests, creations, faults,
    checkoutHosts: ['checkout.fictional.example'],
    idempotencyRetentionHours: options.retentionHours ?? 24,
    async authority() {
      transport(faults.authority);
      return { accountRef: credentialAccountRef, livemode: false as const };
    },
    async createSession(creation) {
      requests.push(structuredClone(creation));
      const fault = faults.createSession;
      if (fault && fault !== 'lost_response' && ['refused', 'unavailable', 'timeout', 'malformed_reply', 'redirect_reply', 'idempotency_mismatch'].includes(fault)) {
        // `refused` happens before anything is created; the others may or may not have created (the fictional one did not).
        transport(fault);
      }
      const digest = createHash('sha256').update(encodeCreationRequest(creation.request)).digest('hex');
      const kept = keys.get(creation.idempotencyKey);
      if (kept && now().getTime() - kept.at <= retention) {
        if (kept.digest !== digest) throw new ProcessorError('idempotency_mismatch');
        return structuredClone(corrupt(observe(sessions.get(kept.sessionRef)!), fault));
      }
      creations.push(structuredClone(creation));
      const ref = 'cs_test_' + randomBytes(12).toString('hex');
      const request = creation.request;
      const session = processorSession.parse({
        sessionRef: ref, url: `https://checkout.fictional.example/c/pay/${ref}`, expiresAt: new Date(request.expiresAtUnix * 1000).toISOString(), status: 'open', paymentStatus: 'unpaid',
        paymentIntentStatus: null, successUrl: request.successUrl, cancelUrl: request.cancelUrl,
        mode: request.mode, livemode: false, amountTotal: amountFor(request.priceRef), currency: 'usd', clientReferenceId: request.clientReferenceId,
        metadata: { order_id: request.metadataOrderId }, priceRefs: [request.priceRef], accountRef: credentialAccountRef,
      });
      sessions.set(ref, session); keys.set(creation.idempotencyKey, { digest, sessionRef: ref, at: now().getTime() });
      if (fault === 'lost_response') { faults.createSession = undefined; throw new ProcessorError('lost_response'); }
      return structuredClone(corrupt(observe(session), fault));
    },
    async retrieveSession(sessionRef) {
      transport(faults.retrieveSession);
      const session = sessions.get(sessionRef);
      if (!session) throw new ProcessorError('refused');
      return structuredClone(corrupt(observe(session), faults.retrieveSession));
    },
    /** The fictional visitor finishes, pays later, fails or abandons the hosted page. */
    settle(sessionRef, outcome) {
      const session = sessions.get(sessionRef);
      if (!session) throw new Error('fictional session missing');
      const next: Partial<ProcessorSession> =
        outcome === 'paid' ? { status: 'complete', paymentStatus: 'paid', paymentIntentStatus: 'succeeded' }
        : outcome === 'processing' ? { status: 'complete', paymentStatus: 'unpaid', paymentIntentStatus: 'processing' }
        : outcome === 'succeeded_async' ? { status: 'complete', paymentStatus: 'paid', paymentIntentStatus: 'succeeded' }
        : outcome === 'failed_async' ? { status: 'complete', paymentStatus: 'unpaid', paymentIntentStatus: 'requires_payment_method' }
        : { status: 'expired' };
      sessions.set(sessionRef, { ...session, ...next });
    },
  };
  /** The fictional price list: the processor knows the amount of a price it holds. Tests that need another amount mutate the session. */
  const amounts = new Map<string, number>();
  function amountFor(priceRef: string) { return amounts.get(priceRef) ?? 1999; }
  return Object.assign(processor, { setPriceAmount(priceRef: string, amountMinor: number) { amounts.set(priceRef, amountMinor); } });
}
