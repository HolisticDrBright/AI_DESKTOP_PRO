if (typeof window !== 'undefined') throw new Error('fictional learner media storage is server-only');
import { S3Client } from '@aws-sdk/client-s3';
import { issueAwsProgramMediaVersionPreview } from './aws-program-media-preview';
import { LearnerMediaError, type LearnerMediaObject, type LearnerMediaStorage } from './learner-media';

/**
 * A FICTIONAL learner media storage reader for source tests and the local journey fixture: no
 * network, no account, no real credentials. It signs with the real exact-version signer over
 * visibly fictional static credentials (signing is local computation), so the capability has the
 * genuine shape a reviewed reader would issue, and it fetches nothing. Its `before` hook lets a test
 * act while the "storage read" is in progress (to withdraw access mid-read, for example).
 */
export const FICTIONAL_LEARNER_MEDIA_BUCKET = 'alp-fictional-lessons';
export function createFictionalLearnerMediaStorage(options: {
  bucket?: string;
  before?: (object: LearnerMediaObject) => Promise<void> | void;
  fail?: () => boolean;
} = {}): LearnerMediaStorage & { issued: LearnerMediaObject[] } {
  const bucket = options.bucket ?? FICTIONAL_LEARNER_MEDIA_BUCKET;
  const s3 = new S3Client({ region: 'us-east-2', credentials: { accessKeyId: 'AKIAFICTIONALFIXTURE', secretAccessKey: 'fictional-fixture-secret-not-a-credential-0000' } });
  const issued: LearnerMediaObject[] = [];
  return {
    issued,
    async issue(object, signal, assertLive) {
      issued.push(object);
      await options.before?.(object);
      assertLive();
      if (options.fail?.()) throw new LearnerMediaError('service_unavailable');
      try {
        const signed = await issueAwsProgramMediaVersionPreview({ s3, bucket, objectKey: object.objectKey, objectVersion: object.objectVersion, contentType: object.contentType, signal, assertLive });
        return { url: signed.token, expiresAt: signed.until };
      } catch { throw new LearnerMediaError('service_unavailable'); }
    },
  };
}
