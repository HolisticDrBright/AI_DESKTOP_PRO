-- BLOCKED source candidate: patient notifications (patient-notifications/1) — preferences, text
-- consent with the exact wording agreed to, STOP suppression, "something new is waiting" notices
-- with batching and per-channel delivery records, and the text half of appointment reminders.
-- Not in migrations/manifest.json; not applied anywhere; not registered; not to be applied until
-- docs/claude-patient-notifications-2026-10-13.md and src/server/notifications/*.ts are reviewed.
-- Notices and texts are both DISABLED by the activation row below; only a separately reviewed
-- change may enable either. No consent wording is seeded: texts cannot be agreed to until counsel
-- has approved a wording and it is recorded.
--
-- Parent assumptions (written against exactly these artifacts, each unchanged; the test refuses to
-- run if any digest has moved). It changes none of them.
--   migrations/manifest.json                                         f6cf4aa9507c3e61bed4e033dbef74e45acd4461f139abdc11f379ac48d90917
--   migrations/20260812010000_synthetic_identity_consent.sql          c4ca967352bce6c678249336ef410fe7de4216d123a0d3da06a467379780c445
--     (persons, identities, organization_memberships, patient_connections, the request claims)
--   migrations/20260821010000_governed_synthetic_lab_import.sql       ed25afdeacfec2bad9722ab1dcff50265a185207f799207c87dc55b19223bb5d
--     (lab_import_events, lab_observations: a result is visible once its import is accepted)
--   migrations/20260929090000_synthetic_care_messages.sql             779d879e6058827b46570927ac0de162f8e93d35c326cea59d0d229e4a2b01bd
--   migrations/20260929120000_synthetic_program_assignments.sql       8d6bcac8dfbe5582e7ee63d5f7ed6a5b4466760195f251d10780f08e3fb4a1d8
--   migrations/20260930140000_synthetic_intake_forms_and_signatures.sql 4cdb7042fc2fd7d83911ad024e9f9f2b07075441ea138f9f447fbfded887b64e
--
-- What it holds and refuses:
--   * A NOTICE is enqueued only for an item that is visible to the patient NOW, checked here against
--     the item's own table: a message a clinic member sent on the patient's connection; an open form
--     packet on it; a lab result whose import a clinician accepted; a program offered to the patient,
--     or a phase a practitioner released. Drafts, items under review, another clinic's items and a
--     paused or revoked connection are refused or skipped. A protocol has no synthetic table to
--     check against, so a protocol notice is refused ('notice_source_unverifiable') until the
--     production protocol path gains a successor that can prove the protocol was approved for them.
--   * Nothing about the item is stored: the kind, a SHA-256 of "kind:item id" for idempotency, who
--     made it visible and when. No title, body, value, product or dose.
--   * BATCHING: a patient's notice forms once the first waiting item has been visible for the batch
--     window, and carries every waiting kind once. Each channel gets one delivery row recording the
--     kinds it named, its state and a reason; never a body or an email address. A text's number is
--     kept only as a SHA-256 lookup key on the delivery.
--   * PREFERENCES: one per patient, exactly the patient-notifications/1 shape. Defaults are
--     reminders by email on, every kind by email on, every text off, push off (the patient app has
--     no push). A text preference can be turned on only with active text consent.
--   * TEXT CONSENT names one number and an approved wording version with its exact SHA-256, at the
--     database clock; a new number withdraws the old consent. Withdrawal turns every text preference
--     off. Consent rows are append-only except for the one-time withdrawal stamp.
--   * STOP from a number suppresses texts to that number at once, before any other check, and is
--     stored (as a SHA-256 of the number). START lifts it only when consent is on record at that
--     number; otherwise texts stay off until the patient agrees in the app AND replies START.
--     Inbound replies are idempotent on the provider's message id; no inbound body is stored.
--   * QUIET HOURS: a text delivery is never handed out outside 08:00–21:00 in the patient's own
--     time zone, and never without one. The dispatcher applies the same rule before sending.
--   * Every check is re-run when a delivery is handed out: preference, consent, number, STOP,
--     connection and the clinic's contact line. What no longer holds is skipped with its reason.
--   * The CLINIC's name and help line used in every message are recorded by its owner or admin.
--     Without them nothing is sent for that clinic.
--
-- Authority: one new NOLOGIN, NOINHERIT, non-bypass role owns every function here and reads only
-- through policies added for it. clinical_core_api may execute the consumer, workforce and clinic
-- functions; patient_notification_worker (NOLOGIN; a reviewed worker login is Codex's) may execute
-- the delivery and inbound functions. Neither gains a table privilege. No login, password, number,
-- wording or activation is created.

create role patient_notification_authority nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
create role patient_notification_worker nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
grant usage on schema clinical_core,clinical_private to patient_notification_authority;
grant usage on schema clinical_core to patient_notification_worker;
grant execute on function clinical_private.claim(text),clinical_private.actor_person_id(),clinical_private.organization_id(),
 clinical_private.is_active_member(uuid),clinical_private.has_clinical_role(uuid),clinical_private.block_update_delete() to patient_notification_authority;

/* -------------------------------------------------------------- activation (disabled) */

create table clinical_core.patient_notification_activation(
 singleton boolean primary key default true check(singleton),
 notices_enabled boolean not null default false,
 texts_enabled boolean not null default false,
 evidence_sha256 text check(evidence_sha256 is null or evidence_sha256 ~ '^[a-f0-9]{64}$'),
 reviewed_by text check(reviewed_by is null or char_length(btrim(reviewed_by)) between 1 and 200),
 reviewed_at timestamptz,
 updated_at timestamptz not null default clock_timestamp(),
 check(not (notices_enabled or texts_enabled) or (evidence_sha256 is not null and reviewed_by is not null and reviewed_at is not null))
);
insert into clinical_core.patient_notification_activation(singleton) values(true);
create trigger patient_notification_activation_no_delete before delete on clinical_core.patient_notification_activation
 for each row execute function clinical_private.block_update_delete();

/* -------------------------------------------------------------- shapes */

create function clinical_private.patient_notice_kinds() returns text[] language sql immutable set search_path='' as $$
 select array['lab_result','protocol','message','form','program_lesson']::text[]
$$;
create function clinical_private.patient_sha256(_value text) returns text language sql immutable strict set search_path='' as $$
 select encode(pg_catalog.sha256(convert_to(_value,'UTF8')),'hex')
$$;
create function clinical_private.patient_keys(_value jsonb) returns text[] language sql immutable set search_path='' as $$
 select case when jsonb_typeof(_value)='object' then (select coalesce(array_agg(k order by k collate "C"),'{}') from jsonb_object_keys(_value) k) end
