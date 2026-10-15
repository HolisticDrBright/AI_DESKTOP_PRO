if (typeof window !== 'undefined') throw new Error('qualification-program-api is server-only');
import type { ApiGatewayV2Event, ApiGatewayV2Response } from './aws-identity-api';
import type { ClinicalCoreDatabase } from './database';
import type { RdsDataConfiguration } from './rds-data-database';
import { ownedConsumerIdentity } from './owned-consumer-api';
import { OwnedStorageError } from './owned-consumer-records';
import { recordingWorkforceIdentity } from './recording-authority-api';
import { RecordingAuthorityError } from './encounter-recording-operations';
import { markQualificationResponse, resolveQualificationExecution } from './qualification-execution';
import { ProductionProgramAssignmentError } from './production-program-assignments';
import { createQualificationProgramAssignments, QUALIFICATION_PROGRAM_BOUNDARY_CANDIDATE_SHA256, QUALIFICATION_PROGRAM_LEDGER,
  validateQualificationProgramFunctions, type QualificationProgramFunctionBinding } from './qualification-program-assignments';

/**
 * The two program routes for the isolated qualification API, BLOCKED by default and source-only: no Lambda entry point,
 * template or route registration imports this yet (see docs/qualification-program-boundary-2026-10-15.md).
 *
 * It replaces, for the qualification target only, the identity Lambda's synthetic program route, which calls
 * createProgramAssignments and so needs a synthetic-staging database the qualification target does not have. The route
 * and the database function agree on one context and one contract: the production-shaped context the qualification
 * database runs, the qualification adapter (the production request path behind qualification execution), and
 * clinical_core.production_program_bounded_request opened by the BLOCKED qualification-program-boundary successor.
 *
 * Construction refuses, and every request then answers 503 without any database client being created, unless: the
 * build is clean and names the approved 112 ledger and the exact boundary candidate; PHI is off; the program activation
 * is `blocked`; qualification execution is enabled for the synthetic account and a qualification database; the issuers
 * and the clinic are pinned. Under it, only designated fictional subjects are admitted.
 */
