-- BLOCKED source candidate: program offer revisions (program-offer/1), the commercial
-- record of what a clinic sells when it sells a built program, for Codex's review.
-- Not a schema successor. Not registered in migrations/manifest.json; not applied
-- anywhere; not to be applied until the offer contract in src/contracts/programOffers.ts
-- and docs/claude-program-commerce-closure-2026-10-11.md are reviewed. The runtime that
-- would call these functions (src/server/commerce/program-offer-ledger-sql.ts) is
-- disabled in source, and the activation row below is disabled and unwritable by the
-- API role.
--
-- Parent assumptions (written against exactly these artifacts; the test refuses to run
-- it if either digest has moved):
--   20260812010000_synthetic_identity_consent.sql
--     sha256 c4ca967352bce6c678249336ef410fe7de4216d123a0d3da06a467379780c445
--     (clinical_core.organizations, clinical_core.persons, clinical_core_api,
--      clinical_private.block_update_delete, clinical_private.actor_person_id,
--      clinical_private.organization_id, clinical_private.has_clinical_role)
--   20260903200000_synthetic_desktop_programs_inbox.sql
--     sha256 6ba42349af12e2deb2aa163fbca59ea168bababe4017a098ec88314f31a8b26f
--     (clinical_core.synthetic_desktop_programs (id, organization_id, published_version_id),
--      clinical_core.synthetic_desktop_program_versions (id, organization_id, program_id,
--      version, status, content))
--   20260929120000_synthetic_program_assignments.sql
--     sha256 8d6bcac8dfbe5582e7ee63d5f7ed6a5b4466760195f251d10780f08e3fb4a1d8
--     (clinical_private.program_consumer_content, the digest the assignment service pins)
-- No historical migration, ledger, binary, privilege, IAM or custody file is changed by
-- this file. No price, frequency, duration, refund policy, tax treatment or provider
-- account is decided here.
--
-- Commercial data lives in its own schema. No clinical function reads it, and the test
-- asserts that no clinical_core or clinical_private function body names this schema.
-- The functions here read program publication state (which version is published and the
-- digest of its patient-facing content) because an offer is bound to exactly that; they
-- read no patient, consent, encounter or record table, and no such column exists here.
--
-- What the ledger holds and refuses:
--   * an offer belongs to one clinic and one program of that clinic, and is bound to one
--     published curriculum version of that program; the binding columns are immutable;
--   * every change raises the revision by exactly one and writes an append-only snapshot;
--   * the only transitions are draft -> draft (revise), draft -> published,
--     draft -> retired, published -> retired; retired is terminal; a published offer's
--     terms cannot change;
--   * money is an integer count of minor units in a supported currency with an explicit
--     billing mode; nothing defaults; a paid offer without pricing is a draft that cannot
--     publish; a paid offer is never stored with a zero or negative amount;
--   * complimentary is a mode named by the caller with an authorizer and a written
--     reason; it never results from an incomplete paid row;
--   * a provider mapping is a typed reference plus a separately recorded approval; a
--     changed reference drops the approval; only test-mode Stripe references are admitted;
--   * at most one published offer per program;
--   * the API role executes the reviewed functions and touches no table directly; the
--     functions refuse until the activation row is enabled by a separately reviewed change.

create schema commercial_education;
grant usage on schema commercial_education to clinical_core_api;
revoke all on schema commercial_education from public;

create table commercial_education.program_commerce_activation(
 singleton boolean primary key default true check(singleton),
 enabled boolean not null default false,
 evidence_sha256 text check(evidence_sha256 is null or evidence_sha256 ~ '^[a-f0-9]{64}$'),
 reviewed_by text check(reviewed_by is null or char_length(btrim(reviewed_by)) between 1 and 200),
 reviewed_at timestamptz,
 updated_at timestamptz not null default clock_timestamp(),
 check(not enabled or (evidence_sha256 is not null and reviewed_by is not null and reviewed_at is not null))
);
insert into commercial_education.program_commerce_activation(singleton,enabled) values(true,false);
alter table commercial_education.program_commerce_activation enable row level security;
alter table commercial_education.program_commerce_activation force row level security;
revoke all on commercial_education.program_commerce_activation from public,clinical_core_api;
create trigger program_commerce_activation_append_only before delete on commercial_education.program_commerce_activation
 for each row execute function clinical_private.block_update_delete();

