-- Unreleased preserving overlay on canonical 105. Not an ordered migration,
-- not a deployed route, and not authority to activate qualification or PHI.
-- No identities, invitations, reviews, approvals or grants are seeded.
create table clinical_core.care_claim_requests (
  organization_id uuid not null references clinical_core.organizations(id),
  consumer_person_id uuid not null references clinical_core.persons(id),
  request_id uuid not null,
  token_sha256 text check(token_sha256 ~ '^[a-f0-9]{64}$'),
  status text not null check(status in ('committed','cancelled')),
  connection_id uuid references clinical_core.patient_connections(id),
  receipt jsonb,
  decided_at timestamptz not null default clock_timestamp(),
  primary key(organization_id,consumer_person_id,request_id),
  check((status='cancelled' and token_sha256 is null and connection_id is null and receipt is null)
    or (status='committed' and token_sha256 is not null and connection_id is not null
      and receipt is not null and jsonb_typeof(receipt)='object' and receipt->>'connectionId'=connection_id::text))
);
create index care_claim_requests_owner on clinical_core.care_claim_requests(consumer_person_id,organization_id,request_id);
alter table clinical_core.care_claim_requests enable row level security;
alter table clinical_core.care_claim_requests force row level security;
revoke all on clinical_core.care_claim_requests from public,clinical_core_api;
create trigger care_claim_requests_immutable before update or delete on clinical_core.care_claim_requests
  for each row execute function clinical_private.block_update_delete();

create table clinical_audit.care_claim_events (
  id uuid primary key default public.gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  consumer_person_id uuid not null references clinical_core.persons(id),
  request_id uuid not null,
  action text not null check(action in ('claim','receipt','settle')),
  outcome text not null check(outcome in ('committed','cancelled','unresolved','withheld')),
  occurred_at timestamptz not null default clock_timestamp()
);
create index care_claim_events_owner on clinical_audit.care_claim_events(consumer_person_id,organization_id,occurred_at);
alter table clinical_audit.care_claim_events enable row level security;
alter table clinical_audit.care_claim_events force row level security;
revoke all on clinical_audit.care_claim_events from public,clinical_core_api;
create trigger care_claim_events_immutable before update or delete on clinical_audit.care_claim_events
  for each row execute function clinical_private.block_update_delete();

create function clinical_private.care_claim_result(_org uuid,_actor uuid,_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _row clinical_core.care_claim_requests;
begin
  select * into _row from clinical_core.care_claim_requests
    where organization_id=_org and consumer_person_id=_actor and request_id=_request_id;
  if not found then return jsonb_build_object('requestId',_request_id,'status','unresolved'); end if;
  if _row.status='cancelled' then return jsonb_build_object('requestId',_request_id,'status','cancelled'); end if;
  -- A receipt confirms the exact historical command, not today's connection
  -- state. Do not reveal its location after the link/chart becomes inaccessible.
  if not exists(select 1 from clinical_core.patient_connections c join clinical_core.patient_records p
    on p.id=c.patient_record_id and p.organization_id=c.organization_id
    where c.id=_row.connection_id and c.organization_id=_org and c.consumer_person_id=_actor
      and c.state in ('verified','paused') and p.status='active') then
    return jsonb_build_object('requestId',_request_id,'status','withheld');
  end if;
  return jsonb_build_object('requestId',_request_id,'status','committed','connection',_row.receipt);
end $$;

create function clinical_core.production_care_claim_request(_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _action text:=_request->>'action'; _actor uuid; _org uuid:=clinical_private.organization_id();
  _request_id uuid; _token text; _hash text; _row clinical_core.care_claim_requests; _result jsonb; _receipt jsonb;
begin
  if jsonb_typeof(_request) is distinct from 'object' or octet_length(_request::text)>1024
    or jsonb_typeof(_request->'action') is distinct from 'string' or _action not in ('claim','receipt','settle')
    or jsonb_typeof(_request->'requestId') is distinct from 'string'
    or (_request->>'requestId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or exists(select 1 from jsonb_object_keys(_request) k where not(k=any(case when _action='claim'
      then array['action','requestId','token'] else array['action','requestId'] end))) then
    raise exception using errcode='22023',message='care_connection_invalid';
  end if;
  if _action='claim' then
    if jsonb_typeof(_request->'token') is distinct from 'string' or char_length(_request->>'token')>24 then
      raise exception using errcode='22023',message='care_connection_invalid'; end if;
    _token:=upper(replace(btrim(_request->>'token'),'-',''));
    if _token !~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{13}$' then
      raise exception using errcode='22023',message='care_connection_invalid'; end if;
    _hash:=encode(public.digest(_token,'sha256'),'hex');
  end if;
  _request_id:=(_request->>'requestId')::uuid;
  _actor:=clinical_private.care_connection_actor('consumer','identity_link');
  -- Shared by claim, receipt and settlement before any chart/connection/owner
  -- lock or write. An absent row can be permanently fenced by settling first.
  perform pg_advisory_xact_lock(hashtextextended('care-claim:'||_org::text||':'||_actor::text||':'||_request_id::text,1));
  select * into _row from clinical_core.care_claim_requests
    where organization_id=_org and consumer_person_id=_actor and request_id=_request_id;
  if _action='claim' then
    if _row.request_id is not null then
      if _row.status='cancelled' or _row.token_sha256 is distinct from _hash then
        raise exception using errcode='40001',message='care_connection_conflict'; end if;
    else
      -- The existing verified claim implementation still enforces chart,
      -- invitation, one-connection, account-deletion and identity boundaries.
      _receipt:=clinical_core.production_care_connection_request(jsonb_build_object('action','claim','token',_token));
      insert into clinical_core.care_claim_requests(organization_id,consumer_person_id,request_id,token_sha256,status,connection_id,receipt)
        values(_org,_actor,_request_id,_hash,'committed',(_receipt->>'connectionId')::uuid,_receipt);
    end if;
  elsif _action='settle' and _row.request_id is null then
    insert into clinical_core.care_claim_requests(organization_id,consumer_person_id,request_id,status)
      values(_org,_actor,_request_id,'cancelled');
  end if;
  _result:=clinical_private.care_claim_result(_org,_actor,_request_id);
  -- Codes, token hashes, receipt bodies and clinical data never enter the audit.
  -- Repeated status accesses are separate reads; repeated writes remain immutable.
  insert into clinical_audit.care_claim_events(organization_id,consumer_person_id,request_id,action,outcome)
    values(_org,_actor,_request_id,_action,_result->>'status');
  return _result;
end $$;
revoke all on function clinical_private.care_claim_result(uuid,uuid,uuid) from public,clinical_core_api;
revoke all on function clinical_core.production_care_claim_request(jsonb) from public;
grant execute on function clinical_core.production_care_claim_request(jsonb) to clinical_core_api;
