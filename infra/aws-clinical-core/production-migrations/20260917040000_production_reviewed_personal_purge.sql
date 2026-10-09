-- Preview-bound execution of the personal-storage portion of a deletion.
-- No policy authorization, operator assignment, purge or activation is seeded.
alter table clinical_private.owned_retention_policies
  add column personal_purge_authorized_sha256 text check(personal_purge_authorized_sha256 ~ '^[a-f0-9]{64}$');

create table clinical_private.owned_personal_purge_commands (
  privacy_request_id uuid not null references clinical_private.owned_privacy_requests(id),
  command_id uuid not null,
  command_sha256 text not null check(command_sha256 ~ '^[a-f0-9]{64}$'),
  operator_id uuid not null references clinical_core.persons(id),
  receipt jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key(privacy_request_id,command_id)
);
alter table clinical_private.owned_personal_purge_commands enable row level security;
alter table clinical_private.owned_personal_purge_commands force row level security;
revoke all on clinical_private.owned_personal_purge_commands from public,clinical_core_api;
create trigger owned_personal_purge_command_immutable before update or delete on clinical_private.owned_personal_purge_commands
  for each row execute function clinical_private.block_update_delete();

create function clinical_private.personal_purge_inventory(_owner uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _records bigint; _consents bigint; _plans bigint; _history bigint; _hash text;
begin
  -- Private helper. Caller must hold the same owner lock as writers.
  select count(*) into _records from clinical_core.owned_consumer_record_versions where owner_id=_owner;
  select count(*) into _consents from clinical_core.consumer_storage_consents where owner_id=_owner;
  select count(*) into _plans from clinical_core.owned_consumer_active_plans where owner_id=_owner;
  select count(*) into _history from clinical_core.owned_consumer_active_plan_history where owner_id=_owner;
  if greatest(_records,_consents,_plans,_history)>100000 then
    raise exception using errcode='22023',message='personal_purge_inventory_too_large';
  end if;
  select encode(public.digest(coalesce(string_agg(s.digest,',' order by s.kind,s.digest),'')||':'||_owner::text,'sha256'),'hex')
    into _hash from (
      select 'records' kind,encode(public.digest(to_jsonb(r)::text,'sha256'),'hex') digest
        from clinical_core.owned_consumer_record_versions r where owner_id=_owner
      union all select 'consents',encode(public.digest(to_jsonb(c)::text,'sha256'),'hex')
        from clinical_core.consumer_storage_consents c where owner_id=_owner
      union all select 'plans',encode(public.digest(to_jsonb(p)::text,'sha256'),'hex')
        from clinical_core.owned_consumer_active_plans p where owner_id=_owner
      union all select 'history',encode(public.digest(to_jsonb(h)::text,'sha256'),'hex')
        from clinical_core.owned_consumer_active_plan_history h where owner_id=_owner
    ) s;
  return jsonb_build_object('records',_records,'consents',_consents,'activePlans',_plans,'planHistory',_history,'inventorySha256',_hash);
end $$;

create function clinical_private.preview_owned_personal_purge(_request_id uuid,_policy_version text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _r clinical_private.owned_privacy_requests; _policy clinical_private.owned_retention_policies;
begin
  _r:=clinical_private.lock_owned_privacy_request(_request_id);
  if _r.kind<>'deletion' then raise exception using errcode='22023',message='personal_purge_request_invalid'; end if;
  _policy:=clinical_private.verified_owned_retention_policy(_policy_version);
  if _policy.personal_purge_authorized_sha256 is distinct from _policy.content_sha256 then
    raise exception using errcode='42501',message='personal_purge_policy_required';
  end if;
  return clinical_private.personal_purge_inventory(_r.owner_id)||jsonb_build_object(
    'privacyRequestId',_request_id,'policyVersion',_policy.version,'policySha256',_policy.content_sha256,
    'policyContent',_policy.content,'completeAccountDeletion',false);
end $$;

create function clinical_private.execute_owned_personal_purge(_request_id uuid,_command_id uuid,
  _policy_version text,_policy_sha256 text,_inventory_sha256 text,_confirmation text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _r clinical_private.owned_privacy_requests; _operator uuid; _command_hash text;
  _previous clinical_private.owned_personal_purge_commands; _preview jsonb; _after jsonb; _result jsonb;
begin
  perform clinical_private.privacy_operator();
  if _request_id is null or _command_id is null or _policy_version is null or _policy_sha256 is null
    or _inventory_sha256 is null or _policy_sha256 !~ '^[a-f0-9]{64}$' or _inventory_sha256 !~ '^[a-f0-9]{64}$'
    or _confirmation is distinct from 'PURGE PERSONAL HISTORY' then
    raise exception using errcode='22023',message='personal_purge_request_invalid';
  end if;
  select * into _r from clinical_private.owned_privacy_requests where id=_request_id;
  if not found then raise exception using errcode='42501',message='privacy_operator_assignment_required'; end if;
  _operator:=clinical_private.privacy_operator_for_owner(_r.owner_id);
  _command_hash:=encode(public.digest(jsonb_build_array(_request_id,_command_id,_policy_version,_policy_sha256,_inventory_sha256,_confirmation)::text,'sha256'),'hex');
  select * into _previous from clinical_private.owned_personal_purge_commands where privacy_request_id=_request_id and command_id=_command_id;
  if found then
    if _previous.command_sha256<>_command_hash then raise exception using errcode='40001',message='personal_purge_command_conflict'; end if;
    -- Return historical evidence only, even if new data/holds now exist.
    return _previous.receipt;
  end if;
  _preview:=clinical_private.preview_owned_personal_purge(_request_id,_policy_version);
  if _preview->>'policySha256'<>_policy_sha256 or _preview->>'inventorySha256'<>_inventory_sha256 then
    raise exception using errcode='40001',message='personal_purge_preview_changed';
  end if;
  update clinical_private.owned_privacy_requests set status='in_progress',updated_at=clock_timestamp() where id=_request_id;
  perform clinical_private.purge_owned_personal_history(_request_id,_policy_version);
  _after:=clinical_private.personal_purge_inventory(_r.owner_id);
  if (_after->>'records')::bigint<>0 or (_after->>'consents')::bigint<>0 or (_after->>'activePlans')::bigint<>0 or (_after->>'planHistory')::bigint<>0 then
    raise exception using errcode='40001',message='personal_purge_verification_failed';
  end if;
  _result:=(_preview-'policyContent')||jsonb_build_object('commandId',_command_id,'outcome','purged',
    'verifiedAt',clock_timestamp(),'evidenceSha256',encode(public.digest(jsonb_build_array(_command_hash,_preview-'policyContent',_after,_operator)::text,'sha256'),'hex'));
  insert into clinical_private.owned_personal_purge_commands(privacy_request_id,command_id,command_sha256,operator_id,receipt)
    values(_request_id,_command_id,_command_hash,_operator,_result);
  return _result;
end $$;
-- New API callers cannot bypass preview/command semantics with the older entry.
revoke all on function clinical_private.purge_owned_personal_history(uuid,text) from clinical_core_api;
revoke all on function clinical_private.personal_purge_inventory(uuid),
  clinical_private.preview_owned_personal_purge(uuid,text),
  clinical_private.execute_owned_personal_purge(uuid,uuid,text,text,text,text) from public,clinical_core_api;
grant execute on function clinical_private.preview_owned_personal_purge(uuid,text),
  clinical_private.execute_owned_personal_purge(uuid,uuid,text,text,text,text) to clinical_core_api;

-- A historical receipt is not proof that a store remains empty. Preserve all
-- existing nine-store/policy/hold checks, then recheck these stores under the
-- same owner lock. Any failure rolls the entire completion transaction back.
alter function clinical_private.complete_owned_privacy_request(uuid) rename to complete_owned_privacy_request_v2;
revoke all on function clinical_private.complete_owned_privacy_request_v2(uuid) from public,clinical_core_api;
create function clinical_private.complete_owned_privacy_request(_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _result jsonb; _owner uuid; _inventory jsonb; _store text; _outcome text; _count bigint;
begin
  _result:=clinical_private.complete_owned_privacy_request_v2(_request_id);
  select owner_id into _owner from clinical_private.owned_privacy_requests where id=_request_id;
  _inventory:=clinical_private.personal_purge_inventory(_owner);
  foreach _store in array array['personal_records','personal_consents','active_plan'] loop
    select outcome into _outcome from clinical_private.owned_privacy_fulfillment
      where privacy_request_id=_request_id and store=_store order by recorded_at desc,id desc limit 1;
    _count:=case _store when 'personal_records' then (_inventory->>'records')::bigint
      when 'personal_consents' then (_inventory->>'consents')::bigint
      else (_inventory->>'activePlans')::bigint+(_inventory->>'planHistory')::bigint end;
    if _outcome in ('purged','not_applicable') and _count<>0 then
      raise exception using errcode='40001',message='privacy_request_personal_store_changed';
    end if;
  end loop;
  return _result;
end $$;
revoke all on function clinical_private.complete_owned_privacy_request(uuid) from public,clinical_core_api;
grant execute on function clinical_private.complete_owned_privacy_request(uuid) to clinical_core_api;