create table commercial_education.program_offers(
 id uuid primary key default public.gen_random_uuid(),
 organization_id uuid not null references clinical_core.organizations(id),
 program_id uuid not null,
 revision integer not null default 1 check(revision>=1),
 state text not null default 'draft' check(state in('draft','published','retired')),
 mode text not null check(mode in('paid','complimentary')),
 name text not null check(char_length(btrim(name)) between 1 and 120),
 curriculum_version_id uuid not null,
 curriculum_version integer not null check(curriculum_version>0),
 curriculum_source_digest text not null check(curriculum_source_digest ~ '^[a-f0-9]{64}$'),
 currency text check(currency is null or currency in('USD')),
 amount_minor integer check(amount_minor is null or (amount_minor between 1 and 1000000)),
 billing_kind text check(billing_kind is null or billing_kind in('one_time','recurring')),
 billing_interval text check(billing_interval is null or billing_interval in('month','year')),
 billing_interval_count integer check(billing_interval_count is null or (billing_interval_count between 1 and 12)),
 provider text check(provider is null or provider='stripe'),
 provider_mode text check(provider_mode is null or provider_mode='test'),
 provider_price_ref text check(provider_price_ref is null or provider_price_ref ~ '^price_[A-Za-z0-9]{8,64}$'),
 provider_approved_by uuid references clinical_core.persons(id),
 provider_approved_at timestamptz,
 access_terms_version text check(access_terms_version is null or access_terms_version ~ '^education-access-terms/[1-9][0-9]{0,3}$'),
 access_duration_days integer check(access_duration_days is null or (access_duration_days between 1 and 3650)),
 complimentary_reason text check(complimentary_reason is null or char_length(btrim(complimentary_reason)) between 10 and 600),
 complimentary_authorized_by uuid references clinical_core.persons(id),
 complimentary_authorized_at timestamptz,
 authored_by uuid not null references clinical_core.persons(id),
 authored_at timestamptz not null default clock_timestamp(),
 created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(),
 foreign key(program_id,organization_id) references clinical_core.synthetic_desktop_programs(id,organization_id),
 foreign key(curriculum_version_id,organization_id) references clinical_core.synthetic_desktop_program_versions(id,organization_id),
 unique(id,organization_id),
 constraint program_offers_paid_shape check(mode<>'paid' or (complimentary_reason is null and complimentary_authorized_by is null and complimentary_authorized_at is null)),
 constraint program_offers_complimentary_shape check(mode<>'complimentary' or (complimentary_reason is not null and complimentary_authorized_by is not null and complimentary_authorized_at is not null
  and currency is null and amount_minor is null and billing_kind is null and provider is null)),
 constraint program_offers_pricing_whole check((currency is null)=(amount_minor is null) and (currency is null)=(billing_kind is null)),
 constraint program_offers_billing_recurring check(billing_kind is distinct from 'recurring' or (billing_interval is not null and billing_interval_count is not null)),
 constraint program_offers_billing_one_time check(billing_kind is distinct from 'one_time' or (billing_interval is null and billing_interval_count is null)),
 constraint program_offers_billing_absent check(billing_kind is not null or (billing_interval is null and billing_interval_count is null)),
 constraint program_offers_provider_whole check((provider is null)=(provider_mode is null) and (provider is null)=(provider_price_ref is null)),
 constraint program_offers_provider_approval_whole check((provider_approved_by is null)=(provider_approved_at is null)),
 constraint program_offers_provider_approval_needs_ref check(provider_approved_by is null or provider_price_ref is not null),
 constraint program_offers_published_paid_complete check(state<>'published' or mode<>'paid' or (amount_minor is not null and provider_approved_by is not null)),
 constraint program_offers_published_terms check(state<>'published' or access_terms_version is not null)
);
create unique index program_offers_one_published on commercial_education.program_offers(program_id) where state='published';
create index program_offers_program_idx on commercial_education.program_offers(organization_id,program_id);
alter table commercial_education.program_offers enable row level security;
alter table commercial_education.program_offers force row level security;
revoke all on commercial_education.program_offers from public,clinical_core_api;

