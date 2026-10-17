/**
 * qualification-issuer-release-map/1: which hosted runner, authorizer and handler expects which Cognito pool, issuer,
 * audience, MFA posture and token times, and which stack values it reads. SOURCE ONLY: nothing here calls AWS or
 * Cognito, changes an authorizer, or decides which pool a deployment should use. It describes what the source pins
 * today, and every value carries the file and line it came from; qualification-issuer-release-map.test.ts reads those
 * lines and the actual templates and fails if the map and the source disagree, or if a pool id appears anywhere in
 * source without an entry here.
 *
 * Its one rule: a qualification run uses ONE workforce issuer. assertQualificationIssuerPlan refuses a plan whose
 * runners expect different workforce pools (mixed_workforce_issuer), an observed authorizer whose issuer or audience
 * disagrees with its runner (authorizer_issuer_mismatch), an issuer that is not known (unknown is not "the same"), a
 * production or consumer pool where a qualification workforce pool belongs, and a workforce pool whose MFA is optional
 * (the qualification fleet's own requirement, docs/inventory-qualification-fleet.md:202).
 */

export const QUALIFICATION_ISSUER_RELEASE_MAP_CONTRACT = 'qualification-issuer-release-map/1' as const;
export const QUALIFICATION_API_ID = '6zt8e9qz04';
export const SYNTHETIC_STAGING_API_ID = 'wxv734oi12';
const REGION = 'us-east-2';
export const issuerOf = (pool: string) => `https://cognito-idp.${REGION}.amazonaws.com/${pool}`;

/** A cited source fact: `text` must appear on `line` of `file` (1-based), exactly. */
export type Cite = { file: string; line: number; text: string };
export type PoolRole = 'workforce' | 'consumer';
export type Pool = {
  id: string; role: PoolRole; plane: 'production' | 'shared_synthetic_staging' | 'isolated_qualification_fixture';
  client: string; mfa: 'ON' | 'OPTIONAL' | 'unverified_here'; mfaEvidence: string; pins: Cite[];
};

export const COGNITO_POOLS: Readonly<Record<string, Pool>> = Object.freeze({
  'us-east-2_AZMa5gxSZ': {
    id: 'us-east-2_AZMa5gxSZ', role: 'workforce', plane: 'production', client: '67moqjql53ms7247tphe5ftpd8', mfa: 'unverified_here',
    mfaEvidence: 'Not part of qualification. Its MFA is a Codex read (docs/workforce-current-identity-consent-2026-10-15.md:228).',
    pins: [{ file: 'src/server/clinical-core/aws-workforce-token-binding.ts', line: 13, text: 'const PRODUCTION_POOL = "us-east-2_AZMa5gxSZ";' },
      { file: 'src/server/clinical-core/aws-workforce-token-binding.ts', line: 14, text: 'const PRODUCTION_CLIENT = "67moqjql53ms7247tphe5ftpd8";' }],
  },
  'us-east-2_ueGlFRbNB': {
    id: 'us-east-2_ueGlFRbNB', role: 'workforce', plane: 'shared_synthetic_staging', client: '4s7jgr4o8sqdq7cvo9gmq96e2h', mfa: 'OPTIONAL',
    mfaEvidence: 'Read-only diagnostic of 2026-10-09: "The workforce pool also has optional MFA, so it fails the new qualification requirement for enforced workforce MFA" (docs/inventory-qualification-fleet.md:202; docs/inventory-qualification-identities.md:3). Reported, not observed in this session.',
    pins: [{ file: 'src/server/clinical-core/aws-workforce-token-binding.ts', line: 15, text: 'const QUALIFICATION_POOL = "us-east-2_ueGlFRbNB";' },
      { file: 'src/server/clinical-core/aws-workforce-token-binding.ts', line: 16, text: 'const QUALIFICATION_CLIENT = "4s7jgr4o8sqdq7cvo9gmq96e2h";' }],
  },
  'us-east-2_nYngyyYGE': {
    id: 'us-east-2_nYngyyYGE', role: 'consumer', plane: 'shared_synthetic_staging', client: '72aksm2dm4nf03l8d9nrp2dbh0', mfa: 'OPTIONAL',
    mfaEvidence: 'Same diagnostic: "The consumer pool has optional software-token MFA" (docs/inventory-qualification-fleet.md:202).',
    pins: [{ file: 'scripts/synthetic-care-release.mjs', line: 15, text: "consumerPool: 'us-east-2_nYngyyYGE', consumerClient: '72aksm2dm4nf03l8d9nrp2dbh0'," }],
  },
  'us-east-2_zGOVBoeGT': {
    id: 'us-east-2_zGOVBoeGT', role: 'workforce', plane: 'isolated_qualification_fixture', client: '1ffcdpnh0k45b3gc2hm9938ebl', mfa: 'ON',
    mfaEvidence: 'Template: scripts/build-inventory-qualification-identities.mjs:27 (MfaConfiguration ON for the workforce pool). Required on observation by scripts/telehealth-qualification-preflight.mjs:62 and inventory-qualification-identity-dependency.ts:105.',
    pins: [{ file: 'src/server/clinical-core/inventory-qualification-fixtures.ts', line: 11, text: "workforceIssuer: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_zGOVBoeGT'," },
      { file: 'src/server/clinical-core/inventory-qualification-fixtures.ts', line: 12, text: "workforceAudience: '1ffcdpnh0k45b3gc2hm9938ebl'," }],
  },
  'us-east-2_G2Hvf9wzJ': {
    id: 'us-east-2_G2Hvf9wzJ', role: 'consumer', plane: 'isolated_qualification_fixture', client: '18q2q70rlsv8ti37knolpq7qsu', mfa: 'OPTIONAL',
    mfaEvidence: 'Template: scripts/build-inventory-qualification-identities.mjs:27 (OPTIONAL for consumers).',
    pins: [{ file: 'src/server/clinical-core/inventory-qualification-fixtures.ts', line: 9, text: "consumerIssuer: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_G2Hvf9wzJ'," },
      { file: 'src/server/clinical-core/inventory-qualification-fixtures.ts', line: 10, text: "consumerAudience: '18q2q70rlsv8ti37knolpq7qsu'," }],
  },
});

