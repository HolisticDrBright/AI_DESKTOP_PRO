// Deployment artifact only: copy-and-fill CloudFormation parameter files for deploying each production candidate with the
// qualification execution profile (docs/aws-qualification-target.md). Every value is fictional or a visible placeholder;
// the posture values are fixed (PHI disabled, production activation blocked, qualification enabled, synthetic account,
// qualification database) and the test proves each file's keys equal its template's parameters, every value satisfies
// the template's AllowedPattern or AllowedValues, and the template's Qualification condition evaluates true with them.
// Usage: node scripts/build-aws-qualification-parameters.mjs [--check]  (writes infra/aws-clinical-core/qualification-parameters/)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

export const QUALIFICATION_ACCOUNT_ID = '588966314750';
export const QUALIFICATION_DATABASE_NAME = 'clinical_core_qualification';
const REGION = 'us-east-2';
const PLACEHOLDER_HASH = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const FIXTURE = { organization: '11111111-1111-4111-8111-111111111111', release: '55555555-5555-4555-8555-555555555555' };
const KMS = id => `arn:aws:kms:${REGION}:${QUALIFICATION_ACCOUNT_ID}:key/${id}`;
const KEY = { secret: KMS('11111111-1111-4111-8111-111111111111'), logs: KMS('22222222-2222-4222-8222-222222222222'), core: KMS('33333333-3333-4333-8333-333333333333'),
  export: KMS('44444444-4444-4444-8444-444444444444'), lab: KMS('66666666-6666-4666-8666-666666666666'), voice: KMS('77777777-7777-4777-8777-777777777777'), recording: KMS('88888888-8888-4888-8888-888888888888') };
const TABLE = name => `arn:aws:dynamodb:${REGION}:${QUALIFICATION_ACCOUNT_ID}:table/${name}`;

export const CANDIDATES = {
  'personal-storage': { build: ['scripts/build-aws-personal-storage.mjs'], template: 'dist/aws-clinical-core/personal-storage/template.json' },
  'owned-lab': { build: ['scripts/build-aws-owned-lab.mjs'], template: 'dist/aws-clinical-core/owned-lab/template.json' },
  'owned-voice': { build: ['scripts/build-aws-owned-voice.mjs'], template: 'dist/aws-clinical-core/owned-voice/template.json' },
  'privacy-operations': { build: ['scripts/build-aws-privacy-operations.mjs'], template: 'dist/aws-clinical-core/privacy-operations/template.json' },
  'recording-authority': { build: ['scripts/build-aws-recording-authority.mjs'], template: 'dist/aws-clinical-core/recording-authority/template.json' },
  'recording-capture': { build: ['scripts/build-aws-recording-authority.mjs', '--capture'], template: 'dist/aws-clinical-core/recording-capture/template.json' },
  'recording-cleanup-review': { build: ['scripts/build-aws-recording-authority.mjs', '--cleanup-review'], template: 'dist/aws-clinical-core/recording-cleanup-review/template.json' },
  'recording-cleanup-execution': { build: ['scripts/build-aws-recording-authority.mjs', '--cleanup-execution'], template: 'dist/aws-clinical-core/recording-cleanup-execution/template.json' },
  'recording-transcription': { build: ['scripts/build-aws-recording-authority.mjs', '--transcription'], template: 'dist/aws-clinical-core/recording-transcription/template.json' },
  'recording-drafting': { build: ['scripts/build-aws-recording-authority.mjs', '--drafting'], template: 'dist/aws-clinical-core/recording-drafting/template.json' },
};

