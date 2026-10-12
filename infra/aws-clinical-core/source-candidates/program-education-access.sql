-- BLOCKED source candidate: education access settlement (program-education-access/1), for
-- Codex's review. Not a schema successor. Not registered in migrations/manifest.json; not
-- applied anywhere; not to be applied until the settlement boundary in
-- src/server/commerce/program-settlement.ts and docs/claude-program-commerce-closure-2026-10-11.md
-- are reviewed. The runtime that would call these functions
-- (src/server/commerce/program-education-ledger-sql.ts) is disabled in source, and every
-- function below refuses until the commercial activation row is enabled by a separately
-- reviewed change.
--
-- Parent assumptions (written against exactly these artifacts; the test refuses to run it if
-- either digest has moved):
--   20260812010000_synthetic_identity_consent.sql
--     sha256 c4ca967352bce6c678249336ef410fe7de4216d123a0d3da06a467379780c445
--     (clinical_core.organizations, clinical_core.identities, clinical_core_api,
--      clinical_private.block_update_delete, the request context claims)
--   source-candidates/program-checkout-orders.sql (BLOCKED, unregistered; applied first, after
--   program-offer-revisions.sql)
--     sha256 767ac13bc111a15b98bdc2978a5e42a33f5f1ab61f010061907787040b0c37ee
--     (commercial_education.program_orders and its verification columns)
-- No historical migration, ledger, binary, privilege, IAM or custody file is changed by this
-- file. No refund, dispute, renewal, retention or deletion policy is decided here: money-related
-- events put an entitlement in a HELD state the operator sees; release and revocation are the
-- operator's recorded decisions.
--
-- What the ledger holds and refuses:
--   * one entitlement per order (unique), created only from an order that is payment_verified,
--     paid, from the expected test-mode account; the terms are copied from the order and are
--     immutable; it starts awaiting_claim with no subject;
--   * one or more claims per entitlement, each a token HASH with an expiry, single-use; using a
--     claim binds the subject, opens the window from the saved duration and creates the one
--     enrollment, in one transaction; a used, expired or superseded claim changes nothing;
--   * the subject, once bound, is immutable: nobody re-claims, nobody transfers;
--   * transitions follow the table in the contract; expired and revoked are final; nothing
--     returns to awaiting_claim except an operator release of a never-claimed entitlement;
--   * policy events are append-only with their reference; the entitlement's last event is
--     denormalized for the status view;
--   * the access read returns one subject's own rows; the curriculum read serves the EXACT
--     purchased version (id, number, digest) from the published version table, or withholds;
--   * the API role executes the reviewed functions and touches no table; no clinical function
--     reads this schema; no column names a person, an email, a card or a health fact. The
--     consumer subject is the identity API's opaque subject.