/** Where a runner's workforce issuer comes from. */
export type IssuerSource =
  | { kind: 'pinned'; pool: string; pins: Cite[] }
  /** Supplied per run by a reviewed binding or target file, compared by the runner with the deployed authorizer. */
  | { kind: 'binding'; comparedWithAuthorizer: Cite | null }
  /** Set as a stack parameter; the runner does not compare it with anything (an observed authorizer must be supplied). */
  | { kind: 'unchecked_parameter'; parameter: Cite };

export type ReleaseMapEntry = {
  id: string;
  kind: 'authorizer_template' | 'runner' | 'handler' | 'pre_token_trigger';
  /** The HTTP API it serves or inspects; `target` means the qualification-target manifest's apiId. */
  api: typeof QUALIFICATION_API_ID | typeof SYNTHETIC_STAGING_API_ID | 'production' | 'target' | 'none';
  workforce: IssuerSource | null;
  consumer: IssuerSource | null;
  /** What it requires of the workforce pool's MFA, and where. */
  mfaRequirement: { required: boolean; cite: Cite | null; note: string };
  /** How the verified token's iat, exp and auth_time are used. */
  tokenTimes: { note: string; cite: Cite | null };
  /** The stack outputs or parameters it reads (empty for a pure handler). */
  stackReads: { names: string[]; cite: Cite | null };
  /** Set when the source still names the older MFA-optional workforce issuer or cannot be bound to one issuer. */
  hostedHold?: string;
};

const pinned = (pool: string, ...pins: Cite[]): IssuerSource => ({ kind: 'pinned', pool, pins });
const PROGRAM_TOKEN_TIMES = {
  note: 'Workforce: recordingWorkforceIdentity requires exp > now, iat < exp, iat <= now + 60 s, auth_time <= iat and a sign-in within 15 minutes. Consumer: ownedConsumerIdentity requires exp > now, 0 < iat <= now + 60 s, iat < exp.',
  cite: { file: 'src/server/clinical-core/recording-authority-api.ts', line: 88, text: '|| now - Number(v.auth_time) * 1000 > 15 * 60000)' },
};
const OLDER_ISSUER_HOLD = 'Names the older MFA-optional shared staging workforce issuer us-east-2_ueGlFRbNB; the isolated qualification fixtures and the telehealth candidate expect us-east-2_zGOVBoeGT on the same API. Not changed here: moving it is a reviewed template, subject and Cognito decision for Codex.';

