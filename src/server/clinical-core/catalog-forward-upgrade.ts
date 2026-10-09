if (typeof window !== 'undefined') throw new Error('catalog-forward-upgrade is server-only');
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ClinicalCoreDatabase, ClinicalCoreTransaction } from './database';
import { splitPostgresStatements, type ClinicalCoreMigration } from './migrations';
import { CARE_ERASURE_AWS, CareErasureUpgradeError, careErasurePreservation, type CareErasureUpgradeConfiguration } from './care-erasure-schema-upgrade';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const rows = (migrations: ClinicalCoreMigration[]) => migrations.map(({ version, name, sha256 }) => ({ version, name, sha256 }));
const ordinal = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export const CATALOG_FORWARD_UPGRADE = Object.freeze({
  version: '20261008060000', name: 'catalog_offer_current_product',
  sqlSha256: '3d63f4a04b8168818844736ea5143115ca1e01fc9b2c96f0da6d5889938a6117',
  sourceCoreSha256: '02026932fff5a37db42a17a1c4f80bd38a759cf8e2ccb2f4d53b8299c66065e7',
  liveCoreSha256: '447cf4ea8c8da3decbaa7edea964f97d9e3bdb029c38723bf3a5767c38679a50',
  referenceBeforeSha256: '83d51dc056b41f47b5fb3d6020201163915faa2116004e3692af9bb41aad0f62',
  tableMetadataSha256: 'b2f51c806ce1ddf0c7d7a1bb745136c4f468e01403f3f3de489ccd1d67b90a56',
});

type Category = 'boundary_refused' | 'artifact_refused' | 'history_refused' | 'inventory_refused' | 'upgrade_busy'
  | 'policy_refused' | 'observation_changed' | 'data_changed' | 'schema_changed' | 'verification_failed' | 'upgrade_failed';
export class CatalogForwardUpgradeError extends Error {
  constructor(readonly category: Category, readonly stage?: string) { super(category); }
}
const fail = (category: Category, stage?: string): never => { throw new CatalogForwardUpgradeError(category, stage); };
export function loadCatalogForwardCandidate(): ClinicalCoreMigration {
  const sql = readFileSync(path.join(process.cwd(), 'infra/aws-clinical-core/source-candidates/catalog-offer-current-product.sql'), 'utf8').replace(/\r\n?/g, '\n');
  return { version: CATALOG_FORWARD_UPGRADE.version, name: CATALOG_FORWARD_UPGRADE.name, sha256: sha(sql), sql };
}
function canonical(migrations: ClinicalCoreMigration[]) {
  if (migrations.some((m, i) => !/^\d{14}$/.test(m.version) || !/^[a-z0-9_]+$/.test(m.name)
    || m.sql !== m.sql.replace(/\r\n?/g, '\n') || sha(m.sql) !== m.sha256 || i > 0 && m.version <= migrations[i - 1].version)) fail('artifact_refused');
}
/** A future reference successor is a separate artifact. The registered two-entry
 * manifest and every historical SQL byte remain unchanged until a matched
 * release can adopt the new reference identity after routing custody settles. */
export function catalogForwardMapping(core: ClinicalCoreMigration[], reference: ClinicalCoreMigration[], candidate: ClinicalCoreMigration,
  configuration: CareErasureUpgradeConfiguration) {
  const a = CARE_ERASURE_AWS, p = CATALOG_FORWARD_UPGRADE, c = configuration;
  if (c.account !== a.account || c.region !== a.region || c.clusterArn !== a.clusterArn || c.secretArn !== a.secretArn
    || c.databaseName !== a.databaseName || c.phiAllowed !== false || c.environment !== 'synthetic-staging'
    || c.dataClassification !== 'synthetic_only') fail('boundary_refused');
  canonical(core); canonical(reference); canonical([candidate]);
  if (core.length !== 47 || sha(JSON.stringify(rows(core))) !== p.sourceCoreSha256 || reference.length !== 2
    || sha(JSON.stringify(rows(reference))) !== p.referenceBeforeSha256 || candidate.version !== p.version
    || candidate.name !== p.name || candidate.sha256 !== p.sqlSha256) fail('artifact_refused');
  const alias = core.find(m => m.version === '20260821049700') ?? fail('artifact_refused');
  const liveCore = [...rows(core), { version: '20260902230000', name: alias.name, sha256: alias.sha256 }]
    .sort((left, right) => ordinal(left.version, right.version));
  if (sha(JSON.stringify(liveCore)) !== p.liveCoreSha256) fail('artifact_refused');
  const before = rows(reference), after = [...before, ...rows([candidate])];
  return { liveCore, before, after, referenceAfterSha256: sha(JSON.stringify(after)), candidateSqlSha256: p.sqlSha256 };
}