/** The value for one parameter: fixed posture, candidate-specific reviewed inputs, or a visible placeholder of the right shape. */
export function qualificationValue(candidate, name, definition) {
  const fixed = {
    PhiAllowed: 'false', Activation: 'blocked', ActivationEvidenceSha256: '', ProviderEvidenceSha256: '', CleanupEvidenceSha256: '',
    QualificationExecution: 'enabled', QualificationAccountId: QUALIFICATION_ACCOUNT_ID, QualificationReviewSha256: PLACEHOLDER_HASH,
    QualificationIdentitySubjects: 'replace-with-consumer-cognito-sub,replace-with-workforce-cognito-sub',
    DatabaseName: QUALIFICATION_DATABASE_NAME,
    DatabaseClusterArn: `arn:aws:rds:${REGION}:${QUALIFICATION_ACCOUNT_ID}:cluster:ai-clinical-core-synthetic-clinicaldatabasecluster-lftvrccuflxa`,
    DatabaseSecretArn: `arn:aws:secretsmanager:${REGION}:${QUALIFICATION_ACCOUNT_ID}:secret:rds!cluster-replace-with-secret-suffix`,
    SecretKmsKeyArn: KEY.secret, LogsKmsKeyArn: KEY.logs, ClinicalCoreKeyArn: KEY.core,
    AlarmTopicArn: `arn:aws:sns:${REGION}:${QUALIFICATION_ACCOUNT_ID}:ai-clinical-core-qualification-alarms`,
    ApiId: 'abcdefghij', ClinicalApiId: 'abcdefghij', ConsumerJwtAuthorizerId: 'replace-with-consumer-authorizer-id',
    ConsumerIssuer: `https://cognito-idp.${REGION}.amazonaws.com/${REGION}_REPLACEconsumer`, ConsumerAudience: 'replaceconsumerappclientid0001',
    WorkforceIssuer: `https://cognito-idp.${REGION}.amazonaws.com/${REGION}_REPLACEworkforce`, WorkforceAudience: 'replaceworkforceappclientid001',
    OrganizationId: FIXTURE.organization,
    CodeBucket: `ai-clinical-core-code-${QUALIFICATION_ACCOUNT_ID}`, LambdaCodeBucket: `ai-clinical-core-code-${QUALIFICATION_ACCOUNT_ID}`,
    CodeKey: `qualification/${candidate}/index.zip`, ApiCodeKey: `qualification/${candidate}/api.zip`, WorkerCodeKey: `qualification/${candidate}/worker.zip`,
    VoiceJobsCodeKey: `qualification/${candidate}/voice-jobs.zip`, CodeVersion: 'REPLACE_WITH_S3_OBJECT_VERSION',
    SourceCommit: 'REPLACE'.padEnd(40, '0').replace(/[^a-f0-9]/g, '0'),
    BillingApiOrigin: `https://abcdefghij.execute-api.${REGION}.amazonaws.com`,
    OpenAISecretArn: `arn:aws:secretsmanager:${REGION}:${QUALIFICATION_ACCOUNT_ID}:secret:ai-clinical-core/qualification/openai-test-provider`,
    OpenAiSecretArn: `arn:aws:secretsmanager:${REGION}:${QUALIFICATION_ACCOUNT_ID}:secret:ai-clinical-core/qualification/openai-test-provider`,
    LabRangeMode: 'reviewed_release', LabRangeReleaseBucket: `ai-clinical-core-releases-${QUALIFICATION_ACCOUNT_ID}`,
    LabRangeReleaseKey: 'reviewed-lab-ranges/replace-with-release.json', LabRangeReleaseSha256: PLACEHOLDER_HASH,
    LabRangeSignerPublicKeyPem: '-----BEGIN PUBLIC KEY-----\nREPLACE_WITH_REVIEWED_SIGNER_PUBLIC_KEY\n-----END PUBLIC KEY-----',
    KnowledgeReleaseMode: 'disabled', KnowledgeReleaseBucket: '', KnowledgeReleaseKey: '', KnowledgeReleaseObjectVersion: '', KnowledgeReleaseSha256: '', KnowledgeSourcePackageSha256: '', KnowledgeSignerPublicKeyPem: '',
    ExportBucketName: 'ai-clinical-core-qualification-personal-exports', ExportKmsKeyArn: KEY.export, ExportReviewSha256: PLACEHOLDER_HASH,
    ExportLabJobTableArn: TABLE('replace-with-lab-job-table'), ExportLabDocumentBucketName: 'ai-clinical-core-qualification-lab-documents', ExportLabKmsKeyArn: KEY.lab,
    ExportVoiceJobTableArn: TABLE('replace-with-voice-job-table'), ExportTranscriptionBucketName: 'ai-clinical-core-qualification-transcription', ExportVoiceKmsKeyArn: KEY.voice,
    CrossStoreExportReviewSha256: PLACEHOLDER_HASH,
    // Privacy sub-activations: export cleanup on (the export and retention harnesses need it); the rest stay off until reviewed.
    PersonalPurgeEnabled: 'false', PersonalPurgeEvidenceSha256: '', ExternalInventoryEnabled: 'false', ExternalInventoryEvidenceSha256: '',
    ExternalPurgeEnabled: 'false', ExternalPurgeEvidenceSha256: '', IdentityDeletionEnabled: 'false', IdentityDeletionEvidenceSha256: '',
    ExportCleanupEnabled: 'true', ExportCleanupEvidenceSha256: PLACEHOLDER_HASH,
    RetentionScheduleEnabled: 'false', RetentionScheduleEvidenceSha256: '', RetentionServicePersonId: '', RetentionServiceSubject: '', RetentionServiceOrganizationId: '',
    RetentionOverdueAlarmSeconds: '259200', ConsumerUserPoolId: '', LabDocumentBucket: '', LabStateMachineArn: '', VoiceBucket: '', VoiceKmsKeyArn: '',
    LabTableArn: '', VoiceTableArn: '', LabTableKmsKeyArn: '', VoiceTableKmsKeyArn: '',
    RecordingBucket: 'ai-clinical-core-qualification-recordings', RecordingKmsKeyArn: KEY.recording,
  };
  if (name === 'AllowedScopes') {
    if (definition.AllowedValues) return definition.AllowedValues.find(v => v !== '') ?? '';
    return 'forms_checkins,symptoms_adherence,nutrition,protocols_supplements,wearables,reproductive_health,ai_context,lab_history,voice_transcription';
  }
  if (name in fixed) return fixed[name];
  // Candidate-specific reviewed inputs, by shape: release ids are fixture uuids, review hashes are the placeholder hash.
  if (/ReleaseId$/.test(name)) return FIXTURE.release;
  if (/Sha256$/.test(name)) return PLACEHOLDER_HASH;
  if (/SecretArn$/.test(name)) return `arn:aws:secretsmanager:${REGION}:${QUALIFICATION_ACCOUNT_ID}:secret:ai-clinical-core/qualification/${candidate}-test-provider`;
  if (/KmsKeyArn$/.test(name)) return KEY.recording;
  if (/Bucket(Name)?$/.test(name)) return `ai-clinical-core-qualification-${candidate}`;
  if (definition.AllowedValues) return definition.Default ?? definition.AllowedValues[0];
  if (definition.Default !== undefined) return String(definition.Default);
  throw new Error(`qualification_parameter_unresolved:${candidate}:${name}`);
}

