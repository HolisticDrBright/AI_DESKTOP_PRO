-- BLOCKED source candidate (successor): claim delivery and purchaser recovery
-- (program-education-access/1 claim view without any code digest, with delivery state), for
-- Codex's review. Not in migrations/manifest.json; not applied anywhere; not registered; not to be
-- applied until src/server/commerce/program-claim-delivery.ts, program-settlement.ts and
-- docs/claude-program-commerce-reliability-learner-journeys-2026-10-11.md are reviewed. Disabled
-- like its parents: every function refuses until the commercial activation row is enabled by a
-- separately reviewed change, and the SQL ledger enables only with evidence naming every digest.
--
-- Parent assumptions (written against exactly these artifacts, applied first, each unchanged; the
-- test refuses to run it if any digest has moved):
--   source-candidates/program-education-access.sql (BLOCKED, unregistered)
--     sha256 e4f11e29f1b6a68f1478dbc112aaac1ea2bbf72adf86f9458dd5a20c8151df93
--     (program_entitlements, program_claims, program_education_enrollments,
--      program_entitlement_events, claim_json, entitlement_json, enrollment_json,
--      settle_program_order, claim_program_entitlement, program_education_status)
--   source-candidates/program-checkout-recovery.sql (BLOCKED, unregistered; order_json program-checkout/2)
--     sha256 29d85d75da43176b1a6d007afc5a0a892f99a08994f44bb459a4a756e2e2efc0
--   and through them program-checkout-orders.sql 767ac13…, program-offer-revisions.sql 4973461…
--   and 20260812010000_synthetic_identity_consent.sql c4ca9673….
-- No historical migration, ledger, binary, privilege, IAM or custody file is changed by this file.
--
-- The purchaser threat model this answers: payment verification, a verified consumer session and
-- proof of being the purchaser are three separate gates. An order id, a processor reference, an
-- email address, a success URL or the staff status proves none of them. The one-time code is the
-- purchaser proof; it is delivered to the contact the payment processor holds (read by the delivery
-- worker at send time, never stored here), and it binds the entitlement to the verified consumer
-- session that presents it.
--
-- What this successor adds and refuses:
--   * program_claim_deliveries: one row per claim; the code exists here only SEALED (opaque to the
--     database), only while delivery is pending or its outcome unknown, and is erased (set null) the
--     moment delivery is accepted, fails for good, or the claim is used, expires or is superseded;
--   * settle_program_order_sealed: settlement creates the entitlement, its claim (with the caller's
--     claim id) and the sealed delivery in one transaction; the parent's unsealed settlement is no
--     longer executable by the API role, so no entitlement can exist without a way to deliver its code;
--   * claim_program_entitlement (replaced): the same verified subject presenting its used code again
--     gets the same receipt (no second enrollment, no second window); anyone else is refused; using or
--     expiring a claim withdraws its delivery;
--   * claim_json (replaced): no token hash; the delivery state instead; program_education_status
--     therefore shows staff claim and delivery state and never a code or a digest;
--   * two NOLOGIN roles, neither granted to the API role nor to each other:
--       commercial_education_delivery  reads due sealed codes and records attempts (the delivery worker);
--       commercial_education_operator  issues a replacement code, superseding every issued claim and
--                                      withdrawing its delivery in the same transaction;
--     the general API role cannot read a sealed code, record a delivery or issue a replacement.

do $$ begin
 if not exists(select 1 from pg_roles where rolname='commercial_education_delivery') then create role commercial_education_delivery nologin; end if;
 if not exists(select 1 from pg_roles where rolname='commercial_education_operator') then create role commercial_education_operator nologin; end if;
end $$;
grant usage on schema commercial_education to commercial_education_delivery, commercial_education_operator;

