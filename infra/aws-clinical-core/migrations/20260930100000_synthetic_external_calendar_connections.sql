-- External calendar connections. Synthetic-only; no production activation, and no
-- provider is configured, so nothing here can reach a calendar today.
--
-- This is where the transport's secrets live. Two decisions shape the table.
--
-- The refresh token is stored sealed and is never readable as a column value: the
-- table is revoked from the API role entirely, and the only way to obtain the
-- envelope is a function that checks the caller owns the connection. The
-- authorization state is stored as a digest rather than as itself, so a row read
-- does not hand someone the value a callback is compared against.
--
-- Disconnecting is erasure, not a status change. The sealed material is nulled in
-- the same statement that moves the state, because a disconnected connection that
-- still holds a usable refresh token is a connection.
create table clinical_core.external_calendar_connections(
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references clinical_core.organizations(id),
 practitioner_id uuid not null references clinical_core.persons(id),
 provider text not null check(provider in('google')),
 state text not null check(state in('disconnected','pending_authorization','connected','revoked','expired')),
 scopes text[] not null,
 calendar_ids text[] not null default '{}',
 -- Sealed envelopes only. A plaintext token has no column to live in.
 refresh_ciphertext text check(refresh_ciphertext is null or char_length(refresh_ciphertext) between 1 and 8192),
 refresh_iv text check(refresh_iv is null or refresh_iv ~ '^[A-Za-z0-9+/=]{16}$'),
 refresh_tag text check(refresh_tag is null or refresh_tag ~ '^[A-Za-z0-9+/=]{24}$'),
 verifier_ciphertext text check(verifier_ciphertext is null or char_length(verifier_ciphertext) between 1 and 8192),
 verifier_iv text check(verifier_iv is null or verifier_iv ~ '^[A-Za-z0-9+/=]{16}$'),
 verifier_tag text check(verifier_tag is null or verifier_tag ~ '^[A-Za-z0-9+/=]{24}$'),
 authorization_state_digest text check(authorization_state_digest is null or authorization_state_digest ~ '^[a-f0-9]{64}$'),
 authorization_started_at timestamptz,
 access_expires_at timestamptz,
 revision bigint not null default 1 check(revision>0),
 created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(),
 unique(practitioner_id),
 -- An envelope is all three parts or none of them; two parts is a corrupt row, not a token.
 check((refresh_ciphertext is null)=(refresh_iv is null) and (refresh_iv is null)=(refresh_tag is null)),
 check((verifier_ciphertext is null)=(verifier_iv is null) and (verifier_iv is null)=(verifier_tag is null)),
 check(state<>'pending_authorization' or (authorization_state_digest is not null and verifier_ciphertext is not null and authorization_started_at is not null)),
 check(state<>'connected' or access_expires_at is not null),
 -- Nothing that is not an authorization in flight keeps the verifier.
 check(state='pending_authorization' or (verifier_ciphertext is null and authorization_state_digest is null)),
 check(state in('connected','expired','revoked') or refresh_ciphertext is null)
);
alter table clinical_core.external_calendar_connections enable row level security;
revoke all on clinical_core.external_calendar_connections from public,clinical_core_api;
create index external_calendar_connections_org_idx
 on clinical_core.external_calendar_connections(organization_id,practitioner_id);

create table clinical_core.external_calendar_audit(
 id bigserial primary key,
 actor_id uuid not null references clinical_core.persons(id),
 organization_id uuid not null references clinical_core.organizations(id),
 connection_id uuid not null references clinical_core.external_calendar_connections(id),
 -- Content-free by construction: what happened, never what was on the calendar.
 action text not null check(action in('begin','complete','disconnect','state_recorded','material_read','calendars_set')),
 at timestamptz not null default clock_timestamp()
);
alter table clinical_core.external_calendar_audit enable row level security;
revoke all on clinical_core.external_calendar_audit from public,clinical_core_api;
create index external_calendar_audit_connection_idx
 on clinical_core.external_calendar_audit(connection_id,at desc);

-- The read-only scope allowlist, mirrored from `externalCalendarSync.ts`. A scope
-- outside it cannot be written here even if an API caller asks for one.
create or replace function clinical_private.calendar_scopes_readonly(_scopes text[])
returns boolean language sql immutable as $$
 select _scopes is not null and cardinality(_scopes) between 1 and 8
  and not exists(select 1 from unnest(_scopes) s where s not in(
   'https://www.googleapis.com/auth/calendar.readonly',
   'https://www.googleapis.com/auth/calendar.events.readonly',
   'https://www.googleapis.com/auth/calendar.freebusy'))
