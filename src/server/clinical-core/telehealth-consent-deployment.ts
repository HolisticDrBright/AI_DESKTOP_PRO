if (typeof window !== 'undefined') throw Error('telehealth-consent-deployment is server-only');
import { createHash } from 'node:crypto';
import type { ApiGatewayV2Event, ApiGatewayV2Response } from './aws-identity-api';
import type { ClinicalCoreDatabase } from './database';
import { validateCareConnectionFunctions, type CareConnectionFunctionBinding } from './care-connections-database-binding';
import { bindTelehealthConsentDatabase } from './telehealth-consent-database-binding';
import { createProductionTelehealthConsentApi } from './production-telehealth-consent-api';
import { createProductionTelehealthConsent } from './production-telehealth-consent';
import { createRdsDataClinicalCoreDatabase, type RdsDataConfiguration } from './rds-data-database';
import { resolveQualificationExecution } from './qualification-execution';

export const TELEHEALTH_CONSENT_RELEASE = '45aec4369ec94bf6339a17e47eadba7b81e7b5195fd5be46c2903e587b709fb4';
export const TELEHEALTH_CONSENT_ASSEMBLY = '6cc191355442ae2c2349cab50466979eaab0e45961a4e1547f34785294dce4b9';
export const TELEHEALTH_CONSENT_SQL = '5d4b361c4849b900c4c6e4f95686cf77c28797584bc9e9ec1136f38bdc325e0e';
export type TelehealthConsentBuild = { sourceCommit: string; sourceClean: boolean; sourceInputSha256: string;
  migrationCount: 112; migrationReleaseSha256: string; assemblySha256: string; sqlSha256: string;
  functions: readonly CareConnectionFunctionBinding[]; telehealthFunctionSha256: string };
type Environment = Record<string, string | undefined>;
const hash = /^[a-f0-9]{64}$/;
/** Release configuration identity, NOT approval evidence. Only identifiers and
 * gates are hashed; never a JWT, secret value, consent wording or patient data. */
export const TELEHEALTH_CONSENT_CONFIGURATION_KEYS = ['AWS_REGION', 'DEPLOYMENT_ACCOUNT_ID', 'SOURCE_COMMIT',
  'SOURCE_INPUT_SHA256', 'MIGRATION_RELEASE_SHA256', 'TELEHEALTH_CONSENT_ACTIVATION', 'PHI_ALLOWED',
  'TELEHEALTH_CONSENT_ENABLED', 'TELEHEALTH_CONSENT_ORGANIZATION_ID', 'TELEHEALTH_CONSENT_EVIDENCE_SHA256',
  'DATABASE_REVIEW_SHA256', 'WORKFORCE_MFA_REVIEW_SHA256', 'CONNECTION_REVIEW_SHA256', 'CONSENT_REVIEW_SHA256',
  'RETENTION_REVIEW_SHA256', 'CONSUMER_ISSUER', 'CONSUMER_AUDIENCE', 'WORKFORCE_ISSUER', 'WORKFORCE_AUDIENCE',
  'CLINICAL_DATABASE_CLUSTER_ARN', 'CLINICAL_DATABASE_SECRET_ARN', 'CLINICAL_DATABASE_NAME',
  'QUALIFICATION_EXECUTION', 'QUALIFICATION_REVIEW_SHA256', 'QUALIFICATION_ACCOUNT_ID', 'QUALIFICATION_IDENTITY_SUBJECTS'] as const;
export function telehealthConsentConfigurationSha256(e: Environment): string {
  return createHash('sha256').update(JSON.stringify(TELEHEALTH_CONSENT_CONFIGURATION_KEYS.map(key => [key, e[key] ?? '']))).digest('hex');
}
/** Strict operator input for computing configuration identity. This validates
 * identifiers, not approvals or cloud observations. Never read a process-wide
 * environment dump: AWS credentials and other unrelated values are not inputs. */
