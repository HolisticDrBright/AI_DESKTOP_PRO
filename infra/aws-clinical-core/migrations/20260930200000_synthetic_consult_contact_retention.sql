-- Erasing the contact details of someone who asked about care and never became a patient.
-- Synthetic-only. No real patient data, and nothing here is enabled for production.
--
-- This closes a defect in the public consult link shipped earlier today, and the defect is
-- worth stating plainly because the shape of it recurs.
--
-- Both erasure scopes delete a consult request by joining through `patient_connections`:
--
--   delete from clinical_core.consult_requests q using clinical_core.patient_connections c
--    where c.id=q.connection_id and c.consumer_person_id=_actor;
--
-- `connection_id` is nullable, and it is null until a request is converted. So an enquiry from
-- someone who never became a patient matched neither scope, no retention sweep touched the
-- table, and their encrypted contact details stayed indefinitely. They had no account to ask
-- from either: the erasure path is for owners, and an enquirer is not one. A person who wrote
-- once and never came back could not be forgotten. The erasure worked for everyone it could
-- see, and the people it could not see were precisely the ones with no other route.
--
-- Two mechanisms, deliberately separate.
--
-- The clinic can purge a finished request's contact details now. Declined and withdrawn are
-- finished; received and accepted are not, and purging those would destroy the clinic's ability
-- to answer someone who is still waiting, so the manual path refuses them.
--
-- And a practice may set a retention window, after which any unconverted request's contact
-- details are purgeable whatever its status — because an unanswered enquiry going stale is
-- exactly the case nobody is coming back for. There is deliberately NO default window. How long
-- a clinic keeps an enquiry is its own compliance posture in its own jurisdiction, and a number
-- invented here would quietly become that posture. Unset means nothing is purged automatically,
-- and the screen says so rather than implying a policy exists.
--
-- What a purge removes is the contact envelope. The row stays: which link, what kind of visit,
-- when it arrived, what the clinic decided. That is the clinic's record of having been asked and
-- having answered, it identifies nobody once the envelope is gone, and destroying it would erase
-- the evidence that the clinic handled the enquiry at all.

-- The envelope becomes removable. All four columns travel together: a row with a ciphertext and
-- no tag is not a partly-erased record, it is an unopenable one.
alter table clinical_core.consult_requests alter column contact_ciphertext drop not null;
alter table clinical_core.consult_requests alter column contact_iv drop not null;
alter table clinical_core.consult_requests alter column contact_tag drop not null;
alter table clinical_core.consult_requests alter column contact_digest drop not null;
alter table clinical_core.consult_requests add column contact_purged_at timestamptz;
alter table clinical_core.consult_requests add constraint consult_requests_contact_all_or_nothing
 check((contact_purged_at is null
   and contact_ciphertext is not null and contact_iv is not null
   and contact_tag is not null and contact_digest is not null)
  or (contact_purged_at is not null
   and contact_ciphertext is null and contact_iv is null
   and contact_tag is null and contact_digest is null));

-- The whole action list carried forward, with two added. Writing only the new ones would drop
-- every existing action and the first symptom would be a received request failing to audit.
alter table clinical_core.consult_request_audit drop constraint consult_request_audit_action_check;
alter table clinical_core.consult_request_audit add constraint consult_request_audit_action_check
 check(action in('link_created','link_updated','link_disabled','link_enabled',
  'request_received','request_throttled','request_accepted','request_declined',
  'request_withdrawn','request_converted','contact_opened',
  'contact_purged','retention_window_set'));

/* What a practice keeps, and for how long. Versioned and append-only like every other stated
   policy here, so "what was our retention when this was purged" has an answer.
   `purge_contact_after_days` null means no automatic purge: an explicit decision to keep
   enquiries until somebody purges them by hand, not an accident. */
