-- BLOCKED source candidate (successor): commerce authority separation and reviewed access terms,
-- for Codex's review. Not in migrations/manifest.json; not applied anywhere; not registered; not to
-- be applied until src/server/commerce/program-education-ledger-sql.ts, program-checkout-ledger-sql.ts
-- and docs/claude-program-commerce-reliability-learner-journeys-2026-10-11.md are reviewed. Disabled
-- like its parents: every function refuses until the commercial activation row is enabled by a
-- separately reviewed change, and the SQL ledgers enable only with evidence naming every digest.
--
-- Parent assumptions (written against exactly these artifacts, applied first, each unchanged; the
-- test refuses to run it if any digest has moved):
--   source-candidates/program-education-delivery.sql (BLOCKED, unregistered; claim delivery)
--     sha256 653965ff19f1d522067a6b636ac4ed5a4d2f9f1696cbb692c9545e3fc2046ae6
--   source-candidates/program-education-access.sql (BLOCKED, unregistered)
--     sha256 e4f11e29f1b6a68f1478dbc112aaac1ea2bbf72adf86f9458dd5a20c8151df93
--   source-candidates/program-checkout-recovery.sql (BLOCKED, unregistered; program-checkout/2)
--     sha256 29d85d75da43176b1a6d007afc5a0a892f99a08994f44bb459a4a756e2e2efc0
--   source-candidates/program-checkout-orders.sql 767ac13bc111a15b98bdc2978a5e42a33f5f1ab61f010061907787040b0c37ee
--   source-candidates/program-offer-revisions.sql 4973461564e6812906403525cb3aa109d6fd569eec159c9400fcf568a90b321f
--     (publish_holds and program_purchase_availability, which this file replaces in place)
--   and 20260812010000_synthetic_identity_consent.sql c4ca9673… (clinical_private.claim,
--     actor_person_id, organization_id, has_clinical_role, set_request_context).
-- No historical migration, shared identity function, ledger, binary, privilege outside the
-- commercial_education schema, IAM or custody file is changed by this file.
--
-- Who may call what, after this file (the API role is the request path; everything else is a
-- NOLOGIN role a separate host session assumes, never granted to the API role nor to each other):
--   clinical_core_api                 the visitor's checkout start (admit_program_order, and
--                                     advance_program_checkout, which may only record a creation
--                                     request, a session, an unknown outcome, an expiry or a refusal:
--                                     never a payment outcome); webhook admission; the offer
--                                     authoring command and availability (unchanged); the
--                                     consumer's OWN claim, access and entitlement read through
--                                     the *_for_caller functions, whose subject is the verified
--                                     request context and never an argument; staff status and the
--                                     staff curriculum read, from the workforce context of a
--                                     clinician of that clinic.
--   commercial_education_worker       intake processing, the order observation transitions,
--                                     reconciliation lists and counts, settlement, the settlement
--                                     backlog, the per-order entitlement read, and an expiry sweep
--                                     bounded by count and by the DATABASE clock.
--   commercial_education_delivery     (from the parent) the due sealed codes and attempts.
--   commercial_education_operator     policy holds, release and revocation, entitlement
--                                     transitions, replacement codes (parent) and recording a
--                                     reviewed access-terms entry.
-- The API role loses execute on every function it no longer needs; a test reproduces each call
-- that succeeded before this file and is refused after it.
--
-- Reviewed access terms. An access-terms version is a name until someone reviews what it says.
-- reviewed_access_terms is append-only and ships EMPTY: whoever reviews the terms records each
-- decision (duration policy, Core dependency, refund and renewal policy references) with evidence.
-- Publication and availability hold an offer whose version has no reviewed entry, whose duration
-- contradicts the reviewed duration policy (null is "no end" only under `indefinite`), whose
-- reviewed terms make it depend on Core (a purchase never grants Core, and nothing here can check
-- that a buyer holds it), or whose refund or (recurring) renewal policy is undecided. The same holds
-- apply again at activation: a claim of an entitlement whose terms are held is refused
-- `terms_undecided` and binds nothing, whatever an older, looser artifact let through.

do $$ begin
 if not exists(select 1 from pg_roles where rolname='commercial_education_worker') then create role commercial_education_worker nologin; end if;
end $$;
grant usage on schema commercial_education to commercial_education_worker;

