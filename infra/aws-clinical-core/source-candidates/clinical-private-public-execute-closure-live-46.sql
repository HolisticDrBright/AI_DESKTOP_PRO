-- BLOCKED source candidate for the observed 46-migration production ledger only.
-- Do not apply without a separate reviewed production change and rollback drill.
-- The 46 live ledger hashes were read-only compared with the repository prefix.

do $$
declare _count integer; _latest text; _ledger_hash text; _actual text[];
begin
  select count(*)::integer,max(version),
    encode(sha256(convert_to(string_agg(version||':'||sha256,E'\n' order by version),'UTF8')),'hex')
    into _count,_latest,_ledger_hash
    from clinical_core.schema_migrations;
  if _count<>46 or _latest<>'20260904090000'
    or _ledger_hash<>'3c7952cad75ae60bf7eba1977e595d45ec48332ac545ae917c43a6c231917bec' then
    raise exception using errcode='55000',message='private_function_acl_ledger_mismatch';
  end if;
  select array_agg(p.oid::regprocedure::text order by p.oid::regprocedure::text)
    into _actual
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='clinical_private'
      and exists (
        select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        where a.grantee=0 and a.privilege_type='EXECUTE'
      );
  if _actual is distinct from array[
    'clinical_private.build_sync_payload(uuid,uuid,text,uuid)',
    'clinical_private.cancel_sync_on_consent_revoke()',
    'clinical_private.consumer_collection_scope(text)',
    'clinical_private.knowledge_import_validation_errors(text,jsonb)',
    'clinical_private.move_entitlement(uuid,text,integer,text,uuid,text,uuid)',
    'clinical_private.protect_clinical_pathway()',
    'clinical_private.protect_clinical_pathway_version()',
    'clinical_private.protect_knowledge_import_batch()',
    'clinical_private.protect_knowledge_import_item()',
    'clinical_private.protect_review_queue_identity()',
    'clinical_private.protect_sync_append_only()',
    'clinical_private.protect_sync_delivery_identity()',
    'clinical_private.protect_sync_event_identity()',
    'clinical_private.protect_sync_inbound_identity()',
    'clinical_private.require_knowledge_admin(uuid)',
    'clinical_private.require_knowledge_editor(uuid)',
    'clinical_private.sync_inbound_scope(text)',
    'clinical_private.sync_scope_for(text)'
  ]::text[] then
    raise exception using errcode='55000',message='private_function_acl_parent_mismatch';
  end if;
end $$;

revoke execute on all functions in schema clinical_private from public;
