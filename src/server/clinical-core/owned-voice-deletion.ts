import type {VoiceJob} from './voice-jobs';
import type {ExternalDeletionScope} from './owned-external-deletion';
import {voiceOwner} from './owned-voice-authorization';
import {OwnedStorageError} from './owned-consumer-records';

/** Derive cleanup identity from the persisted server binding, not a request,
 * provider response, object name or a possibly revoked processing consent. */
export function ownedVoiceDeletionScope(job:Pick<VoiceJob,'id'|'owner'|'authorization'>):ExternalDeletionScope{
  const a=job.authorization;
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if(!/^[a-f0-9]{64}$/.test(job.id)||!a||a.version!=='owned-voice/1'
    ||!uuid.test(a.personId)||!uuid.test(a.organizationId)||!/^[A-Za-z0-9:_-]{8,128}$/.test(a.identitySubject)
    ||job.owner!==voiceOwner({actorPersonId:a.personId,organizationId:a.organizationId,identitySubject:a.identitySubject}))
    throw new OwnedStorageError('owner_required');
  return {personId:a.personId,organizationId:a.organizationId,ownerSub:a.identitySubject};
}