export function qualificationParameters(candidate, template) {
  return Object.entries(template.Parameters).map(([name, definition]) => ({ ParameterKey: name, ParameterValue: qualificationValue(candidate, name, definition) }));
}

export function loadTemplate(candidate, { build = true } = {}) {
  const { build: command, template } = CANDIDATES[candidate];
  if (build || !existsSync(template)) execFileSync(process.execPath, command, { stdio: 'pipe' });
  return JSON.parse(readFileSync(template, 'utf8'));
}

const OUT = 'infra/aws-clinical-core/qualification-parameters';
if (process.argv[1] && /build-aws-qualification-parameters\.mjs$/.test(process.argv[1])) {
  const check = process.argv.includes('--check');
  mkdirSync(OUT, { recursive: true });
  let drift = 0;
  for (const candidate of Object.keys(CANDIDATES)) {
    const content = JSON.stringify(qualificationParameters(candidate, loadTemplate(candidate)), null, 2) + '\n';
    const file = `${OUT}/${candidate}.example.json`;
    if (check) { if (!existsSync(file) || readFileSync(file, 'utf8') !== content) { drift += 1; console.error(`qualification parameters out of date: ${file}`); } }
    else writeFileSync(file, content);
  }
  if (check && drift) process.exit(1);
  console.log(check ? 'Qualification parameter examples match their templates.' : `Wrote ${Object.keys(CANDIDATES).length} qualification parameter examples to ${OUT}/ (placeholders, no deployment).`);
}
