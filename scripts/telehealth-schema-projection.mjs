/** Versioned SOURCE metadata projection. No record values, credentials or
 * approval rows are read. Runtime expected digests must be compiled separately
 * from validated source, never learned from the database being admitted. */
export const TELEHEALTH_SCHEMA_NAMES = Object.freeze([
  'clinical_core', 'clinical_private', 'clinical_audit', 'clinical_reference',
  'commercial_reference', 'fullscript_delivery', 'clinical_telehealth',
]);
export const TELEHEALTH_SCHEMA_PROJECTION = `with
 selected_schemas as (select n.* from pg_namespace n where n.nspname in(select jsonb_array_elements_text($1::jsonb))),
 application_roles as (select r.* from pg_roles r where r.rolname='clinical_core_api' or r.rolname like 'clinical\\_%' escape '\\' or r.rolname like 'fullscript\\_%' escape '\\'),
 items as (
 select 'schema:'||n.nspname name,jsonb_build_object('owner',n.nspowner::regrole::text,
  'acl',coalesce(n.nspacl,acldefault('n',n.nspowner))::text) metadata from selected_schemas n
 union all
 select 'relation:'||n.nspname||'.'||c.relname,jsonb_build_object(
  'kind',c.relkind,'owner',c.relowner::regrole::text,'rls',c.relrowsecurity,'forced',c.relforcerowsecurity,
  'acl',coalesce(c.relacl,acldefault(case when c.relkind='S' then 's'::"char" else 'r'::"char" end,c.relowner))::text,
  'replica_identity',c.relreplident,'options',c.reloptions,'partition',c.relispartition,
  'partition_bound',pg_get_expr(c.relpartbound,c.oid),
  'parents',(select jsonb_agg(i.inhparent::regclass::text order by i.inhseqno) from pg_inherits i where i.inhrelid=c.oid),
  'columns',(select jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),
    'not_null',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,'dropped',a.attisdropped,
    'acl',a.attacl::text,'default',pg_get_expr(d.adbin,d.adrelid),'collation',a.attcollation::regcollation::text) order by a.attnum)
    from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0),
  'constraints',(select jsonb_agg(jsonb_build_object('name',k.conname,'type',k.contype,'valid',k.convalidated,
    'def',pg_get_constraintdef(k.oid),'deferred',k.condeferred,'deferrable',k.condeferrable) order by k.conname) from pg_constraint k where k.conrelid=c.oid),
  'indexes',(select jsonb_agg(jsonb_build_object('name',i.indexrelid::regclass::text,'def',pg_get_indexdef(i.indexrelid),
    'valid',i.indisvalid,'ready',i.indisready,'live',i.indislive,'replica_identity',i.indisreplident) order by i.indexrelid::regclass::text) from pg_index i where i.indrelid=c.oid),
  'policies',(select jsonb_agg(jsonb_build_object('name',p.polname,'command',p.polcmd,'permissive',p.polpermissive,
    'roles',(select jsonb_agg(case when v=0 then 'public' else v::regrole::text end order by v::regrole::text) from unnest(p.polroles) v),
    'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) order by p.polname) from pg_policy p where p.polrelid=c.oid),
  'triggers',(select jsonb_agg(jsonb_build_object('name',t.tgname,'enabled',t.tgenabled,'internal',t.tgisinternal,
    'def',pg_get_triggerdef(t.oid)) order by t.tgname) from pg_trigger t where t.tgrelid=c.oid and not t.tgisinternal),
  'internal_triggers',(select jsonb_agg(jsonb_build_object(
    'constraint',k.conname,'constraint_from',k.conrelid::regclass::text,'constraint_to',nullif(k.confrelid,0)::regclass::text,
    'function',t.tgfoid::regprocedure::text,'enabled',t.tgenabled,'type',t.tgtype,'deferrable',t.tgdeferrable,
    'initially_deferred',t.tginitdeferred,'attributes',t.tgattr::text,'arguments',encode(t.tgargs,'hex'),
    'old_table',t.tgoldtable,'new_table',t.tgnewtable)
    order by k.conrelid::regclass::text,k.conname,t.tgfoid::regprocedure::text,t.tgtype)
    from pg_trigger t left join pg_constraint k on k.oid=t.tgconstraint where t.tgrelid=c.oid and t.tgisinternal),
  'foreign_keys',(select jsonb_agg(jsonb_build_object('name',k.conname,'from',k.conrelid::regclass::text,'to',k.confrelid::regclass::text,
    'def',pg_get_constraintdef(k.oid),'valid',k.convalidated) order by k.conrelid::regclass::text,k.conname) from pg_constraint k where k.confrelid=c.oid and k.contype='f'),
  'view',case when c.relkind in ('v','m') then pg_get_viewdef(c.oid) else null end,
  'sequence',(select jsonb_build_object('type',format_type(s.seqtypid,null),'start',s.seqstart,'increment',s.seqincrement,
    'max',s.seqmax,'min',s.seqmin,'cache',s.seqcache,'cycle',s.seqcycle) from pg_sequence s where s.seqrelid=c.oid)
 ) from pg_class c join selected_schemas n on n.oid=c.relnamespace where c.relkind in ('r','p','f','v','m','S','c')
 union all
 select 'function:'||p.oid::regprocedure::text,jsonb_build_object('def',pg_get_functiondef(p.oid),'owner',p.proowner::regrole::text,
  'acl',coalesce(p.proacl,acldefault('f',p.proowner))::text,'kind',p.prokind,'language',l.lanname,'volatility',p.provolatile,
  'definer',p.prosecdef,'strict',p.proisstrict,'leakproof',p.proleakproof,'parallel',p.proparallel,
  'config',p.proconfig,'cost',p.procost,'rows',p.prorows)
  from pg_proc p join selected_schemas n on n.oid=p.pronamespace join pg_language l on l.oid=p.prolang where p.prokind in ('f','p')
 union all
 select 'non_callable_function:'||p.oid::regprocedure::text,jsonb_build_object('kind',p.prokind,
  'owner',p.proowner::regrole::text,'acl',coalesce(p.proacl,acldefault('f',p.proowner))::text,
  'source',p.prosrc,'binary',p.probin,'config',p.proconfig)
  from pg_proc p join selected_schemas n on n.oid=p.pronamespace where p.prokind not in ('f','p')
 union all
 select 'type:'||n.nspname||'.'||t.typname,jsonb_build_object('kind',t.typtype,'owner',t.typowner::regrole::text,
  'acl',coalesce(t.typacl,acldefault('T',t.typowner))::text,'base',format_type(nullif(t.typbasetype,0),t.typtypmod),
  'not_null',t.typnotnull,'default',t.typdefault,'collation',t.typcollation::regcollation::text,
  'element',format_type(nullif(t.typelem,0),null),'relation',nullif(t.typrelid,0)::regclass::text,
  'input',t.typinput::regprocedure::text,'output',t.typoutput::regprocedure::text,
  'receive',t.typreceive::regprocedure::text,'send',t.typsend::regprocedure::text,
  'range',(select jsonb_build_object('subtype',format_type(r.rngsubtype,null),'collation',r.rngcollation::regcollation::text,
    'canonical',r.rngcanonical::regprocedure::text,'subdiff',r.rngsubdiff::regprocedure::text)
    from pg_range r where r.rngtypid=t.oid),
  'enum',(select jsonb_agg(e.enumlabel order by e.enumsortorder) from pg_enum e where e.enumtypid=t.oid),
  'constraints',(select jsonb_agg(jsonb_build_object('name',k.conname,'valid',k.convalidated,'def',pg_get_constraintdef(k.oid)) order by k.conname) from pg_constraint k where k.contypid=t.oid))
  from pg_type t join selected_schemas n on n.oid=t.typnamespace
 union all
 select 'collation:'||n.nspname||'.'||c.collname,jsonb_build_object('owner',c.collowner::regrole::text,
  'provider',c.collprovider,'deterministic',c.collisdeterministic,'encoding',c.collencoding,
  'collate',c.collcollate,'ctype',c.collctype,'locale',to_jsonb(c)->>'colllocale','version',c.collversion)
  from pg_collation c join selected_schemas n on n.oid=c.collnamespace
 union all
 select 'role:'||r.rolname,jsonb_build_object('super',r.rolsuper,'inherit',r.rolinherit,'create_role',r.rolcreaterole,
  'create_db',r.rolcreatedb,'login',r.rolcanlogin,'replication',r.rolreplication,'bypass_rls',r.rolbypassrls,
  'connection_limit',r.rolconnlimit,'valid_until',r.rolvaliduntil,'config',r.rolconfig) from application_roles r
 union all
 select 'membership:'||m.roleid::regrole::text||':'||m.member::regrole::text||':'||m.grantor::regrole::text,
  jsonb_build_object('admin',m.admin_option,'inherit',(to_jsonb(m)->>'inherit_option')::boolean,
    'set',(to_jsonb(m)->>'set_option')::boolean) from pg_auth_members m
  where m.roleid in(select oid from application_roles) or m.member in(select oid from application_roles)
 union all
 select 'default_acl:'||d.defaclrole::regrole::text||':'||coalesce(n.nspname,'*')||':'||d.defaclobjtype::text,
  jsonb_build_object('acl',d.defaclacl::text) from pg_default_acl d left join pg_namespace n on n.oid=d.defaclnamespace
  where d.defaclnamespace=0 or d.defaclnamespace in(select oid from selected_schemas)
 ) select name,encode(sha256(convert_to(metadata::text,'UTF8')),'hex') as digest from items order by name collate "C" limit 3001`;

export async function projectTelehealthSchema(query) {
  // RDS Data API's existing transport admits scalar JSON text, not JS arrays.
  const result=await query(TELEHEALTH_SCHEMA_PROJECTION,[JSON.stringify(TELEHEALTH_SCHEMA_NAMES)]);
  const rows=result.rows;
  if(!Array.isArray(rows)||rows.length<500||rows.length>3000
    ||rows.some((r,i)=>!r||Object.keys(r).sort().join(',')!=='digest,name'||typeof r.name!=='string'||!r.name||Buffer.byteLength(r.name,'utf8')>1000
      ||typeof r.digest!=='string'||!/^[a-f0-9]{64}$/.test(r.digest)||(i>0&&rows[i-1].name>=r.name)))
    throw Error('telehealth_schema_projection_refused');
  return rows.map(({name,digest})=>({name,digest}));
}
