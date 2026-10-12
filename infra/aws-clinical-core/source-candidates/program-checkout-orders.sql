-- BLOCKED source candidate: program checkout orders and webhook intake (program-checkout/1),
-- for Codex's review. Not a schema successor. Not registered in migrations/manifest.json;
-- not applied anywhere; not to be applied until the checkout boundary in
-- src/server/commerce/program-checkout.ts and docs/claude-program-commerce-closure-2026-10-11.md
-- are reviewed. The runtime that would call these functions
-- (src/server/commerce/program-checkout-ledger-sql.ts) is disabled in source: it is constructed
-- only with activation evidence naming this file's digest, and every function below refuses
-- until the commercial activation row (program-offer-revisions.sql) is enabled by a separately
-- reviewed change.
--
-- Parent assumptions (written against exactly these artifacts; the test refuses to run it if
-- either digest has moved):
--   20260812010000_synthetic_identity_consent.sql
--     sha256 c4ca967352bce6c678249336ef410fe7de4216d123a0d3da06a467379780c445
--     (clinical_core.organizations, clinical_core_api, clinical_private.block_update_delete)
--   source-candidates/program-offer-revisions.sql (BLOCKED, unregistered; applied first)
--     sha256 4973461564e6812906403525cb3aa109d6fd569eec159c9400fcf568a90b321f
--     (commercial_education schema, program_commerce_activation, program_offers)
-- No historical migration, ledger, binary, privilege, IAM or custody file is changed by this
-- file. No price, provider account, refund policy or fulfilment is decided here: the order
-- vocabulary ends at payment verification, and settlement is a later candidate.
--
-- What the ledger holds and refuses:
--   * an order is admitted with its terms snapshot (offer revision, curriculum, pricing, price
--     reference, access terms, duration) copied from the offer at admission and immutable after;
--     while an order is admitted, open or unresolved, the same attempt key cannot admit a second
--     order for the same offer revision;
--   * a processor binding is recorded once and names return destinations on the configured
--     public https origin at the opaque /buy/return path (naming no program) with the order id
--     and outcome as the only keys;
--   * verification is recorded once and only together with the payment_verified or
--     payment_failed transition; the amount, currency and session it names must equal the
--     snapshot and the binding;
--   * every change raises the revision by one and follows the transition table; terminal states
--     are terminal; the subject binding is immutable here (claiming is a later candidate);
--   * intake is one row per event id, admitted pending, settled by bounded attempts; a settled
--     row cannot be reopened; the raw body digest, account and API version are kept as received;
--   * nothing here names a person: the subject is 'unclaimed'; no email, name, card or health
--     column exists, and the test asserts none is added.