/* -------------------------------------------------------------- reviewed access terms */

create table commercial_education.reviewed_access_terms(
 version text primary key check(version ~ '^education-access-terms/[1-9][0-9]{0,3}$'),
 duration_policy text not null check(duration_policy in('fixed_days','indefinite')),
 core_policy text not null check(core_policy in('not_required','required')),
 refund_policy_ref text check(refund_policy_ref is null or refund_policy_ref ~ '^[A-Za-z0-9_.:/-]{1,120}$'),
 renewal_policy_ref text check(renewal_policy_ref is null or renewal_policy_ref ~ '^[A-Za-z0-9_.:/-]{1,120}$'),
 reviewed_by text not null check(char_length(btrim(reviewed_by)) between 1 and 120),
 evidence_sha256 text not null check(evidence_sha256 ~ '^[a-f0-9]{64}$'),
 recorded_at timestamptz not null default clock_timestamp()
);
alter table commercial_education.reviewed_access_terms enable row level security;
alter table commercial_education.reviewed_access_terms force row level security;
revoke all on commercial_education.reviewed_access_terms from public,clinical_core_api,commercial_education_worker,commercial_education_delivery,commercial_education_operator;
-- A reviewed entry is never edited: a change of terms is a new version.
create trigger reviewed_access_terms_append_only before update or delete on commercial_education.reviewed_access_terms
 for each row execute function clinical_private.block_update_delete();

create function commercial_education.record_reviewed_access_terms(_version text,_duration_policy text,_core_policy text,_refund_policy_ref text,_reviewed_by text,_evidence_sha256 text,_renewal_policy_ref text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _t commercial_education.reviewed_access_terms%rowtype;
begin
 perform commercial_education.require_activation();
 if exists(select 1 from commercial_education.reviewed_access_terms where version=_version) then raise exception using errcode='55000',message='program_terms_recorded'; end if;
 insert into commercial_education.reviewed_access_terms(version,duration_policy,core_policy,refund_policy_ref,renewal_policy_ref,reviewed_by,evidence_sha256)
  values(_version,_duration_policy,_core_policy,_refund_policy_ref,_renewal_policy_ref,_reviewed_by,_evidence_sha256) returning * into _t;
 return jsonb_build_object('version',_t.version,'durationPolicy',_t.duration_policy,'corePolicy',_t.core_policy,'refundPolicyRef',_t.refund_policy_ref,
  'renewalPolicyRef',_t.renewal_policy_ref,'reviewedBy',_t.reviewed_by,'evidenceSha256',_t.evidence_sha256);
end $$;
revoke all on function commercial_education.record_reviewed_access_terms(text,text,text,text,text,text,text) from public;
grant execute on function commercial_education.record_reviewed_access_terms(text,text,text,text,text,text,text) to commercial_education_operator;

-- The holds an offer's (or an entitlement's) terms raise against the reviewed entry for its version.
create function commercial_education.access_terms_holds(_version text,_duration integer,_billing_kind text) returns text[]
language plpgsql stable security definer set search_path='' as $$
declare _t commercial_education.reviewed_access_terms%rowtype;
begin
 if _version is null then return array[]::text[]; end if;
 select * into _t from commercial_education.reviewed_access_terms where version=_version;
 if not found then return array['access_terms_unreviewed']; end if;
 return array_remove(array[
  case when (_t.duration_policy='indefinite')<>(_duration is null) then 'access_duration_undecided' end,
  case when _t.core_policy<>'not_required' then 'core_dependency_unresolved' end,
  case when _t.refund_policy_ref is null then 'refund_terms_undecided' end,
  case when _billing_kind='recurring' and _t.renewal_policy_ref is null then 'renewal_terms_undecided' end],null);
end $$;
revoke all on function commercial_education.access_terms_holds(text,integer,text) from public;

