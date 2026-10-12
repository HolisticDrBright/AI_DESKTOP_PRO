import { z } from 'zod';
import { educationCurriculumRead, educationEnrollment, programClaim, programEntitlement, type EducationEnrollment, type ProgramClaim, type ProgramEntitlement } from '../../contracts/programEducationAccess';
import { programOrder, type ProgramOrder } from '../../contracts/programCheckout';
import { ClinicalCoreDatabaseRejection, clinicalUuid, type ClinicalCoreDatabase } from '../clinical-core/database';
import { PROGRAM_OFFER_SCHEMA_CANDIDATE_SHA256, programCommerceActivationState } from './program-commerce-activation';
import { PROGRAM_CHECKOUT_RECOVERY_SCHEMA_CANDIDATE_SHA256, PROGRAM_CHECKOUT_SCHEMA_CANDIDATE_SHA256 } from './program-checkout-ledger-sql';
import { EducationLedgerError, type ClaimOutcome, type DeliveryRecord, type EducationLedgerCategory, type ProgramEducationLedger } from './program-education-ledger';

/**
 * The SQL-backed education access ledger over the BLOCKED candidate
 * (infra/aws-clinical-core/source-candidates/program-education-access.sql) and its BLOCKED successor
 * (program-education-delivery.sql). Three database handles, one per authority, each a session of its
 * own reduced role that the host constructs (this source constructs none):
 *   database  the API role: settlement, claim, reads, policy, staff status;
 *   delivery  commercial_education_delivery: the due sealed codes and the record of each attempt;
 *   operator  commercial_education_operator: a replacement code.
 * A missing handle refuses its calls as unavailable. Constructed disabled unless evidence names every
 * candidate it was built against; every function re-checks the activation row. Refusals are
 * categories; no SQL text leaves this module.
 */
/** SHA-256 of infra/aws-clinical-core/source-candidates/program-education-access.sql, held equal to the file by its test. */
export const PROGRAM_EDUCATION_SCHEMA_CANDIDATE_SHA256 = 'e4f11e29f1b6a68f1478dbc112aaac1ea2bbf72adf86f9458dd5a20c8151df93';
/** SHA-256 of infra/aws-clinical-core/source-candidates/program-education-delivery.sql (successor; parent above), held equal to the file by its test. */
export const PROGRAM_EDUCATION_DELIVERY_SCHEMA_CANDIDATE_SHA256 = '653965ff19f1d522067a6b636ac4ed5a4d2f9f1696cbb692c9545e3fc2046ae6';

export type SqlEducationLedgerDependencies = {
  database: ClinicalCoreDatabase; delivery?: ClinicalCoreDatabase; operator?: ClinicalCoreDatabase; activation?: unknown;
  checkoutCandidateSha256?: string; checkoutRecoveryCandidateSha256?: string; educationCandidateSha256?: string; educationDeliveryCandidateSha256?: string;
};