$$;
/** Exactly the patient-notifications/1 preference shape; push is false until the patient app supports it. */
create function clinical_private.patient_notification_preferences_valid(_p jsonb) returns boolean language plpgsql immutable set search_path='' as $$
declare _kind text; _v jsonb;
begin
 if clinical_private.patient_keys(_p) is distinct from array['appointmentReminders','contract','notices']
  or _p->'contract' is distinct from to_jsonb('patient-notifications/1'::text) then return false; end if;
 _v:=_p->'appointmentReminders';
 if clinical_private.patient_keys(_v) is distinct from array['email','sms']
  or jsonb_typeof(_v->'email')<>'boolean' or jsonb_typeof(_v->'sms')<>'boolean' then return false; end if;
 if clinical_private.patient_keys(_p->'notices') is distinct from array['form','lab_result','message','program_lesson','protocol'] then return false; end if;
 foreach _kind in array clinical_private.patient_notice_kinds() loop
  _v:=_p->'notices'->_kind;
  if clinical_private.patient_keys(_v) is distinct from array['email','push','sms']
   or jsonb_typeof(_v->'email')<>'boolean' or jsonb_typeof(_v->'sms')<>'boolean' or _v->'push' is distinct from 'false'::jsonb then return false; end if;
 end loop;
 return true;
end $$;
create function clinical_private.patient_notification_defaults() returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('contract','patient-notifications/1','appointmentReminders',jsonb_build_object('email',true,'sms',false),
  'notices',(select jsonb_object_agg(k,jsonb_build_object('email',true,'sms',false,'push',false)) from unnest(clinical_private.patient_notice_kinds()) k))
$$;
/** Every text preference off; used when consent is withdrawn. */
create function clinical_private.patient_preferences_without_text(_p jsonb) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_set(jsonb_set(_p,'{appointmentReminders,sms}','false'::jsonb),'{notices}',
  (select jsonb_object_agg(k,jsonb_set(_p->'notices'->k,'{sms}','false'::jsonb)) from unnest(clinical_private.patient_notice_kinds()) k))
$$;
create function clinical_private.patient_preferences_use_text(_p jsonb) returns boolean language sql immutable set search_path='' as $$
 select (_p->'appointmentReminders'->>'sms')::boolean or exists(select 1 from unnest(clinical_private.patient_notice_kinds()) k where (_p->'notices'->k->>'sms')::boolean)
$$;
/** An IANA Area/Location zone (or UTC) the database knows; never an abbreviation or a POSIX offset. */
create function clinical_private.patient_time_zone_valid(_zone text) returns boolean language sql stable set search_path='' as $$
 select _zone ~ '^(UTC|[A-Z][A-Za-z_]+(/[A-Za-z0-9_+-]+){1,2})$' and exists(select 1 from pg_catalog.pg_timezone_names n where n.name=_zone)
$$;
create function clinical_private.patient_within_text_hours(_zone text,_at timestamptz) returns boolean language sql stable set search_path='' as $$
 select _zone is not null and extract(hour from (_at at time zone _zone)) between 8 and 20
$$;

/* -------------------------------------------------------------- tables */

create table clinical_core.patient_notification_clinics(
 organization_id uuid primary key references clinical_core.organizations(id),
 display_name text not null check(display_name ~ '^[A-Za-z0-9][A-Za-z0-9 .,&''()-]{0,79}$'),
 help_line text not null check(help_line ~ '^\+[1-9][0-9]{7,14}$'),
 version bigint not null default 1 check(version>0),
 recorded_by uuid not null references clinical_core.persons(id),
 updated_at timestamptz not null default clock_timestamp()
);
create table clinical_core.patient_notification_settings(
 person_id uuid primary key references clinical_core.persons(id),
 preferences jsonb not null check(clinical_private.patient_notification_preferences_valid(preferences)),
 time_zone text check(time_zone is null or char_length(time_zone) between 3 and 64),
 version bigint not null default 1 check(version>0),
 updated_at timestamptz not null default clock_timestamp()
);
create table clinical_core.patient_text_consent_wordings(
 version text primary key check(version ~ '^text-consent/[1-9][0-9]{0,3}$'),
 body text not null check(char_length(body) between 20 and 2000),
 sha256 text not null check(sha256=clinical_private.patient_sha256(body)),
 approved_by text not null check(char_length(btrim(approved_by)) between 1 and 200),
 approved_at timestamptz not null,
 recorded_at timestamptz not null default clock_timestamp()
);
create table clinical_core.patient_text_consents(
 id uuid primary key default gen_random_uuid(),
 person_id uuid not null references clinical_core.persons(id),
 phone text not null check(phone ~ '^\+[1-9][0-9]{7,14}$'),
 phone_sha256 text not null check(phone_sha256=clinical_private.patient_sha256(phone)),
 wording_version text not null references clinical_core.patient_text_consent_wordings(version),
 wording_sha256 text not null check(wording_sha256 ~ '^[a-f0-9]{64}$'),
 source text not null check(source='patient_app'),
 agreed_at timestamptz not null default clock_timestamp(),
 withdrawn_at timestamptz,
 withdrawn_by text check(withdrawn_by in('patient','number_changed')),
 check((withdrawn_at is null)=(withdrawn_by is null))
);
create unique index patient_text_consents_active on clinical_core.patient_text_consents(person_id) where withdrawn_at is null;
create index patient_text_consents_phone on clinical_core.patient_text_consents(phone_sha256) where withdrawn_at is null;
create table clinical_core.patient_text_inbound(
 inbound_ref_sha256 text primary key check(inbound_ref_sha256 ~ '^[a-f0-9]{64}$'),
 phone_sha256 text not null check(phone_sha256 ~ '^[a-f0-9]{64}$'),
 classification text not null check(classification in('stop','help','start','other')),
 outcome text not null check(outcome ~ '^[a-z_]{1,48}$'),
 received_at timestamptz not null default clock_timestamp()
);
create table clinical_core.patient_text_stops(
 id uuid primary key default gen_random_uuid(),
 phone_sha256 text not null check(phone_sha256 ~ '^[a-f0-9]{64}$'),
 stop_ref_sha256 text not null unique references clinical_core.patient_text_inbound(inbound_ref_sha256),
 stopped_at timestamptz not null default clock_timestamp(),
 lifted_at timestamptz,
 lifted_by_ref_sha256 text unique references clinical_core.patient_text_inbound(inbound_ref_sha256),
 check((lifted_at is null)=(lifted_by_ref_sha256 is null))
);
create unique index patient_text_stops_active on clinical_core.patient_text_stops(phone_sha256) where lifted_at is null;
create table clinical_core.patient_notices(
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references clinical_core.organizations(id),
 person_id uuid not null references clinical_core.persons(id),
 kinds text[] not null check(cardinality(kinds) between 1 and 5 and kinds <@ clinical_private.patient_notice_kinds()),
 template_version text not null check(template_version='patient-notice-wording/1'),
 first_visible_at timestamptz not null,
 formed_at timestamptz not null default clock_timestamp()
);
create table clinical_core.patient_notice_events(
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references clinical_core.organizations(id),
 person_id uuid not null references clinical_core.persons(id),
 connection_id uuid not null references clinical_core.patient_connections(id),
 kind text not null check(kind=any(clinical_private.patient_notice_kinds())),
 item_ref_sha256 text not null check(item_ref_sha256 ~ '^[a-f0-9]{64}$'),
 recorded_by uuid not null references clinical_core.persons(id),
 visible_at timestamptz not null default clock_timestamp(),
 notice_id uuid references clinical_core.patient_notices(id),
 unique(organization_id,kind,item_ref_sha256)
);
create index patient_notice_events_waiting on clinical_core.patient_notice_events(person_id,visible_at) where notice_id is null;
create table clinical_core.patient_notice_deliveries(
 id uuid primary key default gen_random_uuid(),
 notice_id uuid not null references clinical_core.patient_notices(id),
 channel text not null check(channel in('email','sms')),
 kinds text[] not null check(cardinality(kinds) between 1 and 5 and kinds <@ clinical_private.patient_notice_kinds()),
 state text not null default 'queued' check(state in('queued','sending','sent','skipped','failed')),
 not_before timestamptz not null default clock_timestamp(),
 lease_until timestamptz,
 attempts integer not null default 0 check(attempts between 0 and 3),
 phone_sha256 text check(phone_sha256 is null or phone_sha256 ~ '^[a-f0-9]{64}$'),
 provider_ref_sha256 text check(provider_ref_sha256 is null or provider_ref_sha256 ~ '^[a-f0-9]{64}$'),
 reason text check(reason is null or reason ~ '^[a-z_]{1,48}$'),
 updated_at timestamptz not null default clock_timestamp(),
 unique(notice_id,channel),
 check((channel='sms')=(phone_sha256 is not null)),
 check(state<>'sent' or provider_ref_sha256 is not null)
);
create index patient_notice_deliveries_due on clinical_core.patient_notice_deliveries(not_before) where state in('queued','sending');
create table clinical_core.patient_reminder_texts(
 reminder_ref_sha256 text primary key check(reminder_ref_sha256 ~ '^[a-f0-9]{64}$'),
 organization_id uuid not null references clinical_core.organizations(id),
 person_id uuid not null references clinical_core.persons(id),
 phone_sha256 text not null check(phone_sha256 ~ '^[a-f0-9]{64}$'),
 state text not null default 'sending' check(state in('sending','sent','skipped','failed')),
 reason text check(reason is null or reason ~ '^[a-z_]{1,48}$'),
 provider_ref_sha256 text check(provider_ref_sha256 is null or provider_ref_sha256 ~ '^[a-f0-9]{64}$'),
 claimed_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(),
 check(state<>'sent' or provider_ref_sha256 is not null)
);

