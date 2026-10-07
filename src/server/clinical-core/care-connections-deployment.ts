if (typeof window !== 'undefined') throw new Error('care-connections-deployment is server-only');
import type { ApiGatewayV2Event, ApiGatewayV2Response } from './aws-identity-api';
import type { ClinicalCoreDatabase } from './database';
import { bindCareConnectionDatabase, validateCareConnectionFunctions, type CareConnectionFunctionBinding } from './care-connections-database-binding';
import { createProductionCareConnectionApi } from './production-care-connections-api';
import { createProductionCareConnections } from './production-care-connections';
import { createRdsDataClinicalCoreDatabase, type RdsDataConfiguration } from './rds-data-database';
import { resolveQualificationExecution } from './qualification-execution';

export type CareConnectionsBuild = {
  sourceCommit: string; sourceClean: boolean; migrationCount: 106; migrationReleaseSha256: string;
  functions: readonly CareConnectionFunctionBinding[];
};
type Environment = Record<string, string | undefined>;
const release = '514959bf0d32de55ded312509ae2ebe39a0fdde9f59246b096b0c41ba63f4f9b';
const hash = /^[a-f0-9]{64}$/;

/** Review identifiers are supplied by the release operator, not generated here.
 * Construction captures inputs synchronously so later mutation cannot retarget
 * a cached handler. Invalid or blocked requests never construct a data client. */
export function createCareConnectionsHandler(environment: Environment, suppliedBuild: CareConnectionsBuild,
  databaseFactory: (configuration: RdsDataConfiguration) => ClinicalCoreDatabase = createRdsDataClinicalCoreDatabase,
  now?: () => number): (event: ApiGatewayV2Event) => Promise<ApiGatewayV2Response> {
  try {
    const e = { ...environment }, build = structuredClone(suppliedBuild);
    const functions = validateCareConnectionFunctions(build.functions);
    if (!/^[a-f0-9]{40}$/.test(build.sourceCommit) || build.migrationCount !== 106
      || build.migrationReleaseSha256 !== release || e.SOURCE_COMMIT !== build.sourceCommit
      || e.MIGRATION_RELEASE_SHA256 !== release || e.AWS_REGION !== 'us-east-2'
      || !/^https:\/\/cognito-idp\.us-east-2\.amazonaws\.com\/us-east-2_[A-Za-z0-9]+$/.test(e.CONSUMER_ISSUER ?? '')
      || !/^https:\/\/cognito-idp\.us-east-2\.amazonaws\.com\/us-east-2_[A-Za-z0-9]+$/.test(e.WORKFORCE_ISSUER ?? '')
      || !['false', 'true'].includes(e.PHI_ALLOWED ?? '')
      || !['blocked', 'approved'].includes(e.CARE_CONNECTIONS_ACTIVATION ?? '')) throw new Error('binding_refused');
    const activation = e.CARE_CONNECTIONS_ACTIVATION === 'approved' ? 'approved' as const : 'blocked' as const;
    const qualification = resolveQualificationExecution(e, activation);
    const serving = qualification !== undefined || e.PHI_ALLOWED === 'true';
    if (serving) {
      const account = qualification?.accountId ?? '173535830222';
      if (build.sourceClean !== true || e.DEPLOYMENT_ACCOUNT_ID !== account
        || qualification && (account !== '588966314750' || qualification.databaseName !== 'clinical_core_qualification')
        || !new RegExp(`^arn:aws:rds:us-east-2:${account}:cluster:[A-Za-z0-9-]{1,63}$`).test(e.CLINICAL_DATABASE_CLUSTER_ARN ?? '')
        || !new RegExp(`^arn:aws:secretsmanager:us-east-2:${account}:secret:[A-Za-z0-9/_+=.@!-]+$`).test(e.CLINICAL_DATABASE_SECRET_ARN ?? '')
        || !/^[a-z][a-z0-9_]{0,62}$/.test(e.CLINICAL_DATABASE_NAME ?? '')
        || !qualification && /qualification/.test(e.CLINICAL_DATABASE_NAME ?? '')
        || !hash.test(e.RETENTION_REVIEW_SHA256 ?? '')) throw new Error('binding_refused');
    }
    // Empty means every new scope is disabled, not an implicit all-scopes grant.
    const enabledScopes = e.ENABLED_CONSENT_SCOPES === undefined || e.ENABLED_CONSENT_SCOPES === ''
      ? [] : e.ENABLED_CONSENT_SCOPES.split(',');
    let database: ClinicalCoreDatabase | undefined;
    const getDatabase = () => database ??= bindCareConnectionDatabase(databaseFactory({
      clusterArn: e.CLINICAL_DATABASE_CLUSTER_ARN ?? '', secretArn: e.CLINICAL_DATABASE_SECRET_ARN ?? '',
      databaseName: e.CLINICAL_DATABASE_NAME ?? '', region: e.AWS_REGION,
    }), functions);
    return createProductionCareConnectionApi({ configuration: {
      consumerIssuer: e.CONSUMER_ISSUER ?? '', consumerAudience: e.CONSUMER_AUDIENCE ?? '',
      workforceIssuer: e.WORKFORCE_ISSUER ?? '', workforceAudience: e.WORKFORCE_AUDIENCE ?? '',
      organizationId: e.CARE_CONNECTIONS_ORGANIZATION_ID ?? '', phiAllowed: e.PHI_ALLOWED === 'true', activation,
      ...(qualification ? { qualification } : {}), activationEvidenceSha256: e.CARE_CONNECTIONS_EVIDENCE_SHA256,
      databaseReviewSha256: e.DATABASE_REVIEW_SHA256, mfaReviewSha256: e.WORKFORCE_MFA_REVIEW_SHA256,
      connectionReviewSha256: e.CONNECTION_REVIEW_SHA256, consentReviewSha256: e.CONSENT_REVIEW_SHA256,
      enabledScopes,
    }, operations: () => createProductionCareConnections(getDatabase()), now });
  } catch {
    // A malformed deployment is not labelled as a qualified execution.
    return async () => ({ statusCode: 503, headers: { 'content-type': 'application/json', 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff' }, body: JSON.stringify({ error: 'service_unavailable' }) });
  }
}