create table commercial_education.program_offer_revisions(
 offer_id uuid not null references commercial_education.program_offers(id),
 revision integer not null check(revision>=1),
 action text not null check(action in('create','revise','approve_provider_mapping','publish','retire')),
 actor_person_id uuid not null references clinical_core.persons(id),
 detail text check(detail is null or char_length(detail)<=600),
 snapshot jsonb not null check(jsonb_typeof(snapshot)='object'),
 recorded_at timestamptz not null default clock_timestamp(),
 primary key(offer_id,revision)
);
alter table commercial_education.program_offer_revisions enable row level security;
alter table commercial_education.program_offer_revisions force row level security;
revoke all on commercial_education.program_offer_revisions from public,clinical_core_api;
create trigger program_offer_revisions_append_only before update or delete on commercial_education.program_offer_revisions
 for each row execute function clinical_private.block_update_delete();

create function commercial_education.protect_program_offer() returns trigger
language plpgsql security invoker set search_path='' as $$
declare _version clinical_core.synthetic_desktop_program_versions%rowtype;
begin
 if tg_op='DELETE' then raise exception using errcode='55000',message='program_offer_append_only'; end if;
 if tg_op='INSERT' then
  if new.revision<>1 or new.state<>'draft' then raise exception using errcode='55000',message='program_offer_insert_shape'; end if;
  select * into _version from clinical_core.synthetic_desktop_program_versions where id=new.curriculum_version_id;
  if not found or _version.program_id<>new.program_id or _version.organization_id<>new.organization_id or _version.status<>'published' then
   raise exception using errcode='55000',message='program_offer_curriculum_mismatch';
  end if;
  new.updated_at:=clock_timestamp();
  return new;
 end if;
 if new.id<>old.id or new.organization_id<>old.organization_id or new.program_id<>old.program_id or (new.mode<>old.mode and old.state<>'draft')
  or new.curriculum_version_id<>old.curriculum_version_id or new.curriculum_version<>old.curriculum_version or new.curriculum_source_digest<>old.curriculum_source_digest
  or new.created_at<>old.created_at then
  raise exception using errcode='55000',message='program_offer_identity_immutable';
 end if;
 if new.revision<>old.revision+1 then raise exception using errcode='55000',message='program_offer_revision_must_increase'; end if;
 if old.state='retired' then raise exception using errcode='55000',message='program_offer_transition_refused'; end if;
 if old.state='published' then
  if new.state<>'retired' then raise exception using errcode='55000',message='program_offer_transition_refused'; end if;
  if new.name<>old.name or new.mode<>old.mode or new.currency is distinct from old.currency or new.amount_minor is distinct from old.amount_minor
   or new.billing_kind is distinct from old.billing_kind or new.billing_interval is distinct from old.billing_interval or new.billing_interval_count is distinct from old.billing_interval_count
   or new.provider_price_ref is distinct from old.provider_price_ref or new.provider_approved_by is distinct from old.provider_approved_by
   or new.access_terms_version is distinct from old.access_terms_version or new.access_duration_days is distinct from old.access_duration_days
   or new.complimentary_reason is distinct from old.complimentary_reason or new.complimentary_authorized_by is distinct from old.complimentary_authorized_by then
   raise exception using errcode='55000',message='program_offer_published_immutable';
  end if;
 end if;
 if new.provider_price_ref is distinct from old.provider_price_ref and new.provider_approved_by is not null and new.provider_approved_by is not distinct from old.provider_approved_by then
  raise exception using errcode='55000',message='program_offer_approval_bound_to_reference';
 end if;
 new.updated_at:=clock_timestamp();
 return new;
