import { randomUUID } from 'node:crypto';
import {
  PROGRAM_OFFER_CONTRACT, programOffer, programOfferCommand, purchaseAvailability, unavailable,
  type CurriculumBinding, type ProgramOffer, type ProgramOfferCommand, type ProgramOfferResult, type PurchaseAvailability,
} from '../../contracts/programOffers';
export type { ProgramOfferResult } from '../../contracts/programOffers';

/**
 * The program offer ledger: the one authority that writes offer revisions, in whichever store backs it.
 *
 * Two implementations exist. The fictional one here holds everything in memory and is what the
 * repository's tests and the local contract fixture run against. The SQL one
 * (program-offer-ledger-sql.ts) speaks to the BLOCKED candidate schema through the API role and is
 * disabled until that candidate is reviewed and activated. Both answer the same contract, so the
 * routes, the Studio editor and the funnel pages do not know which they are talking to.
 *
 * What every implementation holds, and the tests assert of both:
 *   - an offer is created against the program's CURRENT published curriculum, read by the ledger;
 *     the caller cannot name a version, and a program with nothing published gets no offer;
 *   - every change raises the revision and is refused when the caller's expected revision is older;
 *   - a published offer's terms are immutable: it can be retired, and a new offer written, nothing else;
 *   - publishing re-reads the curriculum and refuses when it moved since the draft was bound;
 *   - one published offer per program;
 *   - paid terms that are incomplete stay a draft; they never become complimentary, free or zero;
 *   - complimentary is a mode chosen by name, with the authorizer and a written reason recorded;
 *   - a program of another clinic is not found, so nothing cross-clinic is written or read.
 */
export type OfferActor = { personId: string; organizationId: string };

export type CurriculumRead = { programId: string; current: CurriculumBinding | null };
/** Reads the program's current published curriculum within the actor's clinic; null when the program is not in that clinic. */
export type CurriculumReader = (organizationId: string, programId: string) => Promise<CurriculumRead | null>;

export type OfferLedgerCategory =
  | 'request_invalid' | 'program_not_found' | 'offer_not_found' | 'revision_stale' | 'state_invalid'
  | 'curriculum_unpublished' | 'curriculum_changed' | 'publish_refused' | 'identity_refused' | 'activation_refused' | 'service_unavailable';

export class ProgramOfferError extends Error {
  constructor(readonly category: OfferLedgerCategory, readonly holds: readonly string[] = []) {
    super(category);
    this.name = 'ProgramOfferError';
  }
}

export interface ProgramOfferLedger {
  execute(actor: OfferActor, command: unknown): Promise<ProgramOfferResult>;
  read(actor: OfferActor, offerId: string): Promise<ProgramOffer | null>;
  /** The visitor's question: may this program be bought now, and on what terms? Never throws; a failure is a hold. */
  availability(organizationId: string, programId: string): Promise<PurchaseAvailability>;
}

/** The holds that keep a draft from publishing, in the words the editor shows. */
export function publishHolds(offer: ProgramOffer, current: CurriculumBinding | null): string[] {
  const holds: string[] = [];
  if (offer.mode === 'paid') {
    if (!offer.pricing) holds.push('no_pricing');
    if (!offer.providerPrice) holds.push('provider_mapping_missing');
    else if (!offer.providerPrice.approval) holds.push('provider_mapping_unapproved');
  }
  if (!offer.accessTermsVersion) holds.push('no_access_terms');
  if (!current) holds.push('curriculum_unpublished');
  else if (current.versionId !== offer.curriculum.versionId || current.version !== offer.curriculum.version || current.sourceDigest !== offer.curriculum.sourceDigest) holds.push('curriculum_changed');
  return holds;
}

export type FictionalOfferLedgerOptions = {
  curriculum: CurriculumReader;
  now?: () => Date;
  /** Fault injection for the routes' failure tests: throws before the named action runs. */
  faults?: { before?: (action: string) => void };
};

export type OfferAuditEntry = { at: string; actor: string; organizationId: string; offerId: string; action: string; revision: number; detail?: string };