export const QUALIFICATION_ISSUER_RELEASE_MAP: readonly ReleaseMapEntry[] = Object.freeze([
  {
    id: 'program-api/candidate', kind: 'authorizer_template', api: QUALIFICATION_API_ID,
    workforce: pinned('us-east-2_ueGlFRbNB', { file: 'infra/aws-clinical-core/qualification-program-api-candidate.json', line: 33, text: '"us-east-2_ueGlFRbNB"' },
      { file: 'scripts/build-qualification-program-api.mjs', line: 21, text: "parameters.WorkforceUserPoolId.AllowedValues = ['us-east-2_ueGlFRbNB'];" }),
    consumer: pinned('us-east-2_nYngyyYGE', { file: 'infra/aws-clinical-core/qualification-program-api-candidate.json', line: 47, text: '"us-east-2_nYngyyYGE"' },
      { file: 'scripts/build-qualification-program-api.mjs', line: 23, text: "parameters.ConsumerUserPoolId.AllowedValues = ['us-east-2_nYngyyYGE'];" }),
    mfaRequirement: { required: false, cite: null, note: 'Neither the template nor any runner reads the pool\'s MFA configuration.' },
    tokenTimes: PROGRAM_TOKEN_TIMES,
    stackReads: { names: ['Outputs: FunctionArn, QualificationExecution, PhiAllowed (declared; no runner reads this /1 template)'], cite: null },
    hostedHold: OLDER_ISSUER_HOLD,
  },
  {
    id: 'program-api/successor', kind: 'authorizer_template', api: QUALIFICATION_API_ID,
    workforce: pinned('us-east-2_ueGlFRbNB', { file: 'infra/aws-clinical-core/qualification-program-api-successor.json', line: 37, text: '"us-east-2_ueGlFRbNB"' }),
    consumer: pinned('us-east-2_nYngyyYGE', { file: 'infra/aws-clinical-core/qualification-program-api-successor.json', line: 51, text: '"us-east-2_nYngyyYGE"' }),
    mfaRequirement: { required: false, cite: null, note: 'Not read.' },
    tokenTimes: PROGRAM_TOKEN_TIMES,
    stackReads: { names: ['see runner program-api/preflight'], cite: null },
    hostedHold: OLDER_ISSUER_HOLD,
  },
  {
    id: 'program-api/restricted-credential', kind: 'authorizer_template', api: QUALIFICATION_API_ID,
    workforce: pinned('us-east-2_ueGlFRbNB', { file: 'infra/aws-clinical-core/qualification-program-api-restricted-credential.json', line: 38, text: '"us-east-2_ueGlFRbNB"' }),
    consumer: pinned('us-east-2_nYngyyYGE', { file: 'infra/aws-clinical-core/qualification-program-api-restricted-credential.json', line: 52, text: '"us-east-2_nYngyyYGE"' }),
    mfaRequirement: { required: false, cite: null, note: 'Not read.' },
    tokenTimes: PROGRAM_TOKEN_TIMES,
    stackReads: { names: ['see runner program-api/update-preflight'], cite: null },
    hostedHold: OLDER_ISSUER_HOLD,
  },
  {
    id: 'program-api/preflight', kind: 'runner', api: QUALIFICATION_API_ID,
    workforce: pinned('us-east-2_ueGlFRbNB', { file: 'scripts/preflight-qualification-program-api.mjs', line: 52, text: '{ pool: template.Parameters.WorkforceUserPoolId?.AllowedValues?.[0], client: template.Parameters.WorkforceUserPoolClientId?.AllowedValues?.[0] },' }),
    consumer: pinned('us-east-2_nYngyyYGE', { file: 'scripts/preflight-qualification-program-api.mjs', line: 47, text: '|| template.Parameters.ConsumerUserPoolId?.AllowedValues?.[0] !== b.ConsumerPoolId' }),
    mfaRequirement: { required: false, cite: null, note: 'Requires an authorizer for each template pool on the API; never reads MFA.' },
    tokenTimes: { note: 'Runs no request: no token is read.', cite: null },
    stackReads: { names: ['foundation Outputs: ApiId, DatabaseName, PhiAllowed, Activation, QualificationExecution, DataClassification, CodeBucket, AlarmTopicArn, DatabaseClusterArn, LogsKmsKeyArn',
      'billing Parameters: ConsumerPoolId, ConsumerClientId, BillingActivation; Outputs: Activation, ApiOrigin', 'API authorizers: JwtConfiguration.Issuer/Audience per template pool'],
    cite: { file: 'scripts/preflight-qualification-program-api.mjs', line: 58, text: "a.AuthorizerType === 'JWT' && a.JwtConfiguration?.Issuer === `https://cognito-idp.${region}.amazonaws.com/${pool}`" } },
    hostedHold: OLDER_ISSUER_HOLD,
  },
  {
    id: 'program-api/update-preflight', kind: 'runner', api: QUALIFICATION_API_ID,
    workforce: pinned('us-east-2_ueGlFRbNB', { file: 'scripts/preflight-qualification-program-api-update.mjs', line: 52, text: 'const workforcePool = template.Parameters.WorkforceUserPoolId.AllowedValues[0];' }),
    consumer: pinned('us-east-2_nYngyyYGE', { file: 'scripts/preflight-qualification-program-api-update.mjs', line: 50, text: 'const consumerPool = template.Parameters.ConsumerUserPoolId.AllowedValues[0];' }),
    mfaRequirement: { required: false, cite: null, note: 'Never reads MFA.' },
    tokenTimes: { note: 'Runs no request: no token is read.', cite: null },
    stackReads: { names: ['stack Parameters: SourceCommit, ClinicalApiId, DatabaseName, ConsumerUserPoolId, ConsumerUserPoolClientId, WorkforceUserPoolId, WorkforceUserPoolClientId, QualificationProgramOrganizationId, QualificationIdentitySubjects, DatabaseClusterArn, QualificationBillingApiOrigin',
      'stack Outputs: FunctionArn, PhiAllowed, QualificationExecution', 'route authorizers: JwtConfiguration.Issuer/Audience'],
    cite: { file: 'scripts/preflight-qualification-program-api-update.mjs', line: 83, text: '|| auth.JwtConfiguration?.Issuer !== `https://cognito-idp.${region}.amazonaws.com/${pool}`' } },
    hostedHold: OLDER_ISSUER_HOLD,
  },
  {
    id: 'telehealth/qualification-template', kind: 'authorizer_template', api: 'target',
    workforce: pinned('us-east-2_zGOVBoeGT', { file: 'scripts/telehealth-qualification-template.mjs', line: 13, text: "WorkforceUserPoolId: 'us-east-2_zGOVBoeGT'," },
      { file: 'scripts/telehealth-qualification-template.mjs', line: 14, text: "WorkforceUserPoolClientId: '1ffcdpnh0k45b3gc2hm9938ebl'," }),
    consumer: pinned('us-east-2_G2Hvf9wzJ', { file: 'scripts/telehealth-qualification-template.mjs', line: 11, text: "ConsumerUserPoolId: 'us-east-2_G2Hvf9wzJ'," }),
    mfaRequirement: { required: true, cite: { file: 'scripts/telehealth-qualification-preflight.mjs', line: 62, text: '|| pool.MfaConfiguration !== mfa || pool.AdminCreateUserConfig?.AllowAdminCreateUserOnly !== true)' },
      note: 'The preflight requires the workforce pool MfaConfiguration ON and the workforce subject enrolled in SOFTWARE_TOKEN_MFA.' },
    tokenTimes: { note: 'Legacy claims path checks iss, aud and token_use only: exp is the API Gateway authorizer\'s (aws-telehealth-requests.ts:2857). The database_current path also requires exp > now (:2876).',
      cite: { file: 'src/server/clinical-core/aws-telehealth-requests.ts', line: 2876, text: '|| !Number.isFinite(expiry) || expiry * 1000 <= Date.now()' } },
    stackReads: { names: ['foundation Outputs: PhiAllowed, Activation, QualificationExecution, QualificationInfrastructure, Environment, DataClassification, ApiId, ApiOrigin, DatabaseName, DatabaseClusterArn, DatabaseSecretArn, CodeBucket'],
      cite: { file: 'scripts/telehealth-qualification-preflight.mjs', line: 50, text: "if (f.PhiAllowed !== 'false' || f.Activation !== 'blocked' || f.QualificationExecution !== 'disabled'" } },
  },
  {
    id: 'inventory/fixture-identities', kind: 'runner', api: 'target',
    workforce: pinned('us-east-2_zGOVBoeGT', { file: 'src/server/clinical-core/inventory-qualification-fixtures.ts', line: 11, text: "workforceIssuer: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_zGOVBoeGT'," }),
    consumer: pinned('us-east-2_G2Hvf9wzJ', { file: 'src/server/clinical-core/inventory-qualification-fixtures.ts', line: 9, text: "consumerIssuer: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_G2Hvf9wzJ'," }),
    mfaRequirement: { required: true, cite: { file: 'src/server/clinical-core/inventory-qualification-identity-dependency.ts', line: 105, text: "const m = obj(raw); same(m.MfaConfiguration, workforce ? 'ON' : 'OPTIONAL'); same(m.SoftwareTokenMfaConfiguration, { Enabled: true });" },
      note: 'The identity observer requires MfaConfiguration ON (workforce) and the fixture authenticator a fresh software-token challenge.' },
    tokenTimes: { note: 'Fixture tokens: iss and token_use exact, iat and auth_time within [now - 120 s, now + 30 s], exp > now, exp - iat <= 900 s.',
      cite: { file: 'src/server/clinical-core/inventory-fixture-token.ts', line: 51, text: '|| Number(claims.exp) - Number(claims.iat) > 900 || Number(claims.exp) <= Number(claims.iat)' } },
    stackReads: { names: ['candidate stack Parameters (exact): WorkforceIssuer, WorkforceAudience, ConsumerIssuer, ConsumerAudience from the fixture identity, ApiId, SourceCommit, DatabaseName and the rest',
      'the shared API\'s routes and authorizers (the voice consumer authorizer against the fixture consumer issuer)'],
      cite: { file: 'src/server/clinical-core/inventory-qualification-target.ts', line: 129, text: 'WorkforceIssuer: identity.workforceIssuer, WorkforceAudience: identity.workforceAudience,' } },
  },
  {
    id: 'clinic-records/runner', kind: 'runner', api: 'target',
    workforce: { kind: 'binding', comparedWithAuthorizer: { file: 'scripts/clinic-records-qualification-target.mjs', line: 141, text: '|| !same(auth.JwtConfiguration, { Issuer: t.parameters[`${pool}Issuer`], Audience: [t.parameters[`${pool}Audience`]] })' } },
    consumer: { kind: 'binding', comparedWithAuthorizer: { file: 'scripts/clinic-records-qualification-target.mjs', line: 141, text: '|| !same(auth.JwtConfiguration, { Issuer: t.parameters[`${pool}Issuer`], Audience: [t.parameters[`${pool}Audience`]] })' } },
    mfaRequirement: { required: false, cite: { file: 'scripts/clinic-records-qualification-target.mjs', line: 43, text: 'RetentionReviewSha256: b.reviews.retention, WorkforceMfaReviewSha256: b.reviews.workforceMfa,' },
      note: 'A WorkforceMfaReviewSha256 review hash is required as a stack parameter; the pool\'s MFA configuration is not read.' },
    tokenTimes: { note: 'The runner classifies each supplied token by auth_time: fresh <= 4 min, aged between the 5-minute copy window and the 15-minute consumer window (30 s margins), stale > 15 min + 30 s; a token outside its window ends the run.',
      cite: { file: 'scripts/clinic-records-qualification-runner.mjs', line: 69, text: 'fresh: age => age <= 4 * 60_000,' } },
    stackReads: { names: ['foundation Parameters: DatabaseClusterArn, DatabaseSecretArn; Outputs: ApiId, PhiAllowed, Activation', 'candidate stack Parameters (all, exact)', 'Lambda environment incl. SOURCE_COMMIT', 'route authorizers'],
      cite: { file: 'scripts/clinic-records-qualification-target.mjs', line: 82, text: "if (fp.DatabaseClusterArn !== t.clusterArn || fp.DatabaseSecretArn !== t.secretArn || fo.ApiId !== t.apiId" } },
  },
  {
    id: 'care/observer', kind: 'runner', api: 'target',
    workforce: { kind: 'binding', comparedWithAuthorizer: { file: 'scripts/care-messaging-qualification-observer.mjs', line: 233, text: "same(auth.JwtConfiguration,{Issuer:p[pool+'Issuer'],Audience:[p[pool+'Audience']]},'authorizer_refused');" } },
    consumer: { kind: 'binding', comparedWithAuthorizer: { file: 'scripts/care-messaging-qualification-observer.mjs', line: 233, text: "same(auth.JwtConfiguration,{Issuer:p[pool+'Issuer'],Audience:[p[pool+'Audience']]},'authorizer_refused');" } },
    mfaRequirement: { required: false, cite: null, note: 'The pool\'s MFA configuration is not read (care messaging and care connections inspectors).' },
    tokenTimes: { note: 'Inspector only: runs no request. The handlers use ownedConsumerIdentity (exp > now, iat bounds) for the consumer.', cite: { file: 'src/server/clinical-core/owned-consumer-api.ts', line: 203, text: '|| Number(v.iat)>=Number(v.exp)) throw new OwnedStorageError("owner_required");' } },
    stackReads: { names: ['stack Outputs: PhiAllowed, Activation, SourceCommit, MigrationReleaseSha256, DatabaseName, QualificationExecution, FunctionName (+ ClaimRecoveryEnabled for care-connections)', 'stack Parameters (exact)', 'route authorizers'],
      cite: { file: 'scripts/care-messaging-qualification-observer.mjs', line: 183, text: " same(output,{PhiAllowed:'false',Activation:'blocked',SourceCommit:head,MigrationReleaseSha256:a.manifest.migrationReleaseSha256," } },
  },
  {
    id: 'shared-manifest/candidate-stacks', kind: 'runner', api: 'target',
    workforce: { kind: 'unchecked_parameter', parameter: { file: 'scripts/build-aws-recording-authority.mjs', line: 96, text: 'AuthorizerType: "JWT", IdentitySource: ["$request.header.Authorization"], JwtConfiguration: { Issuer: ref("WorkforceIssuer"), Audience: [ref("WorkforceAudience")] },' } },
    consumer: null,
    mfaRequirement: { required: false, cite: null, note: 'Recording, privacy, personal-storage, owned-lab and owned-voice stacks take WorkforceIssuer as a parameter; the acceptance CLIs compare SourceCommit only.' },
    tokenTimes: { note: 'Recording family handlers use recordingWorkforceIdentity (15-minute auth_time).', cite: PROGRAM_TOKEN_TIMES.cite },
    stackReads: { names: ['Output and Parameter SourceCommit against the manifest; no issuer or audience comparison'],
      cite: { file: 'src/server/clinical-core/qualification-target-manifest.ts', line: 222, text: 'if (parameters.SourceCommit !== manifest.sourceCommit) refuse();' } },
    hostedHold: 'The shared-manifest acceptance CLIs never compare the authorizer issuer with anything (docs/codex-hosted-qualification-packet-2026-10-17.md §5): which pool these stacks were deployed with is unobserved. A plan that includes them must carry an observed authorizer.',
  },
  {
    id: 'fullscript/qualification', kind: 'runner', api: 'target',
    workforce: { kind: 'binding', comparedWithAuthorizer: { file: 'src/server/fullscript/qualification-deployment-execution.ts', line: 109, text: "&&same(auth[0].JwtConfiguration,{Issuer:target[role.toLowerCase()+'Issuer'],Audience:[values[role+'Audience']]}));" } },
    consumer: { kind: 'binding', comparedWithAuthorizer: { file: 'src/server/fullscript/qualification-deployment-execution.ts', line: 109, text: "&&same(auth[0].JwtConfiguration,{Issuer:target[role.toLowerCase()+'Issuer'],Audience:[values[role+'Audience']]}));" } },
    mfaRequirement: { required: true, cite: { file: 'src/server/fullscript/qualification-deployment-resources.ts', line: 75, text: "check(pool.MfaConfiguration==='ON'&&pool.DeviceConfiguration===undefined&&flows.length>0&&new Set(flows).size===flows.length" },
      note: 'Optional-MFA pools are refused (docs/fullscript-qualification-api-2026-10-09.md:47).' },
    tokenTimes: { note: 'Sign-in must follow the currently observed pool, client and user changes (docs/fullscript-qualification-api-2026-10-09.md:38-42).', cite: null },
    stackReads: { names: ['route authorizers, Lambda version and code hash, PHI and qualification settings (live, per request)'], cite: null },
  },
  {
    id: 'token-binding/pre-token-trigger', kind: 'pre_token_trigger', api: 'none',
    workforce: pinned('us-east-2_ueGlFRbNB', { file: 'src/server/clinical-core/aws-workforce-token-binding.ts', line: 15, text: 'const QUALIFICATION_POOL = "us-east-2_ueGlFRbNB";' }),
    consumer: null,
    mfaRequirement: { required: false, cite: null, note: 'A pre-token trigger cannot see MFA; it rechecks the database binding on every issue, refresh included.' },
    tokenTimes: { note: 'Runs at issue and at TokenGeneration_RefreshTokens: an inactive clinic, membership or identity gets no clinic claims on refresh.',
      cite: { file: 'src/server/clinical-core/aws-workforce-token-binding.ts', line: 28, text: '"TokenGeneration_RefreshTokens",' } },
    stackReads: { names: [], cite: null },
    hostedHold: 'BLOCKED and not configured on any pool. Its qualification configuration accepts only the older MFA-optional pool; pointing it at us-east-2_zGOVBoeGT is a reviewed source change.',
  },
  {
    id: 'workforce-applications/api', kind: 'handler', api: 'none',
    workforce: pinned('us-east-2_ueGlFRbNB', { file: 'src/server/clinical-core/aws-workforce-applications-api.ts', line: 16, text: "const POOL = 'us-east-2_ueGlFRbNB';" },
      { file: 'src/server/clinical-core/aws-workforce-applicant-identity.ts', line: 7, text: "const POOL = 'us-east-2_ueGlFRbNB';" }),
    consumer: null,
    mfaRequirement: { required: false, cite: null, note: 'Applicant plane: no clinical authority; the applicant identity checks Cognito Enabled.' },
    tokenTimes: { note: 'iss, aud and token_use exact.', cite: { file: 'src/server/clinical-core/aws-workforce-applications-api.ts', line: 116, text: "|| claim('aud') !== CLIENT || claim('token_use') !== 'id'" } },
    stackReads: { names: [], cite: null },
  },
  {
    id: 'synthetic-care/release', kind: 'runner', api: SYNTHETIC_STAGING_API_ID,
    workforce: pinned('us-east-2_ueGlFRbNB', { file: 'scripts/synthetic-care-release.mjs', line: 16, text: "workforcePool: 'us-east-2_ueGlFRbNB', workforceClient: '4s7jgr4o8sqdq7cvo9gmq96e2h'," }),
    consumer: pinned('us-east-2_nYngyyYGE', { file: 'scripts/synthetic-care-release.mjs', line: 15, text: "consumerPool: 'us-east-2_nYngyyYGE', consumerClient: '72aksm2dm4nf03l8d9nrp2dbh0'," }),
    mfaRequirement: { required: false, cite: null, note: 'The synthetic staging API, not the qualification API.' },
    tokenTimes: { note: 'Synthetic handlers: iss, aud, token_use and custom:synthetic_attested.', cite: null },
    stackReads: { names: ['the staging stack LambdaCodeKey and authorizers (scripts/verify-deployed-synthetic-care.mjs)'], cite: null },
  },
  {
    id: 'production/clinical-api', kind: 'handler', api: 'production',
    workforce: pinned('us-east-2_AZMa5gxSZ', { file: 'src/server/clinical-core/aws-production-clinical-api.ts', line: 38, text: 'const CURRENT_AUTHORITY_ISSUER = "https://cognito-idp.us-east-2.amazonaws.com/us-east-2_AZMa5gxSZ";' },
      { file: 'src/server/clinical-core/aws-identity-api.ts', line: 298, text: '&& (input.configuration.workforceIssuer !== "https://cognito-idp.us-east-2.amazonaws.com/us-east-2_AZMa5gxSZ"' }),
    consumer: null,
    mfaRequirement: { required: false, cite: null, note: 'database_current pins the production issuer; never part of a qualification plan.' },
    tokenTimes: { note: 'Legacy path carries the verified iat/exp only for the BLOCKED ordinary-suspension window (lifetime 300 s to 1 day, else absent).',
      cite: { file: 'src/server/clinical-core/ordinary-suspension-window.ts', line: 40, text: 'if (issuedAt === null || expiresAt === null || expiresAt <= issuedAt || expiresAt - issuedAt < 300 || expiresAt - issuedAt > 86_400) return null;' } },
    stackReads: { names: [], cite: null },
  },
]);