create table commercial_education.program_orders(
 id uuid primary key default public.gen_random_uuid(),
 organization_id uuid not null references clinical_core.organizations(id),
 program_id uuid not null,
 offer_id uuid not null,
 offer_revision integer not null check(offer_revision>=1),
 funnel_slug text not null check(funnel_slug ~ '^[a-z0-9][a-z0-9-]{2,79}$'),
 curriculum_version_id uuid not null,
 curriculum_version integer not null check(curriculum_version>0),
 curriculum_source_digest text not null check(curriculum_source_digest ~ '^[a-f0-9]{64}$'),
 currency text not null check(currency in('USD')),
 amount_minor integer not null check(amount_minor between 1 and 1000000),
 billing_kind text not null check(billing_kind in('one_time','recurring')),
 billing_interval text check(billing_interval is null or billing_interval in('month','year')),
 billing_interval_count integer check(billing_interval_count is null or (billing_interval_count between 1 and 12)),
 provider_price_ref text not null check(provider_price_ref ~ '^price_[A-Za-z0-9]{8,64}$'),
 access_terms_version text not null check(access_terms_version ~ '^education-access-terms/[1-9][0-9]{0,3}$'),
 access_duration_days integer check(access_duration_days is null or (access_duration_days between 1 and 3650)),
 attempt_key_hash text not null check(attempt_key_hash ~ '^[a-f0-9]{64}$'),
 subject_kind text not null default 'unclaimed' check(subject_kind in('unclaimed')),
 state text not null default 'admitted' check(state in('admitted','checkout_open','creation_unresolved','checkout_expired','checkout_cancelled','payment_verified','payment_failed','refused')),
 revision integer not null default 1 check(revision>=1),
 session_ref text check(session_ref is null or session_ref ~ '^cs_test_[A-Za-z0-9]{8,200}$'),
 session_expires_at timestamptz,
 return_success text check(return_success is null or return_success ~ '^https://[^/?#]+/buy/return\?order=[0-9a-f-]{36}&returned=success$'),
 return_cancel text check(return_cancel is null or return_cancel ~ '^https://[^/?#]+/buy/return\?order=[0-9a-f-]{36}&returned=cancel$'),
 verified_event_id text check(verified_event_id is null or verified_event_id ~ '^[A-Za-z0-9_.:-]{3,255}$'),
 verified_amount_minor integer check(verified_amount_minor is null or verified_amount_minor>=0),
 verified_currency text check(verified_currency is null or verified_currency in('USD')),
 verified_payment_status text check(verified_payment_status is null or verified_payment_status in('paid','unpaid','no_payment_required')),
 verified_account_ref text check(verified_account_ref is null or verified_account_ref ~ '^acct_[A-Za-z0-9]{8,64}$'),
 verified_at timestamptz,
 created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(),
 foreign key(offer_id,organization_id) references commercial_education.program_offers(id,organization_id),
 constraint program_orders_billing_recurring check(billing_kind<>'recurring' or (billing_interval is not null and billing_interval_count is not null)),
 constraint program_orders_billing_one_time check(billing_kind<>'one_time' or (billing_interval is null and billing_interval_count is null)),
 constraint program_orders_session_whole check((session_ref is null)=(session_expires_at is null) and (session_ref is null)=(return_success is null) and (session_ref is null)=(return_cancel is null)),
 constraint program_orders_open_needs_session check(state<>'checkout_open' or session_ref is not null),
 constraint program_orders_verification_whole check((verified_at is null)=(verified_amount_minor is null) and (verified_at is null)=(verified_currency is null) and (verified_at is null)=(verified_payment_status is null) and (verified_at is null)=(verified_account_ref is null)),
 constraint program_orders_verified_states check((state in('payment_verified','payment_failed'))=(verified_at is not null)),
 constraint program_orders_verified_binds_snapshot check(verified_at is null or (verified_currency=currency and (state<>'payment_verified' or verified_amount_minor=amount_minor) and session_ref is not null)),
 constraint program_orders_return_names_order check(return_success is null or (position(id::text in return_success)>0 and position(id::text in return_cancel)>0))
);
create unique index program_orders_one_open_per_attempt on commercial_education.program_orders(attempt_key_hash,offer_id,offer_revision) where state in('admitted','checkout_open','creation_unresolved');
create unique index program_orders_one_per_session on commercial_education.program_orders(session_ref) where session_ref is not null;
alter table commercial_education.program_orders enable row level security;
alter table commercial_education.program_orders force row level security;
revoke all on commercial_education.program_orders from public,clinical_core_api;