export function createFictionalProgramOfferLedger(options: FictionalOfferLedgerOptions): ProgramOfferLedger & { revisions: readonly ProgramOffer[]; audit: readonly OfferAuditEntry[]; reset(): void } {
  const now = options.now ?? (() => new Date());
  const offers = new Map<string, ProgramOffer>();
  const revisions: ProgramOffer[] = [];
  const audit: OfferAuditEntry[] = [];
  const stamp = () => now().toISOString();
  // A failing curriculum read is a service failure, never "not found" and never "unpublished".
  const readCurriculum: CurriculumReader = async (organizationId, programId) => {
    try { return await options.curriculum(organizationId, programId); } catch { throw new ProgramOfferError('service_unavailable'); }
  };
  const record = (offer: ProgramOffer, actor: OfferActor, action: string, detail?: string) => {
    offers.set(offer.offerId, offer);
    revisions.push(structuredClone(offer));
    audit.push({ at: stamp(), actor: actor.personId, organizationId: actor.organizationId, offerId: offer.offerId, action, revision: offer.revision, detail });
    return structuredClone(offer);
  };
  const owned = (actor: OfferActor, offerId: string, expectedRevision: number): ProgramOffer => {
    const offer = offers.get(offerId);
    // Another clinic's offer is not found, not forbidden: the id reveals nothing.
    if (!offer || offer.organizationId !== actor.organizationId) throw new ProgramOfferError('offer_not_found');
    if (offer.revision !== expectedRevision) throw new ProgramOfferError('revision_stale');
    return structuredClone(offer);
  };
  const terms = (offer: Pick<ProgramOffer, 'contract' | 'offerId' | 'organizationId' | 'programId' | 'curriculum' | 'revision' | 'state' | 'authoredBy' | 'authoredAt'>, command: Extract<ProgramOfferCommand, { action: 'create' | 'revise' }>, actor: OfferActor, previous: ProgramOffer | null): ProgramOffer => {
    const t = command.terms;
    const shared = { ...offer, name: t.name, accessTermsVersion: t.accessTermsVersion, accessDurationDays: t.accessDurationDays, authoredBy: actor.personId, authoredAt: stamp() };
    if (t.mode === 'paid') {
      // A changed reference drops an earlier approval: what was approved is not what is typed now.
      const keep = previous?.mode === 'paid' && previous.providerPrice && previous.providerPrice.priceRef === t.providerPriceRef ? previous.providerPrice : null;
      return programOffer.parse({ ...shared, mode: 'paid', pricing: t.pricing, providerPrice: t.providerPriceRef ? keep ?? { provider: 'stripe', mode: 'test', priceRef: t.providerPriceRef, approval: null } : null });
    }
    return programOffer.parse({ ...shared, mode: 'complimentary', authorization: { authorizedBy: actor.personId, authorizedAt: stamp(), reason: t.reason } });
  };
  return {
    revisions, audit,
    reset() { offers.clear(); revisions.length = 0; audit.length = 0; },
    async execute(actor, raw) {
      const parsed = programOfferCommand.safeParse(raw);
      if (!parsed.success) throw new ProgramOfferError('request_invalid');
      const command = parsed.data;
      options.faults?.before?.(command.action);
      switch (command.action) {
        case 'list': {
          const read = await readCurriculum(actor.organizationId, command.programId);
          if (!read) throw new ProgramOfferError('program_not_found');
          const list = [...offers.values()].filter(o => o.organizationId === actor.organizationId && o.programId === command.programId).map(o => structuredClone(o));
          return { action: 'list', offers: list, curriculum: read.current };
        }
        case 'create': {
          const read = await readCurriculum(actor.organizationId, command.programId);
          if (!read) throw new ProgramOfferError('program_not_found');
          if (!read.current) throw new ProgramOfferError('curriculum_unpublished');
          const offer = terms({ contract: PROGRAM_OFFER_CONTRACT, offerId: randomUUID(), organizationId: actor.organizationId, programId: command.programId, curriculum: read.current, revision: 1, state: 'draft', authoredBy: actor.personId, authoredAt: stamp() }, command, actor, null);
          return { action: 'create', offer: record(offer, actor, 'create') };
        }
        case 'revise': {
          const offer = owned(actor, command.offerId, command.expectedRevision);
          if (offer.state !== 'draft') throw new ProgramOfferError('state_invalid');
          const next = terms({ ...offer, revision: offer.revision + 1 }, command, actor, offer);
          return { action: 'revise', offer: record(next, actor, 'revise') };
        }
        case 'approve_provider_mapping': {
          const offer = owned(actor, command.offerId, command.expectedRevision);
          if (offer.state !== 'draft' || offer.mode !== 'paid' || !offer.providerPrice) throw new ProgramOfferError('state_invalid');
          const next = programOffer.parse({ ...offer, revision: offer.revision + 1, providerPrice: { ...offer.providerPrice, approval: { by: actor.personId, at: stamp() } } });
          return { action: 'approve_provider_mapping', offer: record(next, actor, 'approve_provider_mapping', offer.providerPrice.priceRef) };
        }
        case 'publish': {
          const offer = owned(actor, command.offerId, command.expectedRevision);
          if (offer.state !== 'draft') throw new ProgramOfferError('state_invalid');
          const read = await readCurriculum(actor.organizationId, offer.programId);
          const holds = publishHolds(offer, read?.current ?? null);
          if (holds.length) throw new ProgramOfferError('publish_refused', holds);
          if ([...offers.values()].some(o => o.organizationId === actor.organizationId && o.programId === offer.programId && o.state === 'published')) throw new ProgramOfferError('state_invalid', ['another_offer_published']);
          const next = programOffer.parse({ ...offer, revision: offer.revision + 1, state: 'published' });
          return { action: 'publish', offer: record(next, actor, 'publish') };
        }
        case 'retire': {
          const offer = owned(actor, command.offerId, command.expectedRevision);
          if (offer.state === 'retired') throw new ProgramOfferError('state_invalid');
          const next = programOffer.parse({ ...offer, revision: offer.revision + 1, state: 'retired' });
          return { action: 'retire', offer: record(next, actor, 'retire', command.reason) };
        }
      }
    },
    async read(actor, offerId) {
      const offer = offers.get(offerId);
      return offer && offer.organizationId === actor.organizationId ? structuredClone(offer) : null;
    },
    async availability(organizationId, programId) {
      try {
        options.faults?.before?.('availability');
        const read = await readCurriculum(organizationId, programId);
        if (!read) return unavailable('offer_absent');
        const mine = [...offers.values()].filter(o => o.organizationId === organizationId && o.programId === programId);
        const published = mine.find(o => o.state === 'published') ?? null;
        if (!published) return unavailable(mine.some(o => o.state === 'draft') ? 'offer_draft' : mine.length ? 'offer_retired' : 'offer_absent');
        return purchaseAvailability(published, read.current);
      } catch {
        return unavailable('commerce_unverifiable');
      }
    },
  };
}