create table clinical_core.consult_retention_settings(
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references clinical_core.organizations(id),
 version integer not null check(version>0),
 status text not null default 'published' check(status in('published','retired')),
 purge_contact_after_days integer
  check(purge_contact_after_days is null or purge_contact_after_days between 1 and 3650),
 set_at timestamptz not null default clock_timestamp(),
 set_by_person_id uuid not null references clinical_core.persons(id),
 unique(organization_id,version)
);
create unique index consult_retention_settings_one_published
 on clinical_core.consult_retention_settings(organization_id) where status='published';

create or replace function clinical_private.protect_consult_retention_setting() returns trigger
language plpgsql set search_path='' as $$
begin
 if tg_op='DELETE' then
  raise exception using errcode='0A000',message='consult_retention_immutable'; end if;
 if old.status='published' and new.status='retired'
 and new.purge_contact_after_days is not distinct from old.purge_contact_after_days
 and new.version=old.version and new.set_at=old.set_at then return new; end if;
 raise exception using errcode='0A000',message='consult_retention_immutable';
end $$;
create trigger consult_retention_settings_protect before update or delete
 on clinical_core.consult_retention_settings
 for each row execute function clinical_private.protect_consult_retention_setting();

/* The append-only refusal on a request is narrowed, not lifted.
   Two allowances now, and BOTH must be carried forward by whoever replaces this next: the
   delete inside the owner's erasure window, added in migration 20260930150000, and the purge
   below. Replacing this function from migration 20260930130000's body — as the first draft of
   this migration did — silently removes the erasure allowance, and the symptom is an account
   closure failing for anyone who ever enquired. Two existing tests caught it.
   The purge permits exactly one new update: the four contact columns going from present to
   absent together, with the purge stamp appearing at the same moment. Everything else both
   earlier versions refused, this still refuses — including a purge that leaves any part of the
   envelope behind, and a second purge of an already-purged row. */
create or replace function clinical_private.protect_consult_request() returns trigger
language plpgsql security invoker set search_path='' as $$
declare _owner uuid; _purging boolean;
begin
 if tg_op='DELETE' then
  _owner:=clinical_private.care_erasure_owner();
  if _owner is not null and old.connection_id is not null
  and exists(select 1 from clinical_core.patient_connections c
   where c.id=old.connection_id and c.consumer_person_id=_owner) then
   return old;
  end if;
  raise exception using errcode='55000',message='append_only_record';
 end if;
 _purging:=old.contact_purged_at is null and new.contact_purged_at is not null
  and new.contact_ciphertext is null and new.contact_iv is null
  and new.contact_tag is null and new.contact_digest is null;
 if new.id is distinct from old.id
 or new.organization_id is distinct from old.organization_id
 or new.link_id is distinct from old.link_id
 or new.reference_code is distinct from old.reference_code
 or new.visit_type is distinct from old.visit_type
 or new.reason_code is distinct from old.reason_code
 or new.preferred_windows is distinct from old.preferred_windows
 or new.received_at is distinct from old.received_at
 or (not _purging and (
  new.contact_ciphertext is distinct from old.contact_ciphertext
  or new.contact_iv is distinct from old.contact_iv
  or new.contact_tag is distinct from old.contact_tag
  or new.contact_digest is distinct from old.contact_digest
  or new.contact_purged_at is distinct from old.contact_purged_at)) then
  raise exception using errcode='55000',message='consult_request_immutable';
 end if;
 return new;
end $$;

/* Opening a purged envelope is refused here rather than answered with nulls.
   The refusal lives on the audit insert because that is the one thing every open does before
   returning the envelope, so a purged row cannot be read by any path that records having read
   it — and a path that did not record it would be the worse bug. */
create or replace function clinical_private.consult_open_purged_guard() returns trigger
language plpgsql set search_path='' as $$
begin
 if new.action='contact_opened' and exists(
  select 1 from clinical_core.consult_requests r
   where r.id=new.request_id and r.contact_purged_at is not null) then
  raise exception using errcode='0A000',message='consult_contact_purged';
 end if;
 return new;