const policyName = 'affiliate_offer_versions_read_active';
const tableName = 'commercial_reference.affiliate_offer_versions';
const POLICY_QUERY = `select polname name,polcmd::text command,polpermissive permissive,
  array_to_json(array(select r.rolname::text from pg_roles r where r.oid=any(p.polroles) order by r.rolname))::text roles,
  pg_get_expr(polqual,polrelid) expression,pg_get_expr(polwithcheck,polrelid) with_check
  from pg_policy p where polrelid='commercial_reference.affiliate_offer_versions'::regclass order by polname`;
const beforeExpression = "((direct_order_allowed = true) AND (declared_restricted = false) AND (EXISTS ( SELECT 1\n   FROM commercial_reference.affiliate_offers o\n  WHERE ((o.stable_id = affiliate_offer_versions.offer_stable_id) AND (o.review_status = 'approved'::text) AND (o.active_version = affiliate_offer_versions.version)))) AND (environment = NULLIF(current_setting('clinical.catalog.environment'::text, true), ''::text)))";
const afterExpression = "((direct_order_allowed = true) AND (declared_restricted = false) AND (environment = NULLIF(current_setting('clinical.catalog.environment'::text, true), ''::text)) AND (EXISTS ( SELECT 1\n   FROM commercial_reference.affiliate_offers o\n  WHERE ((o.stable_id = affiliate_offer_versions.offer_stable_id) AND (o.review_status = 'approved'::text) AND (o.active_version = affiliate_offer_versions.version)))) AND (EXISTS ( SELECT 1\n   FROM (clinical_reference.catalog_products p\n     JOIN clinical_reference.catalog_product_versions v ON (((v.product_stable_id = p.stable_id) AND (v.version = p.active_version))))\n  WHERE ((p.stable_id = affiliate_offer_versions.product_stable_id) AND (p.review_status = 'approved'::text) AND (p.contains_phi = false) AND (p.environment = affiliate_offer_versions.environment) AND (p.environment = NULLIF(current_setting('clinical.catalog.environment'::text, true), ''::text)) AND (v.product_type = 'supplement'::text) AND (v.access_tier = 'open'::text) AND (v.declared_restricted = false) AND (v.direct_order_allowed = true)))))";
async function verifyPolicy(tx: ClinicalCoreTransaction, successor: boolean) {
  // RDS arrayValue is tagged, not a native array. Compare exact SQL-produced
  // JSON text; do not weaken role checks or change the shared driver.
  const expected = [{ name: policyName, command: 'r', permissive: true, roles: JSON.stringify(['clinical_core_api']),
    expression: successor ? afterExpression : beforeExpression, with_check: null }];
  if (JSON.stringify((await tx.query(POLICY_QUERY)).rows) !== JSON.stringify(expected)) fail('policy_refused');
  const role = (await tx.query<{ valid: boolean }>(`select count(*)=1 and bool_and(not rolsuper and not rolbypassrls)
    valid from pg_roles where rolname='clinical_core_api'`)).rows[0]?.valid;
  if (role !== true) fail('policy_refused');
}
type Mapping = ReturnType<typeof catalogForwardMapping>;
async function history(tx: ClinicalCoreTransaction, mapping: Mapping) {
  const core = (await tx.query('select version,name,sha256 from clinical_core.schema_migrations order by version')).rows;
  if (JSON.stringify(core) !== JSON.stringify(mapping.liveCore)) fail('history_refused');
  const reference = (await tx.query('select version,name,sha256 from clinical_reference.schema_migrations order by version')).rows;
  const successor = reference.length === 3;
  if (JSON.stringify(reference) !== JSON.stringify(successor ? mapping.after : mapping.before)) fail('history_refused');
  return successor;
}
type Table = { schema_name: string; table_name: string; kind: string; rls: boolean; forced: boolean } & Record<string, unknown>;
async function inventory(tx: ClinicalCoreTransaction) {
  const tables = (await tx.query<Table>(careErasurePreservation.tableQuery)).rows;
  if (tables.length !== 89 || sha(JSON.stringify(tables)) !== CATALOG_FORWARD_UPGRADE.tableMetadataSha256
    || tables.some(t => t.kind !== 'r')) fail('inventory_refused');
  tables.forEach(careErasurePreservation.qualified);
  return tables;
}
/** Same-engine equality over every registered table, function, schema ACL and
 * API-role membership. Exclude exactly ONE policy which is separately verified
 * before and after. Never ignore all policy/ACL changes or only compare counts. */