-- Publication holds (replaced): the parent's holds, with the reviewed-terms holds between the terms and the curriculum.
create or replace function commercial_education.publish_holds(_o commercial_education.program_offers,_current jsonb) returns text[]
language sql stable security definer set search_path='' as $$
 select array_remove(array[
  case when _o.mode='paid' and _o.amount_minor is null then 'no_pricing' end,
  case when _o.mode='paid' and _o.provider_price_ref is null then 'provider_mapping_missing' end,
  case when _o.mode='paid' and _o.provider_price_ref is not null and _o.provider_approved_by is null then 'provider_mapping_unapproved' end,
  case when _o.access_terms_version is null then 'no_access_terms' end],null)
 || commercial_education.access_terms_holds(_o.access_terms_version,_o.access_duration_days,_o.billing_kind)
 || array_remove(array[
  case when _current is null then 'curriculum_unpublished' end,
  case when _current is not null and ((_current->>'versionId')::uuid<>_o.curriculum_version_id or (_current->>'version')::integer<>_o.curriculum_version
   or _current->>'sourceDigest'<>_o.curriculum_source_digest) then 'curriculum_changed' end],null)
$$;
revoke all on function commercial_education.publish_holds(commercial_education.program_offers,jsonb) from public;
-- program_purchase_availability (parent) calls publish_holds by name, so an offer published before a
-- terms entry existed, or whose entry holds, is unavailable with the specific reason from now on.

/* -------------------------------------------------------------- caller identity */

-- The verified consumer subject of this request, or a refusal. Never an argument.
create function commercial_education.caller_consumer_subject() returns text
language plpgsql stable security definer set search_path='' as $$
declare _actor uuid:=clinical_private.actor_person_id(); _subject text:=clinical_private.claim('identity_subject');
begin
 if _actor is null or _subject is null or clinical_private.claim('identity_pool') is distinct from 'consumer'
  or clinical_private.claim('purpose') is distinct from 'clinical_data' or clinical_private.claim('environment') is distinct from 'synthetic-staging'
  or clinical_private.claim('data_classification') is distinct from 'synthetic_only'
  or not exists(select 1 from clinical_core.identities i where i.person_id=_actor and i.identity_pool='consumer' and i.identity_subject=_subject and i.status='active') then
  raise exception using errcode='42501',message='program_entitlement_identity_refused';
 end if;
 return _subject;
end $$;
revoke all on function commercial_education.caller_consumer_subject() from public;

-- A clinician of this clinic, from the workforce request context; the organization argument must be the context's.
create function commercial_education.require_clinic_staff(_organization uuid) returns void
language plpgsql stable security definer set search_path='' as $$
begin
 if clinical_private.claim('identity_pool') is distinct from 'workforce' or clinical_private.organization_id() is distinct from _organization
  or not clinical_private.has_clinical_role(_organization) then
  raise exception using errcode='42501',message='program_entitlement_identity_refused';
 end if;
end $$;
revoke all on function commercial_education.require_clinic_staff(uuid) from public;

/* -------------------------------------------------------------- consumer: own rows only */

