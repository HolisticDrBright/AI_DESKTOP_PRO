-- A shareable consult link, and the requests it produces.
-- Synthetic-only. No real patient data, and nothing here is enabled for production.
--
-- Until now a person could only reach this clinic by installing the app, signing in, and
-- being handed an invitation the clinic had already created for them. That is backwards
-- for a first consult: the clinic cannot invite someone it has never heard from. So there
-- was no way in at all, and the practitioner queue could only ever show people who were
-- already patients.
--
-- This adds the missing front door: a link the clinic publishes, a page anyone can open,
-- and a request that lands in the clinic's own queue.
--
-- Two decisions are deliberate and are not softened elsewhere.
--
-- First, the public surface has no identity, so it has no request context. Every other
-- function in this family derives its authority from verified claims; this one has none to
-- derive from. Its authority is the link itself, and it is therefore allowed to do exactly
-- two things: describe a link, and add one row to consult_requests. It reads no patient,
-- no connection, no clinical record, and it returns nothing about the clinic beyond what
-- the clinic published on the link. An unknown, disabled or expired slug gives one
-- refusal, so a prober cannot use it to learn which clinics exist.
--
-- Second, the public form does not accept free text about health. A visitor picks a visit
-- type and one of the reasons the clinic published. This is a narrower form than the
-- commercial products offer, and that is the point: an unauthenticated endpoint that
-- accepted "describe your symptoms" would be an unauthenticated clinical intake channel,
-- created before any consent exists and before anyone has agreed to receive it. Clinical
-- detail arrives later, through the authenticated and consented intake packet, once the
-- person has an account and the clinic has accepted the request.
--
-- Contact details are sealed before they arrive. The database stores an AES-256-GCM
-- envelope and a digest; the digest exists only so a duplicate submission can be counted
-- and throttled. Nothing in this migration can read a name or an email address.

/* `jsonb_typeof` returns SQL NULL for an absent key, and NULL <> 'string' is NULL, so a
   plain `jsonb_typeof(x->'k') <> 'string'` guard does not fire for a field that is simply
   missing. That is how the earlier program validator accepted phases with absent required
   fields. This names the absence, so every check below fires on it. */
create or replace function clinical_private.jsonb_kind(_value jsonb) returns text
language sql immutable set search_path='' as $$ select coalesce(jsonb_typeof(_value),'absent') $$;
revoke all on function clinical_private.jsonb_kind(jsonb) from public;

create table clinical_core.consult_links(
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references clinical_core.organizations(id),
 -- The public half of the URL. Lower-case and hyphenated so it survives being written
 -- down, read aloud and pasted into a browser.
 slug text not null unique check(slug ~ '^[a-z0-9][a-z0-9-]{2,38}[a-z0-9]$'),
 label text not null check(char_length(label) between 1 and 120),
 visit_types text[] not null
  check(cardinality(visit_types) between 1 and 3
   and visit_types <@ array['initial','follow_up','urgent_question']),
 -- The reasons this link offers. A submission must name one of these, which is what keeps
 -- the public form free of narrative.
 reason_codes text[] not null
  check(cardinality(reason_codes) between 1 and 8
   and reason_codes <@ array['new_consultation','lab_review','follow_up_care',
    'supplement_question','program_question','insurance_question','other']),
 status text not null default 'active' check(status in('active','disabled')),
 -- Separate from status on purpose: a clinic that is simply full should be able to stop
 -- taking requests without retiring a link it has already printed.
 accepts_new_requests boolean not null default true,
 expires_at timestamptz,
 created_at timestamptz not null default clock_timestamp(),
 created_by_person_id uuid not null references clinical_core.persons(id),
 disabled_at timestamptz,
 disabled_by_person_id uuid references clinical_core.persons(id),
 unique(id,organization_id),
 check((status='disabled')=(disabled_at is not null)),
 check((disabled_at is null)=(disabled_by_person_id is null))
);
alter table clinical_core.consult_links enable row level security;
revoke all on clinical_core.consult_links from public,clinical_core_api;
create index consult_links_org_idx on clinical_core.consult_links(organization_id,created_at desc);
create index consult_links_created_by_idx on clinical_core.consult_links(created_by_person_id);
create index consult_links_disabled_by_idx on clinical_core.consult_links(disabled_by_person_id);

