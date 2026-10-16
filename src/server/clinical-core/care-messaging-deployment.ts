if (typeof window !== 'undefined') throw new Error('care-messaging-deployment is server-only');
import type { ApiGatewayV2Event, ApiGatewayV2Response } from './aws-identity-api';
import type { ClinicalCoreDatabase } from './database';
import { createProductionCareMessagingApi } from './production-care-messaging-api';
import { createCurrentMembershipCareMessaging, createProductionCareMessaging, createProductionCareMessageExport, ProductionCareMessageError } from './production-care-messaging';
import { CARE_MESSAGING_QUALIFICATION_ROLE, careMessagingQualificationConfiguration, createRdsDataClinicalCoreDatabase,
  createRdsDataQualificationCareMessagingDatabase, type RdsDataConfiguration } from './rds-data-database';
import type { ClinicalCoreTransaction } from './database';
import { resolveQualificationExecution } from './qualification-execution';
import { assertInventoryQualificationBinding, type InventoryQualificationBuild } from './adopted-plan-inventory-qualification-profile';
import { CURRENT_MEMBERSHIP_SETTER_BODY_SHA256, CURRENT_MEMBERSHIP_SETTER_BOUND_STATEMENT, CURRENT_MEMBERSHIP_SETTER_STATEMENT } from './current-membership-workforce';

export type CareMessagingBuild = {
  sourceCommit: string; sourceClean: boolean; migrationCount: 106 | 112; migrationReleaseSha256: string;
  functions: readonly { schema: string; name: string; sha256: string; callable: boolean }[];
};
export type InventoryCareMessagingBuild = InventoryQualificationBuild & Pick<CareMessagingBuild, 'functions'>;
type Environment = Record<string, string | undefined>;
const hash = /^[a-f0-9]{64}$/, commit = /^[a-f0-9]{40}$/;
const release106 = '514959bf0d32de55ded312509ae2ebe39a0fdde9f59246b096b0c41ba63f4f9b';
const qualificationRelease112 = '45aec4369ec94bf6339a17e47eadba7b81e7b5195fd5be46c2903e587b709fb4';
const tables = ['clinical_core.care_message_thread_links', 'clinical_core.care_message_receipts',
  'clinical_core.care_message_cancellations', 'clinical_audit.care_message_access_events'];

/** Checks deployment identity, not approval. A well-shaped review hash is never
 * created here or claimed to represent an executed review. */
function binding(e: Environment, build: CareMessagingBuild | InventoryCareMessagingBuild, inventory: boolean) {
  if (inventory) assertInventoryQualificationBinding(e, build as InventoryCareMessagingBuild, 'CARE_MESSAGING_ACTIVATION');
  const releaseValid = inventory ? build.migrationCount === 107
    : (build.migrationCount === 106 && build.migrationReleaseSha256 === release106)
      || (build.migrationCount === 112 && build.migrationReleaseSha256 === qualificationRelease112);
  if (!commit.test(build.sourceCommit) || !hash.test(build.migrationReleaseSha256)
    || !releaseValid
    || e.SOURCE_COMMIT !== build.sourceCommit || e.MIGRATION_RELEASE_SHA256 !== build.migrationReleaseSha256
    || e.CARE_MESSAGING_ACTIVATION !== 'blocked' && e.CARE_MESSAGING_ACTIVATION !== 'approved'
    || e.PHI_ALLOWED !== 'false' && e.PHI_ALLOWED !== 'true' || e.AWS_REGION !== 'us-east-2') throw new Error('binding_refused');
  // The 112 artifact is an isolated fictional qualification successor. A
  // separate production release must be reviewed rather than inheriting this
  // synthetic schema test's approval or active-mode template conditions.
  if (!inventory && build.migrationCount === 112
    && (e.PHI_ALLOWED !== 'false' || e.CARE_MESSAGING_ACTIVATION !== 'blocked')) throw new Error('binding_refused');
  // The workforce authority: unset is the deployed claim path. `database_current` is accepted only spelled exactly.
  if (![undefined, '', 'legacy_claims', 'database_current'].includes(e.CARE_MESSAGING_WORKFORCE_AUTHORITY)) throw new Error('binding_refused');
  const activation = e.CARE_MESSAGING_ACTIVATION === 'approved' ? 'approved' as const : 'blocked' as const;
  const qualification = resolveQualificationExecution(e, activation);
  const serving = qualification !== undefined || e.PHI_ALLOWED === 'true';
  if (serving && !build.sourceClean) throw new Error('binding_refused');
  if (serving) {
    const account = qualification?.accountId ?? '173535830222';
    if (e.DEPLOYMENT_ACCOUNT_ID !== account || qualification && (account !== '588966314750'
      || qualification.databaseName !== 'clinical_core_qualification')
      || !new RegExp(`^arn:aws:rds:us-east-2:${account}:cluster:[A-Za-z0-9-]{1,63}$`).test(e.CLINICAL_DATABASE_CLUSTER_ARN ?? '')
      || !new RegExp(`^arn:aws:secretsmanager:us-east-2:${account}:secret:[A-Za-z0-9/_+=.@!-]+$`).test(e.CLINICAL_DATABASE_SECRET_ARN ?? '')
      || !/^[a-z][a-z0-9_]{0,62}$/.test(e.CLINICAL_DATABASE_NAME ?? '')
      || !qualification && /qualification/.test(e.CLINICAL_DATABASE_NAME ?? '')) throw new Error('binding_refused');
  }
  return { activation, qualification };
}

