if (typeof window !== 'undefined') throw new Error('learner media SQL ledger is server-only');
import { clinicalUuid, ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase } from '../clinical-core/database';
import type { ClinicalRequestContext } from '../clinical-core/aws-identity-consent';
import {
  learnerMediaDecision, LearnerMediaError, PROGRAM_MEDIA_LEARNER_ADMISSION_SCHEMA_CANDIDATE_SHA256, staffMediaDecision,
  type LearnerMediaLedger, type LessonSlot,
} from './learner-media';

/**
 * The learner media ledger over the BLOCKED candidate program-media-learner-admission.sql, through
 * its two reviewed read functions only, each in one short transaction on the API session after the
 * request context the server verified. It is DISABLED unless the caller names the exact candidate
 * identity this source was written against, so an older or different schema is never read as if it
 * were this one. Any database failure is `service_unavailable`; the reply shape is checked by the
 * service, never trusted here.
 */
export function createSqlLearnerMediaLedger(deps: { database: ClinicalCoreDatabase; candidateSha256: string }): LearnerMediaLedger {
  const enabled = deps.candidateSha256 === PROGRAM_MEDIA_LEARNER_ADMISSION_SCHEMA_CANDIDATE_SHA256;
  const run = async (sql: string, params: unknown[], context: unknown[]) => {
    if (!enabled) throw new LearnerMediaError('service_unavailable');
    try {
      return await deps.database.transaction(async tx => {
        await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)', context);
        return (await tx.query<{ data: unknown }>(sql, params)).rows[0]?.data;
      });
    } catch (error) {
      // An identity the database refuses is a refusal, not an outage; nothing else is distinguished.
      const refused = (error instanceof ClinicalCoreDatabaseRejection && (error.category === 'identity_refused' || error.reason === 'program_entitlement_identity_refused'))
        || (error instanceof Error && /\bprogram_entitlement_identity_refused\b/.test(error.message));
      throw new LearnerMediaError(refused ? 'identity_refused' : 'service_unavailable');
    }
  };
  const consumer = (c: ClinicalRequestContext) => {
    if (c.identityPool !== 'consumer' || !c.actorPersonId || !c.identitySubject) throw new LearnerMediaError('identity_refused');
    return [clinicalUuid(c.actorPersonId), null, 'consumer', c.identitySubject, 'clinical_data', 'synthetic-staging', 'synthetic_only'];
  };
  const workforce = (c: ClinicalRequestContext) => {
    if (c.identityPool !== 'workforce' || !c.actorPersonId || !c.organizationId || !c.identitySubject) throw new LearnerMediaError('identity_refused');
    return [clinicalUuid(c.actorPersonId), clinicalUuid(c.organizationId), 'workforce', c.identitySubject, 'clinical_data', 'synthetic-staging', 'synthetic_only'];
  };
  const decode = <T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T => {
    // The Data API returns jsonb as text; the embedded engine returns it parsed.
    let raw: unknown = value;
    if (typeof value === 'string') { try { raw = JSON.parse(value); } catch { throw new LearnerMediaError('service_unavailable'); } }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new LearnerMediaError('service_unavailable');
    return parsed.data;
  };
  return {
    async forLearner(context, entitlementId, at: LessonSlot) {
      const data = await run('select commercial_education.education_media_for_caller($1,$2,$3,$4) as data',
        [clinicalUuid(entitlementId), at.lesson.phaseId, at.lesson.itemId, at.slot], consumer(context));
      return decode(learnerMediaDecision, data);
    },
    async forStaff(context, versionId, at: LessonSlot) {
      const data = await run('select clinical_core.program_media_admitted_for_staff($1,$2,$3,$4) as data',
        [clinicalUuid(versionId), at.lesson.phaseId, at.lesson.itemId, at.slot], workforce(context));
      return decode(staffMediaDecision, data);
    },
  };
}