$$;
revoke all on function clinical_private.calendar_scopes_readonly(text[]) from public;
alter table clinical_core.external_calendar_connections
 add constraint external_calendar_scopes_readonly check(clinical_private.calendar_scopes_readonly(scopes));

-- Once sealed material is written it is replaced or erased, never edited in place by
-- an update that leaves the state saying something else.
create or replace function clinical_private.external_calendar_touch()
returns trigger language plpgsql as $$
begin
 if new.practitioner_id is distinct from old.practitioner_id
  or new.organization_id is distinct from old.organization_id
  or new.provider is distinct from old.provider
  or new.created_at is distinct from old.created_at then
  raise exception using errcode='22023',message='external_calendar_immutable';
 end if;
 if new.revision<=old.revision then
  raise exception using errcode='22023',message='external_calendar_immutable';
 end if;
 new.updated_at:=clock_timestamp();
 return new;
end $$;
revoke all on function clinical_private.external_calendar_touch() from public;
create trigger external_calendar_touch before update on clinical_core.external_calendar_connections
 for each row execute function clinical_private.external_calendar_touch();

-- The actor is the verified request context, never a field in the request. A
-- connection that could name its own owner would let any workforce caller mint or
-- read another practitioner's calendar authorization.
create or replace function clinical_core.external_calendar_request(_request jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 _actor uuid:=clinical_private.actor_person_id(); _org uuid:=clinical_private.organization_id();
 _pool text:=clinical_private.claim('identity_pool'); _action text:=_request->>'action';
 _row clinical_core.external_calendar_connections%rowtype;
 _now timestamptz:=clock_timestamp(); _scopes text[]; _expected bigint; _ids text[];
begin
 perform clinical_private.assert_synthetic_context(_org,'clinical_data');
 -- Workforce only, and only a member with a clinical role in this organization.
 if _actor is null or _org is null or _pool<>'workforce'
 or not exists(select 1 from clinical_core.identities i join clinical_core.persons p on p.id=i.person_id
  where i.person_id=_actor and i.identity_pool=_pool and i.identity_subject=clinical_private.claim('identity_subject')
  and i.status='active' and p.status='active' and i.synthetic_attested)
 or not exists(select 1 from clinical_core.organizations where id=_org and status='active')
 or not clinical_private.has_clinical_role(_org) then
  raise exception using errcode='42501',message='external_calendar_forbidden'; end if;
 if _request is null or jsonb_typeof(_request)<>'object' or octet_length(_request::text)>65536
 or _action is null or _action not in('read','begin','pending','complete','material','record_state','set_calendars','disconnect') then
  raise exception using errcode='22023',message='external_calendar_invalid'; end if;

 select * into _row from clinical_core.external_calendar_connections
  where practitioner_id=_actor and organization_id=_org;

 if _action='read' then
  if _row.id is null then
   return jsonb_build_object('action','read','state','disconnected','connected',false); end if;
  insert into clinical_core.external_calendar_audit(actor_id,organization_id,connection_id,action)
   values(_actor,_org,_row.id,'material_read');
  -- Never the envelope, never a calendar's contents: state and shape only.
  return jsonb_build_object('action','read','connectionId',_row.id,'state',_row.state,
   'connected',_row.state='connected','provider',_row.provider,
   'scopes',to_jsonb(_row.scopes),'calendarIds',to_jsonb(_row.calendar_ids),
   'hasRefreshToken',_row.refresh_ciphertext is not null,
   'expiresAt',_row.access_expires_at,'revision',_row.revision::text);
 end if;

 if _action='begin' then
  if not (_request ? 'stateDigest' and _request ? 'verifier' and _request ? 'scopes') then
   raise exception using errcode='22023',message='external_calendar_invalid'; end if;
  if (_request->>'stateDigest') !~ '^[a-f0-9]{64}$' then
   raise exception using errcode='22023',message='external_calendar_invalid'; end if;
  select array_agg(value) into _scopes from jsonb_array_elements_text(_request->'scopes');
  if not clinical_private.calendar_scopes_readonly(_scopes) then
   raise exception using errcode='22023',message='external_calendar_scope_refused'; end if;
  if _row.id is null then
   insert into clinical_core.external_calendar_connections(
    organization_id,practitioner_id,provider,state,scopes,
    verifier_ciphertext,verifier_iv,verifier_tag,authorization_state_digest,authorization_started_at)
   values(_org,_actor,'google','pending_authorization',_scopes,
    _request->'verifier'->>'ciphertext',_request->'verifier'->>'iv',_request->'verifier'->>'tag',
    _request->>'stateDigest',_now) returning * into _row;
  else
   -- Starting again abandons the previous attempt, including any token it held.
   update clinical_core.external_calendar_connections set state='pending_authorization',scopes=_scopes,
    verifier_ciphertext=_request->'verifier'->>'ciphertext',verifier_iv=_request->'verifier'->>'iv',
    verifier_tag=_request->'verifier'->>'tag',authorization_state_digest=_request->>'stateDigest',
    authorization_started_at=_now,refresh_ciphertext=null,refresh_iv=null,refresh_tag=null,
    access_expires_at=null,revision=revision+1
    where id=_row.id returning * into _row;
  end if;
  insert into clinical_core.external_calendar_audit(actor_id,organization_id,connection_id,action)
   values(_actor,_org,_row.id,'begin');
  return jsonb_build_object('action','begin','connectionId',_row.id,'revision',_row.revision::text);
 end if;

 if _row.id is null then raise exception using errcode='22023',message='external_calendar_absent'; end if;

 if _action='pending' then
  if (_request->>'stateDigest') is null or (_request->>'stateDigest') !~ '^[a-f0-9]{64}$' then
   raise exception using errcode='22023',message='external_calendar_invalid'; end if;
  if _row.state<>'pending_authorization' then
   raise exception using errcode='40001',message='external_calendar_not_pending'; end if;
  -- The digest decides, and a stale attempt is not answered at all.
  if _row.authorization_state_digest is distinct from (_request->>'stateDigest') then
   raise exception using errcode='40001',message='external_calendar_state_mismatch'; end if;
  if _now - _row.authorization_started_at > interval '10 minutes' then
   raise exception using errcode='40001',message='external_calendar_authorization_expired'; end if;
  insert into clinical_core.external_calendar_audit(actor_id,organization_id,connection_id,action)
   values(_actor,_org,_row.id,'material_read');
  return jsonb_build_object('action','pending','connectionId',_row.id,'revision',_row.revision::text,
   'verifier',jsonb_build_object('ciphertext',_row.verifier_ciphertext,'iv',_row.verifier_iv,
    'tag',_row.verifier_tag,'connectionId',_row.id),
   'scopes',to_jsonb(_row.scopes));
 end if;

 _expected:=nullif(_request->>'expectedRevision','')::bigint;
 if _expected is not null and _expected<>_row.revision then
  raise exception using errcode='40001',message='external_calendar_revision_stale'; end if;

 if _action='complete' then
  if _row.state<>'pending_authorization' then
   raise exception using errcode='40001',message='external_calendar_not_pending'; end if;
  if not (_request ? 'refresh' and _request ? 'expiresAt' and _request ? 'scopes') then
   raise exception using errcode='22023',message='external_calendar_invalid'; end if;
  select array_agg(value) into _scopes from jsonb_array_elements_text(_request->'scopes');
  -- What the provider granted is re-checked here too, so the database is not relying
  -- on the application having done it.
  if not clinical_private.calendar_scopes_readonly(_scopes) then
   raise exception using errcode='22023',message='external_calendar_scope_refused'; end if;
  update clinical_core.external_calendar_connections set state='connected',scopes=_scopes,
   refresh_ciphertext=nullif(_request->'refresh'->>'ciphertext',''),
   refresh_iv=nullif(_request->'refresh'->>'iv',''),
   refresh_tag=nullif(_request->'refresh'->>'tag',''),
   access_expires_at=(_request->>'expiresAt')::timestamptz,
   verifier_ciphertext=null,verifier_iv=null,verifier_tag=null,authorization_state_digest=null,
   authorization_started_at=null,revision=revision+1
   where id=_row.id returning * into _row;
  insert into clinical_core.external_calendar_audit(actor_id,organization_id,connection_id,action)
   values(_actor,_org,_row.id,'complete');
  return jsonb_build_object('action','complete','connectionId',_row.id,'state',_row.state,
   'revision',_row.revision::text,'expiresAt',_row.access_expires_at);
 end if;

 if _action='material' then
  if _row.state not in('connected','expired') then
   raise exception using errcode='40001',message='external_calendar_not_connected'; end if;
  if _row.refresh_ciphertext is null then
   raise exception using errcode='40001',message='external_calendar_reauthorization_required'; end if;
  insert into clinical_core.external_calendar_audit(actor_id,organization_id,connection_id,action)
   values(_actor,_org,_row.id,'material_read');
  return jsonb_build_object('action','material','connectionId',_row.id,'state',_row.state,
   'revision',_row.revision::text,'expiresAt',_row.access_expires_at,
   'refresh',jsonb_build_object('ciphertext',_row.refresh_ciphertext,'iv',_row.refresh_iv,
    'tag',_row.refresh_tag,'connectionId',_row.id));
 end if;

 if _action='record_state' then
  if (_request->>'state') not in('connected','expired','revoked') then
   raise exception using errcode='22023',message='external_calendar_invalid'; end if;
  -- A revoked authorization loses its token in the same statement that records it.
  update clinical_core.external_calendar_connections set state=_request->>'state',
   refresh_ciphertext=case when _request->>'state'='revoked' then null
    else coalesce(nullif(_request->'refresh'->>'ciphertext',''),refresh_ciphertext) end,
   refresh_iv=case when _request->>'state'='revoked' then null
    else coalesce(nullif(_request->'refresh'->>'iv',''),refresh_iv) end,
   refresh_tag=case when _request->>'state'='revoked' then null
    else coalesce(nullif(_request->'refresh'->>'tag',''),refresh_tag) end,
   access_expires_at=case when _request->>'state'='revoked' then null
    else coalesce((_request->>'expiresAt')::timestamptz,access_expires_at) end,
   revision=revision+1
   where id=_row.id returning * into _row;
  insert into clinical_core.external_calendar_audit(actor_id,organization_id,connection_id,action)
   values(_actor,_org,_row.id,'state_recorded');
  return jsonb_build_object('action','record_state','connectionId',_row.id,'state',_row.state,
   'revision',_row.revision::text,'hasRefreshToken',_row.refresh_ciphertext is not null);
 end if;

 if _action='set_calendars' then
  select coalesce(array_agg(value),'{}'::text[]) into _ids from jsonb_array_elements_text(_request->'calendarIds');
  if cardinality(_ids)>10 or exists(select 1 from unnest(_ids) c where btrim(c)='' or char_length(c)>320) then
   raise exception using errcode='22023',message='external_calendar_invalid'; end if;
  update clinical_core.external_calendar_connections set calendar_ids=_ids,revision=revision+1
   where id=_row.id returning * into _row;
  insert into clinical_core.external_calendar_audit(actor_id,organization_id,connection_id,action)
   values(_actor,_org,_row.id,'calendars_set');
  return jsonb_build_object('action','set_calendars','connectionId',_row.id,'state',_row.state,
   'calendarIds',to_jsonb(_row.calendar_ids),'revision',_row.revision::text);
 end if;

 if _action='disconnect' then
  -- Erasure, not a status change.
  update clinical_core.external_calendar_connections set state='disconnected',
   refresh_ciphertext=null,refresh_iv=null,refresh_tag=null,
   verifier_ciphertext=null,verifier_iv=null,verifier_tag=null,
   authorization_state_digest=null,authorization_started_at=null,access_expires_at=null,
   calendar_ids='{}'::text[],revision=revision+1
   where id=_row.id returning * into _row;
  insert into clinical_core.external_calendar_audit(actor_id,organization_id,connection_id,action)
   values(_actor,_org,_row.id,'disconnect');
  return jsonb_build_object('action','disconnect','connectionId',_row.id,'state',_row.state,
   'revision',_row.revision::text,'hasRefreshToken',false);
 end if;

 raise exception using errcode='22023',message='external_calendar_invalid';
end $$;
revoke all on function clinical_core.external_calendar_request(jsonb) from public;
grant execute on function clinical_core.external_calendar_request(jsonb) to clinical_core_api;