create table commercial_education.program_entitlements(
 id uuid primary key default public.gen_random_uuid(),
 order_id uuid not null unique references commercial_education.program_orders(id),
 organization_id uuid not null references clinical_core.organizations(id),
 program_id uuid not null,
 offer_id uuid not null,
 offer_revision integer not null check(offer_revision>=1),
 curriculum_version_id uuid not null,
 curriculum_version integer not null check(curriculum_version>0),
 curriculum_source_digest text not null check(curriculum_source_digest ~ '^[a-f0-9]{64}$'),
 access_terms_version text not null check(access_terms_version ~ '^education-access-terms/[1-9][0-9]{0,3}$'),
 access_duration_days integer check(access_duration_days is null or (access_duration_days between 1 and 3650)),
 subject_kind text not null default 'unclaimed' check(subject_kind in('unclaimed','claimed')),
 consumer_subject text check(consumer_subject is null or consumer_subject ~ '^[A-Za-z0-9:_-]{8,128}$'),
 claimed_at timestamptz,
 state text not null default 'awaiting_claim' check(state in('awaiting_claim','active','expired','held_refund','held_dispute','held_policy','revoked')),
 revision integer not null default 1 check(revision>=1),
 window_starts_at timestamptz,
 window_ends_at timestamptz,
 verification_event_id text check(verification_event_id is null or verification_event_id ~ '^[A-Za-z0-9_.:-]{3,255}$'),
 settled_at timestamptz not null default clock_timestamp(),
 policy_kind text check(policy_kind is null or policy_kind in('refund','dispute','chargeback','renewal_cancelled','renewal_payment_failed','operator_release','operator_revoke')),
 policy_reference text check(policy_reference is null or policy_reference ~ '^[A-Za-z0-9_.:-]{1,255}$'),
 policy_recorded_at timestamptz,
 created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(),
 constraint program_entitlements_subject_whole check((subject_kind='claimed')=(consumer_subject is not null) and (subject_kind='claimed')=(claimed_at is not null)),
 constraint program_entitlements_window_whole check((window_starts_at is null)=(subject_kind='unclaimed')),
 constraint program_entitlements_window_order check(window_ends_at is null or window_ends_at>window_starts_at),
 constraint program_entitlements_window_from_duration check(window_starts_at is null or (access_duration_days is null)=(window_ends_at is null)),
 constraint program_entitlements_active_claimed check(state<>'active' or subject_kind='claimed'),
 constraint program_entitlements_awaiting_unclaimed check(state<>'awaiting_claim' or subject_kind='unclaimed'),
 constraint program_entitlements_policy_whole check((policy_kind is null)=(policy_reference is null) and (policy_kind is null)=(policy_recorded_at is null))
);
create index program_entitlements_subject_idx on commercial_education.program_entitlements(consumer_subject) where consumer_subject is not null;
create index program_entitlements_program_idx on commercial_education.program_entitlements(organization_id,program_id);
alter table commercial_education.program_entitlements enable row level security;
alter table commercial_education.program_entitlements force row level security;
revoke all on commercial_education.program_entitlements from public,clinical_core_api;

create table commercial_education.program_claims(
 id uuid primary key default public.gen_random_uuid(),
 entitlement_id uuid not null references commercial_education.program_entitlements(id),
 token_hash text not null unique check(token_hash ~ '^[a-f0-9]{64}$'),
 issued_at timestamptz not null default clock_timestamp(),
 expires_at timestamptz not null,
 state text not null default 'issued' check(state in('issued','used','expired','superseded')),
 used_at timestamptz,
 used_by text check(used_by is null or used_by ~ '^[A-Za-z0-9:_-]{8,128}$'),
 constraint program_claims_expiry_after_issue check(expires_at>issued_at),
 constraint program_claims_used_whole check((state='used')=(used_at is not null) and (state='used')=(used_by is not null))
);
create unique index program_claims_one_issued on commercial_education.program_claims(entitlement_id) where state='issued';
alter table commercial_education.program_claims enable row level security;
alter table commercial_education.program_claims force row level security;
revoke all on commercial_education.program_claims from public,clinical_core_api;

create table commercial_education.program_education_enrollments(
 id uuid primary key default public.gen_random_uuid(),
 entitlement_id uuid not null unique references commercial_education.program_entitlements(id),
 consumer_subject text not null check(consumer_subject ~ '^[A-Za-z0-9:_-]{8,128}$'),
 curriculum_version_id uuid not null,
 curriculum_version integer not null check(curriculum_version>0),
 curriculum_source_digest text not null check(curriculum_source_digest ~ '^[a-f0-9]{64}$'),
 state text not null default 'active' check(state in('active','paused','completed','withdrawn','withheld')),
 revision integer not null default 1 check(revision>=1),
 phase_index integer not null default 0 check(phase_index>=0),
 started_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp()
);
alter table commercial_education.program_education_enrollments enable row level security;
alter table commercial_education.program_education_enrollments force row level security;
revoke all on commercial_education.program_education_enrollments from public,clinical_core_api;