create table commercial_education.program_claim_deliveries(
 id uuid primary key default public.gen_random_uuid(),
 claim_id uuid not null unique references commercial_education.program_claims(id),
 state text not null default 'pending' check(state in('pending','provider_unknown','accepted','failed','withdrawn')),
 sealed jsonb check(sealed is null or (jsonb_typeof(sealed)='object' and sealed ?& array['keyRef','iv','ciphertext','tag'] and (sealed - array['keyRef','iv','ciphertext','tag'])='{}'::jsonb)),
 attempts integer not null default 0 check(attempts between 0 and 6),
 next_attempt_at timestamptz,
 last_attempt_at timestamptz,
 accepted_at timestamptz,
 provider_ref text check(provider_ref is null or provider_ref ~ '^[A-Za-z0-9_.:-]{1,200}$'),
 last_outcome text check(last_outcome is null or char_length(last_outcome)<=200),
 created_at timestamptz not null default clock_timestamp(),
 constraint program_claim_deliveries_sealed_while_open check((state in('pending','provider_unknown'))=(sealed is not null)),
 constraint program_claim_deliveries_retry_shape check((state in('pending','provider_unknown'))=(next_attempt_at is not null)),
 constraint program_claim_deliveries_accepted_whole check((state='accepted')=(accepted_at is not null))
);
alter table commercial_education.program_claim_deliveries enable row level security;
alter table commercial_education.program_claim_deliveries force row level security;
revoke all on commercial_education.program_claim_deliveries from public,clinical_core_api,commercial_education_delivery,commercial_education_operator;

create function commercial_education.protect_program_claim_delivery() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if tg_op='DELETE' then raise exception using errcode='55000',message='program_delivery_append_only'; end if;
 if tg_op='INSERT' then
  if new.state<>'pending' or new.attempts<>0 or new.sealed is null or new.last_attempt_at is not null or new.provider_ref is not null then raise exception using errcode='55000',message='program_delivery_insert_shape'; end if;
  return new;
 end if;
 if new.id<>old.id or new.claim_id<>old.claim_id or new.created_at<>old.created_at then raise exception using errcode='55000',message='program_delivery_identity_immutable'; end if;
 if old.state not in('pending','provider_unknown') then raise exception using errcode='55000',message='program_delivery_settled'; end if;
 if new.sealed is not null and new.sealed is distinct from old.sealed then raise exception using errcode='55000',message='program_delivery_sealed_immutable'; end if;
 if new.state='withdrawn' then
  if new.attempts<>old.attempts then raise exception using errcode='55000',message='program_delivery_attempt_must_increase'; end if;
 elsif new.attempts<>old.attempts+1 then raise exception using errcode='55000',message='program_delivery_attempt_must_increase';
 end if;
 return new;
end $$;
revoke all on function commercial_education.protect_program_claim_delivery() from public;
create trigger program_claim_deliveries_protect before insert or update or delete on commercial_education.program_claim_deliveries
 for each row execute function commercial_education.protect_program_claim_delivery();

-- Stop sending a claim's code: nothing more goes out, and the sealed copy is erased.
create function commercial_education.withdraw_program_claim_delivery(_claim uuid,_detail text) returns void
language sql security definer set search_path='' as $$
 update commercial_education.program_claim_deliveries set state='withdrawn',sealed=null,next_attempt_at=null,last_outcome=left(_detail,200)
  where claim_id=_claim and state in('pending','provider_unknown');
$$;
revoke all on function commercial_education.withdraw_program_claim_delivery(uuid,text) from public;

create or replace function commercial_education.claim_json(_c commercial_education.program_claims) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object('claimId',_c.id,'entitlementId',_c.entitlement_id,'issuedAt',_c.issued_at,'expiresAt',_c.expires_at,'state',_c.state,'usedAt',_c.used_at,'usedBy',_c.used_by,
  'delivery',coalesce((select jsonb_build_object('state',d.state,'attempts',d.attempts,'lastAttemptAt',d.last_attempt_at,'acceptedAt',d.accepted_at)
   from commercial_education.program_claim_deliveries d where d.claim_id=_c.id),jsonb_build_object('state','withdrawn','attempts',0,'lastAttemptAt',null,'acceptedAt',null)))
$$;
revoke all on function commercial_education.claim_json(commercial_education.program_claims) from public;

