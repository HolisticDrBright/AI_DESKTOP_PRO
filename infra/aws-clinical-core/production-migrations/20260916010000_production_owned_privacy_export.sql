-- A bounded personal-storage export, NOT a complete account export or erasure.
-- Never enables a public workload, consents, clinical scopes, or PHI.
create table clinical_private.owned_privacy_exports (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references clinical_core.persons(id),
  request_id uuid not null,
  as_of timestamptz not null,
  expires_at timestamptz not null,
  record_count bigint not null check(record_count>=0),
  consent_count bigint not null check(consent_count>=0),
  unique(owner_id,request_id)
);
alter table clinical_private.owned_privacy_exports enable row level security;
alter table clinical_private.owned_privacy_exports force row level security;
revoke all on clinical_private.owned_privacy_exports from public,clinical_core_api;

create table clinical_audit.owned_privacy_export_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references clinical_core.persons(id),
  export_id uuid not null references clinical_private.owned_privacy_exports(id),
  action text not null check(action in ('created','records.read','consents.read')),
  row_count integer not null check(row_count>=0),
  recorded_at timestamptz not null default clock_timestamp()
);
create index owned_privacy_export_audit_owner_time on clinical_audit.owned_privacy_export_events(owner_id,recorded_at,id);
alter table clinical_audit.owned_privacy_export_events enable row level security;
alter table clinical_audit.owned_privacy_export_events force row level security;
revoke all on clinical_audit.owned_privacy_export_events from public,clinical_core_api;

