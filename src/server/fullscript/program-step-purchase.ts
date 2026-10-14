if (typeof window !== 'undefined') throw new Error('Program step purchases are server-only.');
import { z } from 'zod';
import { FULLSCRIPT_CONSUMER_ACTION, type ProductActionIssued, type ProductActionRedeemed } from '@/contracts/fullscriptConsumerAction';
import {
  PROGRAM_STEP_PURCHASE, PROGRAM_STEP_REFUSALS, programStepPurchaseRequest, programStepRedemptionRequest,
  type ProgramStepBinding, type ProgramStepPurchaseRefusal, type ProgramStepRefusal,
} from '@/contracts/programStepPurchase';
import { clinicalUuid, ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase } from '../clinical-core/database';
import type { ClinicalRequestContext } from '../clinical-core/aws-identity-consent';
import { PRODUCTION_PROGRAM_SCHEMA_CANDIDATE_SHA256 } from '../clinical-core/production-program-assignments';

/**
 * A purchase action for one program step (program-step-purchase/1): a source-only adapter, DISABLED, over the BLOCKED
 * successor infra/aws-clinical-core/production-candidates/program-step-purchase.sql and the disabled consumer-action
 * candidate. Nothing routes here. It exists so the binding and its refusals are reviewed as code before anyone
 * decides to release program purchases; the education-only Core release has no purchase release at all, so even with
 * this adapter's evidence every call ends at the consumer candidate's `commerce_disabled`.
 *
 * Order, at issue and again at redemption: this adapter's activation (else program_step_purchase_disabled, before
 * anything is read); the consumer candidate's release, session and admission; the server's CURRENT program review for
 * this exact step and binding (the port below); then the offer, the destination and, at redemption, the atomic spend.
 * An action issued for a step records the binding and can be redeemed only here; the plain path does not know it.
 */
export const PROGRAM_STEP_PURCHASE_CANDIDATE_SHA256 = 'ad66f389221ca77681bc94a0f75b9d6ab45d9656e3431cce22e5cd026de042de';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const programStepPurchaseActivation = z.discriminatedUnion('enabled', [
  z.object({ contract: z.literal('program-step-purchase-activation/1'), enabled: z.literal(false) }).strict(),
  z.object({
    contract: z.literal('program-step-purchase-activation/1'), enabled: z.literal(true), target: z.literal('production-clinical'),
    programCandidateSha256: digest, stepCandidateSha256: digest, evidenceSha256: digest,
    reviewedBy: z.string().trim().min(1).max(200), reviewedAt: z.string().datetime({ offset: true }),
  }).strict(),
]);
export type ProgramStepPurchaseActivation = z.infer<typeof programStepPurchaseActivation>;
export const DISABLED_PROGRAM_STEP_PURCHASE_ACTIVATION: ProgramStepPurchaseActivation = Object.freeze({
  contract: 'program-step-purchase-activation/1', enabled: false });
export function programStepPurchaseActivationState(evidence: unknown): ProgramStepPurchaseActivation {
  const parsed = programStepPurchaseActivation.safeParse(evidence ?? DISABLED_PROGRAM_STEP_PURCHASE_ACTIVATION);
  if (!parsed.success) return DISABLED_PROGRAM_STEP_PURCHASE_ACTIVATION;
  if (parsed.data.enabled && (parsed.data.programCandidateSha256 !== PRODUCTION_PROGRAM_SCHEMA_CANDIDATE_SHA256
    || parsed.data.stepCandidateSha256 !== PROGRAM_STEP_PURCHASE_CANDIDATE_SHA256)) return DISABLED_PROGRAM_STEP_PURCHASE_ACTIVATION;
  return parsed.data;
}

/** The session the route's authenticator verified (the consumer-action candidate's own shape). */
export type ConsumerSession = { accountId: string; sessionId: string; authenticatedAt: string; revoked: boolean };
/** The server's verdict on one step, now. Null when available; otherwise a reason from the closed vocabulary. */
export type ProgramStepPort = { check(session: ConsumerSession, step: ProgramStepBinding): Promise<ProgramStepRefusal | null> };
/**
 * The two program-path entry points of the disabled consumer-action candidate, described here rather than imported:
 * that module is constructed by nothing outside itself and its tests (its own suite holds it to that), and this
 * adapter is handed an instance rather than building one.
 */
