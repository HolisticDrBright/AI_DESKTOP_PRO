if (typeof window !== 'undefined') throw new Error('program media host database is server-only');
import type { ClinicalCoreDatabase } from '@/server/clinical-core/database';
import { programMediaHostTarget } from './program-media-host-target';
import { ProgramMediaError } from './program-media-authoring';

export const PROGRAM_MEDIA_HOST_ROLES_SQL = `select jsonb_build_object(
 'database',current_database(),'login',session_user,'worker',current_user,
 'roles',coalesce((select jsonb_agg(jsonb_build_object('name',rolname,'login',rolcanlogin,'inherit',rolinherit,
 'superuser',rolsuper,'createRole',rolcreaterole,'createDatabase',rolcreatedb,'replication',rolreplication,'bypassRls',rolbypassrls) order by rolname)
 from pg_roles where oid=(select oid from pg_roles where rolname=session_user) or pg_has_role(session_user,oid,'MEMBER')),'[]'::jsonb),
 'schemaCreate',coalesce((select jsonb_agg(nspname order by nspname) from pg_namespace
 where nspname not like 'pg_temp%' and (has_schema_privilege(session_user,oid,'CREATE') or has_schema_privilege(current_user,oid,'CREATE'))),'[]'::jsonb)
 ) as proof`;
export const PROGRAM_MEDIA_HOST_PRIVILEGES_SQL = `with privileges as (
 select n.nspname||'.'||c.relname||':'||p.name as privilege,
 (has_table_privilege(current_user,c.oid,p.name) or case when p.name in ('SELECT','INSERT','UPDATE','REFERENCES')
 then has_any_column_privilege(current_user,c.oid,p.name) else false end) as worker,
 (has_table_privilege(session_user,c.oid,p.name) or case when p.name in ('SELECT','INSERT','UPDATE','REFERENCES')
 then has_any_column_privilege(session_user,c.oid,p.name) else false end) as login
 from pg_class c join pg_namespace n on n.oid=c.relnamespace
 cross join (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(name)
 where c.relkind in ('r','p','v','m','f') and n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg_toast%'
 ), functions as (
 select p.oid::regprocedure::text as signature,
 (has_schema_privilege(current_user,n.oid,'USAGE') and has_function_privilege(current_user,p.oid,'EXECUTE')) as worker,
 (has_schema_privilege(session_user,n.oid,'USAGE') and has_function_privilege(session_user,p.oid,'EXECUTE')) as login
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg_%'
 and p.prorettype not in ('pg_catalog.trigger'::regtype,'pg_catalog.event_trigger'::regtype)
 and (p.prosecdef or n.nspname like 'clinical_%')
 ), sequences as (
 select n.nspname||'.'||c.relname||':'||p.name as privilege
 from pg_class c join pg_namespace n on n.oid=c.relnamespace
 cross join (values ('SELECT'),('UPDATE'),('USAGE')) p(name)
 where c.relkind='S' and n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg_%'
 and (has_sequence_privilege(current_user,c.oid,p.name) or has_sequence_privilege(session_user,c.oid,p.name))
 ) select jsonb_build_object('tables',coalesce(jsonb_agg(privilege order by privilege) filter(where worker or login),'[]'::jsonb),
 'workerFunctions',(select coalesce(jsonb_agg(signature order by signature) filter(where worker),'[]'::jsonb) from functions),
 'loginFunctions',(select coalesce(jsonb_agg(signature order by signature) filter(where login),'[]'::jsonb) from functions),
 'sequences',(select coalesce(jsonb_agg(privilege order by privilege),'[]'::jsonb) from sequences),
 'ledger',clinical_core.program_media_host_ledger()) as proof from privileges`;

const REQUIRED_WORKER_FUNCTIONS = [
  'clinical_core.program_media_host_ledger()',
  'clinical_core.program_media_multipart_request(jsonb)',
  'clinical_core.program_media_request(jsonb)',
  // Historical PUBLIC pure scope-name mapping, not a record read/mutation.
  // Trigger-only routines are not directly callable and neither role can
  // create/attach a trigger; their raw table/TRIGGER privileges are also denied.
  'clinical_private.consumer_collection_scope(text)',
  'clinical_private.set_request_context(uuid,uuid,text,text,text,text,text)',
] as const;

const canonical = (v: unknown): string => Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']'
  : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical((v as Record<string, unknown>)[k])).join(',') + '}' : JSON.stringify(v);
const fail = () => { throw new ProgramMediaError('storage_unverified'); };
const record = (v: unknown): Record<string, unknown> => {
  if (typeof v === 'string') { if (Buffer.byteLength(v) > 262144) return fail(); v = JSON.parse(v); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return fail(); return v as Record<string, unknown>;
};

/** This wrapper runs BEFORE work on every short transaction over the SAME
 * fixed-role Data API connection. SET ROLE under an admin login is refused.
 * Missing/mismatched ledger, raw table/column/sequence grants, additional
 * clinical or SECURITY DEFINER calls, inherited roles or public schema CREATE
 * are refused. Ordinary extension hashing functions are not elevation; an
 * inspection error is never an empty proof. */
export function guardProgramMediaHostDatabase(database: ClinicalCoreDatabase, target: unknown): ClinicalCoreDatabase {
  const t = programMediaHostTarget.parse(structuredClone(target)), transaction = database.transaction.bind(database);
  return Object.freeze({ transaction: async <T>(work: Parameters<ClinicalCoreDatabase['transaction']>[0]): Promise<T> => transaction(async tx => {
    const roles = (await tx.query<{ proof: unknown }>(PROGRAM_MEDIA_HOST_ROLES_SQL)).rows;
    if (roles.length !== 1) fail(); const r = record(roles[0].proof);
    const expectedRoles = ['program_media_runtime', 'program_media_worker'].map(name => ({ name, login: name === 'program_media_runtime',
      inherit: false, superuser: false, createRole: false, createDatabase: false, replication: false, bypassRls: false }));
    if (r.database !== t.databaseName || r.login !== t.loginName || r.worker !== 'program_media_worker'
      || canonical(r.roles) !== canonical(expectedRoles) || canonical(r.schemaCreate) !== '[]') fail();
    const privileges = (await tx.query<{ proof: unknown }>(PROGRAM_MEDIA_HOST_PRIVILEGES_SQL)).rows;
    if (privileges.length !== 1) fail(); const p = record(privileges[0].proof);
    if (canonical(p.tables) !== '[]' || canonical(p.sequences) !== '[]' || canonical(p.loginFunctions) !== '[]'
      || canonical(p.workerFunctions) !== canonical(REQUIRED_WORKER_FUNCTIONS) || canonical(p.ledger) !== canonical(t.migrations)) fail();
    return await work(tx) as T;
  }) });
}