-- Settlement with its sealed delivery, in one transaction. The order is re-read here; the caller's copy is not evidence.
create function commercial_education.settle_program_order_sealed(_order uuid,_claim uuid,_token_hash text,_claim_expires_at timestamptz,_sealed jsonb,_expected_account text) returns jsonb
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
 if _sealed is null or jsonb_typeof(_sealed)<>'object' then raise exception using errcode='22023',message='program_entitlement_request_invalid'; end if;
 insert into commercial_education.program_entitlements(order_id,organization_id,program_id,offer_id,offer_revision,curriculum_version_id,curriculum_version,curriculum_source_digest,access_terms_version,access_duration_days,verification_event_id)
  values(_o.id,_o.organization_id,_o.program_id,_o.offer_id,_o.offer_revision,_o.curriculum_version_id,_o.curriculum_version,_o.curriculum_source_digest,_o.access_terms_version,_o.access_duration_days,_o.verified_event_id)
  returning * into _e;
 insert into commercial_education.program_claims(id,entitlement_id,token_hash,expires_at) values(_claim,_e.id,_token_hash,_claim_expires_at) returning * into _c;
 insert into commercial_education.program_claim_deliveries(claim_id,sealed,next_attempt_at) values(_c.id,_sealed,clock_timestamp());
 insert into commercial_education.program_entitlement_events(entitlement_id,kind,reference) values(_e.id,'settled',_o.id::text);
 return jsonb_build_object('created',true,'entitlement',commercial_education.entitlement_json(_e),'claim',commercial_education.claim_json(_c));
end $$;
revoke all on function commercial_education.settle_program_order_sealed(uuid,uuid,text,timestamptz,jsonb,text) from public;
grant execute on function commercial_education.settle_program_order_sealed(uuid,uuid,text,timestamptz,jsonb,text) to clinical_core_api;
-- An entitlement must never exist without a way to deliver its code.
revoke execute on function commercial_education.settle_program_order(uuid,text,timestamptz,text) from clinical_core_api;

-- The claim (replaced): the winner retrying gets its receipt; using or expiring a claim withdraws its delivery.
create or replace function commercial_education.claim_program_entitlement(_token_hash text,_consumer_subject text,_at timestamptz) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _c commercial_education.program_claims%rowtype; _e commercial_education.program_entitlements%rowtype; _n commercial_education.program_education_enrollments%rowtype;
begin
 perform commercial_education.require_activation();
 select * into _c from commercial_education.program_claims where token_hash=_token_hash for update;
 if not found then return jsonb_build_object('outcome','refused','reason','claim_invalid'); end if;
 select * into _e from commercial_education.program_entitlements where id=_c.entitlement_id for update;
 if _c.state='used' then
  if _c.used_by is distinct from _consumer_subject then return jsonb_build_object('outcome','refused','reason','already_claimed_by_other'); end if;
  select * into _n from commercial_education.program_education_enrollments where entitlement_id=_e.id and consumer_subject=_consumer_subject;
  if not found then raise exception using errcode='55000',message='program_entitlement_request_invalid'; end if;
  return jsonb_build_object('outcome','claimed','entitlement',commercial_education.entitlement_json(_e),'enrollment',commercial_education.enrollment_json(_n));
 end if;
 if _c.state='superseded' then return jsonb_build_object('outcome','refused','reason','claim_superseded'); end if;
 if _c.state='expired' or _c.expires_at<=_at then
  if _c.state='issued' then update commercial_education.program_claims set state='expired' where id=_c.id; end if;
  perform commercial_education.withdraw_program_claim_delivery(_c.id,'claim expired');
  return jsonb_build_object('outcome','refused','reason','claim_expired');
 end if;
 if _e.state<>'awaiting_claim' or _e.subject_kind<>'unclaimed' then
  return jsonb_build_object('outcome','refused','reason',case when _e.subject_kind='claimed' and _e.consumer_subject<>_consumer_subject then 'already_claimed_by_other' else 'entitlement_not_claimable' end);
 end if;
 update commercial_education.program_entitlements set state='active',revision=revision+1,subject_kind='claimed',consumer_subject=_consumer_subject,claimed_at=_at,
  window_starts_at=_at,window_ends_at=case when access_duration_days is null then null else _at+make_interval(days=>access_duration_days) end where id=_e.id returning * into _e;
 update commercial_education.program_claims set state='used',used_at=_at,used_by=_consumer_subject where id=_c.id;
 perform commercial_education.withdraw_program_claim_delivery(_c.id,'claim used');
 insert into commercial_education.program_education_enrollments(entitlement_id,consumer_subject,curriculum_version_id,curriculum_version,curriculum_source_digest,started_at,updated_at)
  values(_e.id,_consumer_subject,_e.curriculum_version_id,_e.curriculum_version,_e.curriculum_source_digest,_at,_at) returning * into _n;
 insert into commercial_education.program_entitlement_events(entitlement_id,kind) values(_e.id,'claimed');
 return jsonb_build_object('outcome','claimed','entitlement',commercial_education.entitlement_json(_e),'enrollment',commercial_education.enrollment_json(_n));
