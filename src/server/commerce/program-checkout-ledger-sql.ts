import { z } from 'zod';
import { INTAKE_STATES, ORDER_STATES, intakeRecord, programOrder, type IntakeRecord, type ProgramOrder } from '../../contracts/programCheckout';
import { ClinicalCoreDatabaseRejection, clinicalUuid, type ClinicalCoreDatabase } from '../clinical-core/database';
import { PROGRAM_OFFER_SCHEMA_CANDIDATE_SHA256, programCommerceActivationState } from './program-commerce-activation';
import { PROGRAM_COMMERCE_AUTHORITY_SCHEMA_CANDIDATE_SHA256 } from './program-commerce-authority';
import { CheckoutLedgerError, type CheckoutWorkStatus, type LedgerCategory, type ProgramCheckoutLedger } from './program-checkout-ledger';

/**
 * The SQL-backed checkout ledger over the BLOCKED candidate
 * (infra/aws-clinical-core/source-candidates/program-checkout-orders.sql) and its BLOCKED successor
 * (program-checkout-recovery.sql, program-checkout/2), under the authority split of
 * program-commerce-authority.sql. Two instances, one per authority, each over a session of its own
 * role that the host constructs (this source constructs none):
 *   `request`  the API role: the visitor's admission, the creation-side order transitions (through
 *              advance_program_checkout, which can never record a payment outcome), the order read
 *              behind the return page, and webhook admission;
 *   `worker`   commercial_education_worker: intake processing, every order transition including the
 *              observed payment outcomes, the reconciliation list and the counts.
 * A call the instance's role may not make is refused by the database and surfaces as unavailable. It is constructed
 * disabled unless activation evidence names EVERY candidate it was built against (the offer
 * candidate the evidence contract pins, and the two checkout digests pinned here), and every
 * function it calls re-checks the database's own activation row. Visitors have no request context, and none of these
 * functions needs one: the server names the clinic and program from the funnel definition. No SQL
 * text or identifier leaves this module; refusals are categories.
 */
/** SHA-256 of infra/aws-clinical-core/source-candidates/program-checkout-orders.sql, held equal to the file by its test. */
export const PROGRAM_CHECKOUT_SCHEMA_CANDIDATE_SHA256 = '767ac13bc111a15b98bdc2978a5e42a33f5f1ab61f010061907787040b0c37ee';
/** SHA-256 of infra/aws-clinical-core/source-candidates/program-checkout-recovery.sql (successor; parent above), held equal to the file by its test. */
export const PROGRAM_CHECKOUT_RECOVERY_SCHEMA_CANDIDATE_SHA256 = '29d85d75da43176b1a6d007afc5a0a892f99a08994f44bb459a4a756e2e2efc0';

export type SqlCheckoutLedgerDependencies = { database: ClinicalCoreDatabase; authority?: 'request' | 'worker'; activation?: unknown; checkoutCandidateSha256?: string; checkoutRecoveryCandidateSha256?: string; commerceAuthorityCandidateSha256?: string };

const admitted = z.object({ reused: z.boolean(), order: programOrder }).strict();
const intakeAdmitted = z.object({ duplicate: z.boolean(), record: intakeRecord }).strict();
const CATEGORY: Record<string, LedgerCategory> = {
  program_order_not_found: 'order_not_found', program_order_revision_stale: 'revision_stale', program_order_transition_refused: 'transition_refused',
  program_order_session_immutable: 'transition_refused', program_order_verification_immutable: 'transition_refused', program_order_verification_session_mismatch: 'transition_refused',
  program_order_verification_needs_settlement: 'transition_refused', program_order_identity_immutable: 'transition_refused', program_order_revision_must_increase: 'transition_refused',
  program_order_snapshot_mismatch: 'request_invalid', program_order_insert_shape: 'request_invalid', program_order_offer_unavailable: 'request_invalid',
  program_intake_settled: 'transition_refused', program_intake_attempt_must_increase: 'transition_refused', program_intake_exhausted: 'transition_refused',
  program_intake_identity_immutable: 'transition_refused', program_intake_insert_shape: 'request_invalid', program_offer_activation_refused: 'store_unavailable',
  program_order_creation_immutable: 'transition_refused', program_order_states_refused: 'request_invalid',
};
const workStatus = z.object({
  orders: z.record(z.enum(ORDER_STATES), z.number().int().min(0)),
  intake: z.record(z.enum(INTAKE_STATES), z.number().int().min(0)),
  oldestUnresolvedAt: z.string().datetime({ offset: true }).nullable(),
}).strict();
function rethrow(error: unknown): never {
  if (error instanceof CheckoutLedgerError) throw error;
  if (error instanceof ClinicalCoreDatabaseRejection) {
    const token = error.reason ? /^(program_(?:order|intake)_[a-z_]+|program_offer_activation_refused)/.exec(error.reason)?.[1] : undefined;
    if (token && CATEGORY[token]) throw new CheckoutLedgerError(CATEGORY[token]);
    throw new CheckoutLedgerError(error.category === 'request_invalid' ? 'request_invalid' : error.category === 'conflict' ? 'transition_refused' : 'store_unavailable');
  }
  throw new CheckoutLedgerError('store_unavailable');
}
const decode = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(typeof value === 'string' ? JSON.parse(value) : value);
  if (!parsed.success) throw new CheckoutLedgerError('store_unavailable');
  return parsed.data;
};

