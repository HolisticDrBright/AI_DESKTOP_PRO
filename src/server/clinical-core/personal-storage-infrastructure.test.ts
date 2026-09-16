import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
describe('personal storage deployment boundary',()=>{
  it('keeps the deployable candidate blocked with logs-only permissions and JWT routes',()=>{
    const script=readFileSync('scripts/build-aws-personal-storage.mjs','utf8');
    expect(script).toContain("PHI_ALLOWED:'false'");expect(script).toContain("PERSONAL_STORAGE_ACTIVATION:'blocked'");expect(script).toContain("PERSONAL_STORAGE_ALLOWED_SCOPES:''");
    expect(script).toContain("AuthorizationType:'JWT'");expect(script).toContain("['logs:CreateLogStream','logs:PutLogEvents']");expect(script).not.toMatch(/rds-data:|secretsmanager:GetSecretValue|s3:GetObject/);
    expect(script).toContain('GET chat-context');expect(script).toContain('POST active-plan/release');
  });
});