export const QUALIFICATION_PROGRAM_ROUTES = ['POST /clinical-core/consumer/programs', 'POST /clinical-core/workforce/programs'] as const;
export type QualificationProgramBuild = {
  sourceCommit: string; sourceClean: boolean; migrationCount: number; migrationReleaseSha256: string;
  boundaryCandidateSha256: string; functions: readonly QualificationProgramFunctionBinding[];
};
type Environment = Record<string, string | undefined>;
const ISSUER = /^https:\/\/cognito-idp\.us-east-2\.amazonaws\.com\/us-east-2_[A-Za-z0-9]+$/;
const AUDIENCE = /^[A-Za-z0-9]{20,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const QUALIFICATION_ACCOUNT = '588966314750';

export function createQualificationProgramHandler(environment: Environment, suppliedBuild: QualificationProgramBuild, deps: {
  databaseFactory: (configuration: RdsDataConfiguration) => ClinicalCoreDatabase;
  /** The consumer's current Core entitlement, verified per request from the authorization the request carried. */
  verifyConsumerCore: (authorization: string) => Promise<void>;
  now?: () => number;
}): (event: ApiGatewayV2Event) => Promise<ApiGatewayV2Response> {
  try {
    const e = { ...environment }, build = structuredClone(suppliedBuild);
    const functions = validateQualificationProgramFunctions(build.functions);
    if (!/^[a-f0-9]{40}$/.test(build.sourceCommit) || build.sourceClean !== true || e.SOURCE_COMMIT !== build.sourceCommit
      || build.migrationCount !== QUALIFICATION_PROGRAM_LEDGER.migrationCount || build.migrationReleaseSha256 !== QUALIFICATION_PROGRAM_LEDGER.migrationReleaseSha256
      || e.MIGRATION_RELEASE_SHA256 !== QUALIFICATION_PROGRAM_LEDGER.migrationReleaseSha256
      || build.boundaryCandidateSha256 !== QUALIFICATION_PROGRAM_BOUNDARY_CANDIDATE_SHA256 || e.QUALIFICATION_PROGRAM_BOUNDARY_SHA256 !== QUALIFICATION_PROGRAM_BOUNDARY_CANDIDATE_SHA256
      || e.AWS_REGION !== 'us-east-2' || e.PHI_ALLOWED !== 'false' || e.PROGRAM_ACTIVATION !== 'blocked'
      || e.DEPLOYMENT_ACCOUNT_ID !== QUALIFICATION_ACCOUNT || !ISSUER.test(e.CONSUMER_ISSUER ?? '') || !ISSUER.test(e.WORKFORCE_ISSUER ?? '')
      || e.CONSUMER_ISSUER === e.WORKFORCE_ISSUER || !AUDIENCE.test(e.CONSUMER_AUDIENCE ?? '') || !AUDIENCE.test(e.WORKFORCE_AUDIENCE ?? '')
      || e.CONSUMER_AUDIENCE === e.WORKFORCE_AUDIENCE || !UUID.test(e.QUALIFICATION_PROGRAM_ORGANIZATION_ID ?? '')
      || !new RegExp(`^arn:aws:secretsmanager:us-east-2:${QUALIFICATION_ACCOUNT}:secret:[A-Za-z0-9/_+=.@!-]+$`).test(e.CLINICAL_DATABASE_SECRET_ARN ?? ''))
      throw new Error('binding_refused');
    const qualification = resolveQualificationExecution(e, 'blocked');
    if (!qualification || qualification.accountId !== QUALIFICATION_ACCOUNT) throw new Error('binding_refused');
    const clock = deps.now ?? Date.now;
    const workforce = { workforceIssuer: e.WORKFORCE_ISSUER!, workforceAudience: e.WORKFORCE_AUDIENCE!, organizationId: e.QUALIFICATION_PROGRAM_ORGANIZATION_ID!,
      phiAllowed: false, activation: 'blocked' as const, qualification };
    const consumer = { consumerIssuer: e.CONSUMER_ISSUER!, consumerAudience: e.CONSUMER_AUDIENCE! };
    let programs: ReturnType<typeof createQualificationProgramAssignments> | undefined;
    // The data client and the adapter are made on the first admitted request, never at construction.
    const service = () => programs ??= createQualificationProgramAssignments({
      database: deps.databaseFactory({ clusterArn: e.CLINICAL_DATABASE_CLUSTER_ARN ?? '', secretArn: e.CLINICAL_DATABASE_SECRET_ARN ?? '',
        databaseName: qualification.databaseName, region: 'us-east-2' }),
      functions, phiAllowed: false, activation: 'blocked', qualification, verifyConsumerCore: deps.verifyConsumerCore,
    });
    const handle = async (event: ApiGatewayV2Event): Promise<ApiGatewayV2Response> => {
      if (!QUALIFICATION_PROGRAM_ROUTES.includes(event.routeKey as typeof QUALIFICATION_PROGRAM_ROUTES[number])) return reply(404, { error: 'route_not_found' });
      try {
        const body = readBody(event), now = clock();
        const context = event.routeKey === QUALIFICATION_PROGRAM_ROUTES[1] ? recordingWorkforceIdentity(event, workforce, now) : ownedConsumerIdentity(event, consumer, 'clinical_data', now);
        if (!qualification.identitySubjects.includes(context.identitySubject)) return reply(503, { error: 'production_not_activated', phiAllowed: false });
        const authorization = Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === 'authorization')?.[1] ?? '';
        return reply(200, { data: await service()(context, body, authorization) });
      } catch (error) {
        if (error instanceof OwnedStorageError || error instanceof RecordingAuthorityError) return reply(401, { error: 'reauth_required' });
        if (error instanceof ProductionProgramAssignmentError) {
          const code = error.category;
          if (code === 'activation_refused') return reply(503, { error: 'production_not_activated', phiAllowed: false });
          return reply(code === 'request_invalid' ? 400 : code === 'conflict' ? 409 : code === 'service_unavailable' ? 503 : 403,
            { error: code, ...(code === 'conflict' && error.reason ? { reason: error.reason } : {}) });
        }
        if (error instanceof RequestInvalid) return reply(400, { error: 'request_invalid' });
        return reply(503, { error: 'service_unavailable' });
      }
    };
    return async event => markQualificationResponse(qualification, await handle(event));
  } catch {
    // A malformed deployment is never labelled as a qualified execution, and never creates a data client.
    return async () => reply(503, { error: 'service_unavailable' });
  }
}
class RequestInvalid extends Error {}
function readBody(event: ApiGatewayV2Event): unknown {
  const type = Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === 'content-type')?.[1];
  if (type?.split(';')[0]?.trim().toLowerCase() !== 'application/json' || Object.keys(event.queryStringParameters ?? {}).length
    || typeof event.body !== 'string' || event.isBase64Encoded || Buffer.byteLength(event.body, 'utf8') > 262_144) throw new RequestInvalid();
  try { return JSON.parse(event.body); } catch { throw new RequestInvalid(); }
}
function reply(statusCode: number, payload: Record<string, unknown>): ApiGatewayV2Response {
  return { statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }, body: JSON.stringify(payload) };
}