/** Pool ids that appear in source but name no workforce issuer of a hosted runner or authorizer here. */
export const OTHER_POOL_PINS: readonly (Cite & { reason: string })[] = Object.freeze([
  { file: 'scripts/prepare-aws-lab-test-account.ps1', line: 2, text: '[string]$UserPoolId = "us-east-2_nYngyyYGE",', reason: 'consumer smoke script against the synthetic staging API; not admissible hosted evidence' },
  { file: 'scripts/provision-synthetic-ask-alp-personas.mjs', line: 14, text: 'const poolId = process.env.CONSUMER_USER_POOL_ID ?? "us-east-2_nYngyyYGE";', reason: 'consumer persona provisioning for the synthetic staging API' },
  { file: 'scripts/qualify-aws-daily-guidance-hosted.mjs', line: 14, text: 'const USER_POOL = "us-east-2_nYngyyYGE";', reason: 'consumer smoke script; compares only iss with a constant' },
]);

export type QualificationIssuerRefusal = 'release_map_entry_unknown' | 'api_mismatch' | 'workforce_issuer_unbound' | 'issuer_unknown'
  | 'issuer_not_workforce_pool' | 'production_issuer_refused' | 'mixed_workforce_issuer' | 'authorizer_issuer_mismatch' | 'authorizer_unobserved'
  | 'workforce_mfa_not_required';
