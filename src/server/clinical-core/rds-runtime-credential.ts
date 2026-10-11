if (typeof window !== "undefined") throw new Error("clinical-core/rds-runtime-credential is server-only.");

/** Read only system metadata, before SET ROLE. SET ROLE does not restrict the
 * session user's ability to return to its login privileges. Runtime credentials
 * therefore must be separate from owners and administrative operators.
 * This is a credential admission boundary, not a complete grants/RLS review. */
export const RUNTIME_CREDENTIAL_ADMISSION_SQL = `/* clinical-runtime-credential/1 */
with login_role as (
 select * from pg_catalog.pg_roles where rolname=session_user
), target_role as (
 select * from pg_catalog.pg_roles where rolname=$1
), reachable as (
 select r.* from pg_catalog.pg_roles r cross join login_role l
 where r.oid=l.oid or pg_catalog.pg_has_role(l.oid,r.oid,'MEMBER')
), application_schemas as (
 select * from pg_catalog.pg_namespace
 where nspname not in ('pg_catalog','information_schema')
 and nspname not like 'pg_toast%' and nspname not like 'pg_temp%'
), table_permissions(name) as (
 values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')
)
select coalesce((
 select l.rolcanlogin
 and not (l.rolsuper or l.rolcreaterole or l.rolcreatedb or l.rolreplication or l.rolbypassrls)
 and not (t.rolsuper or t.rolcreaterole or t.rolcreatedb or t.rolreplication or t.rolbypassrls)
 and pg_catalog.pg_has_role(l.oid,t.oid,'SET')
 and not exists (select 1 from reachable r where r.oid not in (l.oid,t.oid)
   or r.rolsuper or r.rolcreaterole or r.rolcreatedb or r.rolreplication or r.rolbypassrls)
 and not exists (select 1 from pg_catalog.pg_database d join reachable r on r.oid=d.datdba
   where d.datname=current_database())
 and not pg_catalog.has_database_privilege(l.oid,current_database(),'CREATE')
 and not pg_catalog.has_database_privilege(t.oid,current_database(),'CREATE')
 and not exists (select 1 from application_schemas n where
   n.nspowner in (select oid from reachable)
   or pg_catalog.has_schema_privilege(l.oid,n.oid,'CREATE')
   or pg_catalog.has_schema_privilege(t.oid,n.oid,'CREATE')
   or (pg_catalog.has_schema_privilege(l.oid,n.oid,'USAGE')
     and not pg_catalog.has_schema_privilege(t.oid,n.oid,'USAGE')))
 and not exists (select 1 from pg_catalog.pg_class c join application_schemas n on n.oid=c.relnamespace
   where c.relowner in (select oid from reachable))
 and not exists (select 1 from pg_catalog.pg_proc p join application_schemas n on n.oid=p.pronamespace
   where p.proowner in (select oid from reachable))
 and not exists (select 1 from pg_catalog.pg_class c join application_schemas n on n.oid=c.relnamespace
   cross join table_permissions p where c.relkind in ('r','p','v','m','f') and (
     (pg_catalog.has_table_privilege(l.oid,c.oid,p.name) and not pg_catalog.has_table_privilege(t.oid,c.oid,p.name))
     or (p.name in ('SELECT','INSERT','UPDATE','REFERENCES') and exists (
       select 1 from pg_catalog.pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
       and pg_catalog.has_column_privilege(l.oid,c.oid,a.attnum,p.name)
       and not pg_catalog.has_column_privilege(t.oid,c.oid,a.attnum,p.name)))))
 and not exists (select 1 from pg_catalog.pg_class c join application_schemas n on n.oid=c.relnamespace
   cross join (values ('USAGE'),('SELECT'),('UPDATE')) p(name) where c.relkind='S'
   and pg_catalog.has_sequence_privilege(l.oid,c.oid,p.name)
   and not pg_catalog.has_sequence_privilege(t.oid,c.oid,p.name))
 and not exists (select 1 from pg_catalog.pg_proc p join application_schemas n on n.oid=p.pronamespace
   where pg_catalog.has_function_privilege(l.oid,p.oid,'EXECUTE')
   and not pg_catalog.has_function_privilege(t.oid,p.oid,'EXECUTE'))
 from login_role l cross join target_role t
),false) as runtime_credential_admitted`;

export function runtimeCredentialAdmitted(response: Record<string, unknown>): boolean {
  const columns = response.columnMetadata, records = response.records;
  if (!Array.isArray(columns) || columns.length !== 1 || columns[0]?.name !== "runtime_credential_admitted"
    || !Array.isArray(records) || records.length !== 1 || !Array.isArray(records[0]) || records[0].length !== 1) return false;
  const value = records[0][0];
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === 1 && value.booleanValue === true;
}
