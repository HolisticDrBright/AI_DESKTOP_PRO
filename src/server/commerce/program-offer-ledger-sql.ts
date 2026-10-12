import { PURCHASE_HOLD_REASONS, programOffer, programOfferCommand, curriculumBinding, offerPricing, unavailable, type PurchaseAvailability } from '../../contracts/programOffers';
import { ClinicalCoreDatabaseRejection, clinicalUuid, type ClinicalCoreDatabase, type ClinicalCoreTransaction } from '../clinical-core/database';
import { programCommerceActivationState } from './program-commerce-activation';
import { ProgramOfferError, type OfferActor, type OfferLedgerCategory, type ProgramOfferLedger, type ProgramOfferResult } from './program-offer-ledger';
import { z } from 'zod';

/**
 * The SQL-backed offer ledger: the same contract as the fictional one, spoken to the BLOCKED
 * candidate (infra/aws-clinical-core/source-candidates/program-offer-revisions.sql) through the API
 * role. It is constructed disabled and stays disabled unless activation evidence names the exact
 * candidate it was built against; the database's own activation row is checked again by every
 * function it calls. The request context it sets is the synthetic one: the only target this source
 * knows. No SQL text, identifier or provider message leaves this module; refusals are categories.
 */
export type SqlOfferLedgerDependencies = {
  database: ClinicalCoreDatabase;
  activation?: unknown;
  /** The actor's identity as the request context needs it; the ledger does not invent one. */
  identity: (actor: OfferActor) => { identityPool: 'workforce'; identitySubject: string };
};

const result = z.discriminatedUnion('action', [
  z.object({ action: z.enum(['create', 'revise', 'approve_provider_mapping', 'publish', 'retire']), offer: programOffer }).strict(),
  z.object({ action: z.literal('list'), offers: z.array(programOffer), curriculum: curriculumBinding.nullable() }).strict(),
]);
const availability = z.discriminatedUnion('available', [
  z.object({ available: z.literal(false), reason: z.enum(PURCHASE_HOLD_REASONS) }).strict(),
  z.object({ available: z.literal(true), offerId: z.string().uuid(), revision: z.number().int(), name: z.string(), pricing: offerPricing, curriculum: curriculumBinding, accessTermsVersion: z.string(), accessDurationDays: z.number().int().nullable(), providerPriceRef: z.string().regex(/^price_[A-Za-z0-9]{8,64}$/) }).strict(),
]);

const CATEGORY: Record<string, OfferLedgerCategory> = {
  program_offer_request_invalid: 'request_invalid', program_offer_program_not_found: 'program_not_found', program_offer_not_found: 'offer_not_found',
  program_offer_revision_stale: 'revision_stale', program_offer_state_invalid: 'state_invalid', program_offer_curriculum_unpublished: 'curriculum_unpublished',
  program_offer_publish_refused: 'publish_refused', program_offer_identity_refused: 'identity_refused', program_offer_activation_refused: 'activation_refused',
};
export function classifyOfferRejection(message: string): ProgramOfferError {
  const match = /program_offer_[a-z_]+/.exec(message);
  const category = match ? CATEGORY[match[0]] : undefined;
  if (!category) return new ProgramOfferError(/violates|constraint|invalid input|out of range/.test(message) ? 'request_invalid' : 'service_unavailable');
  const detail = message.slice(message.indexOf(match![0]) + match![0].length);
  const holds = detail.startsWith(':') ? detail.slice(1).split(',').filter(Boolean) : [];
  return new ProgramOfferError(category, holds);
}

export function createSqlProgramOfferLedger(deps: SqlOfferLedgerDependencies): ProgramOfferLedger {
  const activation = programCommerceActivationState(deps.activation);
  const context = async (tx: ClinicalCoreTransaction, actor: OfferActor) => {
    const identity = deps.identity(actor);
    await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)', [
      clinicalUuid(actor.personId), clinicalUuid(actor.organizationId), identity.identityPool, identity.identitySubject, 'clinical_data', 'synthetic-staging', 'synthetic_only',
    ]);
  };
  const rethrow = (error: unknown): never => {
    if (error instanceof ProgramOfferError) throw error;
    if (error instanceof ClinicalCoreDatabaseRejection) {
      if (error.reason?.startsWith('program_offer_')) throw classifyOfferRejection(error.reason);
      throw new ProgramOfferError(error.category === 'identity_refused' ? 'identity_refused' : error.category === 'request_invalid' ? 'request_invalid' : 'service_unavailable');
    }
    throw new ProgramOfferError('service_unavailable');
  };
  return {
    async execute(actor, raw) {
      if (!activation.enabled) throw new ProgramOfferError('activation_refused');
      const parsed = programOfferCommand.safeParse(raw);
      if (!parsed.success) throw new ProgramOfferError('request_invalid');
      try {
        return await deps.database.transaction(async tx => {
          await context(tx, actor);
          const row = await tx.query<{ data: unknown }>('select commercial_education.execute_program_offer_command($1::jsonb) as data', [JSON.stringify(parsed.data)]);
          const value = row.rows[0]?.data;
          const decoded = result.safeParse(typeof value === 'string' ? JSON.parse(value) : value);
          if (!decoded.success) throw new ProgramOfferError('service_unavailable');
          return decoded.data as ProgramOfferResult;
        });
      } catch (error) { return rethrow(error); }
    },
    async read(actor, offerId) {
      if (!activation.enabled) throw new ProgramOfferError('activation_refused');
      if (!z.string().uuid().safeParse(offerId).success) throw new ProgramOfferError('request_invalid');
      try {
        return await deps.database.transaction(async tx => {
          await context(tx, actor);
          const row = await tx.query<{ data: unknown }>('select commercial_education.read_program_offer($1) as data', [clinicalUuid(offerId)]);
          const value = row.rows[0]?.data;
          if (value === null || value === undefined) return null;
          const decoded = programOffer.safeParse(typeof value === 'string' ? JSON.parse(value) : value);
          if (!decoded.success) throw new ProgramOfferError('service_unavailable');
          return decoded.data;
        });
      } catch (error) { return rethrow(error); }
    },
    async availability(organizationId, programId): Promise<PurchaseAvailability> {
      if (!activation.enabled) return unavailable('commerce_disabled');
      try {
        return await deps.database.transaction(async tx => {
          const row = await tx.query<{ data: unknown }>('select commercial_education.program_purchase_availability($1,$2) as data', [clinicalUuid(organizationId), clinicalUuid(programId)]);
          const value = row.rows[0]?.data;
          const decoded = availability.safeParse(typeof value === 'string' ? JSON.parse(value) : value);
          if (!decoded.success) return unavailable('commerce_unverifiable');
          return decoded.data.available ? decoded.data : unavailable(decoded.data.reason);
        });
      } catch { return unavailable('commerce_unverifiable'); }
    },
  };
}