create table commercial_education.program_entitlement_events(
 id bigint generated always as identity primary key,
 entitlement_id uuid not null references commercial_education.program_entitlements(id),
 kind text not null check(kind in('settled','claimed','expired','transition','refund','dispute','chargeback','renewal_cancelled','renewal_payment_failed','operator_release','operator_revoke')),
 reference text check(reference is null or char_length(reference)<=255),
 recorded_at timestamptz not null default clock_timestamp()
);
alter table commercial_education.program_entitlement_events enable row level security;
alter table commercial_education.program_entitlement_events force row level security;
revoke all on commercial_education.program_entitlement_events from public,clinical_core_api;
create trigger program_entitlement_events_append_only before update or delete on commercial_education.program_entitlement_events
 for each row execute function clinical_private.block_update_delete();

create function commercial_education.protect_program_entitlement() returns trigger
language plpgsql security invoker set search_path='' as $$
declare _allowed text[]; _order commercial_education.program_orders%rowtype;
begin
 if tg_op='DELETE' then raise exception using errcode='55000',message='program_entitlement_append_only'; end if;
 if tg_op='INSERT' then
  if new.revision<>1 or new.state<>'awaiting_claim' or new.subject_kind<>'unclaimed' then raise exception using errcode='55000',message='program_entitlement_insert_shape'; end if;
  select * into _order from commercial_education.program_orders where id=new.order_id;
  if not found or _order.state<>'payment_verified' or _order.verified_payment_status<>'paid' then raise exception using errcode='55000',message='program_entitlement_order_not_verified'; end if;
  if _order.organization_id<>new.organization_id or _order.program_id<>new.program_id or _order.offer_id<>new.offer_id or _order.offer_revision<>new.offer_revision
   or _order.curriculum_version_id<>new.curriculum_version_id or _order.curriculum_version<>new.curriculum_version or _order.curriculum_source_digest<>new.curriculum_source_digest
   or _order.access_terms_version<>new.access_terms_version or _order.access_duration_days is distinct from new.access_duration_days
   or new.verification_event_id is distinct from _order.verified_event_id then
   raise exception using errcode='55000',message='program_entitlement_snapshot_mismatch';
  end if;
  new.updated_at:=clock_timestamp();
  return new;
 end if;
 if new.id<>old.id or new.order_id<>old.order_id or new.organization_id<>old.organization_id or new.program_id<>old.program_id or new.offer_id<>old.offer_id
  or new.offer_revision<>old.offer_revision or new.curriculum_version_id<>old.curriculum_version_id or new.curriculum_source_digest<>old.curriculum_source_digest
  or new.access_terms_version<>old.access_terms_version or new.access_duration_days is distinct from old.access_duration_days or new.settled_at<>old.settled_at
  or new.verification_event_id is distinct from old.verification_event_id or new.created_at<>old.created_at then
  raise exception using errcode='55000',message='program_entitlement_identity_immutable';
 end if;
 if old.subject_kind='claimed' and (new.subject_kind<>'claimed' or new.consumer_subject<>old.consumer_subject or new.claimed_at<>old.claimed_at or new.window_starts_at<>old.window_starts_at or new.window_ends_at is distinct from old.window_ends_at) then
  raise exception using errcode='55000',message='program_entitlement_subject_immutable';
 end if;
 if new.revision<>old.revision+1 then raise exception using errcode='55000',message='program_entitlement_revision_must_increase'; end if;
 _allowed:=case old.state when 'awaiting_claim' then array['active','held_refund','held_dispute','held_policy','revoked','expired']
  when 'active' then array['expired','held_refund','held_dispute','held_policy','revoked']
  when 'held_refund' then array['active','revoked','expired','awaiting_claim'] when 'held_dispute' then array['active','revoked','expired','awaiting_claim'] when 'held_policy' then array['active','revoked','expired','awaiting_claim']
  else array[]::text[] end;
 if new.state<>old.state and not (new.state=any(_allowed)) then raise exception using errcode='55000',message='program_entitlement_transition_refused'; end if;
 if new.state='awaiting_claim' and old.state<>'awaiting_claim' and old.subject_kind='claimed' then raise exception using errcode='55000',message='program_entitlement_transition_refused'; end if;
 if new.state=old.state and new.policy_kind is not distinct from old.policy_kind and new.policy_reference is not distinct from old.policy_reference then
  raise exception using errcode='55000',message='program_entitlement_transition_refused';
 end if;
 new.updated_at:=clock_timestamp();
 return new;