async function preservedSchema(tx: ClinicalCoreTransaction, tables: Table[]) {
  const names = [...tables.map(careErasurePreservation.tableName), 'clinical_core.schema_migrations', 'clinical_reference.schema_migrations'];
  const entries = (await tx.query<{ relation_name: string; digest: string }>(`select selected.name relation_name,
    encode(sha256(convert_to(jsonb_build_object(
      'relation',jsonb_build_object('kind',c.relkind,'rls',c.relrowsecurity,'forced',c.relforcerowsecurity,'owner',c.relowner::regrole::text,
        'acl',coalesce(c.relacl,acldefault('r',c.relowner))::text),
      'columns',(select jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),
        'required',a.attnotnull,'acl',a.attacl::text,'default',pg_get_expr(d.adbin,d.adrelid)) order by a.attnum)
        from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
        where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
      'constraints',(select jsonb_agg(jsonb_build_object('name',k.conname,'validated',k.convalidated,'def',pg_get_constraintdef(k.oid)) order by k.conname)
        from pg_constraint k where k.conrelid=c.oid),
      'indexes',(select jsonb_agg(pg_get_indexdef(i.indexrelid) order by i.indexrelid::regclass::text) from pg_index i where i.indrelid=c.oid),
      'policies',(select jsonb_agg(to_jsonb(p)-'oid'-'polrelid' order by p.polname) from pg_policy p
        where p.polrelid=c.oid and not(selected.name=$2 and p.polname=$3)),
      'triggers',(select jsonb_agg(jsonb_build_object('enabled',t.tgenabled,'def',pg_get_triggerdef(t.oid)) order by t.tgname)
        from pg_trigger t where t.tgrelid=c.oid and not t.tgisinternal)
    )::text,'UTF8')),'hex') digest from jsonb_array_elements_text($1::jsonb) with ordinality selected(name,position)
    join pg_class c on c.oid=selected.name::regclass order by selected.position`, [JSON.stringify(names), tableName, policyName])).rows;
  if (entries.length !== names.length || entries.some((row, i) => row.relation_name !== names[i] || !/^[a-f0-9]{64}$/.test(row.digest))) fail('verification_failed');
  const [global] = (await tx.query<{ digest: string }>(`select encode(sha256(convert_to(jsonb_build_object(
    'functions',(select jsonb_agg(jsonb_build_object('name',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid),
      'owner',p.proowner::regrole::text,'acl',coalesce(p.proacl,acldefault('f',p.proowner))::text) order by n.nspname,p.proname,p.oid::regprocedure::text)
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname in ('clinical_core','clinical_private','clinical_audit','clinical_reference','commercial_reference') and p.prokind in ('f','p')),
    'schemas',(select jsonb_agg(jsonb_build_object('name',n.nspname,'owner',n.nspowner::regrole::text,
      'acl',coalesce(n.nspacl,acldefault('n',n.nspowner))::text) order by n.nspname) from pg_namespace n
      where n.nspname in ('clinical_core','clinical_private','clinical_audit','clinical_reference','commercial_reference')),
    'other_relations',(select jsonb_agg(jsonb_build_object('schema',n.nspname,'name',c.relname,'kind',c.relkind,
      'owner',c.relowner::regrole::text,'acl',c.relacl::text,
      'view',case when c.relkind in ('v','m') then pg_get_viewdef(c.oid) else null end) order by n.nspname,c.relname)
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname in ('clinical_core','clinical_private','clinical_audit','clinical_reference','commercial_reference')
        and c.relkind not in ('r','i','t')),
    'api_role',(select to_jsonb(r) from pg_roles r where r.rolname='clinical_core_api'),
    'memberships',(select jsonb_agg(to_jsonb(m) order by m.roleid,m.member,m.grantor) from pg_auth_members m
      where m.member=(select oid from pg_roles where rolname='clinical_core_api') or m.roleid=(select oid from pg_roles where rolname='clinical_core_api'))
  )::text,'UTF8')),'hex') digest`)).rows;
  if (!global || !/^[a-f0-9]{64}$/.test(global.digest)) fail('verification_failed');
  return sha(JSON.stringify({ tables: entries, global: global.digest }));
}
async function fingerprint(tx: ClinicalCoreTransaction, tables: Table[]) {
  const data = await careErasurePreservation.fingerprint(tx, tables).catch(error => {
    if (error instanceof CareErasureUpgradeError && error.category === 'inventory_refused') fail('inventory_refused');
    throw error;
  });
  // Preserve old receipt bytes including applied_at. Exclude only the new
  // forward receipt, which history() verifies separately and exactly.
  const ledgers = (await tx.query<{ table_name: string; row_count: number; sha256: string }>(`select 'clinical_core.schema_migrations' table_name,
    count(*)::int row_count,encode(sha256(convert_to(coalesce(string_agg(row_hash,'' order by row_hash),''),'UTF8')),'hex') sha256
    from (select encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') row_hash from clinical_core.schema_migrations t limit 1001) bounded
    union all select 'clinical_reference.schema_migrations' table_name,count(*)::int row_count,
    encode(sha256(convert_to(coalesce(string_agg(row_hash,'' order by row_hash),''),'UTF8')),'hex') sha256
    from (select encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') row_hash from clinical_reference.schema_migrations t
      where version<>$1 limit 1001) bounded`, [CATALOG_FORWARD_UPGRADE.version])).rows;
  if (ledgers.length !== 2 || ledgers[0].table_name !== 'clinical_core.schema_migrations' || ledgers[1].table_name !== 'clinical_reference.schema_migrations'
    || ledgers.some(row => !Number.isSafeInteger(row.row_count) || row.row_count < 0 || row.row_count > 1000 || !/^[a-f0-9]{64}$/.test(row.sha256))) fail('inventory_refused');
  return { sha256: sha(JSON.stringify({ data: data.sha256, ledgers })), rows: data.rows + ledgers.reduce((count, row) => count + row.row_count, 0) };
}
export type CatalogForwardObservation = {
  contract: 'catalog-forward-upgrade/1'; command: 'inspect' | 'rehearse' | 'upgrade';
  execution: 'synthetic-staging'; phiAllowed: false; coreLedgerSha256: string; referenceLedgerSha256: string;
  referenceMigrationCount: 2 | 3; candidateSqlSha256: string; tableCount: 89; rowCount: number;
  dataSha256: string; preservedSchemaSha256: string; observationSha256: string;
  dataPreserved: true; schemaPreserved: true; historicalLedgerPreserved: true;
  applied: boolean; alreadyApplied: boolean; rolledBack: boolean;
  canonicalRegistered: false; hostedAcceptance: false; activationApproved: false;
};
class RollbackRehearsal extends Error { constructor(readonly result: CatalogForwardObservation) { super('catalog_rollback_rehearsal'); } }