end $$;
create trigger consult_request_audit_open_purged before insert on clinical_core.consult_request_audit
 for each row execute function clinical_private.consult_open_purged_guard();

/* Whether a request's contact details may be purged now, and why not if not.
   Returns null when they may be. One function, used by the manual purge, the sweep and the
   preview, so a screen cannot show one answer while the write applies another. */
create or replace function clinical_private.consult_purge_refusal(
 _row clinical_core.consult_requests,_window integer
) returns text language plpgsql stable set search_path='' as $$
begin
 if _row.contact_purged_at is not null then return 'already_purged'; end if;
 -- A converted request belongs to a patient now, and the owner's own erasure reaches it.
 if _row.status='converted' or _row.connection_id is not null then
  return 'converted_to_a_patient_record'; end if;
 if _row.status in('declined','withdrawn') then return null; end if;
 -- Still waiting on the clinic. Purgeable only once the practice's own window has passed.
 if _window is null then return 'still_open_and_no_retention_window_is_set'; end if;
 if _row.received_at > clock_timestamp()-make_interval(days=>_window) then
  return 'still_open_and_inside_the_retention_window'; end if;
 return null;
end $$;
revoke all on function clinical_private.consult_purge_refusal(clinical_core.consult_requests,integer) from public;

/* The practice's retention policy, and erasing an enquirer's contact details.
   There is no consumer surface: an enquirer has no account, and an unauthenticated erase-by-
   contact endpoint would be a way to probe which addresses had written to a clinic. */