end $$;
revoke all on function commercial_education.protect_program_entitlement() from public;
create trigger program_entitlements_protect before insert or update or delete on commercial_education.program_entitlements
 for each row execute function commercial_education.protect_program_entitlement();

create function commercial_education.protect_program_claim() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if tg_op='DELETE' then raise exception using errcode='55000',message='program_claim_append_only'; end if;
 if tg_op='INSERT' then
  if new.state<>'issued' then raise exception using errcode='55000',message='program_claim_insert_shape'; end if;
  return new;
 end if;
 if new.id<>old.id or new.entitlement_id<>old.entitlement_id or new.token_hash<>old.token_hash or new.issued_at<>old.issued_at or new.expires_at<>old.expires_at then
  raise exception using errcode='55000',message='program_claim_identity_immutable';
 end if;
 if old.state<>'issued' then raise exception using errcode='55000',message='program_claim_settled'; end if;
 return new;
end $$;
revoke all on function commercial_education.protect_program_claim() from public;
create trigger program_claims_protect before insert or update or delete on commercial_education.program_claims
 for each row execute function commercial_education.protect_program_claim();

create function commercial_education.entitlement_json(_e commercial_education.program_entitlements) returns jsonb
language sql immutable set search_path='' as $$
 select jsonb_build_object('contract','program-education-access/1','entitlementId',_e.id,'orderId',_e.order_id,'organizationId',_e.organization_id,'programId',_e.program_id,
  'offerId',_e.offer_id,'offerRevision',_e.offer_revision,
  'curriculum',jsonb_build_object('versionId',_e.curriculum_version_id,'version',_e.curriculum_version,'sourceDigest',_e.curriculum_source_digest),
  'accessTermsVersion',_e.access_terms_version,'accessDurationDays',_e.access_duration_days,
  'subject',case when _e.subject_kind='claimed' then jsonb_build_object('kind','claimed','consumerSubject',_e.consumer_subject,'claimedAt',_e.claimed_at) else jsonb_build_object('kind','unclaimed') end,
  'state',_e.state,'revision',_e.revision,
  'window',case when _e.window_starts_at is null then null else jsonb_build_object('startsAt',_e.window_starts_at,'endsAt',_e.window_ends_at) end,
  'settlement',jsonb_build_object('verificationEventId',_e.verification_event_id,'settledAt',_e.settled_at),
  'policy',case when _e.policy_kind is null then null else jsonb_build_object('kind',_e.policy_kind,'reference',_e.policy_reference,'recordedAt',_e.policy_recorded_at) end,
  'createdAt',_e.created_at,'updatedAt',_e.updated_at)
$$;
revoke all on function commercial_education.entitlement_json(commercial_education.program_entitlements) from public;

create function commercial_education.claim_json(_c commercial_education.program_claims) returns jsonb
language sql immutable set search_path='' as $$
 select jsonb_build_object('claimId',_c.id,'entitlementId',_c.entitlement_id,'tokenHash',_c.token_hash,'issuedAt',_c.issued_at,'expiresAt',_c.expires_at,'state',_c.state,'usedAt',_c.used_at,'usedBy',_c.used_by)
$$;
revoke all on function commercial_education.claim_json(commercial_education.program_claims) from public;

