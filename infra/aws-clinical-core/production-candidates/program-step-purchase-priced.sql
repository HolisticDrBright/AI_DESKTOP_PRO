-- Unreleased production candidate: the step-bound program purchase check, behind the program family's consumer
-- boundary and the owner's own program price (program-step-purchase/1, priced). BLOCKED: applied nowhere, registered
-- in no manifest, and its activation row below is disabled.
--
-- Parent: the 106-migration production artifact plus, unchanged and in their documented order,
-- lab-result-transfer-v2.sql, lab-observation-attestation.sql, production-program-assignments.sql,
-- production-program-consumer-boundary.sql and program-step-purchase.sql. It is the successor of the consumer boundary
-- for purchases: it reads program-step-purchase.sql's private step verdict and the boundary's activation, and redefines
-- nothing any of them defines. No historical migration, ledger, IAM or custody file changes. Registration, activation
-- evidence and execution are Codex work after review. Rollback: program-step-purchase-priced-rollback.sql.
--
-- Why it exists.
--   1. program-step-purchase.sql binds a purchase to the step the person was shown (owner, enrollment, exact step,
--      enrollment revision, the review's plan revision, the program content digest, the care connection and the
--      step's catalog product, version and target) and re-reads the server's current review at issue and again at
--      redemption. It did not ask whether the program family's consumer boundary is in force, so its check could be
--      reached with the boundary disabled, beside an unredacted program read.
--   2. Nothing asked whether the clinic has set a price for the program. Prices for separately purchased programs are
--      not decided; until the owner sets one, a step of that program is not something anyone can buy here, whatever
--      the step's own review says. The consultation route is unaffected: booking a consultation is not a purchase and
--      does not pass through this file.
--
-- What it does.
--   * clinical_core.program_step_purchase_priced_check(jsonb) becomes the API role's only step check: EXECUTE on
--     program-step-purchase.sql's check is revoked from clinical_core_api, so the unpriced verdict cannot be reached
--     directly. It needs all three activations (the program family, the consumer boundary, this file) and the step
--     activation, the same purchaser rule and request shape, then the predecessor's step verdict, then the price.
--   * The price: the program the enrollment was assigned from must have an active offer the owner priced
--     (payment_mode invoice_required, a price above zero, a currency). Otherwise program_price_unset, before anything
--     else is said about the offer, and nothing is written.
--
-- What it does not do. It sets no price, invents no price and reads no price into an answer: the verdict says only
-- whether a price is configured. It releases no hold, issues no action and returns no address; the destination stays
-- the consumer-action candidate's, after its own checks, under a reviewed purchase release, and the education-only
-- Core release has none.

create table clinical_core.program_step_purchase_priced_activation(
  singleton boolean primary key default true check(singleton),
  enabled boolean not null default false,
  evidence_sha256 text check(evidence_sha256 is null or evidence_sha256 ~ '^[0-9a-f]{64}$'),
  reviewed_by text check(reviewed_by is null or char_length(btrim(reviewed_by)) between 1 and 200),
  reviewed_at timestamptz,
  check(not enabled or (evidence_sha256 is not null and reviewed_by is not null and reviewed_at is not null))
);
insert into clinical_core.program_step_purchase_priced_activation(singleton,enabled) values(true,false);
alter table clinical_core.program_step_purchase_priced_activation enable row level security;
alter table clinical_core.program_step_purchase_priced_activation force row level security;
revoke all on clinical_core.program_step_purchase_priced_activation from public,clinical_core_api;
create trigger program_step_purchase_priced_activation_append_only before delete on clinical_core.program_step_purchase_priced_activation
  for each row execute function clinical_private.block_update_delete();

-- Has the owner priced the program this enrollment was assigned from? Only whether; never the price itself.
create function clinical_private.program_step_price_configured(_enrollment uuid,_org uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(
    select 1 from clinical_core.program_assignments a
    join clinical_core.program_versions v on v.id=a.program_version_id and v.organization_id=a.organization_id
    join clinical_core.program_offers o on o.program_id=v.program_id and o.organization_id=v.organization_id
    where a.id=_enrollment and a.organization_id=_org
      and o.status='active' and o.payment_mode='invoice_required' and o.price_cents>0 and char_length(o.currency)=3)
$$;
revoke all on function clinical_private.program_step_price_configured(uuid,uuid) from public;

-- Is this exact step available to buy now, under the boundary and at an owner-set price? The binding is the one the
-- person was shown; the answer is the server's. The request shape is the predecessor's, unchanged.
create function clinical_core.program_step_purchase_priced_check(_request jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare _actor uuid; _step jsonb:=_request->'step'; _reason text;
begin
  if not exists(select 1 from clinical_core.program_step_purchase_priced_activation where singleton and enabled)
    or not exists(select 1 from clinical_core.program_consumer_boundary_activation where singleton and enabled) then
    raise exception using errcode='42501',message='program_step_purchase_disabled'; end if;
  -- The predecessor's purchaser rule: both of its activations, the production consumer identity, the plan consent.
  _actor:=clinical_private.program_step_purchaser(true,true);
  if _request is null or jsonb_typeof(_request)<>'object' or octet_length(_request::text)>4096
    or _request-array['contract','step']<>'{}'::jsonb or _request->>'contract' is distinct from 'program-step-purchase/1'
    or jsonb_typeof(_step)<>'object'
    or _step-array['enrollmentId','itemId','assignmentRevision','planRevision','sourceDigest','connectionId','catalog']<>'{}'::jsonb
    or coalesce(_step->>'enrollmentId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or coalesce(_step->>'connectionId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or coalesce(_step->>'itemId','') !~ '^[A-Za-z0-9_.:-]{1,160}$'
    or coalesce(_step->>'assignmentRevision','') !~ '^[0-9]{1,18}$'
    or coalesce(_step->>'planRevision','') !~ '^[A-Za-z0-9:._-]+$' or char_length(_step->>'planRevision')>300
    or coalesce(_step->>'sourceDigest','') !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(_step->'catalog')<>'object' or (_step->'catalog')-array['stableId','version','target']<>'{}'::jsonb
    or coalesce(_step->'catalog'->>'stableId','') !~ '^prd_[a-z0-9][a-z0-9_-]{2,95}$'
    or jsonb_typeof(_step->'catalog'->'version')<>'number'
    or _step->'catalog'->>'target' is distinct from 'production-clinical' then
    raise exception using errcode='22023',message='program_step_purchase_invalid'; end if;
  -- The step first: another owner's, clinic's or link's step is refused as such before anything is said of its price.
  _reason:=clinical_private.program_step_purchase_reason(_actor,_step);
  if _reason is null and not clinical_private.program_step_price_configured((_step->>'enrollmentId')::uuid,clinical_private.organization_id()) then
    _reason:='program_price_unset'; end if;
  if _reason is not null then
    raise exception using errcode=case when _reason='program_step_refused' then '42501' else '40001' end,message=_reason; end if;
  return jsonb_build_object('contract','program-step-purchase/1','state','available','enrollmentId',_step->>'enrollmentId',
    'itemId',_step->>'itemId','assignmentRevision',_step->>'assignmentRevision','planRevision',_step->>'planRevision',
    'catalog',_step->'catalog');
end $$;
revoke all on function clinical_core.program_step_purchase_priced_check(jsonb) from public;
grant execute on function clinical_core.program_step_purchase_priced_check(jsonb) to clinical_core_api;
-- The unpriced verdict is no longer the API role's to call.
revoke execute on function clinical_core.program_step_purchase_check(jsonb) from clinical_core_api;