/* Append-only, except the one-time stamps named. */
create function clinical_private.patient_consent_withdraw_only() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='DELETE' or old.withdrawn_at is not null or new.withdrawn_at is null
  or (to_jsonb(new)-'withdrawn_at'-'withdrawn_by') is distinct from (to_jsonb(old)-'withdrawn_at'-'withdrawn_by') then
  raise exception using errcode='55000',message='append_only_record';
 end if;
 return new;
end $$;
create function clinical_private.patient_stop_lift_only() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='DELETE' or old.lifted_at is not null or new.lifted_at is null
  or (to_jsonb(new)-'lifted_at'-'lifted_by_ref_sha256') is distinct from (to_jsonb(old)-'lifted_at'-'lifted_by_ref_sha256') then
  raise exception using errcode='55000',message='append_only_record';
 end if;
 return new;
end $$;
create function clinical_private.patient_event_batch_only() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='DELETE' or old.notice_id is not null or new.notice_id is null
  or (to_jsonb(new)-'notice_id') is distinct from (to_jsonb(old)-'notice_id') then
  raise exception using errcode='55000',message='append_only_record';
 end if;
 return new;
end $$;
create trigger patient_text_consents_withdraw_only before update or delete on clinical_core.patient_text_consents
 for each row execute function clinical_private.patient_consent_withdraw_only();
create trigger patient_text_stops_lift_only before update or delete on clinical_core.patient_text_stops
 for each row execute function clinical_private.patient_stop_lift_only();
create trigger patient_notice_events_batch_only before update or delete on clinical_core.patient_notice_events
 for each row execute function clinical_private.patient_event_batch_only();
create trigger patient_text_consent_wordings_append_only before update or delete on clinical_core.patient_text_consent_wordings
 for each row execute function clinical_private.block_update_delete();
create trigger patient_text_inbound_append_only before update or delete on clinical_core.patient_text_inbound
 for each row execute function clinical_private.block_update_delete();
create trigger patient_notices_append_only before update or delete on clinical_core.patient_notices
 for each row execute function clinical_private.block_update_delete();
create trigger patient_notice_deliveries_no_delete before delete on clinical_core.patient_notice_deliveries
 for each row execute function clinical_private.block_update_delete();
create trigger patient_reminder_texts_no_delete before delete on clinical_core.patient_reminder_texts
 for each row execute function clinical_private.block_update_delete();
create trigger patient_notification_settings_no_delete before delete on clinical_core.patient_notification_settings
 for each row execute function clinical_private.block_update_delete();
create trigger patient_notification_clinics_no_delete before delete on clinical_core.patient_notification_clinics
 for each row execute function clinical_private.block_update_delete();

/* -------------------------------------------------------------- shared reads (authority only) */

create function clinical_private.patient_text_stopped(_phone_sha256 text) returns boolean language sql stable set search_path='' as $$
 select exists(select 1 from clinical_core.patient_text_stops s where s.phone_sha256=_phone_sha256 and s.lifted_at is null)
$$;
create function clinical_private.patient_preferences_of(_person uuid) returns jsonb language sql stable set search_path='' as $$
 select coalesce((select s.preferences from clinical_core.patient_notification_settings s where s.person_id=_person),clinical_private.patient_notification_defaults())
$$;
create function clinical_private.patient_active_consent(_person uuid) returns clinical_core.patient_text_consents language sql stable set search_path='' as $$
 select c from clinical_core.patient_text_consents c where c.person_id=_person and c.withdrawn_at is null
$$;
/** The consumer making this request, from the verified claims; any other caller is refused. */
create function clinical_private.patient_notification_consumer() returns uuid language plpgsql stable set search_path='' as $$
declare _person uuid:=clinical_private.actor_person_id();
begin
 if _person is null or clinical_private.claim('identity_pool') is distinct from 'consumer'
  or clinical_private.claim('purpose') is distinct from 'clinical_data'
  or clinical_private.claim('environment') is distinct from 'synthetic-staging'
  or clinical_private.claim('data_classification') is distinct from 'synthetic_only'
  or not exists(select 1 from clinical_core.persons p join clinical_core.identities i on i.person_id=p.id
   where p.id=_person and p.status='active' and i.identity_pool='consumer' and i.status='active') then
  raise exception using errcode='42501',message='notification_identity_refused';
 end if;
 return _person;
