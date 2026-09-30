-- External busy time, stored so booking can actually refuse against it.
-- Synthetic-only; the connector is still disabled and no provider is configured.
--
-- The connector could read a practitioner's busy time and nothing consulted it: the
-- booking function checked internal appointments only. A practitioner could connect a
-- calendar, see "Connected", and still be booked over — which is the one thing the
-- feature exists to prevent.
--
-- The check has to be transactional to be worth anything, and an HTTP read cannot be
-- inside a transaction. So the intervals are stored, and booking consults the stored
-- ones under the same per-practitioner advisory lock it already takes for internal
-- overlap. A check-then-commit against a live HTTP read would lose exactly the race it
-- claims to close.
--
-- The consequence is stated rather than softened: if a practitioner has connected a
-- calendar and we do not have fresh busy data covering the requested window, booking
-- refuses. Unknown is not free. It applies only to practitioners who chose to connect,
-- the reason is distinct so a screen can say which it was, and the remedy is to sync or
-- to disconnect — not to book blind.
create table clinical_core.external_calendar_busy_blocks(
 id bigserial primary key,
 connection_id uuid not null references clinical_core.external_calendar_connections(id),
 organization_id uuid not null references clinical_core.organizations(id),
 practitioner_id uuid not null references clinical_core.persons(id),
 starts_at timestamptz not null,
 ends_at timestamptz not null,
 -- The window this block was read for. A block only answers for its own window.
 window_from timestamptz not null,
 window_to timestamptz not null,
 synced_at timestamptz not null default clock_timestamp(),
 check(ends_at>starts_at),
 check(window_to>window_from),
 check(starts_at>=window_from and ends_at<=window_to)
);
alter table clinical_core.external_calendar_busy_blocks enable row level security;
revoke all on clinical_core.external_calendar_busy_blocks from public,clinical_core_api;
create index external_busy_blocks_practitioner
 on clinical_core.external_calendar_busy_blocks(practitioner_id,starts_at,ends_at);
create index external_busy_blocks_window
 on clinical_core.external_calendar_busy_blocks(connection_id,window_from,window_to);

-- A sync that covered a window but found nothing busy still has to be recorded, or an
-- empty calendar would be indistinguishable from no sync at all.
create table clinical_core.external_calendar_busy_windows(
 id bigserial primary key,
 connection_id uuid not null references clinical_core.external_calendar_connections(id),
 practitioner_id uuid not null references clinical_core.persons(id),
 window_from timestamptz not null,
 window_to timestamptz not null,
 -- Calendars the provider could not answer for. A window with any of these is not a
 -- complete answer and does not count as covering anything.
 unavailable_calendars integer not null default 0 check(unavailable_calendars>=0),
 synced_at timestamptz not null default clock_timestamp(),
 check(window_to>window_from),
 unique(connection_id,window_from,window_to)
);
alter table clinical_core.external_calendar_busy_windows enable row level security;
revoke all on clinical_core.external_calendar_busy_windows from public,clinical_core_api;

/* How old a sync may be and still answer for a booking. Declared once so the refusal
   and any operator report cannot disagree about it. */
create or replace function clinical_private.external_busy_freshness() returns interval
language sql immutable set search_path='' as $$ select interval '15 minutes' $$;
revoke all on function clinical_private.external_busy_freshness() from public;

/* Why a booking may not proceed against a practitioner's external calendar, or null if
   it may. Null is returned only when there is nothing to check or when a fresh,
   complete answer says the time is free. */
create or replace function clinical_private.external_busy_refusal(
 _organization_id uuid,_practitioner_id uuid,_from timestamptz,_to timestamptz
) returns text language plpgsql stable set search_path='' as $$
declare _state text; _covered boolean; _fresh boolean;
begin
 select c.state into _state from clinical_core.external_calendar_connections c
  where c.practitioner_id=_practitioner_id and c.organization_id=_organization_id;
 -- No connection at all: there is no external calendar to respect.
 if _state is null or _state='disconnected' then return null; end if;
 -- A connection that cannot be read is not an absence of busy time. It is an unknown,
 -- and the practitioner chose to have it consulted.
 if _state in('pending_authorization','revoked') then return 'external_busy_unreadable'; end if;

 -- count(*)>0 rather than a literal: `select true, max(...)` returns one row even when
 -- nothing matched, which reported an absent window as covered but stale.
 select count(*)>0,max(w.synced_at)>clock_timestamp()-clinical_private.external_busy_freshness()
  into _covered,_fresh
 from clinical_core.external_calendar_busy_windows w
 join clinical_core.external_calendar_connections c on c.id=w.connection_id
 where c.practitioner_id=_practitioner_id and c.organization_id=_organization_id
  and w.window_from<=_from and w.window_to>=_to and w.unavailable_calendars=0;

 if _covered is not true then return 'external_busy_unknown'; end if;
 if _fresh is not true then return 'external_busy_stale'; end if;

 if exists(select 1 from clinical_core.external_calendar_busy_blocks b
  join clinical_core.external_calendar_connections c on c.id=b.connection_id
  where c.practitioner_id=_practitioner_id and c.organization_id=_organization_id
   and b.window_from<=_from and b.window_to>=_to
   and b.synced_at>clock_timestamp()-clinical_private.external_busy_freshness()
   and tstzrange(b.starts_at,b.ends_at,'[)')&&tstzrange(_from,_to,'[)')) then
  return 'external_busy_conflict';
 end if;
 return null;
