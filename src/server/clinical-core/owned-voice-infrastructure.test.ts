import {beforeAll,describe,it,expect} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {readFileSync,readdirSync} from 'node:fs';
let template=JSON.parse('{}');
beforeAll(()=>{
  execFileSync(process.execPath,['scripts/build-aws-owned-voice.mjs'],{stdio:'pipe'});
  template=JSON.parse(readFileSync('dist/aws-clinical-core/owned-voice/template.json','utf8'));
});
describe('production voice release candidate',()=>{
  it('is blocked and least-privileged by default with explicit activation evidence',()=>{
    expect(template.Parameters.PhiAllowed.Default).toBe('false');expect(template.Parameters.Activation.Default).toBe('blocked');
    expect(template.Parameters.AllowedScopes.Default).toBe('');
    expect(template.Resources.VoiceJobRole.Properties.Policies[0].PolicyDocument.Statement.flatMap((s:{Action:string[]})=>s.Action))
      .toEqual(['logs:CreateLogStream','logs:PutLogEvents']);
    expect(template.Resources.VoiceJobRole.Properties.Policies[1]['Fn::If'][0]).toBe('Active');
    expect(template.Resources.VoiceSweepRule.Properties.State['Fn::If']).toEqual(['SweepEnabled','ENABLED','DISABLED']);
    expect(JSON.stringify(template.Rules)).toContain('ProviderEvidenceSha256');
    expect(JSON.stringify(template.Rules)).toContain('AlarmTopicArn');
    expect(JSON.stringify(template.Rules)).toContain('BillingApiOrigin');
  });
  it('drain retains maintenance permissions but never ingestion, transcript access or SQL',()=>{
    expect(template.Parameters.Activation.AllowedValues).toContain('draining');
    expect(template.Parameters.CleanupEvidenceSha256.Default).toBe('');
    expect(JSON.stringify(template.Rules.DrainRequiresReviewedCleanup)).toContain('CleanupEvidenceSha256');
    const branch=template.Resources.VoiceJobRole.Properties.Policies[2]['Fn::If'];
    expect(branch[0]).toBe('Draining');expect(branch[2]).toEqual({Ref:'AWS::NoValue'});
    const statements=branch[1].PolicyDocument.Statement as {Action:string[];Resource:unknown;Condition?:unknown}[];
    expect(statements.every(s=>s.Resource!=='*')).toBe(true);
    expect(statements.flatMap(s=>s.Action).sort()).toEqual([
      'dynamodb:GetItem','dynamodb:UpdateItem','dynamodb:Query','s3:DeleteObjectVersion','s3:ListBucketVersions',
      'transcribe:GetTranscriptionJob','transcribe:DeleteTranscriptionJob','kms:Encrypt','kms:Decrypt','kms:GenerateDataKey'].sort());
    expect(statements.find(s=>s.Action.includes('kms:Decrypt'))?.Condition).toEqual({StringEquals:{
      'kms:ViaService':{'Fn::Sub':'dynamodb.${AWS::Region}.amazonaws.com'},
      'kms:EncryptionContext:aws:dynamodb:tableName':{Ref:'VoiceJobTable'},
      'kms:EncryptionContext:aws:dynamodb:subscriberId':{Ref:'AWS::AccountId'}}});
    expect(template.Conditions.SweepEnabled).toEqual({'Fn::Or':[{Condition:'Active'},{Condition:'Draining'}]});
  });
  it('scopes provider, object-version cleanup and database permissions to named resources',()=>{
    const statements=template.Resources.VoiceJobRole.Properties.Policies[1]['Fn::If'][1].PolicyDocument.Statement;
    expect(statements.every((s:{Resource:unknown})=>s.Resource!=='*')).toBe(true);
    expect(JSON.stringify(statements)).toContain('transcription-job/alp-personal-voice-*');
    expect(JSON.stringify(statements)).toContain('s3:DeleteObjectVersion');
    expect(JSON.stringify(statements)).toContain('s3:ListBucketVersions');
    expect(template.Resources.TranscriptionBucket.Properties.VersioningConfiguration.Status).toBe('Enabled');
    expect(template.Resources.VoiceJobTable.Properties.PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled).toBe(true);
    const routes=(Object.values(template.Resources) as {Type:string;Properties:{AuthorizationType:string}}[]).filter(r=>r.Type==='AWS::ApiGatewayV2::Route');
    expect(routes).toHaveLength(3);expect(routes.every(r=>r.Properties.AuthorizationType==='JWT')).toBe(true);
  });
  it('built handler refuses before accessing providers under the default closed boundary',()=>{
    const script="const h=require('./dist/aws-clinical-core/owned-voice/index.js');h.handler({rawPath:'/clinical-core/consumer/chat-transcription/jobs',requestContext:{http:{method:'POST'}}}).then(r=>{if(r.statusCode!==503||JSON.parse(r.body).phiAllowed!==false)process.exit(1);})";
    expect(()=>execFileSync(process.execPath,['-e',script],{env:{...process.env,CONSUMER_ISSUER:'https://cognito-idp.us-east-2.amazonaws.com/fixture',
      CONSUMER_AUDIENCE:'12345678901234567890',PHI_ALLOWED:'false',PERSONAL_VOICE_ACTIVATION:'blocked',PERSONAL_VOICE_ALLOWED_SCOPES:''},stdio:'pipe'})).not.toThrow();
  });
  it('registers every production SQL file including privacy export and voice consent',()=>{
    const root='infra/aws-clinical-core/production-migrations';
    const manifest=JSON.parse(readFileSync(root+'/manifest.json','utf8'));
    const files=manifest.migrations.map((m:{file:string})=>m.file);
    expect(new Set(files).size).toBe(files.length);
    expect([...files].sort()).toEqual(readdirSync(root).filter(f=>f.endsWith('.sql')).sort());
    expect(files).toContain('20260916010000_production_owned_privacy_export.sql');
    expect(files).toContain('20260916020000_production_owned_voice_consent.sql');
    expect(files).toContain('20260916030000_production_owned_active_plan.sql');
    expect(files).toContain('20260916040000_production_owned_privacy_requests.sql');
    expect(files).toContain('20260916050000_production_guardian_authority.sql');
  });
  it('built inventory tool refuses missing or malformed scope before AWS access',()=>{
    const usage=spawnSync(process.execPath,['dist/aws-clinical-core/owned-voice/inventory.cjs'],{encoding:'utf8'});
    expect(usage.status).toBe(2);expect(usage.stdout).toBe('');expect(usage.stderr).toContain('Usage:');
    const refused=spawnSync(process.execPath,['dist/aws-clinical-core/owned-voice/inventory.cjs','--read-only','not-account','us-east-2','fixture'],{encoding:'utf8'});
    expect(refused.status).toBe(1);expect(refused.stdout).toBe('');expect(refused.stderr).toContain('no completion claimed');
  });
  it('built drain handler rejects public requests without DB/provider configuration',()=>{
    const script="const h=require('./dist/aws-clinical-core/owned-voice/index.js');h.handler({rawPath:'/clinical-core/consumer/chat-transcription/jobs',requestContext:{http:{method:'POST'}}}).then(r=>{if(r.statusCode!==503||JSON.parse(r.body).error!=='voice_cleanup_only')process.exit(1);})";
    expect(()=>execFileSync(process.execPath,['-e',script],{env:{...process.env,
      CONSUMER_ISSUER:'https://cognito-idp.us-east-2.amazonaws.com/fixture',CONSUMER_AUDIENCE:'12345678901234567890',
      PHI_ALLOWED:'false',PERSONAL_VOICE_ACTIVATION:'draining',PERSONAL_VOICE_ALLOWED_SCOPES:'',
      PERSONAL_VOICE_EVIDENCE_SHA256:'a'.repeat(64),PERSONAL_VOICE_PROVIDER_EVIDENCE_SHA256:'b'.repeat(64),
      PERSONAL_VOICE_CLEANUP_EVIDENCE_SHA256:'c'.repeat(64)},stdio:'pipe'})).not.toThrow();
  });
});