/** Narrow preserving library; no provider/consumer transport and no lasting
 * public CLI. Future matched release must supply a fresh inspect witness under
 * shared routing custody. Supplying a hash is not an approval/activation gate. */
export async function runCatalogForwardUpgrade(database: ClinicalCoreDatabase, suppliedCore: ClinicalCoreMigration[],
  suppliedReference: ClinicalCoreMigration[], suppliedCandidate: ClinicalCoreMigration, suppliedConfiguration: CareErasureUpgradeConfiguration,
  command: 'inspect' | 'rehearse' | 'upgrade', expectedObservationSha256?: string): Promise<CatalogForwardObservation> {
  const core = suppliedCore.map(m => ({ ...m })), reference = suppliedReference.map(m => ({ ...m }));
  const candidate = { ...suppliedCandidate }, configuration = { ...suppliedConfiguration };
  const mapping = catalogForwardMapping(core, reference, candidate, configuration);
  if (!['inspect', 'rehearse', 'upgrade'].includes(command) || command === 'inspect' && expectedObservationSha256 !== undefined
    || command !== 'inspect' && !/^[a-f0-9]{64}$/.test(expectedObservationSha256 ?? '')) fail('boundary_refused');
  let stage = 'transaction_start';
  try { return await database.transaction(async tx => {
    stage = 'transaction_settings';
    // Inspection needs a stable read-only snapshot. Writers need a fresh
    // snapshot AFTER all table locks have been acquired: repeatable read would
    // retain the snapshot taken by the earlier identity/advisory queries even
    // if a conflicting writer commits while LOCK waits. The complete table
    // locks below keep every preserved row and ledger stable thereafter.
    await tx.query(command === 'inspect' ? 'set transaction isolation level repeatable read read only' : 'set transaction isolation level read committed');
    await tx.query("set local lock_timeout='5s'"); await tx.query("set local statement_timeout='30s'"); await tx.query('set local row_security=off');
    stage = 'database_identity';
    if ((await tx.query<{ name: string }>('select current_database() as name')).rows[0]?.name !== configuration.databaseName) fail('boundary_refused');
    if (command !== 'inspect') {
      stage = 'operator_locks';
      for (const key of ['ai-desktop-pro:clinical-core-migrations', 'ai-desktop-pro:governed-catalog-migrations'])
        if ((await tx.query<{ acquired: boolean }>('select pg_try_advisory_xact_lock(hashtext($1)) acquired', [key])).rows[0]?.acquired !== true) fail('upgrade_busy');
    }
    stage = 'inventory'; const tables = await inventory(tx);
    if (command !== 'inspect') {
      stage = 'writer_locks';
      const names = [...tables.map(careErasurePreservation.qualified), 'clinical_core.schema_migrations', 'clinical_reference.schema_migrations'].sort(ordinal);
      await tx.query(`lock table ${names.join(',')} in share row exclusive mode`);
      if (JSON.stringify(await inventory(tx)) !== JSON.stringify(tables)) fail('inventory_refused');
    }
    stage = 'history'; const successor = await history(tx, mapping);
    stage = 'before_policy'; await verifyPolicy(tx, successor);
    stage = 'before_fingerprint'; const before = await fingerprint(tx, tables);
    const schema = await preservedSchema(tx, tables);
    const observation = (data: string, preserved: string, state: boolean) => sha(JSON.stringify({
      contract: 'catalog-forward-upgrade-observation/1', account: configuration.account, region: configuration.region,
      clusterArn: configuration.clusterArn, secretArn: configuration.secretArn, databaseName: configuration.databaseName,
      coreLedgerSha256: CATALOG_FORWARD_UPGRADE.liveCoreSha256,
      referenceLedgerSha256: state ? mapping.referenceAfterSha256 : CATALOG_FORWARD_UPGRADE.referenceBeforeSha256,
      candidateSqlSha256: mapping.candidateSqlSha256, dataSha256: data, schemaSha256: preserved,
    }));
    if (command !== 'inspect' && observation(before.sha256, schema, successor) !== expectedObservationSha256) fail('observation_changed');
    let applied = false;
    if (command !== 'inspect' && !successor) {
      stage = 'policy_ddl'; for (const sql of splitPostgresStatements(candidate.sql)) await tx.query(sql);
      stage = 'ledger_receipt';
      await tx.query('insert into clinical_reference.schema_migrations(version,name,sha256) values($1,$2,$3)', [candidate.version, candidate.name, candidate.sha256]);
      applied = true;
    }
    const final = applied || successor;
    stage = 'after_history'; if (await history(tx, mapping) !== final) fail('history_refused');
    stage = 'after_inventory'; if (JSON.stringify(await inventory(tx)) !== JSON.stringify(tables)) fail('inventory_refused');
    stage = 'after_policy'; await verifyPolicy(tx, final);
    stage = 'after_schema'; if (await preservedSchema(tx, tables) !== schema) fail('schema_changed');
    stage = 'after_fingerprint'; const after = await fingerprint(tx, tables);
    if (after.sha256 !== before.sha256 || after.rows !== before.rows) fail('data_changed');
    const result: CatalogForwardObservation = {
      contract: 'catalog-forward-upgrade/1', command, execution: 'synthetic-staging', phiAllowed: false,
      coreLedgerSha256: CATALOG_FORWARD_UPGRADE.liveCoreSha256,
      referenceLedgerSha256: final ? mapping.referenceAfterSha256 : CATALOG_FORWARD_UPGRADE.referenceBeforeSha256,
      referenceMigrationCount: final ? 3 : 2, candidateSqlSha256: candidate.sha256, tableCount: 89,
      rowCount: after.rows, dataSha256: after.sha256, preservedSchemaSha256: schema,
      observationSha256: observation(after.sha256, schema, final),
      dataPreserved: true, schemaPreserved: true, historicalLedgerPreserved: true,
      applied, alreadyApplied: successor, rolledBack: false,
      canonicalRegistered: false, hostedAcceptance: false, activationApproved: false,
    };
    if (command === 'rehearse') throw new RollbackRehearsal(result);
    return result;
  }); } catch (error) {
    if (error instanceof RollbackRehearsal) {
      const inspected = await runCatalogForwardUpgrade(database, core, reference, candidate, configuration, 'inspect');
      if (inspected.observationSha256 !== expectedObservationSha256) fail('verification_failed', 'rollback_readback');
      return { ...inspected, command: 'rehearse', rolledBack: true };
    }
    if (error instanceof CatalogForwardUpgradeError) throw new CatalogForwardUpgradeError(error.category, error.stage ?? stage);
    throw new CatalogForwardUpgradeError('upgrade_failed', stage);
  }
}