-- Narrow SECURITY DEFINER operations are intentional: ordinary record reads
-- require active feature consent. Privacy access must survive withdrawal.
-- Revalidate the active consumer identity, derive owner from it, use no caller
-- owner parameter, and grant no direct access to the export/session tables.
create function clinical_core.start_owned_privacy_export(_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor(); _saved clinical_private.owned_privacy_exports;
  _as_of timestamptz; _records bigint; _consents bigint;
begin
  if clinical_private.claim('purpose') is distinct from 'consent_management' or _request_id is null then
    raise exception using errcode='22023',message='privacy_export_request_invalid';
  end if;
  -- Same owner lock used by every record and consent write. A later normal
  -- write cannot acquire a received_at <= this cut-off, even across pages.
  perform pg_advisory_xact_lock(hashtextextended(_actor::text,0));
  select * into _saved from clinical_private.owned_privacy_exports where owner_id=_actor and request_id=_request_id;
  if not found then
    -- At most one new snapshot per minute per owner; retries reuse the same ID.
    if exists(select 1 from clinical_private.owned_privacy_exports where owner_id=_actor and as_of>clock_timestamp()-interval '1 minute') then
      raise exception using errcode='40001',message='privacy_export_conflict';
    end if;
    _as_of:=clock_timestamp();
    select count(*) into _records from clinical_core.owned_consumer_record_versions where owner_id=_actor and received_at<=_as_of;
    select count(*) into _consents from clinical_core.consumer_storage_consents where owner_id=_actor and recorded_at<=_as_of;
    insert into clinical_private.owned_privacy_exports(owner_id,request_id,as_of,expires_at,record_count,consent_count)
      values(_actor,_request_id,_as_of,_as_of+interval '15 minutes',_records,_consents) returning * into _saved;
    insert into clinical_audit.owned_privacy_export_events(owner_id,export_id,action,row_count) values(_actor,_saved.id,'created',0);
  end if;
  if _saved.expires_at<=clock_timestamp() then raise exception using errcode='22023',message='privacy_export_request_invalid'; end if;
  return jsonb_build_object('exportId',_saved.id,'asOf',_saved.as_of,'expiresAt',_saved.expires_at,
    'recordCount',_saved.record_count,'consentCount',_saved.consent_count);
end $$;

create function clinical_core.read_owned_privacy_export(_export_id uuid,_section text,_limit integer,_after jsonb default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor(); _saved clinical_private.owned_privacy_exports;
  _items jsonb; _next jsonb; _last jsonb; _out jsonb:='[]'::jsonb;
  _row jsonb; _bytes integer:=2; _more boolean:=false;
begin
  if clinical_private.claim('purpose') is distinct from 'consent_management' or _export_id is null
    or _section is null or _section not in ('records','consents') or _limit is null or _limit<1 or _limit>100 then
    raise exception using errcode='22023',message='privacy_export_request_invalid';
  end if;
  select * into _saved from clinical_private.owned_privacy_exports where id=_export_id and owner_id=_actor and expires_at>clock_timestamp();
  if not found then raise exception using errcode='22023',message='privacy_export_request_invalid'; end if;
  if _after is not null then
    if jsonb_typeof(_after)<>'object' or not (_after ?& array['key','revision'])
      or jsonb_typeof(_after->'key')<>'string' or length(_after->>'key')>80
      or jsonb_typeof(_after->'revision')<>'number' or (_after->>'revision')!~'^[1-9][0-9]{0,9}$'
      or (_after->>'revision')::numeric>=2147483647
      or (_section='records' and (not (_after ? 'recordId') or jsonb_typeof(_after->'recordId')<>'string' or (_after->>'recordId')!~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'))
      or (_after - case when _section='records' then array['key','recordId','revision'] else array['key','revision'] end)<>'{}'::jsonb then
      raise exception using errcode='22023',message='privacy_export_request_invalid';
    end if;
  end if;
  if _section='records' then
    select coalesce(jsonb_agg(jsonb_build_object('collection',r.collection,'recordId',r.record_id,'revision',r.revision,
      'payload',r.payload,'deleted',r.deleted,'consentRevision',r.consent_revision,'receivedAt',r.received_at)
      order by r.collection collate "C",r.record_id,r.revision),'[]'::jsonb) into _items
    from (select * from clinical_core.owned_consumer_record_versions where owner_id=_actor and received_at<=_saved.as_of
      and (_after is null or (collection collate "C",record_id,revision)>((_after->>'key') collate "C",(_after->>'recordId')::uuid,(_after->>'revision')::integer))
      order by collection collate "C",record_id,revision limit _limit+1) r;
  else
    select coalesce(jsonb_agg(jsonb_build_object('scope',r.scope,'revision',r.revision,'status',r.status,
      'releaseVersion',r.release_version,'recordedAt',r.recorded_at) order by r.scope collate "C",r.revision),'[]'::jsonb) into _items
    from (select * from clinical_core.consumer_storage_consents where owner_id=_actor and recorded_at<=_saved.as_of
      and (_after is null or (scope collate "C",revision)>((_after->>'key') collate "C",(_after->>'revision')::integer))
      order by scope collate "C",revision limit _limit+1) r;
  end if;
  -- This function returns one JSON field. RDS Data API limits each result row
  -- to 64 KiB even when the whole result is below 1 MiB. Bound unescaped JSON
  -- to 24 KiB, leaving room for escaping and the outer envelope. Each stored
  -- payload is already bounded to 16 KiB. A short page can still have a cursor.
  for _row in select value from jsonb_array_elements(_items) loop
    if jsonb_array_length(_out)>=_limit or _bytes+octet_length(_row::text)+2>24576 then _more:=true; exit; end if;
    _out:=_out||jsonb_build_array(_row); _bytes:=_bytes+octet_length(_row::text)+2;
  end loop;
  _items:=_out;
  if _more then
    if jsonb_array_length(_items)=0 then raise exception using errcode='22023',message='privacy_export_request_invalid'; end if;
    _last:=_items->(jsonb_array_length(_items)-1);
    _next:=case when _section='records' then jsonb_build_object('key',_last->'collection','recordId',_last->'recordId','revision',_last->'revision')
      else jsonb_build_object('key',_last->'scope','revision',_last->'revision') end;
  end if;
  insert into clinical_audit.owned_privacy_export_events(owner_id,export_id,action,row_count)
    values(_actor,_export_id,_section||'.read',jsonb_array_length(_items));
  return jsonb_build_object('exportId',_saved.id,'asOf',_saved.as_of,'section',_section,'items',_items,'next',_next);
end $$;
-- Stable keyset export ordering uses indexes, not OFFSET or all-row JSON.
create index owned_privacy_records_page on clinical_core.owned_consumer_record_versions(owner_id,collection collate "C",record_id,revision);
create index owned_privacy_consents_page on clinical_core.consumer_storage_consents(owner_id,scope collate "C",revision);
revoke all on function clinical_core.start_owned_privacy_export(uuid),clinical_core.read_owned_privacy_export(uuid,text,integer,jsonb) from public;
grant execute on function clinical_core.start_owned_privacy_export(uuid),clinical_core.read_owned_privacy_export(uuid,text,integer,jsonb) to clinical_core_api;