export class QualificationIssuerPlanError extends Error {
  constructor(readonly refusal: QualificationIssuerRefusal, readonly detail: string) { super(`${refusal}:${detail}`); this.name = 'QualificationIssuerPlanError'; }
}

export type IssuerBinding = { workforceIssuer: string; workforceAudience: string };
export type QualificationIssuerPlan = {
  /** The one HTTP API the run targets; `target` entries resolve to it. */
  apiId: string;
  /** Release-map entry ids the run depends on. */
  entries: readonly string[];
  /** The reviewed binding or target issuer for entries whose issuer is supplied per run. */
  bindings?: Readonly<Record<string, IssuerBinding>>;
  /** Authorizer JwtConfiguration as read from the deployed API, per entry, when it has been observed. */
  observedAuthorizers?: Readonly<Record<string, IssuerBinding>>;
};

const poolFromIssuer = (issuer: string) => {
  const match = /^https:\/\/cognito-idp\.us-east-2\.amazonaws\.com\/(us-east-2_[A-Za-z0-9]+)$/.exec(issuer);
  return match ? match[1]! : null;
};
const refuse = (refusal: QualificationIssuerRefusal, detail: string): never => { throw new QualificationIssuerPlanError(refusal, detail); };

/**
 * One workforce issuer for one qualification run, or a refusal. Returns the pool, issuer and audience every runner in
 * the plan expects. It reads nothing but its arguments and the map.
 */
