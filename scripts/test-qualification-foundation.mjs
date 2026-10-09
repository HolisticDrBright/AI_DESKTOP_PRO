import assert from 'node:assert/strict';
import {buildQualificationFoundation,ACCOUNT,REGION} from './build-aws-qualification-foundation.mjs';
const t=buildQualificationFoundation();
assert.equal(ACCOUNT,'588966314750');assert.equal(REGION,'us-east-2');
assert.equal(t.Outputs.PhiAllowed.Value,'false');assert.equal(t.Outputs.Activation.Value,'blocked');
assert.equal(t.Outputs.QualificationExecution.Value,'disabled');assert.equal(t.Outputs.DatabaseName.Value,'clinical_core_qualification');
for(const r of Object.values(t.Resources)){
 assert.equal(r.Condition,'SyntheticAccountAndRegion');
 assert.ok(!['AWS::Lambda::Function','AWS::ApiGatewayV2::Route','AWS::RDS::DBCluster','AWS::Cognito::UserPool','AWS::IAM::Role'].includes(r.Type));
 if(r.Type==='AWS::S3::Bucket'){
  assert.equal(r.DeletionPolicy,'RetainExceptOnCreate');assert.equal(r.Properties.VersioningConfiguration.Status,'Enabled');
  const bucketName=r.Properties.BucketName['Fn::Sub'].replace('${AWS::AccountId}',ACCOUNT).replace('${AWS::Region}',REGION);
  assert.ok(bucketName.length>=3 && bucketName.length<=63);assert.match(bucketName,/^[a-z0-9-]+$/);
  assert.ok(Object.values(r.Properties.PublicAccessBlockConfiguration).every(v=>v===true));
  assert.equal(r.Properties.OwnershipControls.Rules[0].ObjectOwnership,'BucketOwnerEnforced');
 }
 if(r.Type==='AWS::KMS::Key'){assert.equal(r.DeletionPolicy,'RetainExceptOnCreate');assert.equal(r.Properties.EnableKeyRotation,true);}
}
assert.equal(t.Resources.ExportBucket.Properties.BucketEncryption.ServerSideEncryptionConfiguration[0].ServerSideEncryptionByDefault.SSEAlgorithm,'aws:kms');
assert.equal(t.Resources.ExportBucket.Properties.LifecycleConfiguration.Rules.length,4);
assert.equal(t.Metadata.Qualification.FixturesSeeded,false);
assert.equal(t.Metadata.Qualification.AlarmDeliveryVerified,false);
assert.deepEqual(t.Resources.AlarmTopic.Properties.Subscription,undefined);
assert.ok(!/Authorization|requestBody|queryString|identity|sourceIp/i.test(t.Resources.Stage.Properties.AccessLogSettings.Format));
assert.ok(!JSON.stringify(t).includes('173535830222'));
assert.ok(!t.Resources.AlarmTopicPolicy.Properties.PolicyDocument.Statement.flatMap(s=>s.Action).includes('sns:*'));
console.log('Qualification foundation boundaries passed: no routes, handlers, DB changes, identities or PHI activation.');