/** Metadata only under clinical_core_api, never an administrative connection.
 * Checks the deployed messaging contract on every transaction before business
 * SQL. The complete migration ledger is separately verified by the deployment
 * operator/hosted target runner; this is not a whole-database ledger claim. */
export function bindCareMessagingDatabase(database: ClinicalCoreDatabase, build: Pick<CareMessagingBuild, 'functions'>): ClinicalCoreDatabase {
  const functions = validateFunctions(build.functions);
  return { transaction: work => database.transaction(async tx => {
    const checked = await tx.query<{ valid: boolean }>(`with expected as (
      select * from jsonb_to_recordset($1::jsonb) as e(schema text,name text,sha256 text,callable boolean)
    ), checked_functions as (
      select count(*)=7 and bool_and(p.prosecdef and p.proconfig=array['search_path=""']::text[]
        and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=e.sha256
        and has_function_privilege('clinical_core_api',p.oid,'EXECUTE')=e.callable
        and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
          where a.grantee=0 and a.privilege_type='EXECUTE')) valid
      from expected e join pg_namespace n on n.nspname=e.schema join pg_proc p on p.pronamespace=n.oid and p.proname=e.name
    ), checked_tables as (
      select count(*)=4 and bool_and(c.relrowsecurity and c.relforcerowsecurity
        and not has_table_privilege('clinical_core_api',c.oid,'SELECT,INSERT,UPDATE,DELETE')
        and not exists(select 1 from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
          where a.grantee=0 and a.privilege_type in ('SELECT','INSERT','UPDATE','DELETE'))) valid
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname||'.'||c.relname in (select jsonb_array_elements_text($2::jsonb))
    ), expected_triggers(table_name,trigger_name,function_name,event_mask) as (values
      ('clinical_core.care_message_receipts','care_message_receipts_immutable','block_update_delete',27),
      ('clinical_core.care_message_cancellations','care_message_cancellations_immutable','block_update_delete',27),
      ('clinical_core.care_message_thread_links','care_message_thread_links_immutable','block_update_delete',27),
      ('clinical_audit.care_message_access_events','care_message_access_events_immutable','block_update_delete',27),
      ('clinical_core.care_message_receipts','care_message_receipt_admission','production_care_message_admission',7),
      ('clinical_core.messages','stored_care_messages_immutable','production_care_message_immutable',27)
    ), checked_triggers as (
      select count(*)=6 and bool_and(not t.tgisinternal and t.tgenabled='O' and t.tgtype=e.event_mask
        and n.nspname='clinical_private' and p.proname=e.function_name and p.pronargs=0) valid
      from expected_triggers e join pg_trigger t on t.tgname=e.trigger_name and t.tgrelid=e.table_name::regclass
      join pg_proc p on p.oid=t.tgfoid join pg_namespace n on n.oid=p.pronamespace
    ) select current_user='clinical_core_api' and f.valid and t.valid and g.valid as valid
      from checked_functions f cross join checked_tables t cross join checked_triggers g`, [JSON.stringify(functions), JSON.stringify(tables)]);
    if (checked.rows[0]?.valid !== true) throw new ProductionCareMessageError('service_unavailable');
    return work(tx);
  }) };
}

