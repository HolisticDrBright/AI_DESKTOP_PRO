import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const template = JSON.parse(readFileSync('infra/aws-clinical-core/qualification-recording-storage.json', 'utf8'));

describe('fictional-only qualification recording storage', () => {
  it('pins the account and refuses a PHI-enabled parameter', () => {
    expect(template.Parameters.PhiAllowed).toMatchObject({ Default: 'false', AllowedValues: ['false'] });
    expect(template.Parameters.RecordingKmsKeyArn.AllowedPattern).toContain('588966314750');
    expect(template.Parameters.SourceCommit.AllowedPattern).toBe('^[a-f0-9]{40}$');
    expect(template.Outputs.SourceCommit.Value).toEqual({ Ref: 'SourceCommit' });
    expect(template.Resources.RecordingBucket.Properties.BucketName).toEqual({ 'Fn::Sub': 'alp-qualification-recordings-${AWS::AccountId}-${AWS::Region}' });
  });

  it('retains an encrypted, private, versioned Object Lock bucket without an automatic expiry', () => {
    const bucket = template.Resources.RecordingBucket;
    expect(bucket.DeletionPolicy).toBe('Retain');
    expect(bucket.UpdateReplacePolicy).toBe('Retain');
    expect(bucket.Properties.VersioningConfiguration).toEqual({ Status: 'Enabled' });
    expect(bucket.Properties.ObjectLockEnabled).toBe(true);
    expect(bucket.Properties.ObjectLockConfiguration).toEqual({ ObjectLockEnabled: 'Enabled' });
    expect(bucket.Properties.ObjectLockConfiguration.Rule).toBeUndefined();
    expect(bucket.Properties.LifecycleConfiguration).toBeUndefined();
    expect(bucket.Properties.PublicAccessBlockConfiguration).toEqual({
      BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true,
    });
    expect(bucket.Properties.OwnershipControls).toEqual({ Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] });
    expect(bucket.Properties.BucketEncryption.ServerSideEncryptionConfiguration[0]).toMatchObject({
      ServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms', KMSMasterKeyID: { Ref: 'RecordingKmsKeyArn' } },
    });
  });

  it('denies insecure or unencrypted writes and grants no capture or cleanup permissions', () => {
    const statements = template.Resources.RecordingBucketPolicy.Properties.PolicyDocument.Statement;
    expect(statements.map((statement: { Sid: string }) => statement.Sid)).toEqual([
      'DenyInsecureTransport', 'DenyUnencryptedObjectWrites', 'DenyWrongObjectKey',
    ]);
    expect(statements.every((statement: { Effect: string }) => statement.Effect === 'Deny')).toBe(true);
    const types = Object.values(template.Resources).map(resource => (resource as { Type: string }).Type);
    expect(types).toEqual(['AWS::S3::Bucket', 'AWS::S3::BucketPolicy']);
  });
});