end $$;
revoke all on function commercial_education.protect_program_offer() from public;
create trigger program_offers_protect before insert or update or delete on commercial_education.program_offers
 for each row execute function commercial_education.protect_program_offer();

create function commercial_education.offer_json(_o commercial_education.program_offers) returns jsonb
language sql immutable set search_path='' as $$
 select jsonb_build_object('contract','program-offer/1','offerId',_o.id,'organizationId',_o.organization_id,'programId',_o.program_id,
  'curriculum',jsonb_build_object('versionId',_o.curriculum_version_id,'version',_o.curriculum_version,'sourceDigest',_o.curriculum_source_digest),
  'revision',_o.revision,'state',_o.state,'name',_o.name,'accessTermsVersion',_o.access_terms_version,'accessDurationDays',_o.access_duration_days,
  'authoredBy',_o.authored_by,'authoredAt',_o.authored_at,'mode',_o.mode)
 || case when _o.mode='paid' then jsonb_build_object(
   'pricing',case when _o.amount_minor is null then null else jsonb_build_object('currency',_o.currency,'amountMinor',_o.amount_minor,
    'billing',case when _o.billing_kind='one_time' then jsonb_build_object('kind','one_time')
     else jsonb_build_object('kind','recurring','interval',_o.billing_interval,'intervalCount',_o.billing_interval_count) end) end,
   'providerPrice',case when _o.provider_price_ref is null then null else jsonb_build_object('provider','stripe','mode','test','priceRef',_o.provider_price_ref,
    'approval',case when _o.provider_approved_by is null then null else jsonb_build_object('by',_o.provider_approved_by,'at',_o.provider_approved_at) end) end)
  else jsonb_build_object('authorization',jsonb_build_object('authorizedBy',_o.complimentary_authorized_by,'authorizedAt',_o.complimentary_authorized_at,'reason',_o.complimentary_reason)) end
$$;
revoke all on function commercial_education.offer_json(commercial_education.program_offers) from public;

