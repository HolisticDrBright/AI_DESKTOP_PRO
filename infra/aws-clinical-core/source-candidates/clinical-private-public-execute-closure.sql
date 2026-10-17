-- BLOCKED source candidate. Do not register or apply without a reviewed production
-- role-compatibility check and a preserving, rollback-capable change procedure.
-- PostgreSQL gives PUBLIC EXECUTE on new functions by default. The production
-- clinical_private schema is usable by clinical_core_api, so a public function
-- grant is not harmless merely because the function is in a private schema.

do $$
declare _actual text[];
begin
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
    'clinical_private.owned_record_regime_is_append_only()',
    'clinical_private.owned_record_regime_is_immutable()',
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