create table clinical_core.consult_requests(
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references clinical_core.organizations(id),
 link_id uuid not null references clinical_core.consult_links(id),
 -- What the visitor is shown and can quote back. Ambiguous glyphs are left out of the
 -- alphabet so a person reading it off a screen to a receptionist gets it right.
 reference_code text not null unique check(reference_code ~ '^[A-HJ-NP-Z2-9]{10}$'),
 contact_ciphertext text not null check(char_length(contact_ciphertext) between 1 and 8192),
 contact_iv text not null check(contact_iv ~ '^[A-Za-z0-9+/=]{16}$'),
 contact_tag text not null check(contact_tag ~ '^[A-Za-z0-9+/=]{24}$'),
 contact_digest text not null check(contact_digest ~ '^[a-f0-9]{64}$'),
 visit_type text not null check(visit_type in('initial','follow_up','urgent_question')),
 reason_code text not null check(reason_code in('new_consultation','lab_review','follow_up_care',
  'supplement_question','program_question','insurance_question','other')),
 -- Times the visitor said they could attend. Times only; no note travels with them.
 preferred_windows jsonb not null default '[]'::jsonb
  check(jsonb_typeof(preferred_windows)='array' and jsonb_array_length(preferred_windows)<=5),
 time_zone text check(time_zone is null or char_length(time_zone) between 3 and 64),
 status text not null default 'received'
  check(status in('received','accepted','declined','withdrawn','converted')),
 decline_reason text check(decline_reason is null or decline_reason in(
  'outside_scope','not_accepting','duplicate_request','unreachable')),
 patient_record_id uuid references clinical_core.patient_records(id),
 connection_id uuid references clinical_core.patient_connections(id),
 received_at timestamptz not null default clock_timestamp(),
 decided_at timestamptz,
 decided_by_person_id uuid references clinical_core.persons(id),
 converted_at timestamptz,
 revision bigint not null default 1 check(revision>0),
 foreign key (link_id,organization_id) references clinical_core.consult_links(id,organization_id),
 check((status='declined')=(decline_reason is not null)),
 check(status in('received','withdrawn') or decided_at is not null),
 -- A decision has an author. A withdrawal does not: the visitor made it, and the visitor
 -- is not a person row in this database.
 check((decided_at is null)=(decided_by_person_id is null)),
 check((status='converted')=(converted_at is not null)),
 check(status='converted' or (patient_record_id is null and connection_id is null)),
 check(status<>'converted' or (patient_record_id is not null and connection_id is not null))
);
alter table clinical_core.consult_requests enable row level security;
revoke all on clinical_core.consult_requests from public,clinical_core_api;
create index consult_requests_queue_idx
 on clinical_core.consult_requests(organization_id,status,received_at desc);
create index consult_requests_link_idx on clinical_core.consult_requests(link_id,received_at desc);
create index consult_requests_digest_idx on clinical_core.consult_requests(contact_digest,received_at desc);
create index consult_requests_patient_idx on clinical_core.consult_requests(patient_record_id);
create index consult_requests_connection_idx on clinical_core.consult_requests(connection_id);
create index consult_requests_decided_by_idx on clinical_core.consult_requests(decided_by_person_id);

-- What a request said when it arrived is not editable. Only the clinic's handling of it
-- moves, and a delete would destroy the record of a person having asked.
create or replace function clinical_private.protect_consult_request() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if tg_op='DELETE' then raise exception using errcode='55000',message='append_only_record'; end if;
 if new.id is distinct from old.id
 or new.organization_id is distinct from old.organization_id
 or new.link_id is distinct from old.link_id
 or new.reference_code is distinct from old.reference_code
 or new.contact_ciphertext is distinct from old.contact_ciphertext
 or new.contact_iv is distinct from old.contact_iv
 or new.contact_tag is distinct from old.contact_tag
 or new.contact_digest is distinct from old.contact_digest
 or new.visit_type is distinct from old.visit_type
 or new.reason_code is distinct from old.reason_code
 or new.preferred_windows is distinct from old.preferred_windows
 or new.received_at is distinct from old.received_at then
  raise exception using errcode='55000',message='consult_request_immutable';
 end if;
 return new;
end $$;
revoke all on function clinical_private.protect_consult_request() from public;
create trigger consult_requests_protected
 before update or delete on clinical_core.consult_requests
 for each row execute function clinical_private.protect_consult_request();