create function commercial_education.enrollment_json(_n commercial_education.program_education_enrollments) returns jsonb
language sql immutable set search_path='' as $$
 select jsonb_build_object('enrollmentId',_n.id,'entitlementId',_n.entitlement_id,'consumerSubject',_n.consumer_subject,
  'curriculum',jsonb_build_object('versionId',_n.curriculum_version_id,'version',_n.curriculum_version,'sourceDigest',_n.curriculum_source_digest),
  'state',_n.state,'revision',_n.revision,'phaseIndex',_n.phase_index,'startedAt',_n.started_at,'updatedAt',_n.updated_at)
$$;
revoke all on function commercial_education.enrollment_json(commercial_education.program_education_enrollments) from public;

-- Settlement: idempotent per order. The order is re-read here; the caller's copy is not evidence.
create function commercial_education.settle_program_order(_order uuid,_token_hash text,_claim_expires_at timestamptz,_expected_account text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _o commercial_education.program_orders%rowtype; _e commercial_education.program_entitlements%rowtype; _c commercial_education.program_claims%rowtype;
begin
 perform commercial_education.require_activation();
 select * into _e from commercial_education.program_entitlements where order_id=_order;
 if found then
  select * into _c from commercial_education.program_claims where entitlement_id=_e.id order by (state='issued') desc,issued_at desc limit 1;
  return jsonb_build_object('created',false,'entitlement',commercial_education.entitlement_json(_e),'claim',commercial_education.claim_json(_c));
 end if;
 select * into _o from commercial_education.program_orders where id=_order for update;
 if not found or _o.state<>'payment_verified' or _o.verified_at is null then raise exception using errcode='55000',message='program_entitlement_settlement_refused:order_not_verified'; end if;
 if _o.verified_payment_status<>'paid' then raise exception using errcode='55000',message='program_entitlement_settlement_refused:payment_not_paid'; end if;
 if _o.verified_account_ref is distinct from _expected_account then raise exception using errcode='55000',message='program_entitlement_settlement_refused:account_mismatch'; end if;
 insert into commercial_education.program_entitlements(order_id,organization_id,program_id,offer_id,offer_revision,curriculum_version_id,curriculum_version,curriculum_source_digest,access_terms_version,access_duration_days,verification_event_id)
  values(_o.id,_o.organization_id,_o.program_id,_o.offer_id,_o.offer_revision,_o.curriculum_version_id,_o.curriculum_version,_o.curriculum_source_digest,_o.access_terms_version,_o.access_duration_days,_o.verified_event_id)
  returning * into _e;
 insert into commercial_education.program_claims(entitlement_id,token_hash,expires_at) values(_e.id,_token_hash,_claim_expires_at) returning * into _c;
 insert into commercial_education.program_entitlement_events(entitlement_id,kind,reference) values(_e.id,'settled',_o.id::text);
 return jsonb_build_object('created',true,'entitlement',commercial_education.entitlement_json(_e),'claim',commercial_education.claim_json(_c));
end $$;
revoke all on function commercial_education.settle_program_order(uuid,text,timestamptz,text) from public;
grant execute on function commercial_education.settle_program_order(uuid,text,timestamptz,text) to clinical_core_api;

create function commercial_education.unsettled_program_orders(_limit integer) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare _list jsonb;
begin
 perform commercial_education.require_activation();
 select coalesce(jsonb_agg(commercial_education.order_json(o) order by o.verified_at),'[]'::jsonb) into _list
  from (select * from commercial_education.program_orders o where o.state='payment_verified' and o.verified_payment_status='paid'
   and not exists(select 1 from commercial_education.program_entitlements e where e.order_id=o.id) order by o.verified_at limit greatest(1,least(_limit,100))) o;
 return _list;
end $$;
revoke all on function commercial_education.unsettled_program_orders(integer) from public;
grant execute on function commercial_education.unsettled_program_orders(integer) to clinical_core_api;

-- The claim: one step binds the subject, opens the window and creates the enrollment.
create function commercial_education.claim_program_entitlement(_token_hash text,_consumer_subject text,_at timestamptz) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _c commercial_education.program_claims%rowtype; _e commercial_education.program_entitlements%rowtype; _n commercial_education.program_education_enrollments%rowtype;
begin
 perform commercial_education.require_activation();
 select * into _c from commercial_education.program_claims where token_hash=_token_hash for update;
 if not found then return jsonb_build_object('outcome','refused','reason','claim_invalid'); end if;
 select * into _e from commercial_education.program_entitlements where id=_c.entitlement_id for update;
 if _c.state='used' then return jsonb_build_object('outcome','refused','reason',case when _e.subject_kind='claimed' and _e.consumer_subject<>_consumer_subject then 'already_claimed_by_other' else 'claim_used' end); end if;
 if _c.state='superseded' then return jsonb_build_object('outcome','refused','reason','claim_superseded'); end if;
 if _c.state='expired' or _c.expires_at<=_at then
  if _c.state='issued' then update commercial_education.program_claims set state='expired' where id=_c.id; end if;
  return jsonb_build_object('outcome','refused','reason','claim_expired');
 end if;
 if _e.state<>'awaiting_claim' or _e.subject_kind<>'unclaimed' then
  return jsonb_build_object('outcome','refused','reason',case when _e.subject_kind='claimed' and _e.consumer_subject<>_consumer_subject then 'already_claimed_by_other' else 'entitlement_not_claimable' end);
 end if;
 update commercial_education.program_entitlements set state='active',revision=revision+1,subject_kind='claimed',consumer_subject=_consumer_subject,claimed_at=_at,
  window_starts_at=_at,window_ends_at=case when access_duration_days is null then null else _at+make_interval(days=>access_duration_days) end where id=_e.id returning * into _e;
 update commercial_education.program_claims set state='used',used_at=_at,used_by=_consumer_subject where id=_c.id;
 insert into commercial_education.program_education_enrollments(entitlement_id,consumer_subject,curriculum_version_id,curriculum_version,curriculum_source_digest,started_at,updated_at)
  values(_e.id,_consumer_subject,_e.curriculum_version_id,_e.curriculum_version,_e.curriculum_source_digest,_at,_at) returning * into _n;
 insert into commercial_education.program_entitlement_events(entitlement_id,kind) values(_e.id,'claimed');
 return jsonb_build_object('outcome','claimed','entitlement',commercial_education.entitlement_json(_e),'enrollment',commercial_education.enrollment_json(_n));
end $$;
revoke all on function commercial_education.claim_program_entitlement(text,text,timestamptz) from public;
grant execute on function commercial_education.claim_program_entitlement(text,text,timestamptz) to clinical_core_api;

create function commercial_education.read_program_entitlement(_entitlement uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare _e commercial_education.program_entitlements%rowtype;
begin
 perform commercial_education.require_activation();
 select * into _e from commercial_education.program_entitlements where id=_entitlement;
 if not found then return null; end if;
 return commercial_education.entitlement_json(_e);
end $$;
revoke all on function commercial_education.read_program_entitlement(uuid) from public;
grant execute on function commercial_education.read_program_entitlement(uuid) to clinical_core_api;

create function commercial_education.entitlement_for_order(_order uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare _e commercial_education.program_entitlements%rowtype;
begin
 perform commercial_education.require_activation();
 select * into _e from commercial_education.program_entitlements where order_id=_order;
 if not found then return null; end if;
 return commercial_education.entitlement_json(_e);
end $$;
revoke all on function commercial_education.entitlement_for_order(uuid) from public;
grant execute on function commercial_education.entitlement_for_order(uuid) to clinical_core_api;

-- The owner's own rows. The subject is the identity API's verified subject, passed by the service, never by a body.
create function commercial_education.education_access(_consumer_subject text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare _entitlements jsonb; _enrollments jsonb;
begin
 perform commercial_education.require_activation();
 select coalesce(jsonb_agg(commercial_education.entitlement_json(e) order by e.created_at),'[]'::jsonb) into _entitlements
  from commercial_education.program_entitlements e where e.subject_kind='claimed' and e.consumer_subject=_consumer_subject;
 select coalesce(jsonb_agg(commercial_education.enrollment_json(n) order by n.started_at),'[]'::jsonb) into _enrollments
  from commercial_education.program_education_enrollments n where n.consumer_subject=_consumer_subject;
 return jsonb_build_object('entitlements',_entitlements,'enrollments',_enrollments);
end $$;
revoke all on function commercial_education.education_access(text) from public;
grant execute on function commercial_education.education_access(text) to clinical_core_api;

-- The exact purchased curriculum: the pinned version, re-digested, served only to the active owner.
create function commercial_education.education_curriculum(_consumer_subject text,_entitlement uuid,_at timestamptz) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare _e commercial_education.program_entitlements%rowtype; _v clinical_core.synthetic_desktop_program_versions%rowtype; _items jsonb; _digest text;
begin
 perform commercial_education.require_activation();
 select * into _e from commercial_education.program_entitlements where id=_entitlement;
 if not found or _e.subject_kind<>'claimed' or _e.consumer_subject<>_consumer_subject then return jsonb_build_object('outcome','withheld','entitlementId',_entitlement,'reason','not_owner'); end if;
 if _e.state<>'active' or _e.window_starts_at>_at or (_e.window_ends_at is not null and _e.window_ends_at<=_at) then return jsonb_build_object('outcome','withheld','entitlementId',_entitlement,'reason','not_active'); end if;
 select * into _v from clinical_core.synthetic_desktop_program_versions where id=_e.curriculum_version_id and version=_e.curriculum_version;
 if not found then return jsonb_build_object('outcome','withheld','entitlementId',_entitlement,'reason','version_missing'); end if;
 _items:=clinical_private.program_consumer_content(_v.content);
 if _items is null then return jsonb_build_object('outcome','withheld','entitlementId',_entitlement,'reason','version_missing'); end if;
 _digest:=encode(public.digest(convert_to((_items->'phases')::text,'UTF8'),'sha256'),'hex');
 if _digest<>_e.curriculum_source_digest then return jsonb_build_object('outcome','withheld','entitlementId',_entitlement,'reason','digest_mismatch'); end if;
 return jsonb_build_object('outcome','served','entitlementId',_entitlement,
  'curriculum',jsonb_build_object('versionId',_e.curriculum_version_id,'version',_e.curriculum_version,'sourceDigest',_e.curriculum_source_digest),
  'title',_items->>'title','phases',_items->'phases');
end $$;
revoke all on function commercial_education.education_curriculum(text,uuid,timestamptz) from public;
grant execute on function commercial_education.education_curriculum(text,uuid,timestamptz) to clinical_core_api;

-- Policy: every money-related kind is a hold; release and revoke are recorded operator decisions.
create function commercial_education.record_entitlement_policy(_order uuid,_kind text,_reference text,_at timestamptz) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _e commercial_education.program_entitlements%rowtype; _target text;
begin
 perform commercial_education.require_activation();
 select * into _e from commercial_education.program_entitlements where order_id=_order for update;
 if not found then raise exception using errcode='P0002',message='program_entitlement_not_found'; end if;
 _target:=case _kind when 'refund' then 'held_refund' when 'dispute' then 'held_dispute' when 'chargeback' then 'held_dispute'
  when 'renewal_cancelled' then 'held_policy' when 'renewal_payment_failed' then 'held_policy'
  when 'operator_release' then case when _e.subject_kind='claimed' then 'active' else 'awaiting_claim' end when 'operator_revoke' then 'revoked' end;
 if _target is null then raise exception using errcode='22023',message='program_entitlement_request_invalid'; end if;
 insert into commercial_education.program_entitlement_events(entitlement_id,kind,reference) values(_e.id,_kind,_reference);
 if _e.state=_target then
  update commercial_education.program_entitlements set revision=revision+1,policy_kind=_kind,policy_reference=_reference,policy_recorded_at=_at where id=_e.id returning * into _e;
 else
  update commercial_education.program_entitlements set state=_target,revision=revision+1,policy_kind=_kind,policy_reference=_reference,policy_recorded_at=_at where id=_e.id returning * into _e;
 end if;
 return commercial_education.entitlement_json(_e);
end $$;
revoke all on function commercial_education.record_entitlement_policy(uuid,text,text,timestamptz) from public;
grant execute on function commercial_education.record_entitlement_policy(uuid,text,text,timestamptz) to clinical_core_api;

create function commercial_education.transition_program_entitlement(_entitlement uuid,_expected integer,_next text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _e commercial_education.program_entitlements%rowtype;
begin
 perform commercial_education.require_activation();
 select * into _e from commercial_education.program_entitlements where id=_entitlement for update;
 if not found then raise exception using errcode='P0002',message='program_entitlement_not_found'; end if;
 if _e.revision<>_expected then raise exception using errcode='55000',message='program_entitlement_revision_stale'; end if;
 update commercial_education.program_entitlements set state=_next,revision=revision+1 where id=_e.id returning * into _e;
 insert into commercial_education.program_entitlement_events(entitlement_id,kind,reference) values(_e.id,'transition',_next);
 return commercial_education.entitlement_json(_e);
end $$;
revoke all on function commercial_education.transition_program_entitlement(uuid,integer,text) from public;
grant execute on function commercial_education.transition_program_entitlement(uuid,integer,text) to clinical_core_api;

create function commercial_education.expire_program_entitlements(_at timestamptz) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _list jsonb; _e commercial_education.program_entitlements%rowtype;
begin
 perform commercial_education.require_activation();
 _list:='[]'::jsonb;
 for _e in select * from commercial_education.program_entitlements where state='active' and window_ends_at is not null and window_ends_at<=_at order by window_ends_at for update loop
  update commercial_education.program_entitlements set state='expired',revision=revision+1 where id=_e.id returning * into _e;
  insert into commercial_education.program_entitlement_events(entitlement_id,kind) values(_e.id,'expired');
  _list:=_list||commercial_education.entitlement_json(_e);
 end loop;
 return _list;
end $$;
revoke all on function commercial_education.expire_program_entitlements(timestamptz) from public;
grant execute on function commercial_education.expire_program_entitlements(timestamptz) to clinical_core_api;

-- The staff status view for one clinic's program: every state, claims by state, enrollments; the subject only in its opaque form.
create function commercial_education.program_education_status(_organization uuid,_program uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare _entitlements jsonb; _enrollments jsonb; _claims jsonb;
begin
 perform commercial_education.require_activation();
 select coalesce(jsonb_agg(commercial_education.entitlement_json(e) order by e.created_at),'[]'::jsonb) into _entitlements from commercial_education.program_entitlements e where e.organization_id=_organization and e.program_id=_program;
 select coalesce(jsonb_agg(commercial_education.enrollment_json(n) order by n.started_at),'[]'::jsonb) into _enrollments from commercial_education.program_education_enrollments n
  join commercial_education.program_entitlements e on e.id=n.entitlement_id where e.organization_id=_organization and e.program_id=_program;
 select coalesce(jsonb_agg(commercial_education.claim_json(c) order by c.issued_at),'[]'::jsonb) into _claims from commercial_education.program_claims c
  join commercial_education.program_entitlements e on e.id=c.entitlement_id where e.organization_id=_organization and e.program_id=_program;
 return jsonb_build_object('entitlements',_entitlements,'enrollments',_enrollments,'claims',_claims);
end $$;
revoke all on function commercial_education.program_education_status(uuid,uuid) from public;
grant execute on function commercial_education.program_education_status(uuid,uuid) to clinical_core_api;