create function commercial_education.protect_program_order() returns trigger
language plpgsql security invoker set search_path='' as $$
declare _allowed text[];
begin
 if tg_op='DELETE' then raise exception using errcode='55000',message='program_order_append_only'; end if;
 if tg_op='INSERT' then
  if new.revision<>1 or new.state<>'admitted' or new.session_ref is not null or new.verified_at is not null then raise exception using errcode='55000',message='program_order_insert_shape'; end if;
  if not exists(select 1 from commercial_education.program_offers o where o.id=new.offer_id and o.organization_id=new.organization_id and o.program_id=new.program_id and o.revision=new.offer_revision and o.state='published' and o.mode='paid'
   and o.curriculum_version_id=new.curriculum_version_id and o.curriculum_version=new.curriculum_version and o.curriculum_source_digest=new.curriculum_source_digest
   and o.currency=new.currency and o.amount_minor=new.amount_minor and o.billing_kind=new.billing_kind and o.billing_interval is not distinct from new.billing_interval
   and o.billing_interval_count is not distinct from new.billing_interval_count and o.provider_price_ref=new.provider_price_ref and o.provider_approved_by is not null
   and o.access_terms_version=new.access_terms_version and o.access_duration_days is not distinct from new.access_duration_days) then
   raise exception using errcode='55000',message='program_order_snapshot_mismatch';
  end if;
  new.updated_at:=clock_timestamp();
  return new;
 end if;
 if new.id<>old.id or new.organization_id<>old.organization_id or new.program_id<>old.program_id or new.offer_id<>old.offer_id or new.offer_revision<>old.offer_revision
  or new.funnel_slug<>old.funnel_slug or new.curriculum_version_id<>old.curriculum_version_id or new.curriculum_source_digest<>old.curriculum_source_digest
  or new.currency<>old.currency or new.amount_minor<>old.amount_minor or new.billing_kind<>old.billing_kind or new.provider_price_ref<>old.provider_price_ref
  or new.access_terms_version<>old.access_terms_version or new.access_duration_days is distinct from old.access_duration_days
  or new.attempt_key_hash<>old.attempt_key_hash or new.subject_kind<>old.subject_kind or new.created_at<>old.created_at then
  raise exception using errcode='55000',message='program_order_identity_immutable';
 end if;
 if new.revision<>old.revision+1 then raise exception using errcode='55000',message='program_order_revision_must_increase'; end if;
 _allowed:=case old.state when 'admitted' then array['checkout_open','creation_unresolved','refused'] when 'creation_unresolved' then array['checkout_open','checkout_expired','refused']
  when 'checkout_open' then array['checkout_expired','checkout_cancelled','payment_verified','payment_failed'] else array[]::text[] end;
 if new.state<>old.state and not (new.state=any(_allowed)) then raise exception using errcode='55000',message='program_order_transition_refused'; end if;
 if new.state=old.state and old.state not in('admitted','creation_unresolved') then raise exception using errcode='55000',message='program_order_transition_refused'; end if;
 if old.session_ref is not null and (new.session_ref is distinct from old.session_ref or new.return_success is distinct from old.return_success or new.return_cancel is distinct from old.return_cancel) then
  raise exception using errcode='55000',message='program_order_session_immutable';
 end if;
 if old.verified_at is not null and (new.verified_at is distinct from old.verified_at or new.verified_event_id is distinct from old.verified_event_id or new.verified_amount_minor is distinct from old.verified_amount_minor) then
  raise exception using errcode='55000',message='program_order_verification_immutable';
 end if;
 if new.verified_at is not null and old.verified_at is null and new.state not in('payment_verified','payment_failed') then
  raise exception using errcode='55000',message='program_order_verification_needs_settlement';
 end if;
 new.updated_at:=clock_timestamp();
 return new;
end $$;
revoke all on function commercial_education.protect_program_order() from public;
create trigger program_orders_protect before insert or update or delete on commercial_education.program_orders
 for each row execute function commercial_education.protect_program_order();

