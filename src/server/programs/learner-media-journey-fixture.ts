if (typeof window !== 'undefined') throw new Error('learner media journey fixture is server-only');
import { createHash } from 'node:crypto';
import { lessonMediaReferences } from '@/contracts/programLearnerMedia';
import type { ClinicalRequestContext } from '../clinical-core/aws-identity-consent';
import { JOURNEY_FIXTURE, JOURNEY_FIXTURE_MEDIA, journeyFixtureMediaReference, learnerMediaFixtureAllowed } from '../commerce/journey-fixture';
import type { createProgramSettlement } from '../commerce/program-settlement';
import { createLearnerMediaService, type LearnerMediaLedger } from './learner-media';
import { createFictionalLearnerMediaStorage } from './learner-media-fictional';

/**
 * The journey fixture's learner media, under its OWN flag (LEARNER_MEDIA_FIXTURE=1 on top of the
 * journey fixture, never a deployment). Authority is decided from the fixture's own purchase the way
 * the SQL read decides it: the caller's served curriculum for their own active entitlement, the
 * released lesson, the slot, and the one fictional publication the fixture "admitted". Storage is the
 * fictional reader: the capability has the genuine signed shape and nothing behind it.
 */
const sha = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
type Settlement = ReturnType<typeof createProgramSettlement>;

export function createJourneyFixtureMediaService(settlement: Settlement) {
  const admitted = JSON.stringify(journeyFixtureMediaReference(sha));
  const ledger: LearnerMediaLedger = {
    async forLearner(context: ClinicalRequestContext, entitlementId, at) {
      if (!learnerMediaFixtureAllowed()) return { outcome: 'held' };
      const read = await settlement.curriculum({ kind: 'consumer', personId: context.actorPersonId, identitySubject: context.identitySubject }, entitlementId);
      if (read.outcome !== 'served') return { outcome: 'refused' };
      const phase = (read.phases as { id?: unknown; items?: { id?: unknown; released?: unknown }[] }[]).find(p => p?.id === at.lesson.phaseId);
      const item = phase?.items?.find(i => i?.id === at.lesson.itemId);
      const ref = item?.released === true ? lessonMediaReferences(read.phases, at.lesson)?.[at.slot] : undefined;
      if (!ref || JSON.stringify(ref) !== admitted) return { outcome: 'refused' };
      return {
        outcome: 'authorized', entitlementId, curriculum: read.curriculum, admissionId: '7e1a0000-0000-4000-8000-000000000021', publicationId: '7e1a0000-0000-4000-8000-000000000022',
        lesson: at.lesson, slot: at.slot,
        media: { artifactId: ref.artifactId, version: ref.version, sha256: ref.sha256, kind: ref.kind, contentType: ref.contentType, bytes: ref.bytes },
        object: { key: `program-media/${JOURNEY_FIXTURE.organizationId}/${JOURNEY_FIXTURE.programId}/${ref.artifactId}/${ref.sha256}.mp4`, version: JOURNEY_FIXTURE_MEDIA.objectVersion, clinic: JOURNEY_FIXTURE.organizationId, programId: JOURNEY_FIXTURE.programId },
        caption: { state: 'available', source: 'supplied_by_author', format: 'vtt', sha256: sha(JOURNEY_FIXTURE_MEDIA.caption), text: JOURNEY_FIXTURE_MEDIA.caption },
        transcript: { state: 'available', source: 'supplied_vendor_file', format: 'plain', sha256: sha(JOURNEY_FIXTURE_MEDIA.transcript), text: JOURNEY_FIXTURE_MEDIA.transcript },
      };
    },
    async forStaff() { return { outcome: 'refused' }; },
  };
  return createLearnerMediaService({ ledger, storage: createFictionalLearnerMediaStorage() });
}