const settled = z.object({ created: z.boolean(), entitlement: programEntitlement, claim: programClaim }).strict();
const sealedCode = z.object({ keyRef: z.string().min(1).max(200), iv: z.string().min(1).max(200), ciphertext: z.string().min(1).max(4000), tag: z.string().min(1).max(200) }).strict();
const timestamp = z.string().datetime({ offset: true });
const deliveryRecord: z.ZodType<DeliveryRecord> = z.object({
  deliveryId: z.string().uuid(), claimId: z.string().uuid(), entitlementId: z.string().uuid(), orderId: z.string().uuid(),
  state: z.enum(['pending', 'provider_unknown', 'accepted', 'failed', 'withdrawn']), sealed: sealedCode.nullable(), attempts: z.number().int().min(0),
  nextAttemptAt: timestamp.nullable(), lastAttemptAt: timestamp.nullable(), acceptedAt: timestamp.nullable(), providerRef: z.string().nullable(), lastOutcome: z.string().nullable(), claimExpiresAt: timestamp,
}).strict();
const reissued = z.object({ claim: programClaim, superseded: z.number().int().min(0) }).strict();
const claimed = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('claimed'), entitlement: programEntitlement, enrollment: educationEnrollment }).strict(),
  z.object({ outcome: z.literal('refused'), reason: z.enum(['claim_invalid', 'claim_expired', 'claim_used', 'claim_superseded', 'entitlement_not_claimable', 'already_claimed_by_other']) }).strict(),
]);
const access = z.object({ entitlements: z.array(programEntitlement), enrollments: z.array(educationEnrollment) }).strict();
const status = access.extend({ claims: z.array(programClaim), orders: z.array(programOrder) }).strict();
const CATEGORY: Record<string, EducationLedgerCategory> = {
  program_entitlement_not_found: 'not_found', program_entitlement_revision_stale: 'revision_stale', program_entitlement_transition_refused: 'transition_refused',
  program_entitlement_settlement_refused: 'settlement_refused', program_entitlement_request_invalid: 'request_invalid', program_entitlement_snapshot_mismatch: 'settlement_refused',
  program_entitlement_order_not_verified: 'settlement_refused', program_entitlement_identity_immutable: 'transition_refused', program_entitlement_subject_immutable: 'transition_refused',
  program_entitlement_revision_must_increase: 'transition_refused', program_claim_settled: 'transition_refused', program_offer_activation_refused: 'store_unavailable',
  program_delivery_not_found: 'not_found', program_delivery_revision_stale: 'revision_stale', program_delivery_settled: 'transition_refused', program_delivery_request_invalid: 'request_invalid',
  program_delivery_attempt_must_increase: 'transition_refused', program_delivery_sealed_immutable: 'transition_refused', program_delivery_identity_immutable: 'transition_refused',
};
function rethrow(error: unknown): never {
  if (error instanceof EducationLedgerError) throw error;
  if (error instanceof ClinicalCoreDatabaseRejection) {
    const match = error.reason ? /^(program_(?:entitlement|claim|delivery)_[a-z_]+|program_offer_activation_refused)(?::([a-z_]+))?/.exec(error.reason) : null;
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
    && deps.checkoutCandidateSha256 === PROGRAM_CHECKOUT_SCHEMA_CANDIDATE_SHA256 && deps.checkoutRecoveryCandidateSha256 === PROGRAM_CHECKOUT_RECOVERY_SCHEMA_CANDIDATE_SHA256
    && deps.educationCandidateSha256 === PROGRAM_EDUCATION_SCHEMA_CANDIDATE_SHA256 && deps.educationDeliveryCandidateSha256 === PROGRAM_EDUCATION_DELIVERY_SCHEMA_CANDIDATE_SHA256;
  const guard = () => { if (!enabled) throw new EducationLedgerError('store_unavailable'); };
  const on = async <T>(database: ClinicalCoreDatabase | undefined, schema: z.ZodType<T>, sql: string, params: unknown[]): Promise<T> => {
    guard();
    if (!database) throw new EducationLedgerError('store_unavailable');
    try { return await database.transaction(async tx => decode(schema, (await tx.query<{ data: unknown }>(sql, params)).rows[0]?.data)); }
    catch (error) { return rethrow(error); }
  };
  const one = <T>(schema: z.ZodType<T>, sql: string, params: unknown[]): Promise<T> => on(deps.database, schema, sql, params);
  const nullable = async <T>(schema: z.ZodType<T>, sql: string, params: unknown[]): Promise<T | null> => {
    guard();
    try {
      return await deps.database.transaction(async tx => { const value = (await tx.query<{ data: unknown }>(sql, params)).rows[0]?.data; return value === null || value === undefined ? null : decode(schema, value); });
    } catch (error) { return rethrow(error); }
  };
  return {
    async settle(order, issue, expectedAccountRef) {
      return one(settled, 'select commercial_education.settle_program_order_sealed($1,$2,$3,$4::timestamptz,$5::jsonb,$6) as data', [clinicalUuid(order.orderId), clinicalUuid(issue.claimId), issue.tokenHash, issue.claimExpiresAt, JSON.stringify(issue.sealed), expectedAccountRef]);
    },
    async dueDeliveries(at, limit) { return on(deps.delivery, z.array(deliveryRecord), 'select commercial_education.due_program_claim_deliveries($1::timestamptz,$2) as data', [at, limit]); },
    async recordDelivery(deliveryId, expectedAttempts, outcome) {
      return on(deps.delivery, deliveryRecord, 'select commercial_education.record_program_claim_delivery($1,$2,$3::jsonb) as data', [clinicalUuid(deliveryId), expectedAttempts, JSON.stringify(outcome)]);
    },
    async reissueClaim(operator, entitlementId, issue) {
      if (operator?.kind !== 'operator') throw new EducationLedgerError('request_invalid');
      return on(deps.operator, reissued, 'select commercial_education.reissue_program_claim($1,$2,$3,$4::timestamptz,$5::jsonb,$6) as data', [clinicalUuid(entitlementId), clinicalUuid(issue.claimId), issue.tokenHash, issue.claimExpiresAt, JSON.stringify(issue.sealed), operator.operatorId]);
    },
    async unsettledOrders(limit) { return one(z.array(programOrder), 'select commercial_education.unsettled_program_orders($1) as data', [limit]); },
    async claim(tokenHash, consumerSubject, at): Promise<ClaimOutcome> { return one(claimed, 'select commercial_education.claim_program_entitlement($1,$2,$3::timestamptz) as data', [tokenHash, consumerSubject, at]); },
    async readEntitlement(entitlementId): Promise<ProgramEntitlement | null> { return nullable(programEntitlement, 'select commercial_education.read_program_entitlement($1) as data', [clinicalUuid(entitlementId)]); },
    async entitlementForOrder(orderId) { return nullable(programEntitlement, 'select commercial_education.entitlement_for_order($1) as data', [clinicalUuid(orderId)]); },
    async access(consumerSubject): Promise<{ entitlements: ProgramEntitlement[]; enrollments: EducationEnrollment[] }> { return one(access, 'select commercial_education.education_access($1) as data', [consumerSubject]); },
    async recordPolicy(orderId, kind, reference, at) { return one(programEntitlement, 'select commercial_education.record_entitlement_policy($1,$2,$3,$4::timestamptz) as data', [clinicalUuid(orderId), kind, reference, at]); },
    async transition(entitlementId, expectedRevision, next) { return one(programEntitlement, 'select commercial_education.transition_program_entitlement($1,$2,$3) as data', [clinicalUuid(entitlementId), expectedRevision, next]); },
    async expireDue(at) { return one(z.array(programEntitlement), 'select commercial_education.expire_program_entitlements($1::timestamptz) as data', [at]); },
    async listForProgram(organizationId, programId): Promise<{ orders: ProgramOrder[]; entitlements: ProgramEntitlement[]; enrollments: EducationEnrollment[]; claims: ProgramClaim[] }> {
      return one(status, 'select commercial_education.program_education_status($1,$2) as data', [clinicalUuid(organizationId), clinicalUuid(programId)]);
    },
    async staffCurriculum(actor, entitlementId) {
      guard();
      try {
        return await deps.database.transaction(async tx => {
          await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)', [clinicalUuid(actor.personId), clinicalUuid(actor.organizationId), 'workforce', actor.identitySubject, 'clinical_data', 'synthetic-staging', 'synthetic_only']);
          return decode(educationCurriculumRead, (await tx.query<{ data: unknown }>('select commercial_education.education_curriculum_staff($1,$2) as data', [clinicalUuid(actor.organizationId), clinicalUuid(entitlementId)])).rows[0]?.data);
        });
      } catch (error) { return rethrow(error); }
    },
  };
}
