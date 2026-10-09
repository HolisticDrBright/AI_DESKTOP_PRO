-- Owner-scoped workforce operations. No assignment or activation is created.
create table clinical_audit.privacy_operator_access (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references clinical_core.persons(id),
  privacy_request_id uuid not null references clinical_private.owned_privacy_requests(id),
  action text not null check(action in ('queue','detail')),
  recorded_at timestamptz not null default clock_timestamp()
);
alter table clinical_audit.privacy_operator_access enable row level security;
alter table clinical_audit.privacy_operator_access force row level security;
revoke all on clinical_audit.privacy_operator_access from public,clinical_core_api;
create trigger privacy_operator_access_immutable before update or delete on clinical_audit.privacy_operator_access
  for each row execute function clinical_private.block_update_delete();

create function clinical_private.list_assigned_privacy_requests(_after uuid default null,_limit integer default 25,_include_closed boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.privacy_operator(); _r record; _rows jsonb:='[]';
begin
  if _limit is null or _limit<1 or _limit>25 or _include_closed is null then
    raise exception using errcode='22023',message='privacy_queue_invalid';
  end if;
  -- Deterministic owner lock order, same as detail/resolution. Selection does
  -- not accept an owner ID; every returned row is independently re-authorized.
  for _r in
    select q.* from (
      select r.id,r.owner_id,r.kind,r.status,r.submitted_at,r.updated_at
      from clinical_private.owned_privacy_requests r
      join clinical_private.owned_privacy_operator_assignments a on a.owner_id=r.owner_id and a.operator_id=_actor
      where a.revoked_at is null and a.approved_at<=clock_timestamp() and a.expires_at>clock_timestamp()
        and (_after is null or r.id>_after)
        and (_include_closed or r.status not in ('completed','refused'))
      order by r.id limit _limit
    ) q order by q.owner_id,q.id
  loop
    perform clinical_private.privacy_operator_for_owner(_r.owner_id);
    select id,owner_id,kind,status,submitted_at,updated_at into _r
      from clinical_private.owned_privacy_requests where id=_r.id;
    if not _include_closed and _r.status in ('completed','refused') then continue; end if;
    _rows:=_rows||jsonb_build_array(jsonb_build_object('privacyRequestId',_r.id,'ownerId',_r.owner_id,
      'kind',_r.kind,'status',_r.status,'submittedAt',_r.submitted_at,'updatedAt',_r.updated_at));
    insert into clinical_audit.privacy_operator_access(operator_id,privacy_request_id,action) values(_actor,_r.id,'queue');
  end loop;
  return coalesce((select jsonb_agg(value order by value->>'privacyRequestId') from jsonb_array_elements(_rows)),'[]'::jsonb);
end $$;

create function clinical_private.get_assigned_privacy_request(_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.privacy_operator(); _r clinical_private.owned_privacy_requests;
  _t clinical_private.owned_correction_targets; _original clinical_core.owned_consumer_record_versions;
  _latest clinical_core.owned_consumer_record_versions; _correction jsonb:=null; _receipt jsonb;
begin
  select * into _r from clinical_private.owned_privacy_requests where id=_id;
  if not found then raise exception using errcode='42501',message='privacy_operator_assignment_required'; end if;
  perform clinical_private.privacy_operator_for_owner(_r.owner_id);
  select * into _r from clinical_private.owned_privacy_requests where id=_id for share;
  _receipt:=clinical_private.owned_privacy_request_json(_r.owner_id,_id);
  select * into _t from clinical_private.owned_correction_targets where privacy_request_id=_id;
  if found then
    select * into _original from clinical_core.owned_consumer_record_versions
      where owner_id=_r.owner_id and collection=_t.collection and record_id=_t.record_id and revision=_t.expected_revision;
    select * into _latest from clinical_core.owned_consumer_record_versions
      where owner_id=_r.owner_id and collection=_t.collection and record_id=_t.record_id order by revision desc limit 1;
    -- Field-limited evidence; do not disclose the rest of an intake or lab panel.
    _correction:=jsonb_build_object('target',_receipt->'correctionTarget','reason',_r.correction->>'reason',
      'requestedValue',_r.correction->'requestedValue','originalAvailable',_original.revision is not null and not _original.deleted,
      'originalValue',case when not _original.deleted then _original.payload->_t.field else null end,
      'currentRevision',_latest.revision,'currentDeleted',coalesce(_latest.deleted,true),
      'currentValue',case when not _latest.deleted then _latest.payload->_t.field else null end,
      'resolution',_receipt->'correctionResolution');
  end if;
  insert into clinical_audit.privacy_operator_access(operator_id,privacy_request_id,action) values(_actor,_id,'detail');
  return jsonb_build_object('privacyRequestId',_r.id,'ownerId',_r.owner_id,'kind',_r.kind,'status',_r.status,
    'submittedAt',_r.submitted_at,'updatedAt',_r.updated_at,'legalHold',_receipt->'legalHold',
    'fulfillment',_receipt->'fulfillment','correction',_correction);
end $$;

revoke all on function clinical_private.list_assigned_privacy_requests(uuid,integer,boolean),
  clinical_private.get_assigned_privacy_request(uuid) from public;
grant execute on function clinical_private.list_assigned_privacy_requests(uuid,integer,boolean),
  clinical_private.get_assigned_privacy_request(uuid) to clinical_core_api;