-- Content-free. Which link, which request, what happened; never who or what about.
create table clinical_core.consult_request_audit(
 id bigserial primary key,
 organization_id uuid not null references clinical_core.organizations(id),
 link_id uuid references clinical_core.consult_links(id),
 request_id uuid references clinical_core.consult_requests(id),
 -- Null for anything the public surface did: there is no actor to name.
 actor_id uuid references clinical_core.persons(id),
 action text not null check(action in('link_created','link_updated','link_disabled','link_enabled',
  'request_received','request_throttled','request_accepted','request_declined',
  'request_withdrawn','request_converted','contact_opened')),
 occurred_at timestamptz not null default clock_timestamp()
);
alter table clinical_core.consult_request_audit enable row level security;
revoke all on clinical_core.consult_request_audit from public,clinical_core_api;
create index consult_request_audit_org_idx
 on clinical_core.consult_request_audit(organization_id,occurred_at desc);
create index consult_request_audit_link_idx on clinical_core.consult_request_audit(link_id);
create index consult_request_audit_request_idx on clinical_core.consult_request_audit(request_id);
create index consult_request_audit_actor_idx on clinical_core.consult_request_audit(actor_id);
create trigger consult_request_audit_append_only
 before update or delete on clinical_core.consult_request_audit
 for each row execute function clinical_private.block_update_delete();

/* Ceilings for the unauthenticated surface. Declared as functions so the refusal and any
   operator report cannot disagree about what the limit is. */
create or replace function clinical_private.consult_link_hourly_ceiling() returns integer
language sql immutable set search_path='' as $$ select 20 $$;
revoke all on function clinical_private.consult_link_hourly_ceiling() from public;
create or replace function clinical_private.consult_contact_daily_ceiling() returns integer
language sql immutable set search_path='' as $$ select 3 $$;
revoke all on function clinical_private.consult_contact_daily_ceiling() from public;

/* A link that may currently be used, by slug, or null. One answer for absent, disabled,
   expired and belonging-to-a-non-synthetic organization, so the public surface cannot be
   used to enumerate. */
create or replace function clinical_private.open_consult_link(_slug text)
returns clinical_core.consult_links language plpgsql stable set search_path='' as $$
declare _link clinical_core.consult_links%rowtype;
begin
 if _slug is null or _slug !~ '^[a-z0-9][a-z0-9-]{2,38}[a-z0-9]$' then return null; end if;
 select l.* into _link from clinical_core.consult_links l
  join clinical_core.organizations o on o.id=l.organization_id
  where l.slug=_slug and l.status='active'
   and (l.expires_at is null or l.expires_at>clock_timestamp())
   and o.status='active' and o.environment='synthetic-staging'
   and o.data_classification='synthetic_only' and o.contains_phi=false;
 return _link;
end $$;
revoke all on function clinical_private.open_consult_link(text) from public;

/* Preferred windows, validated. Times only, each one ordered, none absurdly long, none in
   the past and none far enough out to be a way of writing something into the row. */