end $$;
revoke all on function clinical_private.external_busy_refusal(uuid,uuid,timestamptz,timestamptz) from public;

/* Replace the stored busy time for one window of the caller's own connection. The
   intervals come from the provider read; this stores them and nothing else. */
create or replace function clinical_core.external_calendar_busy_sync(_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 _actor uuid:=clinical_private.actor_person_id(); _org uuid:=clinical_private.organization_id();
 _pool text:=clinical_private.claim('identity_pool');
 _row clinical_core.external_calendar_connections%rowtype;
 _from timestamptz; _to timestamptz; _unavailable integer; _stored integer:=0; _now timestamptz:=clock_timestamp();
begin
 perform clinical_private.assert_synthetic_context(_org,'clinical_data');
 if _actor is null or _org is null or _pool<>'workforce'
 or not exists(select 1 from clinical_core.identities i join clinical_core.persons p on p.id=i.person_id
  where i.person_id=_actor and i.identity_pool=_pool and i.identity_subject=clinical_private.claim('identity_subject')
  and i.status='active' and p.status='active' and i.synthetic_attested)
 or not clinical_private.has_clinical_role(_org) then
  raise exception using errcode='42501',message='external_calendar_forbidden'; end if;
 if _request is null or jsonb_typeof(_request)<>'object'
 or _request-array['action','windowFrom','windowTo','busy','unavailableCalendars']<>'{}'::jsonb
 or (_request->>'action') is distinct from 'busy_sync'
 or jsonb_typeof(_request->'busy')<>'array' or jsonb_array_length(_request->'busy')>500 then
  raise exception using errcode='22023',message='external_calendar_invalid'; end if;
 begin
  _from:=(_request->>'windowFrom')::timestamptz; _to:=(_request->>'windowTo')::timestamptz;
  _unavailable:=coalesce((_request->>'unavailableCalendars')::integer,0);
 exception when others then raise exception using errcode='22023',message='external_calendar_invalid'; end;
 if _from is null or _to is null or _to<=_from or _to-_from>interval '31 days' or _unavailable<0 then
  raise exception using errcode='22023',message='external_calendar_invalid'; end if;

 select * into _row from clinical_core.external_calendar_connections
  where practitioner_id=_actor and organization_id=_org;
 if _row.id is null then raise exception using errcode='22023',message='external_calendar_absent'; end if;
 if _row.state not in('connected','expired') then
  raise exception using errcode='40001',message='external_calendar_not_connected'; end if;

 -- One window, replaced whole. A partial update would leave a removed meeting behind.
 delete from clinical_core.external_calendar_busy_blocks
  where connection_id=_row.id and window_from=_from and window_to=_to;
 insert into clinical_core.external_calendar_busy_blocks(
  connection_id,organization_id,practitioner_id,starts_at,ends_at,window_from,window_to,synced_at)
 select _row.id,_org,_actor,
  greatest((entry->>'start')::timestamptz,_from),least((entry->>'end')::timestamptz,_to),_from,_to,_now
 from jsonb_array_elements(_request->'busy') entry
 where (entry->>'start') is not null and (entry->>'end') is not null
  and (entry->>'end')::timestamptz>(entry->>'start')::timestamptz
  and least((entry->>'end')::timestamptz,_to)>greatest((entry->>'start')::timestamptz,_from);
 get diagnostics _stored=row_count;

 insert into clinical_core.external_calendar_busy_windows(
  connection_id,practitioner_id,window_from,window_to,unavailable_calendars,synced_at)
 values(_row.id,_actor,_from,_to,_unavailable,_now)
 on conflict(connection_id,window_from,window_to) do update
  set unavailable_calendars=excluded.unavailable_calendars,synced_at=excluded.synced_at,
      practitioner_id=excluded.practitioner_id;

 insert into clinical_core.external_calendar_audit(actor_id,organization_id,connection_id,action)
  values(_actor,_org,_row.id,'busy_synced');
 return jsonb_build_object('action','busy_sync','connectionId',_row.id,'stored',_stored,
  'unavailableCalendars',_unavailable,'complete',_unavailable=0,'syncedAt',_now);
end $$;
revoke all on function clinical_core.external_calendar_busy_sync(jsonb) from public;
grant execute on function clinical_core.external_calendar_busy_sync(jsonb) to clinical_core_api;

alter table clinical_core.external_calendar_audit drop constraint external_calendar_audit_action_check;
alter table clinical_core.external_calendar_audit add constraint external_calendar_audit_action_check
 check(action in('begin','complete','disconnect','state_recorded','material_read','calendars_set','busy_synced'));

-- Booking now consults the stored busy time, inside the lock it already takes.
create or replace function clinical_core.book_appointment(
  _organization_id uuid,_practitioner_user_id uuid,_appointment_type text,
  _starts_at timestamptz,_ends_at timestamptz,_patient_id uuid default null,
  _location text default null,_telehealth_url text default null,_title text default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare _id uuid; _external text;
begin
  perform clinical_private.assert_synthetic_context(_organization_id,'clinical_data','workforce');
  if not clinical_private.has_schedule_role(_organization_id) then raise exception using errcode='42501',message='schedule_role_required'; end if;
  if _appointment_type not in ('initial','follow-up','lab-review','supplement','telehealth','group','break')
    or _starts_at is null or _ends_at is null or _ends_at<=_starts_at or _ends_at-_starts_at>interval '8 hours'
    or char_length(coalesce(_location,''))>200 or char_length(coalesce(_telehealth_url,''))>2048
    or char_length(coalesce(_title,''))>200 then raise exception using errcode='22023',message='appointment_invalid'; end if;
  if not exists(select 1 from clinical_core.organization_memberships membership
    where membership.organization_id=_organization_id and membership.person_id=_practitioner_user_id
      and membership.status='active' and membership.role in ('owner','admin','practitioner')) then
    raise exception using errcode='22023',message='practitioner_not_schedulable'; end if;
  if _patient_id is null and _appointment_type not in ('break','group') then raise exception using errcode='22023',message='patient_required'; end if;
  if _patient_id is not null and not exists(select 1 from clinical_core.patient_records patient
    where patient.id=_patient_id and patient.organization_id=_organization_id and patient.status='active') then
    raise exception using errcode='P0002',message='patient_not_found'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('schedule:practitioner:'||_practitioner_user_id::text,0));
  if _patient_id is not null then perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('schedule:patient:'||_patient_id::text,0)); end if;
  if exists(select 1 from clinical_core.appointments appointment where appointment.organization_id=_organization_id
    and appointment.practitioner_person_id=_practitioner_user_id and appointment.deleted_at is null
    and appointment.status not in ('cancelled','no_show')
    and tstzrange(appointment.starts_at,appointment.ends_at,'[)')&&tstzrange(_starts_at,_ends_at,'[)'))
    or (_patient_id is not null and exists(select 1 from clinical_core.appointments appointment
      where appointment.organization_id=_organization_id and appointment.patient_record_id=_patient_id
        and appointment.deleted_at is null and appointment.status not in ('cancelled','no_show')
        and tstzrange(appointment.starts_at,appointment.ends_at,'[)')&&tstzrange(_starts_at,_ends_at,'[)'))) then
    raise exception using errcode='22023',message='appointment_overlap'; end if;
  -- A practitioner who connected an external calendar asked for it to be respected.
  -- Inside the same lock, so a sync landing mid-booking cannot be missed.
  _external:=clinical_private.external_busy_refusal(_organization_id,_practitioner_user_id,_starts_at,_ends_at);
  if _external is not null then raise exception using errcode='22023',message=_external; end if;
  insert into clinical_core.appointments(organization_id,patient_record_id,practitioner_person_id,title,appointment_type,
    location,telehealth_url,starts_at,ends_at,created_by_person_id,updated_by_person_id)
  values(_organization_id,_patient_id,_practitioner_user_id,nullif(btrim(_title),''),_appointment_type,
    nullif(btrim(_location),''),nullif(btrim(_telehealth_url),''),_starts_at,_ends_at,
    clinical_private.actor_person_id(),clinical_private.actor_person_id()) returning id into _id;
  -- The audit insert this function shipped with named `patient_record_id` and
  -- `safe_message`, and `clinical_audit.events` in this family has neither column. Every
  -- booking therefore raised `column "patient_record_id" ... does not exist` at runtime.
  -- Nothing caught it because no test had ever executed the function against the real
  -- SQL; the adapter tests mock the RPC. Corrected to the columns that exist. The
  -- appointment id is the resource, and it resolves to its patient through
  -- `clinical_core.appointments`, so nothing traceable is lost by not repeating it here.
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,purpose,safe_metadata)
  values(_organization_id,clinical_private.actor_person_id(),'appointment.booked','appointment',_id,'clinical_data',
    jsonb_build_object('appointment_type',_appointment_type,'telehealth',nullif(btrim(_telehealth_url),'') is not null));
  return jsonb_build_object('id',_id,'status','scheduled','starts_at',_starts_at,'ends_at',_ends_at);
end $$;