-- The program's current published curriculum within one clinic: the binding an offer is
-- created against and checked against. Null when nothing admitted for patients is
-- published; raises when the program is not that clinic's.
create function commercial_education.current_curriculum(_organization uuid,_program uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare _p clinical_core.synthetic_desktop_programs%rowtype; _v clinical_core.synthetic_desktop_program_versions%rowtype; _items jsonb;
begin
 select * into _p from clinical_core.synthetic_desktop_programs where id=_program and organization_id=_organization;
 if not found then raise exception using errcode='P0002',message='program_offer_program_not_found'; end if;
 if _p.published_version_id is null then return null; end if;
 select * into _v from clinical_core.synthetic_desktop_program_versions where id=_p.published_version_id and program_id=_p.id and organization_id=_organization and status='published';
 if not found then return null; end if;
 _items:=clinical_private.program_consumer_content(_v.content);
 if _items is null then return null; end if;
 return jsonb_build_object('versionId',_v.id,'version',_v.version,'sourceDigest',encode(public.digest(convert_to((_items->'phases')::text,'UTF8'),'sha256'),'hex'));
end $$;
revoke all on function commercial_education.current_curriculum(uuid,uuid) from public;

create function commercial_education.require_activation() returns void
language plpgsql stable security definer set search_path='' as $$
begin
 if not exists(select 1 from commercial_education.program_commerce_activation where enabled) then
  raise exception using errcode='55000',message='program_offer_activation_refused';
 end if;
end $$;
revoke all on function commercial_education.require_activation() from public;

create function commercial_education.apply_terms(_o inout commercial_education.program_offers,_terms jsonb,_actor uuid) returns commercial_education.program_offers
language plpgsql volatile set search_path='' as $$
declare _pricing jsonb:=_terms->'pricing'; _billing jsonb; _ref text;
begin
 _o.name:=btrim(_terms->>'name'); _o.mode:=_terms->>'mode';
 _o.access_terms_version:=_terms->>'accessTermsVersion'; _o.access_duration_days:=(_terms->>'accessDurationDays')::integer;
 _o.authored_by:=_actor; _o.authored_at:=clock_timestamp();
 if _o.mode='paid' then
  _o.complimentary_reason:=null; _o.complimentary_authorized_by:=null; _o.complimentary_authorized_at:=null;
  if _pricing is null or jsonb_typeof(_pricing)='null' then _o.currency:=null; _o.amount_minor:=null; _o.billing_kind:=null; _o.billing_interval:=null; _o.billing_interval_count:=null;
  else
   if jsonb_typeof(_pricing->'amountMinor')<>'number' or (_pricing->>'amountMinor') !~ '^[0-9]+$' then raise exception using errcode='22023',message='program_offer_request_invalid'; end if;
   _o.currency:=_pricing->>'currency'; _o.amount_minor:=(_pricing->>'amountMinor')::integer;
   _billing:=_pricing->'billing'; _o.billing_kind:=_billing->>'kind';
   _o.billing_interval:=_billing->>'interval'; _o.billing_interval_count:=(_billing->>'intervalCount')::integer;
  end if;
  _ref:=_terms->>'providerPriceRef';
  if _ref is null then _o.provider:=null; _o.provider_mode:=null; _o.provider_price_ref:=null; _o.provider_approved_by:=null; _o.provider_approved_at:=null;
  else
   if _o.provider_price_ref is distinct from _ref then _o.provider_approved_by:=null; _o.provider_approved_at:=null; end if;
   _o.provider:='stripe'; _o.provider_mode:='test'; _o.provider_price_ref:=_ref;
  end if;
 elsif _o.mode='complimentary' then
  _o.currency:=null; _o.amount_minor:=null; _o.billing_kind:=null; _o.billing_interval:=null; _o.billing_interval_count:=null;
  _o.provider:=null; _o.provider_mode:=null; _o.provider_price_ref:=null; _o.provider_approved_by:=null; _o.provider_approved_at:=null;
  _o.complimentary_reason:=btrim(_terms->>'reason'); _o.complimentary_authorized_by:=_actor; _o.complimentary_authorized_at:=clock_timestamp();
 else
  raise exception using errcode='22023',message='program_offer_request_invalid';
 end if;
end $$;
revoke all on function commercial_education.apply_terms(commercial_education.program_offers,jsonb,uuid) from public;

create function commercial_education.publish_holds(_o commercial_education.program_offers,_current jsonb) returns text[]
language sql immutable set search_path='' as $$
 select array_remove(array[
  case when _o.mode='paid' and _o.amount_minor is null then 'no_pricing' end,
  case when _o.mode='paid' and _o.provider_price_ref is null then 'provider_mapping_missing' end,
  case when _o.mode='paid' and _o.provider_price_ref is not null and _o.provider_approved_by is null then 'provider_mapping_unapproved' end,
  case when _o.access_terms_version is null then 'no_access_terms' end,
  case when _current is null then 'curriculum_unpublished' end,
  case when _current is not null and ((_current->>'versionId')::uuid<>_o.curriculum_version_id or (_current->>'version')::integer<>_o.curriculum_version
   or _current->>'sourceDigest'<>_o.curriculum_source_digest) then 'curriculum_changed' end],null)
$$;
revoke all on function commercial_education.publish_holds(commercial_education.program_offers,jsonb) from public;

-- The authoring entry point: one command, one revision, one snapshot. Requires the
-- request context (actor and clinic) and a clinical role in that clinic.
create function commercial_education.execute_program_offer_command(_command jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.actor_person_id(); _org uuid:=clinical_private.organization_id(); _action text:=_command->>'action';
 _o commercial_education.program_offers%rowtype; _current jsonb; _holds text[]; _program uuid; _expected integer; _list jsonb;
begin
 perform commercial_education.require_activation();
 if _actor is null or _org is null or not clinical_private.has_clinical_role(_org) then raise exception using errcode='42501',message='program_offer_identity_refused'; end if;
 if jsonb_typeof(_command)<>'object' or _action is null then raise exception using errcode='22023',message='program_offer_request_invalid'; end if;
 if _action='list' then
  _program:=(_command->>'programId')::uuid;
  _current:=commercial_education.current_curriculum(_org,_program);
  select coalesce(jsonb_agg(commercial_education.offer_json(o) order by o.created_at),'[]'::jsonb) into _list
   from commercial_education.program_offers o where o.organization_id=_org and o.program_id=_program;
  return jsonb_build_object('action','list','offers',_list,'curriculum',_current);
 end if;
 if _action='create' then
  _program:=(_command->>'programId')::uuid;
  _current:=commercial_education.current_curriculum(_org,_program);
  if _current is null then raise exception using errcode='55000',message='program_offer_curriculum_unpublished'; end if;
  _o.id:=public.gen_random_uuid(); _o.organization_id:=_org; _o.program_id:=_program; _o.revision:=1; _o.state:='draft';
  _o.curriculum_version_id:=(_current->>'versionId')::uuid; _o.curriculum_version:=(_current->>'version')::integer; _o.curriculum_source_digest:=_current->>'sourceDigest';
  _o.created_at:=clock_timestamp();
  _o:=commercial_education.apply_terms(_o,_command->'terms',_actor);
  insert into commercial_education.program_offers values(_o.*);
  select * into _o from commercial_education.program_offers where id=_o.id;
  insert into commercial_education.program_offer_revisions(offer_id,revision,action,actor_person_id,snapshot) values(_o.id,1,'create',_actor,commercial_education.offer_json(_o));
  return jsonb_build_object('action','create','offer',commercial_education.offer_json(_o));
 end if;
 _expected:=(_command->>'expectedRevision')::integer;
 select * into _o from commercial_education.program_offers where id=(_command->>'offerId')::uuid and organization_id=_org for update;
 if not found then raise exception using errcode='P0002',message='program_offer_not_found'; end if;
 if _o.revision<>_expected then raise exception using errcode='55000',message='program_offer_revision_stale'; end if;
 if _action='revise' then
  if _o.state<>'draft' then raise exception using errcode='55000',message='program_offer_state_invalid'; end if;
  _o:=commercial_education.apply_terms(_o,_command->'terms',_actor);
 elsif _action='approve_provider_mapping' then
  if _o.state<>'draft' or _o.mode<>'paid' or _o.provider_price_ref is null then raise exception using errcode='55000',message='program_offer_state_invalid'; end if;
  _o.provider_approved_by:=_actor; _o.provider_approved_at:=clock_timestamp();
 elsif _action='publish' then
  if _o.state<>'draft' then raise exception using errcode='55000',message='program_offer_state_invalid'; end if;
  _current:=commercial_education.current_curriculum(_org,_o.program_id);
  _holds:=commercial_education.publish_holds(_o,_current);
  if coalesce(array_length(_holds,1),0)>0 then raise exception using errcode='55000',message='program_offer_publish_refused:'||array_to_string(_holds,','); end if;
  if exists(select 1 from commercial_education.program_offers where program_id=_o.program_id and state='published') then
   raise exception using errcode='55000',message='program_offer_state_invalid:another_offer_published';
  end if;
  _o.state:='published';
 elsif _action='retire' then
  if _o.state='retired' then raise exception using errcode='55000',message='program_offer_state_invalid'; end if;
  _o.state:='retired';
 else
  raise exception using errcode='22023',message='program_offer_request_invalid';
 end if;
 _o.revision:=_o.revision+1;
 update commercial_education.program_offers set (revision,state,mode,name,currency,amount_minor,billing_kind,billing_interval,billing_interval_count,provider,provider_mode,provider_price_ref,
  provider_approved_by,provider_approved_at,access_terms_version,access_duration_days,complimentary_reason,complimentary_authorized_by,complimentary_authorized_at,authored_by,authored_at)
  =(_o.revision,_o.state,_o.mode,_o.name,_o.currency,_o.amount_minor,_o.billing_kind,_o.billing_interval,_o.billing_interval_count,_o.provider,_o.provider_mode,_o.provider_price_ref,
  _o.provider_approved_by,_o.provider_approved_at,_o.access_terms_version,_o.access_duration_days,_o.complimentary_reason,_o.complimentary_authorized_by,_o.complimentary_authorized_at,_o.authored_by,_o.authored_at)
  where id=_o.id;
 select * into _o from commercial_education.program_offers where id=_o.id;
 insert into commercial_education.program_offer_revisions(offer_id,revision,action,actor_person_id,detail,snapshot)
  values(_o.id,_o.revision,_action,_actor,case when _action='retire' then left(_command->>'reason',600) when _action='approve_provider_mapping' then _o.provider_price_ref end,commercial_education.offer_json(_o));
 return jsonb_build_object('action',_action,'offer',commercial_education.offer_json(_o));
end $$;
revoke all on function commercial_education.execute_program_offer_command(jsonb) from public;
grant execute on function commercial_education.execute_program_offer_command(jsonb) to clinical_core_api;

create function commercial_education.read_program_offer(_offer uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare _o commercial_education.program_offers%rowtype; _org uuid:=clinical_private.organization_id();
begin
 perform commercial_education.require_activation();
 if _org is null or not clinical_private.has_clinical_role(_org) then raise exception using errcode='42501',message='program_offer_identity_refused'; end if;
 select * into _o from commercial_education.program_offers where id=_offer and organization_id=_org;
 if not found then return null; end if;
 return commercial_education.offer_json(_o);
end $$;
revoke all on function commercial_education.read_program_offer(uuid) from public;
grant execute on function commercial_education.read_program_offer(uuid) to clinical_core_api;

-- The visitor's question, answered without a request context because a visitor has none:
-- the clinic and program are named by the server from the funnel definition, never by the
-- browser. Returns the public terms only when every hold is clear; otherwise the reason.
create function commercial_education.program_purchase_availability(_organization uuid,_program uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare _o commercial_education.program_offers%rowtype; _current jsonb; _holds text[];
begin
 if not exists(select 1 from commercial_education.program_commerce_activation where enabled) then return jsonb_build_object('available',false,'reason','commerce_disabled'); end if;
 if not exists(select 1 from clinical_core.synthetic_desktop_programs where id=_program and organization_id=_organization) then return jsonb_build_object('available',false,'reason','offer_absent'); end if;
 select * into _o from commercial_education.program_offers where organization_id=_organization and program_id=_program and state='published';
 if not found then
  if exists(select 1 from commercial_education.program_offers where organization_id=_organization and program_id=_program and state='draft') then return jsonb_build_object('available',false,'reason','offer_draft'); end if;
  if exists(select 1 from commercial_education.program_offers where organization_id=_organization and program_id=_program and state='retired') then return jsonb_build_object('available',false,'reason','offer_retired'); end if;
  return jsonb_build_object('available',false,'reason','offer_absent');
 end if;
 if _o.mode='complimentary' then return jsonb_build_object('available',false,'reason','complimentary_mode'); end if;
 _current:=commercial_education.current_curriculum(_organization,_program);
 _holds:=commercial_education.publish_holds(_o,_current);
 if coalesce(array_length(_holds,1),0)>0 then return jsonb_build_object('available',false,'reason',_holds[1]); end if;
 return jsonb_build_object('available',true,'offerId',_o.id,'revision',_o.revision,'name',_o.name,
  'pricing',(commercial_education.offer_json(_o))->'pricing','curriculum',(commercial_education.offer_json(_o))->'curriculum',
  'accessTermsVersion',_o.access_terms_version,'accessDurationDays',_o.access_duration_days,'providerPriceRef',_o.provider_price_ref);
end $$;
revoke all on function commercial_education.program_purchase_availability(uuid,uuid) from public;
grant execute on function commercial_education.program_purchase_availability(uuid,uuid) to clinical_core_api;