end $$;
create function clinical_private.patient_notification_view(_person uuid) returns jsonb language plpgsql stable set search_path='' as $$
declare _s clinical_core.patient_notification_settings; _c clinical_core.patient_text_consents;
begin
 select * into _s from clinical_core.patient_notification_settings s where s.person_id=_person;
 _c:=clinical_private.patient_active_consent(_person);
 return jsonb_build_object('contract','patient-notifications/1',
  'preferences',coalesce(_s.preferences,clinical_private.patient_notification_defaults()),
  'timeZone',_s.time_zone,'version',coalesce(_s.version,0),
  'textConsent',case when _c.id is null then null else jsonb_build_object('phone',_c.phone,'wordingVersion',_c.wording_version,
    'wordingSha256',_c.wording_sha256,'agreedAt',to_char(_c.agreed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'source',_c.source) end,
  'textStopped',case when _c.id is null then false else clinical_private.patient_text_stopped(_c.phone_sha256) end,
  'pushAvailable',false);
end $$;

/* -------------------------------------------------------------- the patient's own settings */

create function clinical_core.my_patient_notification_settings() returns jsonb language plpgsql security definer set search_path='' as $$
begin return clinical_private.patient_notification_view(clinical_private.patient_notification_consumer()); end $$;

create function clinical_core.current_text_consent_wording() returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform clinical_private.patient_notification_consumer();
 return (select jsonb_build_object('version',w.version,'body',w.body,'sha256',w.sha256) from clinical_core.patient_text_consent_wordings w
  order by (substring(w.version from '[0-9]+$'))::int desc limit 1);
end $$;

create function clinical_core.set_my_patient_notification_settings(_preferences jsonb,_time_zone text,_expected_version bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _person uuid:=clinical_private.patient_notification_consumer(); _current bigint;
begin
 if not clinical_private.patient_notification_preferences_valid(_preferences) then
  raise exception using errcode='22023',message='notification_preferences_invalid';
 end if;
 if _time_zone is not null and not clinical_private.patient_time_zone_valid(_time_zone) then
  raise exception using errcode='22023',message='time_zone_invalid';
 end if;
 if clinical_private.patient_preferences_use_text(_preferences) and (clinical_private.patient_active_consent(_person)).id is null then
  raise exception using errcode='42501',message='text_consent_required';
 end if;
 select s.version into _current from clinical_core.patient_notification_settings s where s.person_id=_person for update;
 if coalesce(_current,0)<>_expected_version then raise exception using errcode='40001',message='notification_settings_conflict'; end if;
 insert into clinical_core.patient_notification_settings(person_id,preferences,time_zone) values(_person,_preferences,_time_zone)
 on conflict (person_id) do update set preferences=excluded.preferences,time_zone=excluded.time_zone,
  version=clinical_core.patient_notification_settings.version+1,updated_at=clock_timestamp();
 return clinical_private.patient_notification_view(_person);
end $$;

create function clinical_core.record_my_text_consent(_phone text,_wording_version text,_wording_sha256 text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _person uuid:=clinical_private.patient_notification_consumer(); _active clinical_core.patient_text_consents;
begin
 if _phone !~ '^\+[1-9][0-9]{7,14}$' then raise exception using errcode='22023',message='text_phone_invalid'; end if;
 if not exists(select 1 from clinical_core.patient_text_consent_wordings w where w.version=_wording_version and w.sha256=_wording_sha256) then
  raise exception using errcode='22023',message='text_consent_wording_unknown';
 end if;
 select * into _active from clinical_core.patient_text_consents c where c.person_id=_person and c.withdrawn_at is null for update;
 if _active.id is not null and _active.phone=_phone and _active.wording_version=_wording_version then
  return clinical_private.patient_notification_view(_person);
 end if;
 if _active.id is not null then
  update clinical_core.patient_text_consents set withdrawn_at=clock_timestamp(),withdrawn_by='number_changed' where id=_active.id;
 end if;
 insert into clinical_core.patient_text_consents(person_id,phone,phone_sha256,wording_version,wording_sha256,source)
  values(_person,_phone,clinical_private.patient_sha256(_phone),_wording_version,_wording_sha256,'patient_app');
 return clinical_private.patient_notification_view(_person);
end $$;

create function clinical_core.withdraw_my_text_consent() returns jsonb language plpgsql security definer set search_path='' as $$
declare _person uuid:=clinical_private.patient_notification_consumer();
begin
 update clinical_core.patient_text_consents set withdrawn_at=clock_timestamp(),withdrawn_by='patient' where person_id=_person and withdrawn_at is null;
 update clinical_core.patient_notification_settings set preferences=clinical_private.patient_preferences_without_text(preferences),
  version=version+1,updated_at=clock_timestamp() where person_id=_person and clinical_private.patient_preferences_use_text(preferences);
 return clinical_private.patient_notification_view(_person);
end $$;

/* -------------------------------------------------------------- the clinic's name and help line */

create function clinical_core.set_clinic_notification_contact(_display_name text,_help_line text,_expected_version bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _org uuid:=clinical_private.organization_id(); _actor uuid:=clinical_private.actor_person_id(); _current bigint;
begin
 if _org is null or _actor is null or clinical_private.claim('identity_pool') is distinct from 'workforce'
  or clinical_private.claim('purpose') is distinct from 'clinical_data'
  or clinical_private.claim('environment') is distinct from 'synthetic-staging'
  or not exists(select 1 from clinical_core.organization_memberships m where m.organization_id=_org and m.person_id=_actor
   and m.status='active' and m.role in('owner','admin')) then
  raise exception using errcode='42501',message='clinic_contact_refused';
 end if;
 select c.version into _current from clinical_core.patient_notification_clinics c where c.organization_id=_org for update;
 if coalesce(_current,0)<>_expected_version then raise exception using errcode='40001',message='clinic_contact_conflict'; end if;
 insert into clinical_core.patient_notification_clinics(organization_id,display_name,help_line,recorded_by) values(_org,_display_name,_help_line,_actor)
 on conflict (organization_id) do update set display_name=excluded.display_name,help_line=excluded.help_line,recorded_by=excluded.recorded_by,
  version=clinical_core.patient_notification_clinics.version+1,updated_at=clock_timestamp();
 return (select jsonb_build_object('displayName',c.display_name,'helpLine',c.help_line,'version',c.version) from clinical_core.patient_notification_clinics c where c.organization_id=_org);
end $$;

/* -------------------------------------------------------------- an item became visible */

/**
 * Called by the server after the clinical action has COMMITTED, in the same verified workforce
 * request context, so a refused or failed enqueue can never roll back the action. The item is
 * re-proven visible here from its own table. Subjects:
 *   message        {"connectionId","messageId"}  a message a clinic member sent on that connection
 *   form           {"connectionId","packetId"}   an open form packet on that connection
 *   lab_result     {"observationId"}             an observation whose import was accepted
 *   program_lesson {"enrollmentId"}              a program offered or active on the connection
 *                  {"enrollmentId","phaseId"}    a phase a practitioner released
 *   protocol       refused: no synthetic source can prove approval for this patient
 */
create function clinical_core.enqueue_patient_notice(_kind text,_subject jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 _org uuid:=clinical_private.organization_id(); _actor uuid:=clinical_private.actor_person_id();
 _connection uuid; _item text; _c clinical_core.patient_connections; _inserted integer;
begin
 if _org is null or _actor is null or clinical_private.claim('identity_pool') is distinct from 'workforce'
  or clinical_private.claim('purpose') is distinct from 'clinical_data'
  or clinical_private.claim('environment') is distinct from 'synthetic-staging'
  or clinical_private.claim('data_classification') is distinct from 'synthetic_only'
  or not clinical_private.is_active_member(_org) then
  raise exception using errcode='42501',message='notice_identity_refused';
 end if;
 if _kind is null or not (_kind=any(clinical_private.patient_notice_kinds())) or jsonb_typeof(_subject)<>'object' then
  raise exception using errcode='22023',message='notice_request_invalid';
 end if;
 begin
  if _kind='message' and clinical_private.patient_keys(_subject)=array['connectionId','messageId'] then
   select t.connection_id,m.id::text into _connection,_item from clinical_core.care_messages m join clinical_core.care_message_threads t on t.id=m.thread_id
    where m.id=(_subject->>'messageId')::uuid and t.connection_id=(_subject->>'connectionId')::uuid and m.sender_pool='workforce';
  elsif _kind='form' and clinical_private.patient_keys(_subject)=array['connectionId','packetId'] then
   select p.connection_id,p.id::text into _connection,_item from clinical_core.intake_packets p
    where p.id=(_subject->>'packetId')::uuid and p.connection_id=(_subject->>'connectionId')::uuid and p.organization_id=_org and p.status='open';
  elsif _kind='lab_result' and clinical_private.patient_keys(_subject)=array['observationId'] then
   select e.connection_id,o.id::text into _connection,_item from clinical_core.lab_observations o join clinical_core.lab_import_events e on e.id=o.import_event_id
    where o.id=(_subject->>'observationId')::uuid and o.organization_id=_org and e.state='accepted' and o.review_status<>'rejected';
  elsif _kind='program_lesson' and clinical_private.patient_keys(_subject)=array['enrollmentId'] then
   select a.connection_id,a.id::text into _connection,_item from clinical_core.program_assignments a
    where a.id=(_subject->>'enrollmentId')::uuid and a.organization_id=_org and a.state in('offered','active');
  elsif _kind='program_lesson' and clinical_private.patient_keys(_subject)=array['enrollmentId','phaseId'] then
   select a.connection_id,a.id::text||':'||r.phase_id into _connection,_item from clinical_core.program_assignments a
    join clinical_core.program_phase_authorizations r on r.assignment_id=a.id and r.kind='practitioner_release' and r.phase_id=_subject->>'phaseId'
    where a.id=(_subject->>'enrollmentId')::uuid and a.organization_id=_org and a.state='active';
  elsif _kind='protocol' then
   raise exception using errcode='0A000',message='notice_source_unverifiable';
  else
   raise exception using errcode='22023',message='notice_request_invalid';
  end if;
 exception when invalid_text_representation then raise exception using errcode='22023',message='notice_request_invalid';
 end;
 select * into _c from clinical_core.patient_connections c where c.id=_connection and c.organization_id=_org;
 if _c.id is null or _item is null then raise exception using errcode='42501',message='notice_item_not_visible'; end if;
 if _c.state<>'verified' or _c.consumer_person_id is null then return jsonb_build_object('queued',false,'reason','connection_not_verified'); end if;
 if not (select a.notices_enabled from clinical_core.patient_notification_activation a) then
  return jsonb_build_object('queued',false,'reason','notices_disabled');
 end if;
 insert into clinical_core.patient_notice_events(organization_id,person_id,connection_id,kind,item_ref_sha256,recorded_by)
  values(_org,_c.consumer_person_id,_c.id,_kind,clinical_private.patient_sha256(_kind||':'||_item),_actor)
  on conflict (organization_id,kind,item_ref_sha256) do nothing;
 get diagnostics _inserted=row_count;
 return jsonb_build_object('queued',true,'duplicate',_inserted=0);
end $$;

/* -------------------------------------------------------------- the worker: batch, hand out, record */

create function clinical_private.patient_live_connection(_org uuid,_person uuid) returns boolean language sql stable set search_path='' as $$
 select exists(select 1 from clinical_core.patient_connections c where c.organization_id=_org and c.consumer_person_id=_person and c.state='verified')
$$;

/** Forms one notice per patient whose first waiting item has been visible for the window; every waiting kind once. */
create function clinical_core.form_patient_notices(_window_seconds integer,_limit integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare _g record; _notice uuid; _prefs jsonb; _email text[]; _sms text[]; _consent clinical_core.patient_text_consents; _formed integer:=0;
 _act clinical_core.patient_notification_activation;
begin
 if _window_seconds is null or _window_seconds not between 60 and 3600 or _limit is null or _limit not between 1 and 500 then
  raise exception using errcode='22023',message='notice_batch_invalid';
 end if;
 select * into _act from clinical_core.patient_notification_activation;
 if not _act.notices_enabled then return jsonb_build_object('formed',0,'reason','notices_disabled'); end if;
 for _g in
  select e.organization_id,e.person_id,min(e.visible_at) first_visible,
   array(select k from unnest(clinical_private.patient_notice_kinds()) with ordinality u(k,n) where k=any(array_agg(e.kind)) order by n) kinds,
   array_agg(e.id) events
  from clinical_core.patient_notice_events e where e.notice_id is null
  group by e.organization_id,e.person_id
  having min(e.visible_at)<=clock_timestamp()-make_interval(secs=>_window_seconds)
  order by min(e.visible_at) limit _limit
 loop
  perform 1 from clinical_core.patient_notice_events e where e.id=any(_g.events) and e.notice_id is null for update skip locked;
  insert into clinical_core.patient_notices(organization_id,person_id,kinds,template_version,first_visible_at)
   values(_g.organization_id,_g.person_id,_g.kinds,'patient-notice-wording/1',_g.first_visible) returning id into _notice;
  update clinical_core.patient_notice_events set notice_id=_notice where id=any(_g.events) and notice_id is null;
  _prefs:=clinical_private.patient_preferences_of(_g.person_id);
  _email:=array(select k from unnest(_g.kinds) k where (_prefs->'notices'->k->>'email')::boolean);
  _sms:=array(select k from unnest(_g.kinds) k where (_prefs->'notices'->k->>'sms')::boolean);
  if cardinality(_email)>0 then
   insert into clinical_core.patient_notice_deliveries(notice_id,channel,kinds) values(_notice,'email',_email);
  end if;
  _consent:=clinical_private.patient_active_consent(_g.person_id);
  if cardinality(_sms)>0 and _act.texts_enabled and _consent.id is not null and not clinical_private.patient_text_stopped(_consent.phone_sha256) then
   insert into clinical_core.patient_notice_deliveries(notice_id,channel,kinds,phone_sha256) values(_notice,'sms',_sms,_consent.phone_sha256);
  end if;
  _formed:=_formed+1;
 end loop;
 return jsonb_build_object('formed',_formed);
end $$;

create function clinical_private.patient_skip_delivery(_id uuid,_reason text) returns void language sql set search_path='' as $$
 update clinical_core.patient_notice_deliveries set state='skipped',reason=_reason,lease_until=null,updated_at=clock_timestamp() where id=_id
$$;

/**
 * Hands out due deliveries with a short lease, after re-running every check against the current
 * state. What no longer holds is skipped with its reason; a text outside the patient's hours stays
 * queued and is not handed out. A delivery handed out three times without a recorded outcome fails.
 */
create function clinical_core.due_patient_notice_deliveries(_limit integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare _d record; _prefs jsonb; _kinds text[]; _clinic clinical_core.patient_notification_clinics; _consent clinical_core.patient_text_consents;
 _zone text; _subject text; _out jsonb:='[]'::jsonb; _act clinical_core.patient_notification_activation;
begin
 if _limit is null or _limit not between 1 and 100 then raise exception using errcode='22023',message='notice_batch_invalid'; end if;
 select * into _act from clinical_core.patient_notification_activation;
 if not _act.notices_enabled then return _out; end if;
 for _d in
  select d.*,n.organization_id,n.person_id from clinical_core.patient_notice_deliveries d join clinical_core.patient_notices n on n.id=d.notice_id
  where (d.state='queued' and d.not_before<=clock_timestamp()) or (d.state='sending' and d.lease_until<clock_timestamp())
  order by d.not_before for update of d skip locked
 loop
  exit when jsonb_array_length(_out)>=_limit;
  if _d.attempts>=3 then
   update clinical_core.patient_notice_deliveries set state='failed',reason='attempts_exhausted',lease_until=null,updated_at=clock_timestamp() where id=_d.id;
   continue;
  end if;
  if not clinical_private.patient_live_connection(_d.organization_id,_d.person_id) then perform clinical_private.patient_skip_delivery(_d.id,'connection_not_verified'); continue; end if;
  select * into _clinic from clinical_core.patient_notification_clinics c where c.organization_id=_d.organization_id;
  if _clinic.organization_id is null then perform clinical_private.patient_skip_delivery(_d.id,'clinic_contact_missing'); continue; end if;
  _prefs:=clinical_private.patient_preferences_of(_d.person_id);
  _kinds:=array(select k from unnest(_d.kinds) k where (_prefs->'notices'->k->>_d.channel)::boolean);
  if cardinality(_kinds)=0 then perform clinical_private.patient_skip_delivery(_d.id,'preference_off'); continue; end if;
  _zone:=(select s.time_zone from clinical_core.patient_notification_settings s where s.person_id=_d.person_id);
  if _d.channel='sms' then
   _consent:=clinical_private.patient_active_consent(_d.person_id);
   if not _act.texts_enabled then perform clinical_private.patient_skip_delivery(_d.id,'texts_disabled'); continue; end if;
   if clinical_private.patient_text_stopped(_d.phone_sha256) then perform clinical_private.patient_skip_delivery(_d.id,'text_stopped'); continue; end if;
   if _consent.id is null or _consent.phone_sha256<>_d.phone_sha256 then perform clinical_private.patient_skip_delivery(_d.id,'consent_inactive'); continue; end if;
   if _zone is null then perform clinical_private.patient_skip_delivery(_d.id,'time_zone_missing'); continue; end if;
   if not clinical_private.patient_within_text_hours(_zone,clock_timestamp()) then continue; end if;
  end if;
  select i.identity_subject into _subject from clinical_core.identities i where i.person_id=_d.person_id and i.identity_pool='consumer' and i.status='active';
  if _subject is null then perform clinical_private.patient_skip_delivery(_d.id,'consumer_identity_missing'); continue; end if;
  update clinical_core.patient_notice_deliveries set state='sending',kinds=_kinds,attempts=attempts+1,lease_until=clock_timestamp()+interval '2 minutes',
   reason=null,updated_at=clock_timestamp() where id=_d.id;
  _out:=_out||jsonb_build_array(jsonb_build_object('deliveryId',_d.id,'channel',_d.channel,'kinds',to_jsonb(_kinds),'attempt',_d.attempts+1,
   'clinicName',_clinic.display_name,'consumerSubject',_subject,'timeZone',_zone,
   'phone',case when _d.channel='sms' then _consent.phone end));
 end loop;
 return _out;
end $$;

/** Records what happened to a handed-out delivery. 'deferred' and 'retry' put it back in the queue. */
create function clinical_core.record_patient_notice_delivery(_delivery_id uuid,_outcome text,_reason text,_not_before timestamptz,_provider_ref text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _d clinical_core.patient_notice_deliveries;
begin
 select * into _d from clinical_core.patient_notice_deliveries where id=_delivery_id for update;
 if _d.id is null or _d.state<>'sending' then raise exception using errcode='55000',message='notice_delivery_not_sending'; end if;
 if _outcome='sent' and _provider_ref ~ '^[A-Za-z0-9._:/+=-]{1,200}$' then
  update clinical_core.patient_notice_deliveries set state='sent',provider_ref_sha256=clinical_private.patient_sha256(_provider_ref),reason=null,lease_until=null,updated_at=clock_timestamp() where id=_d.id;
 elsif _outcome in('skipped','failed') and _reason ~ '^[a-z_]{1,48}$' then
  update clinical_core.patient_notice_deliveries set state=_outcome,reason=_reason,lease_until=null,updated_at=clock_timestamp() where id=_d.id;
 elsif _outcome='deferred' and _reason ~ '^[a-z_]{1,48}$' and _not_before>clock_timestamp() and _not_before<=clock_timestamp()+interval '2 days' then
  update clinical_core.patient_notice_deliveries set state='queued',attempts=greatest(attempts-1,0),not_before=_not_before,reason=_reason,lease_until=null,updated_at=clock_timestamp() where id=_d.id;
 elsif _outcome='retry' and _reason ~ '^[a-z_]{1,48}$' then
  update clinical_core.patient_notice_deliveries set state='queued',not_before=clock_timestamp()+interval '5 minutes',reason=_reason,lease_until=null,updated_at=clock_timestamp() where id=_d.id;
 else raise exception using errcode='22023',message='notice_delivery_outcome_invalid';
 end if;
 return (select jsonb_build_object('deliveryId',d.id,'state',d.state,'reason',d.reason) from clinical_core.patient_notice_deliveries d where d.id=_d.id);
end $$;

/* -------------------------------------------------------------- inbound replies */

/**
 * One reply to a text, classified by the caller as stop/help/start/other (no body is passed or
 * kept). Idempotent on the provider's inbound message id. STOP suppresses the number first; HELP
 * answers with the clinic of the number's active consent, if exactly one; START lifts a STOP only
 * where consent is on record at that number.
 */
create function clinical_core.record_inbound_text(_phone text,_classification text,_inbound_ref text) returns jsonb language plpgsql security definer set search_path='' as $$
declare _phone_sha text; _ref_sha text; _prior clinical_core.patient_text_inbound; _outcome text; _clinic jsonb; _persons uuid[];
begin
 if _phone !~ '^\+[1-9][0-9]{7,14}$' or _classification not in('stop','help','start','other') or _inbound_ref !~ '^[A-Za-z0-9._:/+=-]{8,200}$' then
  raise exception using errcode='22023',message='inbound_text_invalid';
 end if;
 _phone_sha:=clinical_private.patient_sha256(_phone); _ref_sha:=clinical_private.patient_sha256(_inbound_ref);
 select * into _prior from clinical_core.patient_text_inbound i where i.inbound_ref_sha256=_ref_sha;
 if _prior.inbound_ref_sha256 is not null then
  if _prior.phone_sha256<>_phone_sha or _prior.classification<>_classification then raise exception using errcode='22023',message='inbound_text_reused'; end if;
  return jsonb_build_object('outcome',_prior.outcome,'duplicate',true,'clinic',null);
 end if;
 _persons:=array(select c.person_id from clinical_core.patient_text_consents c where c.phone_sha256=_phone_sha and c.withdrawn_at is null);
 if cardinality(_persons)=1 then
  _clinic:=(select jsonb_build_object('displayName',k.display_name,'helpLine',k.help_line) from clinical_core.patient_connections c
   join clinical_core.patient_notification_clinics k on k.organization_id=c.organization_id
   where c.consumer_person_id=_persons[1] and c.state in('verified','paused') limit 1);
 end if;
 _outcome:=case _classification
  when 'stop' then case when clinical_private.patient_text_stopped(_phone_sha) then 'already_stopped' else 'stopped' end
  when 'help' then case when _clinic is null then 'help_platform' else 'help_clinic' end
  when 'start' then case when not clinical_private.patient_text_stopped(_phone_sha) then 'not_stopped'
   when cardinality(_persons)>0 then 'resumed' else 'consent_required' end
  else 'ignored' end;
 insert into clinical_core.patient_text_inbound(inbound_ref_sha256,phone_sha256,classification,outcome) values(_ref_sha,_phone_sha,_classification,_outcome);
 if _outcome='stopped' then
  insert into clinical_core.patient_text_stops(phone_sha256,stop_ref_sha256) values(_phone_sha,_ref_sha);
  update clinical_core.patient_notice_deliveries set state='skipped',reason='text_stopped',lease_until=null,updated_at=clock_timestamp()
   where channel='sms' and phone_sha256=_phone_sha and state='queued';
 elsif _outcome='resumed' then
  update clinical_core.patient_text_stops set lifted_at=clock_timestamp(),lifted_by_ref_sha256=_ref_sha where phone_sha256=_phone_sha and lifted_at is null;
 end if;
 return jsonb_build_object('outcome',_outcome,'duplicate',false,'clinic',case when _classification='help' then _clinic end);
end $$;

/* -------------------------------------------------------------- text appointment reminders */

/**
 * What the reminder sender may do for this patient of this clinic: email reminders unless the
 * patient turned them off, and a text only with texts enabled, the text preference on, active
 * consent, no STOP, a time zone, a verified connection to this clinic and the clinic's contact.
 */
create function clinical_core.patient_reminder_channels(_organization_id uuid,_person_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare _prefs jsonb:=clinical_private.patient_preferences_of(_person_id); _consent clinical_core.patient_text_consents; _zone text; _clinic clinical_core.patient_notification_clinics; _reason text;
begin
 if _organization_id is null or _person_id is null then raise exception using errcode='22023',message='reminder_request_invalid'; end if;
 _consent:=clinical_private.patient_active_consent(_person_id);
 _zone:=(select s.time_zone from clinical_core.patient_notification_settings s where s.person_id=_person_id);
 select * into _clinic from clinical_core.patient_notification_clinics c where c.organization_id=_organization_id;
 _reason:=case
  when not (select a.texts_enabled from clinical_core.patient_notification_activation a) then 'texts_disabled'
  when not (_prefs->'appointmentReminders'->>'sms')::boolean then 'preference_off'
  when _consent.id is null then 'consent_inactive'
  when clinical_private.patient_text_stopped(_consent.phone_sha256) then 'text_stopped'
  when _zone is null then 'time_zone_missing'
  when not clinical_private.patient_live_connection(_organization_id,_person_id) then 'connection_not_verified'
  when _clinic.organization_id is null then 'clinic_contact_missing' end;
 return jsonb_build_object('email',(_prefs->'appointmentReminders'->>'email')::boolean,
  'text',case when _reason is null then jsonb_build_object('phone',_consent.phone,'timeZone',_zone,'clinicName',_clinic.display_name) end,
  'textReason',_reason);
end $$;

/** Claims one reminder text (request, generation and offset) before sending, so a retried schedule never texts twice. */
create function clinical_core.claim_patient_reminder_text(_reminder_ref text,_organization_id uuid,_person_id uuid,_phone text) returns jsonb language plpgsql security definer set search_path='' as $$
declare _inserted integer;
begin
 if _reminder_ref !~ '^appointment-reminder/2:[0-9a-f-]{36}:[0-9a-f-]{36}:(24h|1h)$' or _phone !~ '^\+[1-9][0-9]{7,14}$' or _organization_id is null or _person_id is null then
  raise exception using errcode='22023',message='reminder_request_invalid';
 end if;
 insert into clinical_core.patient_reminder_texts(reminder_ref_sha256,organization_id,person_id,phone_sha256)
  values(clinical_private.patient_sha256(_reminder_ref),_organization_id,_person_id,clinical_private.patient_sha256(_phone)) on conflict do nothing;
 get diagnostics _inserted=row_count;
 return jsonb_build_object('claimed',_inserted=1);
end $$;
create function clinical_core.settle_patient_reminder_text(_reminder_ref text,_outcome text,_reason text,_provider_ref text) returns jsonb language plpgsql security definer set search_path='' as $$
declare _row clinical_core.patient_reminder_texts;
begin
 select * into _row from clinical_core.patient_reminder_texts where reminder_ref_sha256=clinical_private.patient_sha256(_reminder_ref) for update;
 if _row.reminder_ref_sha256 is null or _row.state<>'sending' then raise exception using errcode='55000',message='reminder_text_not_sending'; end if;
 if _outcome='sent' and _provider_ref ~ '^[A-Za-z0-9._:/+=-]{1,200}$' then
  update clinical_core.patient_reminder_texts set state='sent',provider_ref_sha256=clinical_private.patient_sha256(_provider_ref),updated_at=clock_timestamp() where reminder_ref_sha256=_row.reminder_ref_sha256;
 elsif _outcome in('skipped','failed') and _reason ~ '^[a-z_]{1,48}$' then
  update clinical_core.patient_reminder_texts set state=_outcome,reason=_reason,updated_at=clock_timestamp() where reminder_ref_sha256=_row.reminder_ref_sha256;
 else raise exception using errcode='22023',message='reminder_text_outcome_invalid';
 end if;
 return jsonb_build_object('state',_outcome);
end $$;

/* -------------------------------------------------------------- authority reads and ownership */

alter table clinical_core.patient_notification_activation enable row level security;
alter table clinical_core.patient_notification_clinics enable row level security;
alter table clinical_core.patient_notification_settings enable row level security;
alter table clinical_core.patient_text_consent_wordings enable row level security;
alter table clinical_core.patient_text_consents enable row level security;
alter table clinical_core.patient_text_inbound enable row level security;
alter table clinical_core.patient_text_stops enable row level security;
alter table clinical_core.patient_notices enable row level security;
alter table clinical_core.patient_notice_events enable row level security;
alter table clinical_core.patient_notice_deliveries enable row level security;
alter table clinical_core.patient_reminder_texts enable row level security;
revoke all on clinical_core.patient_notification_activation,clinical_core.patient_notification_clinics,clinical_core.patient_notification_settings,
 clinical_core.patient_text_consent_wordings,clinical_core.patient_text_consents,clinical_core.patient_text_inbound,clinical_core.patient_text_stops,
 clinical_core.patient_notices,clinical_core.patient_notice_events,clinical_core.patient_notice_deliveries,clinical_core.patient_reminder_texts
 from public,clinical_core_api,patient_notification_worker;

grant select on clinical_core.patient_notification_activation,clinical_core.patient_text_consent_wordings to patient_notification_authority;
grant select,insert,update on clinical_core.patient_notification_clinics,clinical_core.patient_notification_settings,clinical_core.patient_text_consents,
 clinical_core.patient_text_stops,clinical_core.patient_notice_events,clinical_core.patient_notice_deliveries,clinical_core.patient_reminder_texts to patient_notification_authority;
grant select,insert on clinical_core.patient_text_inbound,clinical_core.patient_notices to patient_notification_authority;
create policy notification_authority_activation on clinical_core.patient_notification_activation for select to patient_notification_authority using(true);
create policy notification_authority_wordings on clinical_core.patient_text_consent_wordings for select to patient_notification_authority using(true);
create policy notification_authority_clinics on clinical_core.patient_notification_clinics to patient_notification_authority using(true) with check(true);
create policy notification_authority_settings on clinical_core.patient_notification_settings to patient_notification_authority using(true) with check(true);
create policy notification_authority_consents on clinical_core.patient_text_consents to patient_notification_authority using(true) with check(true);
create policy notification_authority_inbound on clinical_core.patient_text_inbound to patient_notification_authority using(true) with check(true);
create policy notification_authority_stops on clinical_core.patient_text_stops to patient_notification_authority using(true) with check(true);
create policy notification_authority_notices on clinical_core.patient_notices to patient_notification_authority using(true) with check(true);
create policy notification_authority_events on clinical_core.patient_notice_events to patient_notification_authority using(true) with check(true);
create policy notification_authority_deliveries on clinical_core.patient_notice_deliveries to patient_notification_authority using(true) with check(true);
create policy notification_authority_reminders on clinical_core.patient_reminder_texts to patient_notification_authority using(true) with check(true);

-- Read-only on the base tables it must check against.
grant select on clinical_core.persons,clinical_core.identities,clinical_core.organization_memberships,clinical_core.patient_connections,
 clinical_core.care_messages,clinical_core.care_message_threads,clinical_core.intake_packets,clinical_core.lab_observations,
 clinical_core.lab_import_events,clinical_core.program_assignments,clinical_core.program_phase_authorizations to patient_notification_authority;
create policy notification_authority_persons on clinical_core.persons for select to patient_notification_authority using(true);
create policy notification_authority_identities on clinical_core.identities for select to patient_notification_authority using(true);
create policy notification_authority_memberships on clinical_core.organization_memberships for select to patient_notification_authority using(true);
create policy notification_authority_connections on clinical_core.patient_connections for select to patient_notification_authority using(true);
create policy notification_authority_messages on clinical_core.care_messages for select to patient_notification_authority using(true);
create policy notification_authority_threads on clinical_core.care_message_threads for select to patient_notification_authority using(true);
create policy notification_authority_packets on clinical_core.intake_packets for select to patient_notification_authority using(true);
create policy notification_authority_observations on clinical_core.lab_observations for select to patient_notification_authority using(true);
create policy notification_authority_imports on clinical_core.lab_import_events for select to patient_notification_authority using(true);
create policy notification_authority_assignments on clinical_core.program_assignments for select to patient_notification_authority using(true);
create policy notification_authority_releases on clinical_core.program_phase_authorizations for select to patient_notification_authority using(true);

grant create on schema clinical_core,clinical_private to patient_notification_authority;
do $$
declare _f regprocedure;
begin
 for _f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where (n.nspname='clinical_private' and p.proname like 'patient\_%') or (n.nspname='clinical_core' and p.proname in(
   'my_patient_notification_settings','current_text_consent_wording','set_my_patient_notification_settings','record_my_text_consent',
   'withdraw_my_text_consent','set_clinic_notification_contact','enqueue_patient_notice','form_patient_notices','due_patient_notice_deliveries',
   'record_patient_notice_delivery','record_inbound_text','patient_reminder_channels','claim_patient_reminder_text','settle_patient_reminder_text'))
 loop
  execute format('alter function %s owner to patient_notification_authority',_f);
  execute format('revoke all on function %s from public',_f);
 end loop;
end $$;
revoke create on schema clinical_core,clinical_private from patient_notification_authority;

grant execute on function clinical_core.my_patient_notification_settings(),clinical_core.current_text_consent_wording(),
 clinical_core.set_my_patient_notification_settings(jsonb,text,bigint),clinical_core.record_my_text_consent(text,text,text),
 clinical_core.withdraw_my_text_consent(),clinical_core.set_clinic_notification_contact(text,text,bigint),
 clinical_core.enqueue_patient_notice(text,jsonb) to clinical_core_api;
grant execute on function clinical_core.form_patient_notices(integer,integer),clinical_core.due_patient_notice_deliveries(integer),
 clinical_core.record_patient_notice_delivery(uuid,text,text,timestamptz,text),clinical_core.record_inbound_text(text,text,text),
 clinical_core.patient_reminder_channels(uuid,uuid),clinical_core.claim_patient_reminder_text(text,uuid,uuid,text),
 clinical_core.settle_patient_reminder_text(text,text,text,text) to patient_notification_worker;