create or replace function clinical_private.consult_windows_valid(_windows jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare _entry jsonb; _from timestamptz; _to timestamptz;
begin
 if _windows is null or jsonb_typeof(_windows)<>'array' then return false; end if;
 if jsonb_array_length(_windows)>5 then return false; end if;
 for _entry in select value from jsonb_array_elements(_windows) loop
  if clinical_private.jsonb_kind(_entry)<>'object' then return false; end if;
  if _entry-array['from','to']<>'{}'::jsonb then return false; end if;
  if clinical_private.jsonb_kind(_entry->'from')<>'string' or clinical_private.jsonb_kind(_entry->'to')<>'string' then return false; end if;
  begin
   _from:=(_entry->>'from')::timestamptz; _to:=(_entry->>'to')::timestamptz;
  exception when others then return false; end;
  if _from is null or _to is null or _to<=_from or _to-_from>interval '12 hours' then return false; end if;
 end loop;
 return true;
end $$;
revoke all on function clinical_private.consult_windows_valid(jsonb) from public;

/* A reference code a person can read aloud. */
create or replace function clinical_private.consult_reference_code() returns text
language plpgsql volatile set search_path='' as $$
declare _alphabet text:='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; _code text:=''; _index integer;
begin
 for _index in 1..10 loop
  _code:=_code||substr(_alphabet,1+floor(random()*char_length(_alphabet))::integer,1);
 end loop;
 return _code;
end $$;
revoke all on function clinical_private.consult_reference_code() from public;

/* The unauthenticated surface. Its only authority is the slug it was given.

   `describe` returns what the clinic published on the link, and nothing else.
   `submit` adds one request. `withdraw` retracts one, proved by its reference code and the
   digest of the contact that made it, so a visitor can change their mind without an
   account.

   No request context is asserted, because a visitor has none. Every read is confined to
   the link reached by slug and, for a withdrawal, to the single request whose reference
   and contact digest both match. */
create or replace function clinical_core.consult_intake_public(_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 _action text; _link clinical_core.consult_links%rowtype; _row clinical_core.consult_requests%rowtype;
 _reference text; _attempt integer:=0; _recent integer; _repeat integer;
begin
 if _request is null or clinical_private.jsonb_kind(_request)<>'object' then
  raise exception using errcode='22023',message='consult_request_invalid'; end if;
 _action:=_request->>'action';
 if _action is null or _action not in('describe','submit','withdraw') then
  raise exception using errcode='22023',message='consult_request_invalid'; end if;

 if _action='describe' then
  if _request-array['action','slug']<>'{}'::jsonb then
   raise exception using errcode='22023',message='consult_request_invalid'; end if;
  _link:=clinical_private.open_consult_link(_request->>'slug');
  if _link.id is null then raise exception using errcode='P0002',message='consult_link_unavailable'; end if;
  return jsonb_build_object('action','describe','slug',_link.slug,'label',_link.label,
   'clinic',(select o.synthetic_label from clinical_core.organizations o where o.id=_link.organization_id),
   'visitTypes',to_jsonb(_link.visit_types),'reasonCodes',to_jsonb(_link.reason_codes),
   'acceptingRequests',_link.accepts_new_requests);
 end if;

 if _action='withdraw' then
  if _request-array['action','reference','contactDigest']<>'{}'::jsonb then
   raise exception using errcode='22023',message='consult_request_invalid'; end if;
  if (_request->>'reference') !~ '^[A-HJ-NP-Z2-9]{10}$'
  or (_request->>'contactDigest') !~ '^[a-f0-9]{64}$' then
   raise exception using errcode='22023',message='consult_request_invalid'; end if;
  select * into _row from clinical_core.consult_requests
   where reference_code=_request->>'reference' and contact_digest=_request->>'contactDigest' for update;
  -- One answer whether the reference is wrong, the digest is wrong, or the request has
  -- already been handled: a guessed reference must not confirm itself.
  if _row.id is null or _row.status<>'received' then
   raise exception using errcode='P0002',message='consult_request_unavailable'; end if;
  update clinical_core.consult_requests
   set status='withdrawn',revision=_row.revision+1 where id=_row.id;
  insert into clinical_core.consult_request_audit(organization_id,link_id,request_id,action)
   values(_row.organization_id,_row.link_id,_row.id,'request_withdrawn');
  return jsonb_build_object('action','withdraw','reference',_row.reference_code,'status','withdrawn');
 end if;

 if _request-array['action','slug','contact','contactDigest','visitType','reasonCode',
  'preferredWindows','timeZone']<>'{}'::jsonb then
  raise exception using errcode='22023',message='consult_request_invalid'; end if;
 _link:=clinical_private.open_consult_link(_request->>'slug');
 if _link.id is null then raise exception using errcode='P0002',message='consult_link_unavailable'; end if;
 if not _link.accepts_new_requests then
  raise exception using errcode='40001',message='consult_link_closed'; end if;
 if clinical_private.jsonb_kind(_request->'contact')<>'object'
 or (_request->'contact')-array['ciphertext','iv','tag']<>'{}'::jsonb
 or (_request->'contact'->>'ciphertext') is null or (_request->'contact'->>'iv') is null
 or (_request->'contact'->>'tag') is null
 or (_request->>'contactDigest') !~ '^[a-f0-9]{64}$'
 or (_request->>'visitType') is null or not (_request->>'visitType')=any(_link.visit_types)
 or (_request->>'reasonCode') is null or not (_request->>'reasonCode')=any(_link.reason_codes)
 or not clinical_private.consult_windows_valid(coalesce(_request->'preferredWindows','[]'::jsonb))
 or (_request ? 'timeZone' and clinical_private.jsonb_kind(_request->'timeZone') not in('string','null')) then
  raise exception using errcode='22023',message='consult_request_invalid'; end if;

 -- Throttles, inside a lock on the link so two simultaneous submissions cannot both pass
 -- a count that only one of them should.
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('consult:link:'||_link.id::text,0));
 select count(*) into _recent from clinical_core.consult_requests
  where link_id=_link.id and received_at>clock_timestamp()-interval '1 hour';
 select count(*) into _repeat from clinical_core.consult_requests
  where contact_digest=_request->>'contactDigest' and received_at>clock_timestamp()-interval '1 day';
 -- A refusal returned rather than raised, and only here. Raising would roll back the
 -- audit row in the same transaction, leaving an unauthenticated endpoint's throttling
 -- invisible; and the refusal is safe to return because it is the absence of an inserted
 -- request, not a permission the caller could proceed without.
 if _recent>=clinical_private.consult_link_hourly_ceiling()
 or _repeat>=clinical_private.consult_contact_daily_ceiling() then
  insert into clinical_core.consult_request_audit(organization_id,link_id,action)
   values(_link.organization_id,_link.id,'request_throttled');
  return jsonb_build_object('action','submit','outcome','throttled','reference',null,
   'retryAfterSeconds',3600);
 end if;

 loop
  _attempt:=_attempt+1; _reference:=clinical_private.consult_reference_code();
  exit when not exists(select 1 from clinical_core.consult_requests where reference_code=_reference);
  if _attempt>=8 then raise exception using errcode='40001',message='consult_reference_unavailable'; end if;
 end loop;

 insert into clinical_core.consult_requests(organization_id,link_id,reference_code,
  contact_ciphertext,contact_iv,contact_tag,contact_digest,visit_type,reason_code,
  preferred_windows,time_zone)
 values(_link.organization_id,_link.id,_reference,
  _request->'contact'->>'ciphertext',_request->'contact'->>'iv',_request->'contact'->>'tag',
  _request->>'contactDigest',_request->>'visitType',_request->>'reasonCode',
  coalesce(_request->'preferredWindows','[]'::jsonb),nullif(_request->>'timeZone',''))
 returning * into _row;
 insert into clinical_core.consult_request_audit(organization_id,link_id,request_id,action)
  values(_link.organization_id,_link.id,_row.id,'request_received');
 return jsonb_build_object('action','submit','outcome','received','reference',_row.reference_code,
  'receivedAt',_row.received_at,'status',_row.status);
end $$;
revoke all on function clinical_core.consult_intake_public(jsonb) from public;
grant execute on function clinical_core.consult_intake_public(jsonb) to clinical_core_api;

/* The clinic's own side: publishing links and working the queue. Ordinary verified
   workforce authority, unlike the public surface above. */
create or replace function clinical_private.assert_consult_workforce(_org uuid) returns uuid
language plpgsql stable set search_path='' as $$
declare _actor uuid:=clinical_private.actor_person_id(); _pool text:=clinical_private.claim('identity_pool');
begin
 perform clinical_private.assert_synthetic_context(_org,'clinical_data');
 if _actor is null or _pool<>'workforce'
 or not exists(select 1 from clinical_core.identities i join clinical_core.persons p on p.id=i.person_id
  where i.person_id=_actor and i.identity_pool=_pool
   and i.identity_subject=clinical_private.claim('identity_subject')
   and i.status='active' and p.status='active' and i.synthetic_attested)
 or not clinical_private.has_clinical_role(_org) then
  raise exception using errcode='42501',message='consult_request_forbidden';
 end if;
 return _actor;
end $$;
revoke all on function clinical_private.assert_consult_workforce(uuid) from public;

create or replace function clinical_core.consult_link_admin(_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 _org uuid:=clinical_private.organization_id(); _actor uuid; _action text;
 _row clinical_core.consult_links%rowtype; _expires timestamptz; _visit text[]; _reasons text[];
begin
 _actor:=clinical_private.assert_consult_workforce(_org);
 if _request is null or clinical_private.jsonb_kind(_request)<>'object' then
  raise exception using errcode='22023',message='consult_link_invalid'; end if;
 _action:=_request->>'action';
 if _action is null or _action not in('list','create','update','disable','enable') then
  raise exception using errcode='22023',message='consult_link_invalid'; end if;

 if _action='list' then
  if _request-array['action']<>'{}'::jsonb then
   raise exception using errcode='22023',message='consult_link_invalid'; end if;
  return jsonb_build_object('action','list','links',coalesce((
   select jsonb_agg(jsonb_build_object('linkId',l.id,'slug',l.slug,'label',l.label,
    'visitTypes',to_jsonb(l.visit_types),'reasonCodes',to_jsonb(l.reason_codes),
    'status',l.status,'acceptingRequests',l.accepts_new_requests,'expiresAt',l.expires_at,
    'createdAt',l.created_at,
    'openRequests',(select count(*) from clinical_core.consult_requests r
     where r.link_id=l.id and r.status='received'))
    order by l.created_at desc)
   from clinical_core.consult_links l where l.organization_id=_org),'[]'::jsonb));
 end if;

 if _action='create' then
  if _request-array['action','slug','label','visitTypes','reasonCodes','expiresAt']<>'{}'::jsonb
  or clinical_private.jsonb_kind(_request->'visitTypes')<>'array' or clinical_private.jsonb_kind(_request->'reasonCodes')<>'array' then
   raise exception using errcode='22023',message='consult_link_invalid'; end if;
  begin
   _visit:=array(select jsonb_array_elements_text(_request->'visitTypes'));
   _reasons:=array(select jsonb_array_elements_text(_request->'reasonCodes'));
   _expires:=nullif(_request->>'expiresAt','')::timestamptz;
  exception when others then raise exception using errcode='22023',message='consult_link_invalid'; end;
  if (_request->>'slug') is null or (_request->>'label') is null then
   raise exception using errcode='22023',message='consult_link_invalid'; end if;
  if exists(select 1 from clinical_core.consult_links where slug=_request->>'slug') then
   raise exception using errcode='40001',message='consult_link_slug_taken'; end if;
  begin
   insert into clinical_core.consult_links(organization_id,slug,label,visit_types,reason_codes,
    expires_at,created_by_person_id)
   values(_org,_request->>'slug',_request->>'label',_visit,_reasons,_expires,_actor)
   returning * into _row;
  exception when check_violation then raise exception using errcode='22023',message='consult_link_invalid';
  end;
  insert into clinical_core.consult_request_audit(organization_id,link_id,actor_id,action)
   values(_org,_row.id,_actor,'link_created');
  return jsonb_build_object('action','create','linkId',_row.id,'slug',_row.slug,'status',_row.status);
 end if;

 if (_request->>'linkId') is null then
  raise exception using errcode='22023',message='consult_link_invalid'; end if;
 begin
  select * into _row from clinical_core.consult_links
   where id=(_request->>'linkId')::uuid and organization_id=_org for update;
 exception when invalid_text_representation then
  raise exception using errcode='22023',message='consult_link_invalid'; end;
 if _row.id is null then raise exception using errcode='P0002',message='consult_link_absent'; end if;

 if _action='update' then
  if _request-array['action','linkId','label','acceptingRequests','expiresAt']<>'{}'::jsonb then
   raise exception using errcode='22023',message='consult_link_invalid'; end if;
  begin _expires:=nullif(_request->>'expiresAt','')::timestamptz;
  exception when others then raise exception using errcode='22023',message='consult_link_invalid'; end;
  update clinical_core.consult_links set
   label=coalesce(nullif(_request->>'label',''),_row.label),
   accepts_new_requests=coalesce((_request->>'acceptingRequests')::boolean,_row.accepts_new_requests),
   expires_at=case when _request ? 'expiresAt' then _expires else _row.expires_at end
   where id=_row.id returning * into _row;
  insert into clinical_core.consult_request_audit(organization_id,link_id,actor_id,action)
   values(_org,_row.id,_actor,'link_updated');
  return jsonb_build_object('action','update','linkId',_row.id,'label',_row.label,
   'acceptingRequests',_row.accepts_new_requests,'expiresAt',_row.expires_at);
 end if;

 if _request-array['action','linkId']<>'{}'::jsonb then
  raise exception using errcode='22023',message='consult_link_invalid'; end if;
 if _action='disable' then
  if _row.status='disabled' then
   return jsonb_build_object('action','disable','linkId',_row.id,'status','disabled'); end if;
  update clinical_core.consult_links
   set status='disabled',disabled_at=clock_timestamp(),disabled_by_person_id=_actor,
       accepts_new_requests=false where id=_row.id;
  insert into clinical_core.consult_request_audit(organization_id,link_id,actor_id,action)
   values(_org,_row.id,_actor,'link_disabled');
  return jsonb_build_object('action','disable','linkId',_row.id,'status','disabled');
 end if;
 if _row.status='active' then
  return jsonb_build_object('action','enable','linkId',_row.id,'status','active'); end if;
 update clinical_core.consult_links
  set status='active',disabled_at=null,disabled_by_person_id=null,accepts_new_requests=true
  where id=_row.id;
 insert into clinical_core.consult_request_audit(organization_id,link_id,actor_id,action)
  values(_org,_row.id,_actor,'link_enabled');
 return jsonb_build_object('action','enable','linkId',_row.id,'status','active');
end $$;
revoke all on function clinical_core.consult_link_admin(jsonb) from public;
grant execute on function clinical_core.consult_link_admin(jsonb) to clinical_core_api;

/* Working the queue: see what arrived, open one contact envelope when the clinic is ready
   to reply, decide, and convert an accepted request into a patient record and a connection
   the existing invitation flow can then reach. */
create or replace function clinical_core.consult_request_review(_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 _org uuid:=clinical_private.organization_id(); _actor uuid; _action text; _status text;
 _row clinical_core.consult_requests%rowtype; _patient uuid; _connection uuid; _key text;
begin
 _actor:=clinical_private.assert_consult_workforce(_org);
 if _request is null or clinical_private.jsonb_kind(_request)<>'object' then
  raise exception using errcode='22023',message='consult_review_invalid'; end if;
 _action:=_request->>'action';
 if _action is null or _action not in('list','open','accept','decline','convert') then
  raise exception using errcode='22023',message='consult_review_invalid'; end if;

 if _action='list' then
  if _request-array['action','status','limit']<>'{}'::jsonb then
   raise exception using errcode='22023',message='consult_review_invalid'; end if;
  _status:=_request->>'status';
  if _status is not null and _status not in('received','accepted','declined','withdrawn','converted') then
   raise exception using errcode='22023',message='consult_review_invalid'; end if;
  return jsonb_build_object('action','list','requests',coalesce((
   select jsonb_agg(entry order by entry->>'receivedAt' desc) from (
    select jsonb_build_object('requestId',r.id,'reference',r.reference_code,'slug',l.slug,
     'visitType',r.visit_type,'reasonCode',r.reason_code,'status',r.status,
     'preferredWindows',r.preferred_windows,'timeZone',r.time_zone,
     'receivedAt',r.received_at,'decidedAt',r.decided_at,'declineReason',r.decline_reason,
     'patientRecordId',r.patient_record_id,'connectionId',r.connection_id,
     'revision',r.revision::text) as entry
    from clinical_core.consult_requests r join clinical_core.consult_links l on l.id=r.link_id
    where r.organization_id=_org and (_status is null or r.status=_status)
    order by r.received_at desc
    limit least(greatest(coalesce((_request->>'limit')::integer,50),1),200)
   ) page),'[]'::jsonb));
 end if;

 if (_request->>'requestId') is null then
  raise exception using errcode='22023',message='consult_review_invalid'; end if;
 begin
  select * into _row from clinical_core.consult_requests
   where id=(_request->>'requestId')::uuid and organization_id=_org for update;
 exception when invalid_text_representation then
  raise exception using errcode='22023',message='consult_review_invalid'; end;
 if _row.id is null then raise exception using errcode='P0002',message='consult_request_absent'; end if;

 if _action='open' then
  if _request-array['action','requestId']<>'{}'::jsonb then
   raise exception using errcode='22023',message='consult_review_invalid'; end if;
  -- The envelope leaves here sealed. Opening it happens in the service, with a key this
  -- database does not hold, and the fact that it was opened is recorded.
  insert into clinical_core.consult_request_audit(organization_id,link_id,request_id,actor_id,action)
   values(_org,_row.link_id,_row.id,_actor,'contact_opened');
  -- The slug and the contact digest come back with the envelope because they are what the
  -- envelope was sealed to. A service that could not reconstruct that binding would have to
  -- open the envelope without checking it belonged to this row.
  return jsonb_build_object('action','open','requestId',_row.id,'reference',_row.reference_code,
   'slug',(select l.slug from clinical_core.consult_links l where l.id=_row.link_id),
   'contactDigest',_row.contact_digest,
   'contact',jsonb_build_object('ciphertext',_row.contact_ciphertext,'iv',_row.contact_iv,
    'tag',_row.contact_tag),'status',_row.status,'revision',_row.revision::text);
 end if;

 if (_request->>'expectedRevision') is null
 or (_request->>'expectedRevision') !~ '^[0-9]{1,18}$' then
  raise exception using errcode='22023',message='consult_review_invalid'; end if;
 if _row.revision<>(_request->>'expectedRevision')::bigint then
  raise exception using errcode='40001',message='consult_request_revision_stale'; end if;

 if _action='accept' then
  if _request-array['action','requestId','expectedRevision']<>'{}'::jsonb then
   raise exception using errcode='22023',message='consult_review_invalid'; end if;
  if _row.status<>'received' then
   raise exception using errcode='40001',message='consult_request_state_invalid'; end if;
  update clinical_core.consult_requests set status='accepted',decided_at=clock_timestamp(),
   decided_by_person_id=_actor,revision=_row.revision+1 where id=_row.id returning * into _row;
  insert into clinical_core.consult_request_audit(organization_id,link_id,request_id,actor_id,action)
   values(_org,_row.link_id,_row.id,_actor,'request_accepted');
  return jsonb_build_object('action','accept','requestId',_row.id,'status',_row.status,
   'revision',_row.revision::text);
 end if;

 if _action='decline' then
  if _request-array['action','requestId','expectedRevision','declineReason']<>'{}'::jsonb
  or (_request->>'declineReason') is null
  or (_request->>'declineReason') not in('outside_scope','not_accepting','duplicate_request','unreachable') then
   raise exception using errcode='22023',message='consult_review_invalid'; end if;
  if _row.status not in('received','accepted') then
   raise exception using errcode='40001',message='consult_request_state_invalid'; end if;
  update clinical_core.consult_requests set status='declined',decline_reason=_request->>'declineReason',
   decided_at=clock_timestamp(),decided_by_person_id=_actor,revision=_row.revision+1
   where id=_row.id returning * into _row;
  insert into clinical_core.consult_request_audit(organization_id,link_id,request_id,actor_id,action)
   values(_org,_row.link_id,_row.id,_actor,'request_declined');
  return jsonb_build_object('action','decline','requestId',_row.id,'status',_row.status,
   'declineReason',_row.decline_reason,'revision',_row.revision::text);
 end if;

 if _request-array['action','requestId','expectedRevision','syntheticRecordKey']<>'{}'::jsonb then
  raise exception using errcode='22023',message='consult_review_invalid'; end if;
 _key:=_request->>'syntheticRecordKey';
 if _key is null or _key !~ '^patient_syn_[A-Za-z0-9_-]{8,96}$' then
  raise exception using errcode='22023',message='consult_review_invalid'; end if;
 -- Only an accepted request becomes a patient record. Converting a declined or withdrawn
 -- request would create a chart for someone who was told no, or who asked to be forgotten.
 if _row.status<>'accepted' then
  raise exception using errcode='40001',message='consult_request_state_invalid'; end if;
 if exists(select 1 from clinical_core.patient_records
  where organization_id=_org and synthetic_record_key=_key) then
  raise exception using errcode='40001',message='consult_record_key_taken'; end if;
 insert into clinical_core.patient_records(organization_id,synthetic_record_key)
  values(_org,_key) returning id into _patient;
 insert into clinical_core.patient_connections(organization_id,patient_record_id,state)
  values(_org,_patient,'invitation_pending') returning id into _connection;
 update clinical_core.consult_requests set status='converted',converted_at=clock_timestamp(),
  patient_record_id=_patient,connection_id=_connection,revision=_row.revision+1
  where id=_row.id returning * into _row;
 insert into clinical_core.consult_request_audit(organization_id,link_id,request_id,actor_id,action)
  values(_org,_row.link_id,_row.id,_actor,'request_converted');
 return jsonb_build_object('action','convert','requestId',_row.id,'status',_row.status,
  'patientRecordId',_patient,'connectionId',_connection,'revision',_row.revision::text);
end $$;
revoke all on function clinical_core.consult_request_review(jsonb) from public;
grant execute on function clinical_core.consult_request_review(jsonb) to clinical_core_api;
