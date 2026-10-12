-- BLOCKED source candidate (successor): program checkout recovery (program-checkout/2), for
-- Codex's review. Not a schema successor in the manifest. Not registered in
-- migrations/manifest.json; not applied anywhere; not to be applied until the checkout boundary in
-- src/server/commerce/program-checkout.ts, the worker in src/server/commerce/program-commerce-worker.ts
-- and docs/claude-program-commerce-reliability-learner-journeys-2026-10-11.md are reviewed. The
-- runtime that would call these functions (src/server/commerce/program-checkout-ledger-sql.ts) is
-- disabled in source: it is constructed only with activation evidence naming the offer candidate
-- and BOTH checkout digests, and every function below refuses until the commercial activation row
-- (program-offer-revisions.sql) is enabled by a separately reviewed change.
--
-- Parent assumptions (written against exactly these artifacts; the test refuses to run it if any
-- digest has moved). It is applied AFTER its parent, which stays byte for byte as it was:
--   source-candidates/program-checkout-orders.sql (BLOCKED, unregistered; applied first)
--     sha256 767ac13bc111a15b98bdc2978a5e42a33f5f1ab61f010061907787040b0c37ee
--     (commercial_education.program_orders, program_checkout_intake, order_json, intake_json,
--      admit_program_order, transition_program_order, protect_program_order, the inline state
--      checks program_orders_state_check and program_checkout_intake_state_check, the index
--      program_orders_one_open_per_attempt)
--   and through it source-candidates/program-offer-revisions.sql
--     sha256 4973461564e6812906403525cb3aa109d6fd569eec159c9400fcf568a90b321f
--   and 20260812010000_synthetic_identity_consent.sql
--     sha256 c4ca967352bce6c678249336ef410fe7de4216d123a0d3da06a467379780c445
-- No historical migration, ledger, binary, privilege, IAM or custody file is changed by this file.
-- No price, provider account, refund policy or fulfilment is decided here.
--
-- What this successor adds and refuses:
--   * `creation`: the complete outbound creation request (parameters, digest, key, recorded time),
--     recorded once on the step admitted -> creation_pending and immutable after; its key, order id,
--     price and billing mode must equal the order's own; every later state but `refused` needs it;
--   * states creation_pending, creation_unreconciled and payment_processing, and the transition
--     table of program-checkout/2 (a completed checkout whose payment is still processing is not
--     failed; an unknown creation beyond the processor's retention is an operator hold);
--   * the intake state `conflict`: an authoritative observation that contradicts a decided order,
--     settled once and visible, never applied;
--   * program_orders_in_states (the worker's bounded reconciliation list) and checkout_work_status
--     (the operator's counts); both refuse until activation, like every other function here.
-- Grants stay as the parent's (clinical_core_api). Separating processor intake, consumer, staff and
-- operator callers into their own reduced roles is the education-authority successor's work.

alter table commercial_education.program_orders add column creation jsonb;
alter table commercial_education.program_orders drop constraint program_orders_state_check;
alter table commercial_education.program_orders add constraint program_orders_state_check check(state in('admitted','creation_pending','creation_unresolved','creation_unreconciled','checkout_open','payment_processing','checkout_expired','checkout_cancelled','payment_verified','payment_failed','refused'));
alter table commercial_education.program_orders add constraint program_orders_creation_shape check(creation is null or (
 jsonb_typeof(creation)='object'
 and creation->>'idempotencyKey'='program-order:'||id::text
 and creation->>'requestSha256' ~ '^[a-f0-9]{64}$'
 and jsonb_typeof(creation->'request')='object'
 and creation->'request'->>'clientReferenceId'=id::text
 and creation->'request'->>'metadataOrderId'=id::text
 and creation->'request'->>'priceRef'=provider_price_ref
 and creation->'request'->>'mode'=case when billing_kind='one_time' then 'payment' else 'subscription' end
 and (creation->'request'->>'quantity')='1'
 and jsonb_typeof(creation->'request'->'expiresAtUnix')='number'
 and creation->'request'->>'successUrl' ~ '^https://[^/?#]+/buy/return\?order=[0-9a-f-]{36}&returned=success$'
 and creation->'request'->>'cancelUrl' ~ '^https://[^/?#]+/buy/return\?order=[0-9a-f-]{36}&returned=cancel$'
 and position(id::text in creation->'request'->>'successUrl')>0
 and position(id::text in creation->'request'->>'cancelUrl')>0
));
alter table commercial_education.program_orders add constraint program_orders_creation_states check(state in('admitted','refused') or creation is not null);
alter table commercial_education.program_orders add constraint program_orders_session_matches_creation check(session_ref is null or (creation is not null and return_success=creation->'request'->>'successUrl' and return_cancel=creation->'request'->>'cancelUrl'));
drop index commercial_education.program_orders_one_open_per_attempt;
create unique index program_orders_one_open_per_attempt on commercial_education.program_orders(attempt_key_hash,offer_id,offer_revision) where state in('admitted','creation_pending','creation_unresolved','creation_unreconciled','checkout_open');

create or replace function commercial_education.protect_program_order() returns trigger
language plpgsql security invoker set search_path='' as $$
declare _allowed text[];
begin
 if tg_op='DELETE' then raise exception using errcode='55000',message='program_order_append_only'; end if;
 if tg_op='INSERT' then
  if new.revision<>1 or new.state<>'admitted' or new.session_ref is not null or new.verified_at is not null or new.creation is not null then raise exception using errcode='55000',message='program_order_insert_shape'; end if;
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
 _allowed:=case old.state
  when 'admitted' then array['creation_pending','refused']
  when 'creation_pending' then array['checkout_open','creation_unresolved','refused']
  when 'creation_unresolved' then array['checkout_open','creation_unreconciled','checkout_expired','refused']
  when 'creation_unreconciled' then array['checkout_open','checkout_expired','refused']
  when 'checkout_open' then array['checkout_expired','checkout_cancelled','payment_processing','payment_verified','payment_failed']
  when 'payment_processing' then array['payment_verified','payment_failed']
  else array[]::text[] end;
 if new.state=old.state or not (new.state=any(_allowed)) then raise exception using errcode='55000',message='program_order_transition_refused'; end if;
 if old.creation is not null and new.creation is distinct from old.creation then raise exception using errcode='55000',message='program_order_creation_immutable'; end if;
 if old.creation is null and new.creation is not null and not (old.state='admitted' and new.state='creation_pending') then raise exception using errcode='55000',message='program_order_creation_immutable'; end if;
 if new.state='creation_pending' and new.creation is null then raise exception using errcode='55000',message='program_order_transition_refused'; end if;
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

create or replace function commercial_education.order_json(_o commercial_education.program_orders) returns jsonb
language sql immutable set search_path='' as $$
 select jsonb_build_object('contract','program-checkout/2','orderId',_o.id,'organizationId',_o.organization_id,'programId',_o.program_id,'offerId',_o.offer_id,'offerRevision',_o.offer_revision,'funnelSlug',_o.funnel_slug,
  'curriculum',jsonb_build_object('versionId',_o.curriculum_version_id,'version',_o.curriculum_version,'sourceDigest',_o.curriculum_source_digest),
  'pricing',jsonb_build_object('currency',_o.currency,'amountMinor',_o.amount_minor,'billing',case when _o.billing_kind='one_time' then jsonb_build_object('kind','one_time') else jsonb_build_object('kind','recurring','interval',_o.billing_interval,'intervalCount',_o.billing_interval_count) end),
  'providerPriceRef',_o.provider_price_ref,'accessTermsVersion',_o.access_terms_version,'accessDurationDays',_o.access_duration_days,'attemptKeyHash',_o.attempt_key_hash,
  'subject',jsonb_build_object('kind',_o.subject_kind),'state',_o.state,'revision',_o.revision,'creation',_o.creation,
  'processor',case when _o.session_ref is null then null else jsonb_build_object('provider','stripe','mode','test','sessionRef',_o.session_ref,'expiresAt',_o.session_expires_at,'returnSuccess',_o.return_success,'returnCancel',_o.return_cancel) end,
  'verification',case when _o.verified_at is null then null else jsonb_build_object('eventId',_o.verified_event_id,'sessionRef',_o.session_ref,'amountMinor',_o.verified_amount_minor,'currency',_o.verified_currency,'paymentStatus',_o.verified_payment_status,'accountRef',_o.verified_account_ref,'verifiedAt',_o.verified_at) end,
  'createdAt',_o.created_at,'updatedAt',_o.updated_at)
$$;
revoke all on function commercial_education.order_json(commercial_education.program_orders) from public;

create or replace function commercial_education.admit_program_order(_attempt_key_hash text,_funnel_slug text,_organization uuid,_program uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _o commercial_education.program_offers%rowtype; _order commercial_education.program_orders%rowtype; _availability jsonb;
begin
 perform commercial_education.require_activation();
 _availability:=commercial_education.program_purchase_availability(_organization,_program);
 if not (_availability->>'available')::boolean then raise exception using errcode='55000',message='program_order_offer_unavailable:'||(_availability->>'reason'); end if;
 select * into _o from commercial_education.program_offers where id=(_availability->>'offerId')::uuid for share;
 select * into _order from commercial_education.program_orders where attempt_key_hash=_attempt_key_hash and offer_id=_o.id and offer_revision=_o.revision and state in('admitted','creation_pending','creation_unresolved','creation_unreconciled','checkout_open');
 if found then return jsonb_build_object('reused',true,'order',commercial_education.order_json(_order)); end if;
 insert into commercial_education.program_orders(organization_id,program_id,offer_id,offer_revision,funnel_slug,curriculum_version_id,curriculum_version,curriculum_source_digest,currency,amount_minor,billing_kind,billing_interval,billing_interval_count,provider_price_ref,access_terms_version,access_duration_days,attempt_key_hash)
  values(_organization,_program,_o.id,_o.revision,_funnel_slug,_o.curriculum_version_id,_o.curriculum_version,_o.curriculum_source_digest,_o.currency,_o.amount_minor,_o.billing_kind,_o.billing_interval,_o.billing_interval_count,_o.provider_price_ref,_o.access_terms_version,_o.access_duration_days,_attempt_key_hash)
  returning * into _order;
 return jsonb_build_object('reused',false,'order',commercial_education.order_json(_order));
end $$;
revoke all on function commercial_education.admit_program_order(text,text,uuid,uuid) from public;
grant execute on function commercial_education.admit_program_order(text,text,uuid,uuid) to clinical_core_api;

-- Transition: one step at an expected revision, carrying the creation request, a processor binding or a verification.
create or replace function commercial_education.transition_program_order(_order uuid,_expected integer,_next text,_carry jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _row commercial_education.program_orders%rowtype; _c jsonb:=_carry->'creation'; _p jsonb:=_carry->'processor'; _v jsonb:=_carry->'verification';
begin
 perform commercial_education.require_activation();
 select * into _row from commercial_education.program_orders where id=_order for update;
 if not found then raise exception using errcode='P0002',message='program_order_not_found'; end if;
 if _row.revision<>_expected then raise exception using errcode='55000',message='program_order_revision_stale'; end if;
 if _c is not null and jsonb_typeof(_c)='object' then
  if _row.creation is not null or _next<>'creation_pending' then raise exception using errcode='55000',message='program_order_creation_immutable'; end if;
  _row.creation:=_c;
 end if;
 if _p is not null and jsonb_typeof(_p)='object' then
  if _row.session_ref is not null then raise exception using errcode='55000',message='program_order_session_immutable'; end if;
  _row.session_ref:=_p->>'sessionRef'; _row.session_expires_at:=(_p->>'expiresAt')::timestamptz; _row.return_success:=_p->>'returnSuccess'; _row.return_cancel:=_p->>'returnCancel';
 end if;
 if _v is not null and jsonb_typeof(_v)='object' then
  if _row.verified_at is not null then raise exception using errcode='55000',message='program_order_verification_immutable'; end if;
  if _next not in('payment_verified','payment_failed') then raise exception using errcode='55000',message='program_order_verification_needs_settlement'; end if;
  if _v->>'sessionRef' is distinct from _row.session_ref then raise exception using errcode='55000',message='program_order_verification_session_mismatch'; end if;
  _row.verified_event_id:=_v->>'eventId'; _row.verified_amount_minor:=(_v->>'amountMinor')::integer; _row.verified_currency:=_v->>'currency';
  _row.verified_payment_status:=_v->>'paymentStatus'; _row.verified_account_ref:=_v->>'accountRef'; _row.verified_at:=(_v->>'verifiedAt')::timestamptz;
 end if;
 if _next in('payment_verified','payment_failed') and _row.verified_at is null then raise exception using errcode='55000',message='program_order_transition_refused'; end if;
 update commercial_education.program_orders set state=_next,revision=_row.revision+1,creation=_row.creation,session_ref=_row.session_ref,session_expires_at=_row.session_expires_at,return_success=_row.return_success,return_cancel=_row.return_cancel,
  verified_event_id=_row.verified_event_id,verified_amount_minor=_row.verified_amount_minor,verified_currency=_row.verified_currency,verified_payment_status=_row.verified_payment_status,verified_account_ref=_row.verified_account_ref,verified_at=_row.verified_at
  where id=_order returning * into _row;
 return commercial_education.order_json(_row);
end $$;
revoke all on function commercial_education.transition_program_order(uuid,integer,text,jsonb) from public;
grant execute on function commercial_education.transition_program_order(uuid,integer,text,jsonb) to clinical_core_api;

alter table commercial_education.program_checkout_intake drop constraint program_checkout_intake_state_check;
alter table commercial_education.program_checkout_intake add constraint program_checkout_intake_state_check check(state in('pending','processed','unhandled','refused','failed_retryable','exhausted','conflict'));

-- The worker's reconciliation list: undecided orders, oldest change first, bounded.
create function commercial_education.program_orders_in_states(_states text[],_limit integer) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare _list jsonb;
begin
 perform commercial_education.require_activation();
 if _states is null or not (_states <@ array['admitted','creation_pending','creation_unresolved','creation_unreconciled','checkout_open','payment_processing']::text[]) then
  raise exception using errcode='22023',message='program_order_states_refused';
 end if;
 select coalesce(jsonb_agg(commercial_education.order_json(o) order by o.updated_at),'[]'::jsonb) into _list
  from (select * from commercial_education.program_orders where state=any(_states) order by updated_at limit greatest(1,least(_limit,100))) o;
 return _list;
end $$;
revoke all on function commercial_education.program_orders_in_states(text[],integer) from public;
grant execute on function commercial_education.program_orders_in_states(text[],integer) to clinical_core_api;

-- The operator's counts: by state, and the oldest unresolved item. Counts only; no order or event body.
create function commercial_education.checkout_work_status() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare _orders jsonb; _intake jsonb; _oldest timestamptz;
begin
 perform commercial_education.require_activation();
 select coalesce(jsonb_object_agg(s,coalesce(n,0)),'{}'::jsonb) into _orders
  from unnest(array['admitted','creation_pending','creation_unresolved','creation_unreconciled','checkout_open','payment_processing','checkout_expired','checkout_cancelled','payment_verified','payment_failed','refused']) s
  left join (select state,count(*)::integer n from commercial_education.program_orders group by state) c on c.state=s;
 select coalesce(jsonb_object_agg(s,coalesce(n,0)),'{}'::jsonb) into _intake
  from unnest(array['pending','processed','unhandled','refused','failed_retryable','exhausted','conflict']) s
  left join (select state,count(*)::integer n from commercial_education.program_checkout_intake group by state) c on c.state=s;
 select min(t) into _oldest from (
  select updated_at t from commercial_education.program_orders where state in('creation_pending','creation_unresolved','creation_unreconciled','payment_processing')
  union all select received_at from commercial_education.program_checkout_intake where state in('pending','failed_retryable','exhausted','conflict')) u;
 return jsonb_build_object('orders',_orders,'intake',_intake,'oldestUnresolvedAt',_oldest);
end $$;
revoke all on function commercial_education.checkout_work_status() from public;
grant execute on function commercial_education.checkout_work_status() to clinical_core_api;