/** Injectable factory permits transport tests without credentials. Runtime data
 * construction is lazy: blocked, mismatched or unauthorized traffic never gets
 * a database client. No secrets, messages, claims or raw errors are logged. */
export function createCareMessagingHandler(e: Environment, build: CareMessagingBuild,
  databaseFactory: (configuration: RdsDataConfiguration) => ClinicalCoreDatabase = createRdsDataClinicalCoreDatabase,
  now?: () => number): (event: ApiGatewayV2Event) => Promise<ApiGatewayV2Response> {
  return createHandler(e, build, databaseFactory, now, false);
}
/** Validate and capture compiled authority before constructing any data client. */
function validateFunctions(supplied: CareMessagingBuild['functions']) {
  const specs = ['clinical_private.production_care_message_actor', 'clinical_private.production_care_message_consent',
    'clinical_private.production_care_message_admission', 'clinical_private.production_care_message_immutable',
    'clinical_core.production_care_message_request', 'clinical_core.production_care_message_resolve', 'clinical_core.production_care_message_export'];
  const functions = supplied.map(f => ({ ...f }));
  if (functions.length !== 7 || new Set(functions.map(f => `${f.schema}.${f.name}`)).size !== 7
    || functions.some(f => !specs.includes(`${f.schema}.${f.name}`) || !hash.test(f.sha256)
      || f.callable !== (f.schema === 'clinical_core'))) throw new Error('binding_refused');
  return functions;
}
export function createInventoryCareMessagingHandler(e: Environment, build: InventoryCareMessagingBuild,
  databaseFactory: (configuration: RdsDataConfiguration) => ClinicalCoreDatabase = createRdsDataClinicalCoreDatabase,
  now?: () => number): (event: ApiGatewayV2Event) => Promise<ApiGatewayV2Response> {
  return createHandler(e, build, databaseFactory, now, true);
}
function createHandler(environment: Environment, supplied: CareMessagingBuild | InventoryCareMessagingBuild,
  databaseFactory: (configuration: RdsDataConfiguration) => ClinicalCoreDatabase, now: (() => number) | undefined,
  inventory: boolean, bind: (database: ClinicalCoreDatabase, build: Pick<CareMessagingBuild, 'functions'>) => ClinicalCoreDatabase = bindCareMessagingDatabase,
): (event: ApiGatewayV2Event) => Promise<ApiGatewayV2Response> {
  try {
    const e = { ...environment }, build = structuredClone(supplied);
    build.functions = validateFunctions(build.functions);
    const { activation, qualification } = binding(e, build, inventory);
    let database: ClinicalCoreDatabase | undefined;
    const getDatabase = () => database ??= bind(databaseFactory({
      clusterArn: e.CLINICAL_DATABASE_CLUSTER_ARN ?? '', secretArn: e.CLINICAL_DATABASE_SECRET_ARN ?? '',
      databaseName: e.CLINICAL_DATABASE_NAME ?? '', region: e.AWS_REGION,
    }), build);
    return createProductionCareMessagingApi({ configuration: {
      consumerIssuer: e.CONSUMER_ISSUER ?? '', consumerAudience: e.CONSUMER_AUDIENCE ?? '',
      workforceIssuer: e.WORKFORCE_ISSUER ?? '', workforceAudience: e.WORKFORCE_AUDIENCE ?? '',
      organizationId: e.CARE_MESSAGING_ORGANIZATION_ID ?? '', phiAllowed: e.PHI_ALLOWED === 'true', activation,
      ...(qualification ? { qualification } : {}), activationEvidenceSha256: e.CARE_MESSAGING_EVIDENCE_SHA256,
      databaseReviewSha256: e.DATABASE_REVIEW_SHA256, mfaReviewSha256: e.WORKFORCE_MFA_REVIEW_SHA256,
      messagingReviewSha256: e.MESSAGING_REVIEW_SHA256, retentionReviewSha256: e.RETENTION_REVIEW_SHA256,
      workforceAuthority: e.CARE_MESSAGING_WORKFORCE_AUTHORITY === 'database_current' ? 'database_current' : 'legacy_claims',
    }, messaging: () => createProductionCareMessaging(getDatabase()),
    currentMessaging: () => createCurrentMembershipCareMessaging(getDatabase()),
    exporter: () => createProductionCareMessageExport(getDatabase()), now });
  } catch {
    return serviceUnavailable;
  }
}
const serviceUnavailable = async (): Promise<ApiGatewayV2Response> => ({ statusCode: 503, headers: { 'content-type': 'application/json',
  'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }, body: JSON.stringify({ error: 'service_unavailable' }) });

/**
 * BLOCKED restricted-credential successor, qualification 112 only
 * (infra/aws-clinical-core/source-candidates/care-messaging-qualification-login.sql).
 *
 * The same messaging service, signed in with its own secret instead of the cluster-master one, running as a NOLOGIN
 * role that can execute four proxies and nothing else. Each proxy calls one of the functions the service already uses,
 * as the owner that function already runs as, so consent, recipient, connection, idempotency and row-level-security
 * checks are unchanged. The configuration is refused before any database client exists unless it names that dedicated
 * secret, the qualification database, the 112 release, PHI off and activation blocked. `database_current` is refused:
 * its setter has no reviewed proxy yet.
 */
export const CARE_MESSAGING_QUALIFICATION_CREDENTIAL = 'restricted_qualification';
export const CARE_MESSAGING_QUALIFICATION_SCHEMA = 'clinical_care_messaging_qualification';
/** Exact prosrc hashes of the four proxies; the candidate test fails if a reviewed body or this binding drifts. */
export const CARE_MESSAGING_QUALIFICATION_PROXIES = [
  { name: 'set_request_context', target: 'clinical_private.set_request_context', bodySha256: '23cb89c1a12f2b2fce4bb13be7e9d34f9759990b1a0afee5470fc22855668215' },
  { name: 'request', target: 'clinical_core.production_care_message_request', bodySha256: '99467cbdf1a891c2770e1a5c543762496fe5935f993de78e53338d625b1f2840' },
  { name: 'resolve', target: 'clinical_core.production_care_message_resolve', bodySha256: 'db7803d4d147edc25b7be38aee803d31f4f56269387f312edfd4fa5a54122330' },
  { name: 'export', target: 'clinical_core.production_care_message_export', bodySha256: '16ae0d63d1383312ef9ed99442e34ff5fe2e7e69cd4c2f5a7822fc8772f675c0' },
] as const;
/** Every statement the messaging service sends under this credential, and the proxy statement it becomes. */
export const CARE_MESSAGING_QUALIFICATION_STATEMENTS: ReadonlyMap<string, string> = new Map([
  ['select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)', `select ${CARE_MESSAGING_QUALIFICATION_SCHEMA}.set_request_context($1,$2,$3,$4,$5,$6,$7)`],
  ['select clinical_core.production_care_message_request($1::jsonb) as data', `select ${CARE_MESSAGING_QUALIFICATION_SCHEMA}.request($1::jsonb) as data`],
  ['select clinical_core.production_care_message_resolve($1::jsonb) as data', `select ${CARE_MESSAGING_QUALIFICATION_SCHEMA}.resolve($1::jsonb) as data`],
  ['select clinical_core.production_care_message_export($1::jsonb) as data', `select ${CARE_MESSAGING_QUALIFICATION_SCHEMA}.export($1::jsonb) as data`],
]);

/** Metadata only, as the restricted role, on every transaction before business SQL. Names are joined, never cast to
 * regclass: the role has no USAGE on the clinical schemas, and must not need it to check them. The counts are the
 * credential's: seven targets and four proxies for the parent, eight and five for the current-context successor. */
const restrictedContractFor = (targetCount: number, proxyCount: number) => `with expected as (
      select * from jsonb_to_recordset($1::jsonb) as e(schema text,name text,sha256 text,callable boolean)
    ), targets as (
      select count(*)=${targetCount} and bool_and(p.prosecdef and p.proconfig=array['search_path=""']::text[]
        and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=e.sha256
        and not has_function_privilege(current_user,p.oid,'EXECUTE')
        and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
          where a.grantee=0 and a.privilege_type='EXECUTE')) valid
      from expected e join pg_namespace n on n.nspname=e.schema join pg_proc p on p.pronamespace=n.oid and p.proname=e.name
    ), proxies as (
      select count(*)=${proxyCount} and bool_and(p.prosecdef and p.proconfig=array['search_path=""']::text[]
        and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=x.sha256
        and has_function_privilege(current_user,p.oid,'EXECUTE')
        and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
          where a.grantee=0 and a.privilege_type='EXECUTE')) valid
      from jsonb_to_recordset($3::jsonb) as x(name text,sha256 text)
      join pg_namespace n on n.nspname='${CARE_MESSAGING_QUALIFICATION_SCHEMA}' join pg_proc p on p.pronamespace=n.oid and p.proname=x.name
    ), proxy_count as (
      select count(*)=${proxyCount} valid from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='${CARE_MESSAGING_QUALIFICATION_SCHEMA}'
    ), tables as (
      select count(*)=4 and bool_and(c.relrowsecurity and c.relforcerowsecurity
        and not has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE')
        and not exists(select 1 from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
          where a.grantee=0 and a.privilege_type in ('SELECT','INSERT','UPDATE','DELETE'))) valid
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname||'.'||c.relname in (select jsonb_array_elements_text($2::jsonb))
    ), expected_triggers(schema_name,table_name,trigger_name,function_name,event_mask) as (values
      ('clinical_core','care_message_receipts','care_message_receipts_immutable','block_update_delete',27),
      ('clinical_core','care_message_cancellations','care_message_cancellations_immutable','block_update_delete',27),
      ('clinical_core','care_message_thread_links','care_message_thread_links_immutable','block_update_delete',27),
      ('clinical_audit','care_message_access_events','care_message_access_events_immutable','block_update_delete',27),
      ('clinical_core','care_message_receipts','care_message_receipt_admission','production_care_message_admission',7),
      ('clinical_core','messages','stored_care_messages_immutable','production_care_message_immutable',27)
    ), triggers as (
      select count(*)=6 and bool_and(not t.tgisinternal and t.tgenabled='O' and t.tgtype=e.event_mask
        and fn.nspname='clinical_private' and p.proname=e.function_name and p.pronargs=0) valid
      from expected_triggers e join pg_namespace tn on tn.nspname=e.schema_name
      join pg_class c on c.relnamespace=tn.oid and c.relname=e.table_name
      join pg_trigger t on t.tgrelid=c.oid and t.tgname=e.trigger_name
      join pg_proc p on p.oid=t.tgfoid join pg_namespace fn on fn.oid=p.pronamespace
    ), reach as (
      select not exists(select 1 from pg_namespace n where n.nspname in ('clinical_core','clinical_private','clinical_audit')
          and has_schema_privilege(current_user,n.oid,'USAGE'))
        and not exists(select 1 from pg_auth_members m join pg_roles r on r.oid=m.member where r.rolname=current_user)
        and (select count(*) from pg_auth_members m join pg_roles r on r.oid=m.member where r.rolname=session_user)=1 valid
    ) select current_user='${CARE_MESSAGING_QUALIFICATION_ROLE}' and session_user<>current_user
        and f.valid and x.valid and k.valid and t.valid and g.valid and r.valid as valid
      from targets f cross join proxies x cross join proxy_count k cross join tables t cross join triggers g cross join reach r`;

const restrictedContract = restrictedContractFor(7, 4);

export function bindRestrictedCareMessagingDatabase(database: ClinicalCoreDatabase, build: Pick<CareMessagingBuild, 'functions'>): ClinicalCoreDatabase {
  const functions = validateFunctions(build.functions);
  const proxies = CARE_MESSAGING_QUALIFICATION_PROXIES.map(({ name, bodySha256 }) => ({ name, sha256: bodySha256 }));
  return { transaction: work => database.transaction(async tx => {
    const checked = await tx.query<{ valid: boolean }>(restrictedContract, [JSON.stringify(functions), JSON.stringify(tables), JSON.stringify(proxies)]);
    if (checked.rows[0]?.valid !== true) throw new ProductionCareMessageError('service_unavailable');
    // Only the service's own statements, each rewritten to its proxy. Anything else is refused before it is sent.
    const proxied: ClinicalCoreTransaction = { query: async (sql, parameters) => {
      const statement = CARE_MESSAGING_QUALIFICATION_STATEMENTS.get(sql);
      if (statement === undefined) throw new ProductionCareMessageError('service_unavailable');
      return tx.query(statement, parameters);
    } };
    return work(proxied);
  }) };
}

/**
 * BLOCKED current-context successor, a separate identity
 * (infra/aws-clinical-core/source-candidates/care-messaging-qualification-current-context.sql over the parent credential
 * and the UNREGISTERED current-membership setter). The same restricted role, plus one fifth proxy that binds messaging's
 * own current workforce context (purpose fixed to `clinical_data`) through the unchanged setter, in the operation's
 * transaction, with its rows share-locked. Under this credential, and only this one, `database_current` is accepted.
 * The parent credential above is unchanged and still refuses it.
 */
export const CARE_MESSAGING_QUALIFICATION_CURRENT_CREDENTIAL = 'restricted_qualification_current';
export const CARE_MESSAGING_QUALIFICATION_CURRENT_PROXY = { name: 'set_current_workforce_context',
  target: 'clinical_private.set_current_workforce_context', bodySha256: '8b1de4471e95f7e3a5a8aea7a390e9c1d9a522cdf3eefd445fc5332d82f2e5be' } as const;
type Rewrite = { sql: string; parameters?: (parameters: readonly unknown[]) => unknown[] };
/** The setter is bound through its proxy: the reviewed setter, unreachable directly, and the proxy executable. */
const currentProxyBound = `select coalesce((select count(*)=1 and bool_and(s.prosecdef and s.proconfig=array['search_path=""']::text[]
      and encode(sha256(convert_to(s.prosrc,'UTF8')),'hex')=$1
      and not has_function_privilege(current_user,s.oid,'EXECUTE')
      and not exists(select 1 from aclexplode(coalesce(s.proacl,acldefault('f',s.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE')
      and has_function_privilege(current_user,x.oid,'EXECUTE'))
    from pg_proc s, pg_namespace sn, pg_proc x, pg_namespace xn
    where sn.oid=s.pronamespace and sn.nspname='clinical_private' and s.proname='set_current_workforce_context'
      and xn.oid=x.pronamespace and xn.nspname='${CARE_MESSAGING_QUALIFICATION_SCHEMA}' and x.proname='set_current_workforce_context'),false) as valid`;
/** The parent's four statements, plus the current-membership path's two. The setter's purpose argument must be the one
 * messaging uses; the proxy fixes it, so anything else is refused before it is sent. */
export const CARE_MESSAGING_QUALIFICATION_CURRENT_STATEMENTS: ReadonlyMap<string, Rewrite> = new Map<string, Rewrite>([
  ...[...CARE_MESSAGING_QUALIFICATION_STATEMENTS].map(([from, sql]): [string, Rewrite] => [from, { sql }]),
  [CURRENT_MEMBERSHIP_SETTER_STATEMENT, { sql: `select ${CARE_MESSAGING_QUALIFICATION_SCHEMA}.set_current_workforce_context($1,$2) as binding`,
    parameters: (parameters) => {
      if (parameters.length !== 3 || parameters[2] !== 'clinical_data') throw new ProductionCareMessageError('service_unavailable');
      return [parameters[0], parameters[1]];
    } }],
  [CURRENT_MEMBERSHIP_SETTER_BOUND_STATEMENT, { sql: currentProxyBound }],
]);
const restrictedCurrentContract = restrictedContractFor(8, 5);

export function bindRestrictedCurrentCareMessagingDatabase(database: ClinicalCoreDatabase, build: Pick<CareMessagingBuild, 'functions'>): ClinicalCoreDatabase {
  const functions = [...validateFunctions(build.functions),
    { schema: 'clinical_private', name: 'set_current_workforce_context', sha256: CURRENT_MEMBERSHIP_SETTER_BODY_SHA256, callable: false }];
  const proxies = [...CARE_MESSAGING_QUALIFICATION_PROXIES, CARE_MESSAGING_QUALIFICATION_CURRENT_PROXY]
    .map(({ name, bodySha256 }) => ({ name, sha256: bodySha256 }));
  return { transaction: work => database.transaction(async tx => {
    const checked = await tx.query<{ valid: boolean }>(restrictedCurrentContract, [JSON.stringify(functions), JSON.stringify(tables), JSON.stringify(proxies)]);
    if (checked.rows[0]?.valid !== true) throw new ProductionCareMessageError('service_unavailable');
    const proxied: ClinicalCoreTransaction = { query: async (sql, parameters) => {
      const rewrite = CARE_MESSAGING_QUALIFICATION_CURRENT_STATEMENTS.get(sql);
      if (rewrite === undefined) throw new ProductionCareMessageError('service_unavailable');
      return tx.query(rewrite.sql, rewrite.parameters ? rewrite.parameters(parameters ?? []) : parameters);
    } };
    return work(proxied);
  }) };
}

const restrictedIdentity = (e: Environment, build: CareMessagingBuild) =>
  build.migrationCount === 112 && build.migrationReleaseSha256 === qualificationRelease112
    && e.PHI_ALLOWED === 'false' && e.CARE_MESSAGING_ACTIVATION === 'blocked' && e.DEPLOYMENT_ACCOUNT_ID === '588966314750'
    && careMessagingQualificationConfiguration({ clusterArn: e.CLINICAL_DATABASE_CLUSTER_ARN, secretArn: e.CLINICAL_DATABASE_SECRET_ARN,
      databaseName: e.CLINICAL_DATABASE_NAME, region: e.AWS_REGION });
/** Deployment identity for the restricted successor, checked before any database client is constructed. */
export function restrictedCareMessagingConfiguration(e: Environment, build: CareMessagingBuild): boolean {
  return e.CARE_MESSAGING_DATABASE_CREDENTIAL === CARE_MESSAGING_QUALIFICATION_CREDENTIAL
    && [undefined, '', 'legacy_claims'].includes(e.CARE_MESSAGING_WORKFORCE_AUTHORITY) && restrictedIdentity(e, build);
}
/** The current-context successor: its own credential flag, and `database_current` exactly. */
export function restrictedCurrentCareMessagingConfiguration(e: Environment, build: CareMessagingBuild): boolean {
  return e.CARE_MESSAGING_DATABASE_CREDENTIAL === CARE_MESSAGING_QUALIFICATION_CURRENT_CREDENTIAL
    && e.CARE_MESSAGING_WORKFORCE_AUTHORITY === 'database_current' && restrictedIdentity(e, build);
}
export function createRestrictedCareMessagingHandler(e: Environment, build: CareMessagingBuild,
  databaseFactory: (configuration: RdsDataConfiguration) => ClinicalCoreDatabase = createRdsDataQualificationCareMessagingDatabase,
  now?: () => number): (event: ApiGatewayV2Event) => Promise<ApiGatewayV2Response> {
  if (restrictedCareMessagingConfiguration({ ...e }, build)) return createHandler(e, build, databaseFactory, now, false, bindRestrictedCareMessagingDatabase);
  if (restrictedCurrentCareMessagingConfiguration({ ...e }, build)) {
    return createHandler(e, build, databaseFactory, now, false, bindRestrictedCurrentCareMessagingDatabase);
  }
  return serviceUnavailable;
}