export function assertQualificationIssuerPlan(plan: QualificationIssuerPlan): { workforcePool: string; workforceIssuer: string; workforceAudience: string; entries: string[] } {
  const expected = new Map<string, { pool: string; audience: string }>();
  for (const id of plan.entries) {
    const entry = QUALIFICATION_ISSUER_RELEASE_MAP.find(e => e.id === id) ?? refuse('release_map_entry_unknown', id);
    const api = entry.api === 'target' ? plan.apiId : entry.api;
    if (api !== plan.apiId) refuse('api_mismatch', `${id}:${entry.api}`);
    if (!entry.workforce) continue;
    let pool: string, audience: string;
    if (entry.workforce.kind === 'pinned') {
      pool = entry.workforce.pool;
      audience = COGNITO_POOLS[pool]?.client ?? refuse('issuer_unknown', `${id}:${pool}`);
    } else {
      const binding = plan.bindings?.[id] ?? refuse('workforce_issuer_unbound', id);
      pool = poolFromIssuer(binding.workforceIssuer) ?? refuse('issuer_unknown', `${id}:${binding.workforceIssuer}`);
      audience = binding.workforceAudience;
    }
    const known = COGNITO_POOLS[pool] ?? refuse('issuer_unknown', `${id}:${pool}`);
    if (known.plane === 'production') refuse('production_issuer_refused', `${id}:${pool}`);
    if (known.role !== 'workforce') refuse('issuer_not_workforce_pool', `${id}:${pool}`);
    if (audience !== known.client) refuse('issuer_unknown', `${id}:${pool}:audience`);
    const observed = plan.observedAuthorizers?.[id];
    if (entry.workforce.kind === 'unchecked_parameter' && !observed) refuse('authorizer_unobserved', id);
    if (observed && (observed.workforceIssuer !== issuerOf(pool) || observed.workforceAudience !== audience)) refuse('authorizer_issuer_mismatch', `${id}:${observed.workforceIssuer}`);
    expected.set(id, { pool, audience });
  }
  const pools = [...new Set([...expected.values()].map(v => v.pool))];
  if (pools.length === 0) refuse('workforce_issuer_unbound', 'no workforce runner in the plan');
  if (pools.length > 1) refuse('mixed_workforce_issuer', [...expected.entries()].map(([id, v]) => `${id}=${v.pool}`).join(','));
  const pool = COGNITO_POOLS[pools[0]!]!;
  if (pool.mfa !== 'ON') refuse('workforce_mfa_not_required', pool.id);
  return { workforcePool: pool.id, workforceIssuer: issuerOf(pool.id), workforceAudience: pool.client, entries: [...expected.keys()] };
}
