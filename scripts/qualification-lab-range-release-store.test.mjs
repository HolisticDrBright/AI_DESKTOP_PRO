import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const template=JSON.parse(readFileSync('infra/aws-clinical-core/qualification-lab-range-release-store.json','utf8'));

test('empty range-release store is pinned to fictional qualification and cannot enable PHI',()=>{
  assert.deepEqual(template.Parameters.PhiAllowed.AllowedValues,['false']);
  assert.equal(template.Parameters.PhiAllowed.Default,'false');
  assert.equal(template.Rules.SyntheticAccountOnly.Assertions[0].Assert['Fn::Equals'][1],'588966314750');
  assert.deepEqual(Object.keys(template.Resources).sort(),['LabRangeReleaseBucket','LabRangeReleaseBucketPolicy']);
  assert.equal(JSON.stringify(template).includes('AWS::IAM::Role'),false);
});

test('release objects retain versions, require encryption and have no automatic deletion',()=>{
  const bucket=template.Resources.LabRangeReleaseBucket;
  assert.equal(bucket.DeletionPolicy,'Retain');
  assert.equal(bucket.UpdateReplacePolicy,'Retain');
  assert.deepEqual(bucket.Properties.BucketName,{'Fn::Sub':'ai-clinical-core-releases-${AWS::AccountId}'});
  assert.equal(bucket.Properties.VersioningConfiguration.Status,'Enabled');
  assert.equal(bucket.Properties.ObjectLockEnabled,true);
  assert.equal(bucket.Properties.ObjectLockConfiguration.ObjectLockEnabled,'Enabled');
  assert.deepEqual(Object.values(bucket.Properties.PublicAccessBlockConfiguration),[true,true,true,true]);
  assert.equal(bucket.Properties.OwnershipControls.Rules[0].ObjectOwnership,'BucketOwnerEnforced');
  assert.equal(bucket.Properties.BucketEncryption.ServerSideEncryptionConfiguration[0].ServerSideEncryptionByDefault.SSEAlgorithm,'aws:kms');
  assert.deepEqual(bucket.Properties.BucketEncryption.ServerSideEncryptionConfiguration[0].ServerSideEncryptionByDefault.KMSMasterKeyID,{Ref:'ReleaseKmsKeyArn'});
  assert.equal('LifecycleConfiguration' in bucket.Properties,false);
  assert.equal('NotificationConfiguration' in bucket.Properties,false);
});

test('bucket policy denies plaintext and wrong-key writes without granting any action',()=>{
  const statements=template.Resources.LabRangeReleaseBucketPolicy.Properties.PolicyDocument.Statement;
  assert.deepEqual(statements.map(s=>s.Sid),['DenyInsecureTransport','DenyUnencryptedObjectWrites','DenyWrongObjectKey']);
  assert.ok(statements.every(s=>s.Effect==='Deny'&&s.Principal==='*'));
  assert.equal(statements[0].Condition.Bool['aws:SecureTransport'],'false');
  assert.equal(statements[1].Condition.StringNotEquals['s3:x-amz-server-side-encryption'],'aws:kms');
  assert.deepEqual(statements[2].Condition.StringNotEquals['s3:x-amz-server-side-encryption-aws-kms-key-id'],{Ref:'ReleaseKmsKeyArn'});
});