-- Claim as the verified caller. Terms that are held refuse activation before anything binds.
create function commercial_education.claim_program_entitlement_for_caller(_token_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _subject text; _c commercial_education.program_claims%rowtype; _e commercial_education.program_entitlements%rowtype; _billing text;
begin
 perform commercial_education.require_activation();
 _subject:=commercial_education.caller_consumer_subject();
 select * into _c from commercial_education.program_claims where token_hash=_token_hash;
 if found and _c.state='issued' and _c.expires_at>clock_timestamp() then
  select * into _e from commercial_education.program_entitlements where id=_c.entitlement_id;
  select o.billing_kind into _billing from commercial_education.program_offers o where o.id=_e.offer_id;
  if _e.state='awaiting_claim' and coalesce(array_length(commercial_education.access_terms_holds(_e.access_terms_version,_e.access_duration_days,_billing),1),0)>0 then
   return jsonb_build_object('outcome','refused','reason','terms_undecided');
  end if;
 end if;
 return commercial_education.claim_program_entitlement(_token_hash,_subject,clock_timestamp());
end $$;
revoke all on function commercial_education.claim_program_entitlement_for_caller(text) from public;
grant execute on function commercial_education.claim_program_entitlement_for_caller(text) to clinical_core_api;

-- The caller's own entitlements and enrollments; the caller's own ended windows are expired first, by the database clock.
create function commercial_education.education_access_for_caller() returns jsonb
language plpgsql security definer set search_path='' as $$
declare _subject text; _e commercial_education.program_entitlements%rowtype;
begin
 perform commercial_education.require_activation();
 _subject:=commercial_education.caller_consumer_subject();
 for _e in select * from commercial_education.program_entitlements where subject_kind='claimed' and consumer_subject=_subject and state='active'
  and window_ends_at is not null and window_ends_at<=clock_timestamp() for update loop
  update commercial_education.program_entitlements set state='expired',revision=revision+1 where id=_e.id;
  insert into commercial_education.program_entitlement_events(entitlement_id,kind) values(_e.id,'expired');
 end loop;
 return commercial_education.education_access(_subject);
end $$;
revoke all on function commercial_education.education_access_for_caller() from public;
grant execute on function commercial_education.education_access_for_caller() to clinical_core_api;

-- One entitlement, only when the caller owns it; null otherwise (another owner's id reveals nothing).
create function commercial_education.own_program_entitlement_for_caller(_entitlement uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare _subject text; _e commercial_education.program_entitlements%rowtype;
begin
 perform commercial_education.require_activation();
 _subject:=commercial_education.caller_consumer_subject();
 select * into _e from commercial_education.program_entitlements where id=_entitlement and subject_kind='claimed' and consumer_subject=_subject;
 if not found then return null; end if;
 return commercial_education.entitlement_json(_e);
end $$;
revoke all on function commercial_education.own_program_entitlement_for_caller(uuid) from public;
grant execute on function commercial_education.own_program_entitlement_for_caller(uuid) to clinical_core_api;

-- The exact purchased curriculum for the caller's own active entitlement, by the database clock.
create function commercial_education.education_curriculum_for_caller(_entitlement uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 perform commercial_education.require_activation();
 return commercial_education.education_curriculum(commercial_education.caller_consumer_subject(),_entitlement,clock_timestamp());
end $$;
revoke all on function commercial_education.education_curriculum_for_caller(uuid) from public;
grant execute on function commercial_education.education_curriculum_for_caller(uuid) to clinical_core_api;

/* -------------------------------------------------------------- staff: their clinic only */

-- Staff status (replaced): the same view, only for a clinician of that clinic in a workforce context.
create or replace function commercial_education.program_education_status(_organization uuid,_program uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare _entitlements jsonb; _enrollments jsonb; _claims jsonb; _orders jsonb;
begin
 perform commercial_education.require_activation();
 perform commercial_education.require_clinic_staff(_organization);
 select coalesce(jsonb_agg(commercial_education.order_json(o) order by o.created_at),'[]'::jsonb) into _orders from commercial_education.program_orders o where o.organization_id=_organization and o.program_id=_program;
 select coalesce(jsonb_agg(commercial_education.entitlement_json(e) order by e.created_at),'[]'::jsonb) into _entitlements from commercial_education.program_entitlements e where e.organization_id=_organization and e.program_id=_program;
 select coalesce(jsonb_agg(commercial_education.enrollment_json(n) order by n.started_at),'[]'::jsonb) into _enrollments from commercial_education.program_education_enrollments n
  join commercial_education.program_entitlements e on e.id=n.entitlement_id where e.organization_id=_organization and e.program_id=_program;
 select coalesce(jsonb_agg(commercial_education.claim_json(c) order by c.issued_at),'[]'::jsonb) into _claims from commercial_education.program_claims c
  join commercial_education.program_entitlements e on e.id=c.entitlement_id where e.organization_id=_organization and e.program_id=_program;
 return jsonb_build_object('orders',_orders,'entitlements',_entitlements,'enrollments',_enrollments,'claims',_claims);
end $$;
revoke all on function commercial_education.program_education_status(uuid,uuid) from public;
grant execute on function commercial_education.program_education_status(uuid,uuid) to clinical_core_api;

/* -------------------------------------------------------------- the visitor's checkout start */

-- The request path's order transitions: recording the creation request and what came back from
-- sending it. A payment outcome is never one of them; that is the worker's observation.
create function commercial_education.advance_program_checkout(_order uuid,_expected integer,_next text,_carry jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 perform commercial_education.require_activation();
 if _next is null or _next not in('creation_pending','creation_unresolved','creation_unreconciled','checkout_open','checkout_expired','refused')
  or (_carry is not null and jsonb_typeof(_carry->'verification')='object') then
  raise exception using errcode='55000',message='program_order_transition_refused';
 end if;
 return commercial_education.transition_program_order(_order,_expected,_next,_carry);
end $$;
revoke all on function commercial_education.advance_program_checkout(uuid,integer,text,jsonb) from public;
grant execute on function commercial_education.advance_program_checkout(uuid,integer,text,jsonb) to clinical_core_api,commercial_education_worker;

/* -------------------------------------------------------------- the worker */

-- A bounded expiry sweep by the database clock: no caller-chosen instant, at most _limit rows.
create function commercial_education.expire_program_entitlements_due(_limit integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _list jsonb:='[]'::jsonb; _e commercial_education.program_entitlements%rowtype;
begin
 perform commercial_education.require_activation();
 for _e in select * from commercial_education.program_entitlements where state='active' and window_ends_at is not null and window_ends_at<=clock_timestamp()
  order by window_ends_at limit greatest(1,least(coalesce(_limit,1),100)) for update loop
  update commercial_education.program_entitlements set state='expired',revision=revision+1 where id=_e.id returning * into _e;
  insert into commercial_education.program_entitlement_events(entitlement_id,kind) values(_e.id,'expired');
  _list:=_list||commercial_education.entitlement_json(_e);
 end loop;
 return _list;
end $$;
revoke all on function commercial_education.expire_program_entitlements_due(integer) from public;
grant execute on function commercial_education.expire_program_entitlements_due(integer) to commercial_education_worker;

grant execute on function commercial_education.read_program_order(uuid) to commercial_education_worker;
grant execute on function commercial_education.find_program_order_by_session(text) to commercial_education_worker;
grant execute on function commercial_education.transition_program_order(uuid,integer,text,jsonb) to commercial_education_worker;
grant execute on function commercial_education.program_orders_in_states(text[],integer) to commercial_education_worker;
grant execute on function commercial_education.checkout_work_status() to commercial_education_worker;
grant execute on function commercial_education.read_checkout_intake(text) to commercial_education_worker;
grant execute on function commercial_education.settle_checkout_intake(text,jsonb) to commercial_education_worker;
grant execute on function commercial_education.due_checkout_intake(timestamptz,integer) to commercial_education_worker;
grant execute on function commercial_education.settle_program_order_sealed(uuid,uuid,text,timestamptz,jsonb,text) to commercial_education_worker;
grant execute on function commercial_education.unsettled_program_orders(integer) to commercial_education_worker;
grant execute on function commercial_education.entitlement_for_order(uuid) to commercial_education_worker;
grant execute on function commercial_education.read_program_entitlement(uuid) to commercial_education_worker;

/* -------------------------------------------------------------- the operator */

grant execute on function commercial_education.record_entitlement_policy(uuid,text,text,timestamptz) to commercial_education_operator;
grant execute on function commercial_education.transition_program_entitlement(uuid,integer,text) to commercial_education_operator;

/* -------------------------------------------------------------- what the API role loses */

revoke execute on function commercial_education.transition_program_order(uuid,integer,text,jsonb) from clinical_core_api;
revoke execute on function commercial_education.find_program_order_by_session(text) from clinical_core_api;
revoke execute on function commercial_education.program_orders_in_states(text[],integer) from clinical_core_api;
revoke execute on function commercial_education.checkout_work_status() from clinical_core_api;
revoke execute on function commercial_education.read_checkout_intake(text) from clinical_core_api;
revoke execute on function commercial_education.settle_checkout_intake(text,jsonb) from clinical_core_api;
revoke execute on function commercial_education.due_checkout_intake(timestamptz,integer) from clinical_core_api;
revoke execute on function commercial_education.settle_program_order_sealed(uuid,uuid,text,timestamptz,jsonb,text) from clinical_core_api;
revoke execute on function commercial_education.unsettled_program_orders(integer) from clinical_core_api;
revoke execute on function commercial_education.claim_program_entitlement(text,text,timestamptz) from clinical_core_api;
revoke execute on function commercial_education.read_program_entitlement(uuid) from clinical_core_api;
revoke execute on function commercial_education.entitlement_for_order(uuid) from clinical_core_api;
revoke execute on function commercial_education.education_access(text) from clinical_core_api;
revoke execute on function commercial_education.education_curriculum(text,uuid,timestamptz) from clinical_core_api;
revoke execute on function commercial_education.record_entitlement_policy(uuid,text,text,timestamptz) from clinical_core_api;
revoke execute on function commercial_education.transition_program_entitlement(uuid,integer,text) from clinical_core_api;
revoke execute on function commercial_education.expire_program_entitlements(timestamptz) from clinical_core_api;