export function createSqlCheckoutLedger(deps: SqlCheckoutLedgerDependencies): ProgramCheckoutLedger {
  const activation = programCommerceActivationState(deps.activation);
  const enabled = activation.enabled && activation.schemaCandidateSha256 === PROGRAM_OFFER_SCHEMA_CANDIDATE_SHA256 && deps.checkoutCandidateSha256 === PROGRAM_CHECKOUT_SCHEMA_CANDIDATE_SHA256
    && deps.checkoutRecoveryCandidateSha256 === PROGRAM_CHECKOUT_RECOVERY_SCHEMA_CANDIDATE_SHA256 && deps.commerceAuthorityCandidateSha256 === PROGRAM_COMMERCE_AUTHORITY_SCHEMA_CANDIDATE_SHA256;
  /** The request path records creation-side transitions only; the worker records every transition. */
  const transitionFunction = (deps.authority ?? 'request') === 'worker' ? 'transition_program_order' : 'advance_program_checkout';
  const guard = () => { if (!enabled) throw new CheckoutLedgerError('store_unavailable'); };
  const one = async <T>(schema: z.ZodType<T>, sql: string, params: unknown[]): Promise<T> => {
    guard();
    try {
      return await deps.database.transaction(async tx => decode(schema, (await tx.query<{ data: unknown }>(sql, params)).rows[0]?.data));
    } catch (error) { return rethrow(error); }
  };
  const nullable = async <T>(schema: z.ZodType<T>, sql: string, params: unknown[]): Promise<T | null> => {
    guard();
    try {
      return await deps.database.transaction(async tx => { const value = (await tx.query<{ data: unknown }>(sql, params)).rows[0]?.data; return value === null || value === undefined ? null : decode(schema, value); });
    } catch (error) { return rethrow(error); }
  };
  return {
    async admitOrder(admission) {
      return one(admitted, 'select commercial_education.admit_program_order($1,$2,$3,$4) as data', [admission.attemptKeyHash, admission.funnelSlug, clinicalUuid(admission.organizationId), clinicalUuid(admission.programId)]);
    },
    async readOrder(orderId) { return nullable(programOrder, 'select commercial_education.read_program_order($1) as data', [clinicalUuid(orderId)]); },
    async findOrderBySession(sessionRef) { return nullable(programOrder, 'select commercial_education.find_program_order_by_session($1) as data', [sessionRef]); },
    async transition(orderId, expectedRevision, next, carry = {}): Promise<ProgramOrder> {
      return one(programOrder, `select commercial_education.${transitionFunction}($1,$2,$3,$4::jsonb) as data`, [clinicalUuid(orderId), expectedRevision, next, JSON.stringify({ creation: carry.creation ?? null, processor: carry.processor ?? null, verification: carry.verification ?? null })]);
    },
    // The state list travels as JSON text: the RDS Data API carries no array parameter, so a JS array here never reached the database hosted.
    async ordersInStates(states, limit) { return one(z.array(programOrder), 'select commercial_education.program_orders_in_states(array(select jsonb_array_elements_text($1::jsonb)),$2) as data', [JSON.stringify(states), limit]); },
    async workStatus(): Promise<CheckoutWorkStatus> {
      const status = await one(workStatus, 'select commercial_education.checkout_work_status() as data', []);
      return { orders: status.orders as CheckoutWorkStatus['orders'], intake: status.intake as CheckoutWorkStatus['intake'], oldestUnresolvedAt: status.oldestUnresolvedAt };
    },
    async admitIntake(admission) { return one(intakeAdmitted, 'select commercial_education.admit_checkout_intake($1::jsonb) as data', [JSON.stringify(admission)]); },
    async readIntake(eventId) { return nullable(intakeRecord, 'select commercial_education.read_checkout_intake($1) as data', [eventId]); },
    async settleIntake(eventId, outcome): Promise<IntakeRecord> { return one(intakeRecord, 'select commercial_education.settle_checkout_intake($1,$2::jsonb) as data', [eventId, JSON.stringify(outcome)]); },
    async dueIntake(now, limit) { return one(z.array(intakeRecord), 'select commercial_education.due_checkout_intake($1::timestamptz,$2) as data', [now, limit]); },
  };
}