create table commercial_education.program_checkout_intake(
 event_id text primary key check(event_id ~ '^[A-Za-z0-9_.:-]{3,255}$'),
 event_type text not null check(event_type ~ '^[a-z0-9_.]{3,160}$'),
 received_at timestamptz not null default clock_timestamp(),
 body_sha256 text not null check(body_sha256 ~ '^[a-f0-9]{64}$'),
 account_ref text check(account_ref is null or account_ref ~ '^acct_[A-Za-z0-9]{8,64}$'),
 api_version text check(api_version is null or api_version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(\.[a-z]+)?$'),
 session_ref text check(session_ref is null or session_ref ~ '^cs_test_[A-Za-z0-9]{8,200}$'),
 state text not null default 'pending' check(state in('pending','processed','unhandled','refused','failed_retryable','exhausted')),
 attempts integer not null default 0 check(attempts between 0 and 8),
 next_attempt_at timestamptz,
 last_outcome text check(last_outcome is null or char_length(last_outcome)<=200),
 order_id uuid references commercial_education.program_orders(id),
 constraint program_checkout_intake_retry_shape check((state in('pending','failed_retryable'))=(next_attempt_at is not null))
);
alter table commercial_education.program_checkout_intake enable row level security;
alter table commercial_education.program_checkout_intake force row level security;
revoke all on commercial_education.program_checkout_intake from public,clinical_core_api;

create function commercial_education.protect_program_checkout_intake() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if tg_op='DELETE' then raise exception using errcode='55000',message='program_intake_append_only'; end if;
 if tg_op='INSERT' then
  if new.state<>'pending' or new.attempts<>0 then raise exception using errcode='55000',message='program_intake_insert_shape'; end if;
  return new;
 end if;
 if new.event_id<>old.event_id or new.event_type<>old.event_type or new.received_at<>old.received_at or new.body_sha256<>old.body_sha256
  or new.account_ref is distinct from old.account_ref or new.api_version is distinct from old.api_version or new.session_ref is distinct from old.session_ref then
  raise exception using errcode='55000',message='program_intake_identity_immutable';
 end if;
 if old.state not in('pending','failed_retryable') then raise exception using errcode='55000',message='program_intake_settled'; end if;
 if new.attempts<>old.attempts+1 then raise exception using errcode='55000',message='program_intake_attempt_must_increase'; end if;
 if new.state='failed_retryable' and new.attempts>=8 then raise exception using errcode='55000',message='program_intake_exhausted'; end if;
 return new;
end $$;
revoke all on function commercial_education.protect_program_checkout_intake() from public;
create trigger program_checkout_intake_protect before insert or update or delete on commercial_education.program_checkout_intake
 for each row execute function commercial_education.protect_program_checkout_intake();

create function commercial_education.order_json(_o commercial_education.program_orders) returns jsonb
language sql immutable set search_path='' as $$
 select jsonb_build_object('contract','program-checkout/1','orderId',_o.id,'organizationId',_o.organization_id,'programId',_o.program_id,'offerId',_o.offer_id,'offerRevision',_o.offer_revision,'funnelSlug',_o.funnel_slug,
  'curriculum',jsonb_build_object('versionId',_o.curriculum_version_id,'version',_o.curriculum_version,'sourceDigest',_o.curriculum_source_digest),
  'pricing',jsonb_build_object('currency',_o.currency,'amountMinor',_o.amount_minor,'billing',case when _o.billing_kind='one_time' then jsonb_build_object('kind','one_time') else jsonb_build_object('kind','recurring','interval',_o.billing_interval,'intervalCount',_o.billing_interval_count) end),
  'providerPriceRef',_o.provider_price_ref,'accessTermsVersion',_o.access_terms_version,'accessDurationDays',_o.access_duration_days,'attemptKeyHash',_o.attempt_key_hash,
  'subject',jsonb_build_object('kind',_o.subject_kind),'state',_o.state,'revision',_o.revision,
  'processor',case when _o.session_ref is null then null else jsonb_build_object('provider','stripe','mode','test','sessionRef',_o.session_ref,'expiresAt',_o.session_expires_at,'returnSuccess',_o.return_success,'returnCancel',_o.return_cancel) end,
  'verification',case when _o.verified_at is null then null else jsonb_build_object('eventId',_o.verified_event_id,'sessionRef',_o.session_ref,'amountMinor',_o.verified_amount_minor,'currency',_o.verified_currency,'paymentStatus',_o.verified_payment_status,'accountRef',_o.verified_account_ref,'verifiedAt',_o.verified_at) end,
  'createdAt',_o.created_at,'updatedAt',_o.updated_at)
$$;
revoke all on function commercial_education.order_json(commercial_education.program_orders) from public;

create function commercial_education.intake_json(_i commercial_education.program_checkout_intake) returns jsonb
language sql immutable set search_path='' as $$
 select jsonb_build_object('eventId',_i.event_id,'eventType',_i.event_type,'receivedAt',_i.received_at,'bodySha256',_i.body_sha256,'accountRef',_i.account_ref,'apiVersion',_i.api_version,
  'sessionRef',_i.session_ref,'state',_i.state,'attempts',_i.attempts,'nextAttemptAt',_i.next_attempt_at,'lastOutcome',_i.last_outcome,'orderId',_i.order_id)
$$;
revoke all on function commercial_education.intake_json(commercial_education.program_checkout_intake) from public;

-- Admission: the terms are copied from the offer as it is NOW, under the same rules the visitor
-- page applied (published, paid, approved, bound to the current curriculum); the trigger checks
-- the copy against the offer again. A still-open order for the same attempt and offer revision
-- is returned instead of a second one.
create function commercial_education.admit_program_order(_attempt_key_hash text,_funnel_slug text,_organization uuid,_program uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _o commercial_education.program_offers%rowtype; _order commercial_education.program_orders%rowtype; _availability jsonb;
begin
 perform commercial_education.require_activation();
 _availability:=commercial_education.program_purchase_availability(_organization,_program);
 if not (_availability->>'available')::boolean then raise exception using errcode='55000',message='program_order_offer_unavailable:'||(_availability->>'reason'); end if;
 select * into _o from commercial_education.program_offers where id=(_availability->>'offerId')::uuid for share;
 select * into _order from commercial_education.program_orders where attempt_key_hash=_attempt_key_hash and offer_id=_o.id and offer_revision=_o.revision and state in('admitted','checkout_open','creation_unresolved');
 if found then return jsonb_build_object('reused',true,'order',commercial_education.order_json(_order)); end if;
 insert into commercial_education.program_orders(organization_id,program_id,offer_id,offer_revision,funnel_slug,curriculum_version_id,curriculum_version,curriculum_source_digest,currency,amount_minor,billing_kind,billing_interval,billing_interval_count,provider_price_ref,access_terms_version,access_duration_days,attempt_key_hash)
  values(_organization,_program,_o.id,_o.revision,_funnel_slug,_o.curriculum_version_id,_o.curriculum_version,_o.curriculum_source_digest,_o.currency,_o.amount_minor,_o.billing_kind,_o.billing_interval,_o.billing_interval_count,_o.provider_price_ref,_o.access_terms_version,_o.access_duration_days,_attempt_key_hash)
  returning * into _order;
 return jsonb_build_object('reused',false,'order',commercial_education.order_json(_order));
end $$;
revoke all on function commercial_education.admit_program_order(text,text,uuid,uuid) from public;
grant execute on function commercial_education.admit_program_order(text,text,uuid,uuid) to clinical_core_api;

create function commercial_education.read_program_order(_order uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare _order_row commercial_education.program_orders%rowtype;
begin
 perform commercial_education.require_activation();
 select * into _order_row from commercial_education.program_orders where id=_order;
 if not found then return null; end if;
 return commercial_education.order_json(_order_row);
end $$;
revoke all on function commercial_education.read_program_order(uuid) from public;
grant execute on function commercial_education.read_program_order(uuid) to clinical_core_api;

create function commercial_education.find_program_order_by_session(_session text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare _order_row commercial_education.program_orders%rowtype;
begin
 perform commercial_education.require_activation();
 select * into _order_row from commercial_education.program_orders where session_ref=_session;
 if not found then return null; end if;
 return commercial_education.order_json(_order_row);
end $$;
revoke all on function commercial_education.find_program_order_by_session(text) from public;
grant execute on function commercial_education.find_program_order_by_session(text) to clinical_core_api;

-- Transition: one step at an expected revision, carrying a processor binding or a verification.
create function commercial_education.transition_program_order(_order uuid,_expected integer,_next text,_carry jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _row commercial_education.program_orders%rowtype; _p jsonb:=_carry->'processor'; _v jsonb:=_carry->'verification';
begin
 perform commercial_education.require_activation();
 select * into _row from commercial_education.program_orders where id=_order for update;
 if not found then raise exception using errcode='P0002',message='program_order_not_found'; end if;
 if _row.revision<>_expected then raise exception using errcode='55000',message='program_order_revision_stale'; end if;
 if _p is not null and jsonb_typeof(_p)='object' then
  if _row.session_ref is not null then raise exception using errcode='55000',message='program_order_session_immutable'; end if;
  _row.session_ref:=_p->>'sessionRef'; _row.session_expires_at:=(_p->>'expiresAt')::timestamptz; _row.return_success:=_p->>'returnSuccess'; _row.return_cancel:=_p->>'returnCancel';
 end if;
 if _v is not null and jsonb_typeof(_v)='object' then
  if _row.verified_at is not null then raise exception using errcode='55000',message='program_order_verification_immutable'; end if;
  if _v->>'sessionRef' is distinct from _row.session_ref then raise exception using errcode='55000',message='program_order_verification_session_mismatch'; end if;
  _row.verified_event_id:=_v->>'eventId'; _row.verified_amount_minor:=(_v->>'amountMinor')::integer; _row.verified_currency:=_v->>'currency';
  _row.verified_payment_status:=_v->>'paymentStatus'; _row.verified_account_ref:=_v->>'accountRef'; _row.verified_at:=(_v->>'verifiedAt')::timestamptz;
 end if;
 if _next in('payment_verified','payment_failed') and _row.verified_at is null then raise exception using errcode='55000',message='program_order_transition_refused'; end if;
 update commercial_education.program_orders set state=_next,revision=_row.revision+1,session_ref=_row.session_ref,session_expires_at=_row.session_expires_at,return_success=_row.return_success,return_cancel=_row.return_cancel,
  verified_event_id=_row.verified_event_id,verified_amount_minor=_row.verified_amount_minor,verified_currency=_row.verified_currency,verified_payment_status=_row.verified_payment_status,verified_account_ref=_row.verified_account_ref,verified_at=_row.verified_at
  where id=_order returning * into _row;
 return commercial_education.order_json(_row);
end $$;
revoke all on function commercial_education.transition_program_order(uuid,integer,text,jsonb) from public;
grant execute on function commercial_education.transition_program_order(uuid,integer,text,jsonb) to clinical_core_api;

create function commercial_education.admit_checkout_intake(_event jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _row commercial_education.program_checkout_intake%rowtype;
begin
 perform commercial_education.require_activation();
 select * into _row from commercial_education.program_checkout_intake where event_id=_event->>'eventId';
 if found then return jsonb_build_object('duplicate',true,'record',commercial_education.intake_json(_row)); end if;
 insert into commercial_education.program_checkout_intake(event_id,event_type,body_sha256,account_ref,api_version,session_ref,next_attempt_at)
  values(_event->>'eventId',_event->>'eventType',_event->>'bodySha256',_event->>'accountRef',_event->>'apiVersion',_event->>'sessionRef',clock_timestamp()) returning * into _row;
 return jsonb_build_object('duplicate',false,'record',commercial_education.intake_json(_row));
end $$;
revoke all on function commercial_education.admit_checkout_intake(jsonb) from public;
grant execute on function commercial_education.admit_checkout_intake(jsonb) to clinical_core_api;

create function commercial_education.read_checkout_intake(_event_id text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare _row commercial_education.program_checkout_intake%rowtype;
begin
 perform commercial_education.require_activation();
 select * into _row from commercial_education.program_checkout_intake where event_id=_event_id;
 if not found then return null; end if;
 return commercial_education.intake_json(_row);
end $$;
revoke all on function commercial_education.read_checkout_intake(text) from public;
grant execute on function commercial_education.read_checkout_intake(text) to clinical_core_api;

create function commercial_education.settle_checkout_intake(_event_id text,_outcome jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _row commercial_education.program_checkout_intake%rowtype; _state text:=_outcome->>'state'; _attempts integer;
begin
 perform commercial_education.require_activation();
 select * into _row from commercial_education.program_checkout_intake where event_id=_event_id for update;
 if not found then raise exception using errcode='P0002',message='program_order_not_found'; end if;
 if _row.state not in('pending','failed_retryable') then raise exception using errcode='55000',message='program_intake_settled'; end if;
 _attempts:=_row.attempts+1;
 if _state='failed_retryable' and _attempts>=8 then _state:='exhausted'; end if;
 update commercial_education.program_checkout_intake set state=_state,attempts=_attempts,last_outcome=left(_outcome->>'detail',200),
  order_id=coalesce((_outcome->>'orderId')::uuid,order_id),next_attempt_at=case when _state='failed_retryable' then coalesce((_outcome->>'nextAttemptAt')::timestamptz,clock_timestamp()+interval '1 minute') end
  where event_id=_event_id returning * into _row;
 return commercial_education.intake_json(_row);
end $$;
revoke all on function commercial_education.settle_checkout_intake(text,jsonb) from public;
grant execute on function commercial_education.settle_checkout_intake(text,jsonb) to clinical_core_api;

create function commercial_education.due_checkout_intake(_now timestamptz,_limit integer) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare _list jsonb;
begin
 perform commercial_education.require_activation();
 select coalesce(jsonb_agg(commercial_education.intake_json(i) order by i.received_at),'[]'::jsonb) into _list
  from (select * from commercial_education.program_checkout_intake where state in('pending','failed_retryable') and next_attempt_at<=_now order by received_at limit greatest(1,least(_limit,100))) i;
 return _list;
end $$;
revoke all on function commercial_education.due_checkout_intake(timestamptz,integer) from public;
grant execute on function commercial_education.due_checkout_intake(timestamptz,integer) to clinical_core_api;