create or replace function clinical_core.consult_contact_retention(_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 _org uuid:=clinical_private.organization_id(); _actor uuid; _action text;
 _row clinical_core.consult_requests%rowtype; _setting clinical_core.consult_retention_settings%rowtype;
 _window integer; _days integer; _refusal text; _purged integer:=0; _next integer;
begin
 _actor:=clinical_private.assert_practice_workforce(_org,'consult_retention_forbidden');
 if _request is null or clinical_private.jsonb_kind(_request)<>'object' then
  raise exception using errcode='22023',message='consult_retention_invalid'; end if;
 _action:=_request->>'action';
 if _action is null or _action not in('settings_read','settings_set','pending','purge','sweep') then
  raise exception using errcode='22023',message='consult_retention_invalid'; end if;

 select * into _setting from clinical_core.consult_retention_settings
  where organization_id=_org and status='published';
 _window:=_setting.purge_contact_after_days;

 if _action='settings_read' then
  if _request-array['action']<>'{}'::jsonb then
   raise exception using errcode='22023',message='consult_retention_invalid'; end if;
  return jsonb_build_object('action','settings_read',
   'purgeContactAfterDays',_window,'version',_setting.version,
   -- Said out loud, because "no window" and "a window nobody chose" must not look the same.
   'automaticPurge',_window is not null);
 end if;

 if _action='settings_set' then
  if _request-array['action','purgeContactAfterDays']<>'{}'::jsonb
  or not _request ? 'purgeContactAfterDays' then
   raise exception using errcode='22023',message='consult_retention_invalid'; end if;
  if clinical_private.jsonb_kind(_request->'purgeContactAfterDays')='number' then
   _days:=(_request->>'purgeContactAfterDays')::numeric::integer;
   if _days<1 or _days>3650 then
    raise exception using errcode='22023',message='consult_retention_invalid'; end if;
  elsif clinical_private.jsonb_kind(_request->'purgeContactAfterDays')='null' then _days:=null;
  else raise exception using errcode='22023',message='consult_retention_invalid'; end if;
  update clinical_core.consult_retention_settings set status='retired'
   where organization_id=_org and status='published';
  select coalesce(max(version),0)+1 into _next from clinical_core.consult_retention_settings
   where organization_id=_org;
  insert into clinical_core.consult_retention_settings(organization_id,version,
   purge_contact_after_days,set_by_person_id) values(_org,_next,_days,_actor)
  returning * into _setting;
  insert into clinical_core.consult_request_audit(organization_id,actor_id,action)
   values(_org,_actor,'retention_window_set');
  return jsonb_build_object('action','settings_set','purgeContactAfterDays',_days,
   'version',_setting.version,'automaticPurge',_days is not null);
 end if;

 if _action='pending' then
  if _request-array['action']<>'{}'::jsonb then
   raise exception using errcode='22023',message='consult_retention_invalid'; end if;
  return jsonb_build_object('action','pending','purgeContactAfterDays',_window,
   'purgeable',(select count(*) from clinical_core.consult_requests r
    where r.organization_id=_org
     and clinical_private.consult_purge_refusal(r,_window) is null),
   'stillHeld',(select count(*) from clinical_core.consult_requests r
    where r.organization_id=_org and r.contact_purged_at is null),
   'alreadyPurged',(select count(*) from clinical_core.consult_requests r
    where r.organization_id=_org and r.contact_purged_at is not null));
 end if;

 if _action='purge' then
  if _request-array['action','requestId']<>'{}'::jsonb then
   raise exception using errcode='22023',message='consult_retention_invalid'; end if;
  begin
   select * into _row from clinical_core.consult_requests
    where organization_id=_org and id=(_request->>'requestId')::uuid for update;
  exception when invalid_text_representation then
   raise exception using errcode='22023',message='consult_retention_invalid'; end;
  if _row.id is null then
   raise exception using errcode='P0002',message='consult_request_absent'; end if;
  _refusal:=clinical_private.consult_purge_refusal(_row,_window);
  -- The reason is returned rather than raised: "not yet, and here is why" is an answer a screen
  -- can show, and a refusal that looked like a failure would get retried.
  if _refusal is not null then
   return jsonb_build_object('action','purge','requestId',_row.id,'purged',false,
    'refusal',_refusal); end if;
  update clinical_core.consult_requests
   set contact_ciphertext=null,contact_iv=null,contact_tag=null,contact_digest=null,
    contact_purged_at=clock_timestamp(),revision=revision+1
   where id=_row.id;
  insert into clinical_core.consult_request_audit(organization_id,link_id,request_id,actor_id,action)
   values(_org,_row.link_id,_row.id,_actor,'contact_purged');
  return jsonb_build_object('action','purge','requestId',_row.id,'purged',true,'refusal',null);
 end if;

 -- sweep
 if _request-array['action']<>'{}'::jsonb then
  raise exception using errcode='22023',message='consult_retention_invalid'; end if;
 -- With no window set the sweep does nothing at all. It never falls back to a default, because
 -- a sweep that invented its own retention would be the policy.
 if _window is null then
  return jsonb_build_object('action','sweep','purged',0,
   'skipped','no_retention_window_is_set'); end if;
 for _row in select * from clinical_core.consult_requests r
  where r.organization_id=_org and r.contact_purged_at is null
   and r.status<>'converted' and r.connection_id is null
   and r.received_at<=clock_timestamp()-make_interval(days=>_window)
  order by r.received_at limit 500 for update
 loop
  if clinical_private.consult_purge_refusal(_row,_window) is null then
   update clinical_core.consult_requests
    set contact_ciphertext=null,contact_iv=null,contact_tag=null,contact_digest=null,
     contact_purged_at=clock_timestamp(),revision=revision+1
    where id=_row.id;
   insert into clinical_core.consult_request_audit(organization_id,link_id,request_id,actor_id,action)
    values(_org,_row.link_id,_row.id,_actor,'contact_purged');
   _purged:=_purged+1;
  end if;
 end loop;
 -- Bounded at 500 a call, so a practice with a long backlog sweeps over several calls rather
 -- than holding one transaction open across all of it.
 return jsonb_build_object('action','sweep','purged',_purged,'skipped',null);
end $$;
revoke all on function clinical_core.consult_contact_retention(jsonb) from public;
grant execute on function clinical_core.consult_contact_retention(jsonb) to clinical_core_api;
