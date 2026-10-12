import { z } from 'zod';
import { educationEnrollment, programClaim, programEntitlement, type EducationEnrollment, type ProgramClaim, type ProgramEntitlement } from '../../contracts/programEducationAccess';
import { programOrder } from '../../contracts/programCheckout';
import { ClinicalCoreDatabaseRejection, clinicalUuid, type ClinicalCoreDatabase } from '../clinical-core/database';
import { PROGRAM_OFFER_SCHEMA_CANDIDATE_SHA256, programCommerceActivationState } from './program-commerce-activation';
import { PROGRAM_CHECKOUT_SCHEMA_CANDIDATE_SHA256 } from './program-checkout-ledger-sql';
import { EducationLedgerError, type ClaimOutcome, type EducationLedgerCategory, type ProgramEducationLedger } from './program-education-ledger';

/**
 * The SQL-backed education access ledger over the BLOCKED candidate
 * (infra/aws-clinical-core/source-candidates/program-education-access.sql) through the API role.
 * Constructed disabled unless evidence names all three candidates it was built against; every
 * function re-checks the activation row. Refusals are categories; no SQL text leaves this module.
 */
/** SHA-256 of infra/aws-clinical-core/source-candidates/program-education-access.sql, held equal to the file by its test. */
export const PROGRAM_EDUCATION_SCHEMA_CANDIDATE_SHA256 = '5086de3b990394a47244bda96617e8bbb4f4f979b8aca7cfbccab7d35d343dc1';

export type SqlEducationLedgerDependencies = { database: ClinicalCoreDatabase; activation?: unknown; checkoutCandidateSha256?: string; educationCandidateSha256?: string };

const settled = z.object({ created: z.boolean(), entitlement: programEntitlement, claim: programClaim }).strict();
const claimed = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('claimed'), entitlement: programEntitlement, enrollment: educationEnrollment }).strict(),
  z.object({ outcome: z.literal('refused'), reason: z.enum(['claim_invalid', 'claim_expired', 'claim_used', 'claim_superseded', 'entitlement_not_claimable', 'already_claimed_by_other']) }).strict(),
]);
const access = z.object({ entitlements: z.array(programEntitlement), enrollments: z.array(educationEnrollment) }).strict();
const status = access.extend({ claims: z.array(programClaim) }).strict();
const CATEGORY: Record<string, EducationLedgerCategory> = {
  program_entitlement_not_found: 'not_found', program_entitlement_revision_stale: 'revision_stale', program_entitlement_transition_refused: 'transition_refused',
  program_entitlement_settlement_refused: 'settlement_refused', program_entitlement_request_invalid: 'request_invalid', program_entitlement_snapshot_mismatch: 'settlement_refused',
  program_entitlement_order_not_verified: 'settlement_refused', program_entitlement_identity_immutable: 'transition_refused', program_entitlement_subject_immutable: 'transition_refused',
  program_entitlement_revision_must_increase: 'transition_refused', program_claim_settled: 'transition_refused', program_offer_activation_refused: 'store_unavailable',
};
function rethrow(error: unknown): never {
  if (error instanceof EducationLedgerError) throw error;
  if (error instanceof ClinicalCoreDatabaseRejection) {
    const match = error.reason ? /^(program_(?:entitlement|claim)_[a-z_]+|program_offer_activation_refused)(?::([a-z_]+))?/.exec(error.reason) : null;
    if (match && CATEGORY[match[1]!]) throw new EducationLedgerError(CATEGORY[match[1]!], match[2]);
    throw new EducationLedgerError(error.category === 'request_invalid' ? 'request_invalid' : 'store_unavailable');
  }
  throw new EducationLedgerError('store_unavailable');
}
const decode = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(typeof value === 'string' ? JSON.parse(value) : value);
  if (!parsed.success) throw new EducationLedgerError('store_unavailable');
  return parsed.data;
};

export function createSqlEducationLedger(deps: SqlEducationLedgerDependencies): ProgramEducationLedger {
  const activation = programCommerceActivationState(deps.activation);
  const enabled = activation.enabled && activation.schemaCandidateSha256 === PROGRAM_OFFER_SCHEMA_CANDIDATE_SHA256
    && deps.checkoutCandidateSha256 === PROGRAM_CHECKOUT_SCHEMA_CANDIDATE_SHA256 && deps.educationCandidateSha256 === PROGRAM_EDUCATION_SCHEMA_CANDIDATE_SHA256;
  const guard = () => { if (!enabled) throw new EducationLedgerError('store_unavailable'); };
  const one = async <T>(schema: z.ZodType<T>, sql: string, params: unknown[]): Promise<T> => {
    guard();
    try { return await deps.database.transaction(async tx => decode(schema, (await tx.query<{ data: unknown }>(sql, params)).rows[0]?.data)); }
    catch (error) { return rethrow(error); }
  };
  const nullable = async <T>(schema: z.ZodType<T>, sql: string, params: unknown[]): Promise<T | null> => {
    guard();
    try {
      return await deps.database.transaction(async tx => { const value = (await tx.query<{ data: unknown }>(sql, params)).rows[0]?.data; return value === null || value === undefined ? null : decode(schema, value); });
    } catch (error) { return rethrow(error); }
  };
  return {
    async settle(order, tokenHash, claimExpiresAt, expectedAccountRef) {
      return one(settled, 'select commercial_education.settle_program_order($1,$2,$3::timestamptz,$4) as data', [clinicalUuid(order.orderId), tokenHash, claimExpiresAt, expectedAccountRef]);
    },
    async unsettledOrders(limit) { return one(z.array(programOrder), 'select commercial_education.unsettled_program_orders($1) as data', [limit]); },
    async claim(tokenHash, consumerSubject, at): Promise<ClaimOutcome> { return one(claimed, 'select commercial_education.claim_program_entitlement($1,$2,$3::timestamptz) as data', [tokenHash, consumerSubject, at]); },
    async readEntitlement(entitlementId): Promise<ProgramEntitlement | null> { return nullable(programEntitlement, 'select commercial_education.read_program_entitlement($1) as data', [clinicalUuid(entitlementId)]); },
    async entitlementForOrder(orderId) { return nullable(programEntitlement, 'select commercial_education.entitlement_for_order($1) as data', [clinicalUuid(orderId)]); },
    async access(consumerSubject): Promise<{ entitlements: ProgramEntitlement[]; enrollments: EducationEnrollment[] }> { return one(access, 'select commercial_education.education_access($1) as data', [consumerSubject]); },
    async recordPolicy(orderId, kind, reference, at) { return one(programEntitlement, 'select commercial_education.record_entitlement_policy($1,$2,$3,$4::timestamptz) as data', [clinicalUuid(orderId), kind, reference, at]); },
    async transition(entitlementId, expectedRevision, next) { return one(programEntitlement, 'select commercial_education.transition_program_entitlement($1,$2,$3) as data', [clinicalUuid(entitlementId), expectedRevision, next]); },
    async expireDue(at) { return one(z.array(programEntitlement), 'select commercial_education.expire_program_entitlements($1::timestamptz) as data', [at]); },
    async listForProgram(organizationId, programId): Promise<{ entitlements: ProgramEntitlement[]; enrollments: EducationEnrollment[]; claims: ProgramClaim[] }> {
      return one(status, 'select commercial_education.program_education_status($1,$2) as data', [clinicalUuid(organizationId), clinicalUuid(programId)]);
    },
  };
}