export function telehealthConsentConfigurationIdentity(value: unknown): { configurationSha256: string } {
  const invalid = () => { throw Error('telehealth_consent_configuration_input_refused'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 2 || input.contract !== 'telehealth-consent-configuration/1'
    || !input.environment || typeof input.environment !== 'object' || Array.isArray(input.environment)) return invalid();
  const e = input.environment as Record<string, unknown>, keys = Object.keys(e);
  if (keys.length !== TELEHEALTH_CONSENT_CONFIGURATION_KEYS.length
    || keys.some(key => !TELEHEALTH_CONSENT_CONFIGURATION_KEYS.some(allowed => allowed === key))) return invalid();
  for (const key of TELEHEALTH_CONSENT_CONFIGURATION_KEYS) {
    const v = e[key]; if (typeof v !== 'string' || v.length > 2200) return invalid();
    let valid = false;
    if (key === 'AWS_REGION') valid = v === 'us-east-2';
    else if (key === 'DEPLOYMENT_ACCOUNT_ID') valid = ['588966314750', '173535830222'].includes(v);
    else if (key === 'SOURCE_COMMIT') valid = /^[a-f0-9]{40}$/.test(v);
    else if (key === 'SOURCE_INPUT_SHA256' || key === 'MIGRATION_RELEASE_SHA256') valid = hash.test(v);
    else if (key.endsWith('_SHA256')) valid = v === '' || hash.test(v);
    else if (key === 'TELEHEALTH_CONSENT_ACTIVATION') valid = ['blocked', 'approved'].includes(v);
    else if (key === 'PHI_ALLOWED' || key === 'TELEHEALTH_CONSENT_ENABLED') valid = ['false', 'true'].includes(v);
    else if (key === 'TELEHEALTH_CONSENT_ORGANIZATION_ID') valid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
    else if (key.endsWith('_ISSUER')) valid = /^https:\/\/cognito-idp\.us-east-2\.amazonaws\.com\/us-east-2_[A-Za-z0-9]+$/.test(v);
    else if (key.endsWith('_AUDIENCE')) valid = /^[A-Za-z0-9]{20,128}$/.test(v);
    else if (key === 'CLINICAL_DATABASE_CLUSTER_ARN') valid = /^arn:aws:rds:us-east-2:[0-9]{12}:cluster:[A-Za-z0-9-]{1,63}$/.test(v);
    else if (key === 'CLINICAL_DATABASE_SECRET_ARN') valid = /^arn:aws:secretsmanager:us-east-2:[0-9]{12}:secret:[A-Za-z0-9/_+=.@!-]+$/.test(v);
    else if (key === 'CLINICAL_DATABASE_NAME') valid = ['clinical_core', 'clinical_core_qualification'].includes(v);
    else if (key === 'QUALIFICATION_EXECUTION') valid = ['enabled', 'disabled'].includes(v);
    else if (key === 'QUALIFICATION_ACCOUNT_ID') valid = v === '' || v === '588966314750';
    else if (key === 'QUALIFICATION_IDENTITY_SUBJECTS') {
      const subjects = v.split(',');
      valid = v === '' || subjects.length <= 16 && subjects.every(s => /^[A-Za-z0-9:_-]{8,128}$/.test(s))
        && new Set(subjects).size === subjects.length;
    }
    if (!valid) return invalid();
  }
  if (e.CONSUMER_ISSUER === e.WORKFORCE_ISSUER || e.CONSUMER_AUDIENCE === e.WORKFORCE_AUDIENCE) return invalid();
  return { configurationSha256: telehealthConsentConfigurationSha256(e as Record<string, string>) };
}

/** Independently compiled 112 entry point. Historical 106/107 paths are unchanged.
 * Request code uses clinical_core_api only. Function/copy protections are
 * checked per transaction; full migration-ledger qualification is operator work. */
export function createTelehealthConsentHandler(environment: Environment, supplied: TelehealthConsentBuild,
  factory: (c: RdsDataConfiguration) => ClinicalCoreDatabase = createRdsDataClinicalCoreDatabase,
  now?: () => number): (event: ApiGatewayV2Event) => Promise<ApiGatewayV2Response> {
  try {
    const e = { ...environment }, build = structuredClone(supplied), functions = validateCareConnectionFunctions(build.functions);
    if (!/^[a-f0-9]{40}$/.test(build.sourceCommit) || typeof build.sourceClean !== 'boolean' || !hash.test(build.sourceInputSha256)
      || build.migrationCount !== 112 || build.migrationReleaseSha256 !== TELEHEALTH_CONSENT_RELEASE
      || build.assemblySha256 !== TELEHEALTH_CONSENT_ASSEMBLY || build.sqlSha256 !== TELEHEALTH_CONSENT_SQL
      || !hash.test(build.telehealthFunctionSha256) || e.SOURCE_COMMIT !== build.sourceCommit
      || e.SOURCE_INPUT_SHA256 !== build.sourceInputSha256 || e.MIGRATION_RELEASE_SHA256 !== TELEHEALTH_CONSENT_RELEASE
      || e.AWS_REGION !== 'us-east-2' || !['false', 'true'].includes(e.PHI_ALLOWED ?? '')
      || !['blocked', 'approved'].includes(e.TELEHEALTH_CONSENT_ACTIVATION ?? '')
      || !['false', 'true'].includes(e.TELEHEALTH_CONSENT_ENABLED ?? '')) throw Error('binding_refused');
    const activation = e.TELEHEALTH_CONSENT_ACTIVATION === 'approved' ? 'approved' as const : 'blocked' as const;
    const qualification = resolveQualificationExecution(e, activation), serving = Boolean(qualification) || e.PHI_ALLOWED === 'true';
    if (serving) {
      const account = qualification?.accountId ?? '173535830222';
      if (!build.sourceClean || e.DEPLOYMENT_ACCOUNT_ID !== account
        || qualification && (account !== '588966314750' || qualification.databaseName !== 'clinical_core_qualification')
        || !new RegExp(`^arn:aws:rds:us-east-2:${account}:cluster:[A-Za-z0-9-]{1,63}$`).test(e.CLINICAL_DATABASE_CLUSTER_ARN ?? '')
        || !new RegExp(`^arn:aws:secretsmanager:us-east-2:${account}:secret:[A-Za-z0-9/_+=.@!-]+$`).test(e.CLINICAL_DATABASE_SECRET_ARN ?? '')
        || !/^[a-z][a-z0-9_]{0,62}$/.test(e.CLINICAL_DATABASE_NAME ?? '')
        || !qualification && e.CLINICAL_DATABASE_NAME !== 'clinical_core'
        || !hash.test(e.RETENTION_REVIEW_SHA256 ?? '') || !hash.test(e.TELEHEALTH_CONSENT_CONFIGURATION_SHA256 ?? '')
        || e.TELEHEALTH_CONSENT_CONFIGURATION_SHA256 !== telehealthConsentConfigurationSha256(e)) throw Error('binding_refused');
    }
    let database: ClinicalCoreDatabase | undefined;
    const get = () => database ??= bindTelehealthConsentDatabase(factory({ clusterArn: e.CLINICAL_DATABASE_CLUSTER_ARN ?? '',
      secretArn: e.CLINICAL_DATABASE_SECRET_ARN ?? '', databaseName: e.CLINICAL_DATABASE_NAME ?? '', region: e.AWS_REGION }),
      functions, build.telehealthFunctionSha256);
    return createProductionTelehealthConsentApi({ configuration: {
      consumerIssuer: e.CONSUMER_ISSUER ?? '', consumerAudience: e.CONSUMER_AUDIENCE ?? '',
      workforceIssuer: e.WORKFORCE_ISSUER ?? '', workforceAudience: e.WORKFORCE_AUDIENCE ?? '',
      organizationId: e.TELEHEALTH_CONSENT_ORGANIZATION_ID ?? '', phiAllowed: e.PHI_ALLOWED === 'true', activation,
      ...(qualification ? { qualification } : {}), activationEvidenceSha256: e.TELEHEALTH_CONSENT_EVIDENCE_SHA256,
      databaseReviewSha256: e.DATABASE_REVIEW_SHA256, mfaReviewSha256: e.WORKFORCE_MFA_REVIEW_SHA256,
      connectionReviewSha256: e.CONNECTION_REVIEW_SHA256, consentReviewSha256: e.CONSENT_REVIEW_SHA256,
      telehealthConsentEnabled: e.TELEHEALTH_CONSENT_ENABLED === 'true',
    }, operations: () => createProductionTelehealthConsent(get()), now });
  } catch {
    return async () => ({ statusCode: 503, headers: { 'content-type': 'application/json', 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff' }, body: JSON.stringify({ error: 'service_unavailable' }) });
  }
}