type StepCheck = (step: ProgramStepBinding) => Promise<string | null>;
type Purchase = {
  issueForProgramStep(session: ConsumerSession, raw: unknown, step: ProgramStepBinding, check: StepCheck):
    Promise<{ ok: true; issued: ProductActionIssued } | { ok: false; refused: string } | { ok: false; step: string }>;
  redeemForProgramStep(session: ConsumerSession, raw: unknown, check: StepCheck):
    Promise<{ ok: true; redeemed: ProductActionRedeemed } | { ok: false; refused: string } | { ok: false; step: string }>;
};
type Refused = { ok: false; refused: ProgramStepPurchaseRefusal };
const refuse = (refused: ProgramStepPurchaseRefusal): Refused => ({ ok: false, refused });
function settle<T extends { ok: true }>(result: T | { ok: false; refused: string } | { ok: false; step: string }): T | Refused {
  if (result.ok) return result as T;
  if ('step' in result) return refuse((PROGRAM_STEP_REFUSALS as readonly string[]).includes(result.step) ? result.step as ProgramStepRefusal : 'program_step_unavailable');
  return refuse(result.refused as ProgramStepPurchaseRefusal);
}

export function createProgramStepPurchase(deps: { purchase: Purchase; steps: ProgramStepPort; activation?: unknown }) {
  const activation = programStepPurchaseActivationState(deps.activation);
  return {
    async issue(session: ConsumerSession, raw: unknown): Promise<{ ok: true; issued: ProductActionIssued } | Refused> {
      if (!activation.enabled) return refuse('program_step_purchase_disabled');
      const parsed = programStepPurchaseRequest.safeParse(raw);
      if (!parsed.success) return refuse('request_invalid');
      return settle<{ ok: true; issued: ProductActionIssued }>(await deps.purchase.issueForProgramStep(session, parsed.data.action, parsed.data.step, step => deps.steps.check(session, step)));
    },
    async redeem(session: ConsumerSession, raw: unknown): Promise<{ ok: true; redeemed: ProductActionRedeemed } | Refused> {
      if (!activation.enabled) return refuse('program_step_purchase_disabled');
      const parsed = programStepRedemptionRequest.safeParse(raw);
      if (!parsed.success) return refuse('request_invalid');
      return settle<{ ok: true; redeemed: ProductActionRedeemed }>(await deps.purchase.redeemForProgramStep(session, { contract: FULLSCRIPT_CONSUMER_ACTION, actionId: parsed.data.actionId },
        step => deps.steps.check(session, step)));
    },
  };
}

const STEP_REASON = new RegExp(`\\b(${PROGRAM_STEP_REFUSALS.join('|')})\\b`);
/**
 * The database ports over the successor: the step check (both purchase paths' program authority) and the held
 * products (the plain path's guard). The context comes from the same verified session the consumer candidate uses.
 * A refusal is read by its token alone; anything unreadable is the step being unavailable, never available.
 */
export function createProgramStepDatabasePorts(database: ClinicalCoreDatabase, contextFor: (accountId: string) => ClinicalRequestContext) {
  const run = async <T>(accountId: string, sql: string, params: unknown[]): Promise<T> => database.transaction(async tx => {
    const context = contextFor(accountId);
    await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)', [
      clinicalUuid(context.actorPersonId), clinicalUuid(context.organizationId), context.identityPool, context.identitySubject,
      context.purpose, context.environment, context.dataClassification]);
    const raw = (await tx.query<{ data: unknown }>(sql, params)).rows[0]?.data;
    return (typeof raw === 'string' ? JSON.parse(raw) : raw) as T;
  });
  return {
    steps: {
      async check(session: ConsumerSession, step: ProgramStepBinding): Promise<ProgramStepRefusal | null> {
        try {
          const verdict = await run<{ state?: unknown; itemId?: unknown; enrollmentId?: unknown }>(session.accountId,
            'select clinical_core.program_step_purchase_check($1::jsonb) as data', [JSON.stringify({ contract: PROGRAM_STEP_PURCHASE, step })]);
          return verdict?.state === 'available' && verdict.itemId === step.itemId && verdict.enrollmentId === step.enrollmentId ? null : 'program_step_unavailable';
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const reason = (error instanceof ClinicalCoreDatabaseRejection ? error.reason : undefined) ?? STEP_REASON.exec(message)?.[1];
          return (PROGRAM_STEP_REFUSALS as readonly string[]).includes(reason ?? '') ? reason as ProgramStepRefusal
            : /\bconsumer_storage_consent_required\b/.test(message) ? 'program_step_refused' : 'program_step_unavailable';
        }
      },
    } satisfies ProgramStepPort,
    programHolds: {
      async heldProductStableIds(accountId: string): Promise<readonly string[]> {
        const held = await run<unknown>(accountId, 'select clinical_core.program_held_catalog_products() as data', []);
        if (!Array.isArray(held) || held.some(id => typeof id !== 'string')) throw new Error('program_holds_unreadable');
        return held as string[];
      },
    },
  };
}