end $$;
revoke all on function commercial_education.claim_program_entitlement(text,text,timestamptz) from public;
grant execute on function commercial_education.claim_program_entitlement(text,text,timestamptz) to clinical_core_api;

-- The delivery worker's queue: due (never attempted, or its retry time has come), still usable, oldest first, bounded. Unusable ones are withdrawn on the way.
create function commercial_education.due_program_claim_deliveries(_at timestamptz,_limit integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _list jsonb:='[]'::jsonb; _d record;
begin
 perform commercial_education.require_activation();
 for _d in select d.claim_id from commercial_education.program_claim_deliveries d join commercial_education.program_claims c on c.id=d.claim_id
  where d.state in('pending','provider_unknown') and (c.state<>'issued' or c.expires_at<=_at) loop
  perform commercial_education.withdraw_program_claim_delivery(_d.claim_id,'claim no longer usable');
 end loop;
 select coalesce(jsonb_agg(jsonb_build_object('deliveryId',x.id,'claimId',x.claim_id,'entitlementId',x.entitlement_id,'orderId',x.order_id,'state',x.state,'sealed',x.sealed,'attempts',x.attempts,
   'nextAttemptAt',x.next_attempt_at,'lastAttemptAt',x.last_attempt_at,'acceptedAt',x.accepted_at,'providerRef',x.provider_ref,'lastOutcome',x.last_outcome,'claimExpiresAt',x.expires_at) order by x.next_attempt_at),'[]'::jsonb) into _list
  from (select d.*,c.entitlement_id,c.expires_at,e.order_id from commercial_education.program_claim_deliveries d
   join commercial_education.program_claims c on c.id=d.claim_id join commercial_education.program_entitlements e on e.id=c.entitlement_id
   where d.state in('pending','provider_unknown') and (d.attempts=0 or d.next_attempt_at<=_at) and c.state='issued' and c.expires_at>_at
   order by d.next_attempt_at limit greatest(1,least(_limit,100))) x;
 return _list;
end $$;
revoke all on function commercial_education.due_program_claim_deliveries(timestamptz,integer) from public;
grant execute on function commercial_education.due_program_claim_deliveries(timestamptz,integer) to commercial_education_delivery;

-- One attempt, at the attempt count the worker read. A seventh unknown outcome is a failure.
create function commercial_education.record_program_claim_delivery(_delivery uuid,_expected_attempts integer,_outcome jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _d commercial_education.program_claim_deliveries%rowtype; _state text:=_outcome->>'state'; _attempts integer; _detail text:=left(_outcome->>'detail',200); _at timestamptz:=(_outcome->>'at')::timestamptz;
begin
 perform commercial_education.require_activation();
 if _state is null or _state not in('accepted','failed','provider_unknown') then raise exception using errcode='22023',message='program_delivery_request_invalid'; end if;
 select * into _d from commercial_education.program_claim_deliveries where id=_delivery for update;
 if not found then raise exception using errcode='P0002',message='program_delivery_not_found'; end if;
 if _d.attempts<>_expected_attempts then raise exception using errcode='55000',message='program_delivery_revision_stale'; end if;
 if _d.state not in('pending','provider_unknown') then raise exception using errcode='55000',message='program_delivery_settled'; end if;
 _attempts:=_d.attempts+1;
 if _state='provider_unknown' and _attempts>=6 then _state:='failed'; _detail:=left('attempts exhausted: '||coalesce(_detail,''),200); end if;
 update commercial_education.program_claim_deliveries set state=_state,attempts=_attempts,last_attempt_at=_at,accepted_at=case when _state='accepted' then _at end,
  provider_ref=coalesce(_outcome->>'providerRef',provider_ref),last_outcome=_detail,
  sealed=case when _state='provider_unknown' then sealed end,
  next_attempt_at=case when _state='provider_unknown' then coalesce((_outcome->>'nextAttemptAt')::timestamptz,clock_timestamp()+interval '1 minute') end
  where id=_delivery returning * into _d;
 return (select jsonb_build_object('deliveryId',_d.id,'claimId',_d.claim_id,'entitlementId',c.entitlement_id,'orderId',e.order_id,'state',_d.state,'sealed',_d.sealed,'attempts',_d.attempts,
  'nextAttemptAt',_d.next_attempt_at,'lastAttemptAt',_d.last_attempt_at,'acceptedAt',_d.accepted_at,'providerRef',_d.provider_ref,'lastOutcome',_d.last_outcome,'claimExpiresAt',c.expires_at)
  from commercial_education.program_claims c join commercial_education.program_entitlements e on e.id=c.entitlement_id where c.id=_d.claim_id);
end $$;
revoke all on function commercial_education.record_program_claim_delivery(uuid,integer,jsonb) from public;
grant execute on function commercial_education.record_program_claim_delivery(uuid,integer,jsonb) to commercial_education_delivery;

-- A replacement code: only an operator, only while nobody holds the entitlement; every issued claim is superseded and its delivery withdrawn in the same transaction.
create function commercial_education.reissue_program_claim(_entitlement uuid,_claim uuid,_token_hash text,_claim_expires_at timestamptz,_sealed jsonb,_operator text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _e commercial_education.program_entitlements%rowtype; _c commercial_education.program_claims%rowtype; _old record; _count integer:=0;
begin
 perform commercial_education.require_activation();
 if _operator is null or _operator !~ '^[A-Za-z0-9:_-]{3,128}$' or _sealed is null or jsonb_typeof(_sealed)<>'object' then raise exception using errcode='22023',message='program_entitlement_request_invalid'; end if;
 select * into _e from commercial_education.program_entitlements where id=_entitlement for update;
 if not found then raise exception using errcode='P0002',message='program_entitlement_not_found'; end if;
 if _e.state<>'awaiting_claim' or _e.subject_kind<>'unclaimed' then raise exception using errcode='55000',message='program_entitlement_transition_refused:entitlement_not_claimable'; end if;
 for _old in select id from commercial_education.program_claims where entitlement_id=_e.id and state='issued' for update loop
  update commercial_education.program_claims set state='superseded' where id=_old.id;
  perform commercial_education.withdraw_program_claim_delivery(_old.id,'claim superseded');
  _count:=_count+1;
 end loop;
 insert into commercial_education.program_claims(id,entitlement_id,token_hash,expires_at) values(_claim,_e.id,_token_hash,_claim_expires_at) returning * into _c;
 insert into commercial_education.program_claim_deliveries(claim_id,sealed,next_attempt_at) values(_c.id,_sealed,clock_timestamp());
 insert into commercial_education.program_entitlement_events(entitlement_id,kind,reference) values(_e.id,'transition',left('claim reissued by operator '||_operator,255));
 return jsonb_build_object('claim',commercial_education.claim_json(_c),'superseded',_count);
end $$;
revoke all on function commercial_education.reissue_program_claim(uuid,uuid,text,timestamptz,jsonb,text) from public;
grant execute on function commercial_education.reissue_program_claim(uuid,uuid,text,timestamptz,jsonb,text) to commercial_education_operator;
