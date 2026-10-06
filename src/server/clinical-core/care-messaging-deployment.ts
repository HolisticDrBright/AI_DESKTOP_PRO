if (typeof window !== 'undefined') throw new Error('care-messaging-deployment is server-only');
import type { ApiGatewayV2Event, ApiGatewayV2Response } from './aws-identity-api';
import type { ClinicalCoreDatabase } from './database';
import { createProductionCareMessagingApi } from './production-care-messaging-api';
import { createProductionCareMessaging, createProductionCareMessageExport, ProductionCareMessageError } from './production-care-messaging';
import { createRdsDataClinicalCoreDatabase, type RdsDataConfiguration } from './rds-data-database';
import { resolveQualificationExecution } from './qualification-execution';

export type CareMessagingBuild = {
  sourceCommit: string; sourceClean: boolean; migrationCount: 104; migrationReleaseSha256: string;
  functions: readonly { schema: string; name: string; sha256: string; callable: boolean }[];
};
type Environment = Record<string, string | undefined>;
const hash = /^[a-f0-9]{64}$/, commit = /^[a-f0-9]{40}$/;
const tables = ['clinical_core.care_message_thread_links', 'clinical_core.care_message_receipts',
  'clinical_core.care_message_cancellations', 'clinical_audit.care_message_access_events'];

/** Checks deployment identity, not approval. A well-shaped review hash is never
 * created here or claimed to represent an executed review. */
function binding(e: Environment, build: CareMessagingBuild) {
  if (!commit.test(build.sourceCommit) || !hash.test(build.migrationReleaseSha256) || build.migrationCount !== 104
    || e.SOURCE_COMMIT !== build.sourceCommit || e.MIGRATION_RELEASE_SHA256 !== build.migrationReleaseSha256
    || e.CARE_MESSAGING_ACTIVATION !== 'blocked' && e.CARE_MESSAGING_ACTIVATION !== 'approved'
    || e.PHI_ALLOWED !== 'false' && e.PHI_ALLOWED !== 'true' || e.AWS_REGION !== 'us-east-2') throw new Error('binding_refused');
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
export function bindCareMessagingDatabase(database: ClinicalCoreDatabase, build: CareMessagingBuild): ClinicalCoreDatabase {
  if (build.functions.length !== 7 || new Set(build.functions.map(f => `${f.schema}.${f.name}`)).size !== 7
    || build.functions.some(f => !/^clinical_(core|private)$/.test(f.schema)
      || !/^production_care_message_[a-z]+$/.test(f.name) || !hash.test(f.sha256))) throw new Error('binding_refused');
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
      from checked_functions f cross join checked_tables t cross join checked_triggers g`, [JSON.stringify(build.functions), JSON.stringify(tables)]);
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
  try {
    const { activation, qualification } = binding(e, build);
    let database: ClinicalCoreDatabase | undefined;
    const getDatabase = () => database ??= bindCareMessagingDatabase(databaseFactory({
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
    }, messaging: () => createProductionCareMessaging(getDatabase()),
    exporter: () => createProductionCareMessageExport(getDatabase()), now });
  } catch {
    return async () => ({ statusCode: 503, headers: { 'content-type': 'application/json', 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff' }, body: JSON.stringify({ error: 'service_unavailable' }) });
  }
}
