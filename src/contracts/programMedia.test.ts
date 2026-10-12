import { describe, expect, it } from 'vitest';
import {
  PROGRAM_MEDIA_TEXT_SOURCES, programMediaArtifact, programMediaExtension, programMediaPrepareRequest, programMediaReference, programMediaStorageSchema, programMediaCleanupReceipt,
} from './programMedia';
import { programItemEducation } from './programAssignments';

/** The program-media contract: what it admits, what it refuses, and that the mirrored program contract is untouched by it. */
const artifact = {
  artifactId: '40000000-0000-4000-8000-000000000001', clinic: '40000000-0000-4000-8000-000000000002', programId: '40000000-0000-4000-8000-000000000003',
  kind: 'video', contentType: 'video/mp4', bytes: 10, sha256: 'a'.repeat(64), objectKey: 'program-media/x/y/z/a.mp4', version: 1, state: 'ready',
  objectVersion: 'v1', committedAt: '2026-10-11T12:00:00.000Z', retiredAt: null, failure: null, caption: null, transcript: null,
};

describe('program-media/1', () => {
  it('admits only the declared kinds and content types, with a matching safe file name', () => {
    expect(programMediaExtension('image', 'image/jpeg')).toBe('jpg');
    expect(programMediaExtension('image', 'video/mp4')).toBeNull();
    const base = { commandId: artifact.artifactId, programId: artifact.programId, kind: 'image', contentType: 'image/jpeg', bytes: 5, sha256: 'b'.repeat(64), fileName: 'lesson.jpg' };
    expect(programMediaPrepareRequest.safeParse(base).success).toBe(true);
    for (const bad of [{ fileName: 'lesson.jpeg' }, { fileName: 'a/b.jpg' }, { fileName: '.jpg' }, { kind: 'audio', contentType: 'audio/mpeg', fileName: 'a.mp3' }, { contentType: 'image/gif', fileName: 'a.gif' }, { bytes: 0 }]) {
      expect(programMediaPrepareRequest.safeParse({ ...base, ...bad }).success).toBe(false);
    }
  });
  it('keeps the artifact state machine consistent: ready and retired carry a proven object; retired carries a time; text follows the kind', () => {
    expect(programMediaArtifact.safeParse(artifact).success).toBe(true);
    expect(programMediaArtifact.safeParse({ ...artifact, objectVersion: null }).success).toBe(false);
    expect(programMediaArtifact.safeParse({ ...artifact, objectVersion: 'null' }).success).toBe(false);
    expect(programMediaArtifact.safeParse({ ...artifact, state: 'reserved' }).success).toBe(false);
    expect(programMediaArtifact.safeParse({ ...artifact, state: 'retired' }).success).toBe(false);
    expect(programMediaArtifact.safeParse({ ...artifact, state: 'retired', retiredAt: artifact.committedAt }).success).toBe(true);
    expect(programMediaArtifact.safeParse({ ...artifact, state: 'held', objectVersion: null, committedAt: null }).success).toBe(true);
    const text = { text: 'x', source: 'supplied_by_author', format: 'vtt', sha256: 'c'.repeat(64) };
    expect(programMediaArtifact.safeParse({ ...artifact, transcript: text }).success).toBe(true);
    expect(programMediaArtifact.safeParse({ ...artifact, kind: 'image', contentType: 'image/png', transcript: text }).success).toBe(false);
    expect(programMediaArtifact.safeParse({ ...artifact, kind: 'image', contentType: 'image/png', caption: text }).success).toBe(false);
    expect(programMediaArtifact.safeParse({ ...artifact, caption: { ...text, source: 'generated' } }).success).toBe(false);
    expect(PROGRAM_MEDIA_TEXT_SOURCES).toEqual(['supplied_by_author', 'supplied_vendor_file']);
  });
  it('a deletion receipt requires one exact complete absence proof per successful action', () => {
    const action = { artifactId: artifact.artifactId, outcome: 'abandoned_object_removed' };
    const proof = { artifactId: artifact.artifactId, claimId: artifact.programId, objectKey: artifact.objectKey,
      checkedAt: artifact.committedAt, complete: true, remainingVersions: 0, removedVersions: ['v1'] };
    const receipt = { programId: artifact.programId, checkedAt: artifact.committedAt, actions: [action], proofs: [proof] };
    expect(programMediaCleanupReceipt.safeParse(receipt).success).toBe(true);
    for (const changed of [{ proofs: [] }, { proofs: [{ ...proof, artifactId: artifact.clinic }] }, { proofs: [{ ...proof, complete: false }] },
      { proofs: [{ ...proof, remainingVersions: 1 }] }, { proofs: [{ ...proof, removedVersions: [] }] }, { proofs: [proof, proof] }, { actions: [action, action] }]) {
      expect(programMediaCleanupReceipt.safeParse({ ...receipt, ...changed }).success).toBe(false);
    }
    expect(programMediaCleanupReceipt.safeParse({ ...receipt, actions: [{ ...action, outcome: 'kept_pending' }] }).success).toBe(false);
  });
  it('refuses a storage declaration that could be a clinical store', () => {
    const storage = { purpose: 'educational_media', phiAllowed: false, dedicated: true, bucket: 'alp-fictional-program-media', expectedBucketOwner: '588966314750', region: 'us-east-2',
      kmsKeyArn: 'arn:aws:kms:us-east-2:588966314750:key/c13ec29d-0e47-4c02-9136-f371bcbb7900', maxImageBytes: 1, maxVideoBytes: 1, publicOrigin: 'https://media.fictional.example/' };
    expect(programMediaStorageSchema.safeParse(storage).success).toBe(true);
    for (const bad of [{ bucket: 'alp-qualification-recordings-588966314750-us-east-2' }, { bucket: 'alp-patient-uploads' }, { phiAllowed: true }, { purpose: 'clinical_data' },
      { publicOrigin: 'https://alp.s3.amazonaws.com/' }, { publicOrigin: 'https://media.fictional.example/path' }, { maxVideoBytes: 268_435_457 }]) {
      expect(programMediaStorageSchema.safeParse({ ...storage, ...bad }).success).toBe(false);
    }
  });
  it('a reference is exact and strict, and the mirrored program media slot is not changed by this contract', () => {
    const reference = { contractVersion: 'program-media-reference/1', artifactId: artifact.artifactId, version: 1, sha256: artifact.sha256, kind: 'video', contentType: 'video/mp4', bytes: 10,
      origin: { clinic: artifact.clinic, programId: artifact.programId }, url: 'https://media.fictional.example/program-media/x/y/z/a.mp4', publishedAt: artifact.committedAt, caption: null, transcript: null };
    expect(programMediaReference.safeParse(reference).success).toBe(true);
    expect(programMediaReference.safeParse({ ...reference, previewToken: 'x' }).success).toBe(false);
    // The shared slot still accepts an https address with an optional caption and nothing else: no artifact reference field exists in the mirror.
    const slot = { kind: 'video', url: 'https://media.example.com/a.mp4', caption: 'Fictional' };
    expect(programItemEducation.media.safeParse([slot]).success).toBe(true);
    expect(programItemEducation.media.safeParse([{ ...slot, artifactId: artifact.artifactId }]).success).toBe(false);
  });
});
