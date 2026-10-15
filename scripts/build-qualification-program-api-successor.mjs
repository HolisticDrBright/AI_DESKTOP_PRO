import { readFileSync, writeFileSync } from 'node:fs';

const base = JSON.parse(readFileSync('infra/aws-clinical-core/qualification-program-api-candidate.json', 'utf8'));
const boundary = JSON.parse(readFileSync('infra/aws-clinical-core/source-candidates/qualification-program-boundary.json', 'utf8'));
if (base.Metadata?.ClinicalCore?.ContractVersion !== 'qualification-program-api-candidate/1'
  || boundary.contract !== 'qualification-program-boundary-candidate/1'
  || boundary.status !== 'BLOCKED' || boundary.ledger.migrationCount !== 112)
  throw new Error('qualification_program_successor_parent_invalid');

const candidate = structuredClone(base);
candidate.Description = 'BLOCKED fictional-only qualification program boundary; no production, PHI, purchase or provider activation.';
candidate.Metadata.ClinicalCore.ContractVersion = 'qualification-program-api-candidate/2';
candidate.Metadata.ClinicalCore.SourceTemplate = 'infra/aws-clinical-core/qualification-program-api-candidate.json';
candidate.Metadata.ClinicalCore.RuntimeSchemaRequirement = {
  Adapter: 'qualification_program_assignments',
  Function: 'clinical_core.production_program_bounded_request(jsonb)',
  BoundaryCandidateSha256: boundary.successor.sha256,
  MigrationCount: boundary.ledger.migrationCount,
  MigrationReleaseSha256: boundary.ledger.migrationReleaseSha256,
  ProductionActivationRequired: false,
  PurchaseReleased: false,
};
candidate.Metadata.ClinicalCore.DeploymentGate = 'BLOCKED: requires reviewed preserving schema upgrade, designated subjects, Sandbox billing API, exact bundle and hosted negatives';

candidate.Parameters.QualificationReviewSha256 = { Type: 'String', AllowedPattern: '^[a-f0-9]{64}$' };
candidate.Parameters.QualificationIdentitySubjects = { Type: 'String', MinLength: 8, MaxLength: 2064,
  AllowedPattern: '^[A-Za-z0-9:_-]{8,128}(,[A-Za-z0-9:_-]{8,128}){0,15}$' };
candidate.Parameters.QualificationProgramOrganizationId = { Type: 'String',
  AllowedPattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' };
candidate.Parameters.QualificationBillingApiOrigin = { Type: 'String',
  AllowedPattern: '^https://[a-z0-9]{10}\\.execute-api\\.us-east-2\\.amazonaws\\.com$' };
candidate.Parameters.LambdaCodeVersion = { Type: 'String', MinLength: 1, MaxLength: 256 };

const resources = candidate.Resources;
resources.IdentityApiLogGroup.Properties.LogGroupName = { 'Fn::Sub': '/aws/lambda/${ClinicalApiId}-qualification-bound-programs' };
resources.IdentityApiFunction.Properties.FunctionName = { 'Fn::Sub': '${ClinicalApiId}-qualification-bound-programs' };
resources.IdentityApiFunction.Properties.Code.S3ObjectVersion = { Ref: 'LambdaCodeVersion' };
const e = resources.IdentityApiFunction.Properties.Environment.Variables;
delete e.CLINICAL_WORKFORCE_ISSUER;
delete e.CLINICAL_WORKFORCE_AUDIENCE;
delete e.CLINICAL_CONSUMER_ISSUER;
delete e.CLINICAL_CONSUMER_AUDIENCE;
Object.assign(e, {
  WORKFORCE_ISSUER: { 'Fn::Sub': 'https://cognito-idp.${AWS::Region}.${AWS::URLSuffix}/${WorkforceUserPoolId}' },
  WORKFORCE_AUDIENCE: { Ref: 'WorkforceUserPoolClientId' },
  CONSUMER_ISSUER: { 'Fn::Sub': 'https://cognito-idp.${AWS::Region}.${AWS::URLSuffix}/${ConsumerUserPoolId}' },
  CONSUMER_AUDIENCE: { Ref: 'ConsumerUserPoolClientId' },
  PHI_ALLOWED: 'false', PROGRAM_ACTIVATION: 'blocked', QUALIFICATION_EXECUTION: 'enabled',
  QUALIFICATION_ACCOUNT_ID: '588966314750',
  QUALIFICATION_REVIEW_SHA256: { Ref: 'QualificationReviewSha256' },
  QUALIFICATION_IDENTITY_SUBJECTS: { Ref: 'QualificationIdentitySubjects' },
  QUALIFICATION_PROGRAM_ORGANIZATION_ID: { Ref: 'QualificationProgramOrganizationId' },
  QUALIFICATION_BILLING_API_ORIGIN: { Ref: 'QualificationBillingApiOrigin' },
  MIGRATION_RELEASE_SHA256: boundary.ledger.migrationReleaseSha256,
  QUALIFICATION_PROGRAM_BOUNDARY_SHA256: boundary.successor.sha256,
});
resources.IdentityApiErrorAlarm.Properties.AlarmName = 'ai-clinical-core-qualification-bound-program-api-errors';
resources.IdentityApiErrorAlarm.Properties.AlarmDescription = 'Fictional qualification bound-program API Lambda errors';

const output = 'infra/aws-clinical-core/qualification-program-api-successor.json';
const rendered = `${JSON.stringify(candidate, null, 2)}\n`;
if (process.argv.includes('--check')) {
  if (readFileSync(output, 'utf8').replaceAll('\r\n', '\n') !== rendered) throw new Error('qualification_program_api_successor_drift');
} else writeFileSync(output, rendered);
