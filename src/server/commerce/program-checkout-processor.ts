import { randomBytes } from 'node:crypto';
import { processorSession, type ProcessorSession, type ProcessorSessionRequest } from '../../contracts/programCheckout';

/**
 * The processor the checkout boundary talks to: create a hosted, tokenized checkout session for an
 * admitted order, and retrieve the authoritative session object later. Two implementations exist:
 * the fictional one here, with every transport failure the handoff names as an injectable fault,
 * and the Stripe test-mode transport (program-checkout-stripe.ts), which is constructed only from a
 * configured test boundary and is never configured in this source. ALP never sees a card number or
 * a CVC through either: the session URL is where the visitor enters them, on the processor's page.
 */
export type ProcessorFailure = 'unavailable' | 'timeout' | 'refused' | 'malformed_reply' | 'redirect_reply' | 'lost_response';
export class ProcessorError extends Error {
  constructor(readonly failure: ProcessorFailure) { super(failure); this.name = 'ProcessorError'; }
}

export interface ProgramCheckoutProcessor {
  readonly accountRef: string;
  createSession(request: ProcessorSessionRequest): Promise<ProcessorSession>;
  retrieveSession(sessionRef: string): Promise<ProcessorSession>;
  /** The session the processor already holds for an idempotency key, when a creation reply was lost. */
  findSessionByIdempotencyKey(idempotencyKey: string): Promise<ProcessorSession | null>;
}

export type FictionalProcessorFault = ProcessorFailure | 'live_object' | 'other_account' | 'amount_drift' | 'extra_metadata' | 'wrong_order';
export type FictionalProcessorOptions = { accountRef?: string; now?: () => Date; faults?: { createSession?: FictionalProcessorFault; retrieveSession?: FictionalProcessorFault } };

export function createFictionalCheckoutProcessor(options: FictionalProcessorOptions = {}) {
  const accountRef = options.accountRef ?? 'acct_FictionalAccount1';
  const now = options.now ?? (() => new Date());
  const sessions = new Map<string, ProcessorSession>();
  const byKey = new Map<string, string>();
  const requests: ProcessorSessionRequest[] = [];
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
  const transport = (fault: FictionalProcessorFault | undefined) => {
    if (fault && ['unavailable', 'timeout', 'refused', 'malformed_reply', 'redirect_reply', 'lost_response'].includes(fault)) throw new ProcessorError(fault as ProcessorFailure);
  };
  const processor: ProgramCheckoutProcessor & { sessions: Map<string, ProcessorSession>; requests: ProcessorSessionRequest[]; faults: typeof faults; settle(sessionRef: string, outcome: 'paid' | 'failed' | 'expired'): void } = {
    accountRef, sessions, requests, faults,
    async createSession(request) {
      requests.push(request);
      const fault = faults.createSession;
      // An idempotent retry finds the session the first call made, whatever happened to that call's reply.
      const existingRef = byKey.get(request.idempotencyKey);
      if (existingRef && fault !== 'lost_response') return structuredClone(sessions.get(existingRef)!);
      if (fault === 'refused' || fault === 'unavailable' || fault === 'timeout' || fault === 'malformed_reply' || fault === 'redirect_reply') { transport(fault); }
      const ref = 'cs_test_' + randomBytes(12).toString('hex');
      const session = processorSession.parse({
        sessionRef: ref, url: `https://checkout.fictional.example/c/pay/${ref}`, expiresAt: request.expiresAt, status: 'open', paymentStatus: 'unpaid',
        mode: request.pricing.billing.kind === 'one_time' ? 'payment' : 'subscription', livemode: false, amountTotal: request.pricing.amountMinor,
        currency: request.pricing.currency.toLowerCase(), clientReferenceId: request.orderId, metadata: { order_id: request.orderId }, priceRefs: [request.providerPriceRef], accountRef,
      });
      sessions.set(ref, session); byKey.set(request.idempotencyKey, ref);
      if (fault === 'lost_response') { faults.createSession = undefined; throw new ProcessorError('lost_response'); }
      return structuredClone(corrupt(session, fault));
    },
    async retrieveSession(sessionRef) {
      transport(faults.retrieveSession);
      const session = sessions.get(sessionRef);
      if (!session) throw new ProcessorError('refused');
      const live = { ...session, status: session.status === 'open' && Date.parse(session.expiresAt) <= now().getTime() ? 'expired' as const : session.status };
      return structuredClone(corrupt(live, faults.retrieveSession));
    },
    async findSessionByIdempotencyKey(idempotencyKey) {
      transport(faults.retrieveSession);
      const ref = byKey.get(idempotencyKey);
      return ref ? structuredClone(sessions.get(ref)!) : null;
    },
    /** The fictional visitor finishes, fails or abandons the hosted page. */
    settle(sessionRef, outcome) {
      const session = sessions.get(sessionRef);
      if (!session) throw new Error('fictional session missing');
      sessions.set(sessionRef, outcome === 'paid' ? { ...session, status: 'complete', paymentStatus: 'paid' } : outcome === 'failed' ? { ...session, status: 'complete', paymentStatus: 'unpaid' } : { ...session, status: 'expired' });
    },
  };
  return processor;
}
