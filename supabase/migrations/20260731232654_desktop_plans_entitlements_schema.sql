-- Phase 8B: plans, packages, memberships, entitlements & reconciliation — SCHEMA.
--
-- EXTENDS the 0011 skeleton in place (packages, memberships, package_redemptions
-- all verified empty): no second plan, purchase, invoice, payment, webhook or
-- reconciliation model. A purchase is a PHASE 8A INVOICE; a subscription charge
-- is a PHASE 8A PAYMENT; a processor event is a PHASE 8A billing_webhook_events
-- row. This migration adds only what 8A genuinely lacks: versioned offerings,
-- an append-only entitlement ledger, patient membership subscriptions, a
-- granular financial permission model, and reconciliation exceptions.
--
-- NOT touched: public.subscriptions (0011) is the ORGANIZATION'S OWN SaaS
-- subscription (plan_tier, seats) — a different domain from a patient's
-- membership. Conflating them would make "seats" meaningless on a patient
-- record, so patient memberships get their own table.
--
-- Clinical separation: nothing here grants clinical permission. An entitlement
-- is a COMMERCIAL right to be billed a certain way. It never implies medical
-- necessity, protocol approval, or eligibility to receive care.

begin;

-- ------------------------------------------------- granular financial perms
--
-- Phase 8A had a single gate (private.can_manage_billing = owner/admin/
-- practitioner). Phase 8B splits it: taking cash at the front desk is not the
-- same authority as issuing a refund, granting complimentary care, or
-- resolving a reconciliation exception.

create table public.financial_permission_grants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- Exactly one of role / user_id: a role default or a per-user override.
  role text check (role in ('owner', 'admin', 'practitioner', 'staff')),
  user_id uuid references auth.users(id) on delete cascade,
  permission text not null check (permission in (
    'billing.view_summary',
    'billing.create_invoice',
    'billing.take_payment',
    'billing.issue_refund',
    'billing.adjust_price',
    'catalog.manage_products',
    'inventory.adjust',
    'plans.manage',
    'comp.assign',
    'reconciliation.resolve',
    'reports.view_org'
  )),
  -- false = an explicit DENY that overrides the role default.
  granted boolean not null default true,
  reason text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  check ((role is null) <> (user_id is null)),
  unique (organization_id, role, permission),
  unique (organization_id, user_id, permission)
);

create index financial_permission_grants_org_role_idx
  on public.financial_permission_grants (organization_id, role);
create index financial_permission_grants_org_user_idx
  on public.financial_permission_grants (organization_id, user_id);
create index financial_permission_grants_created_by_idx
  on public.financial_permission_grants (created_by);

/**
 * Resolve one financial permission for the CALLER.
 *
 * Precedence: an explicit per-user row wins (grant or deny), then an explicit
 * per-org role row, then the built-in default below. Membership must be active
 * in every case — a permission grant never substitutes for membership.
 */
create or replace function private.has_financial_permission(_org uuid, _permission text)
returns boolean language plpgsql stable security definer set search_path = ''
as $$
declare
  _role text;
  _explicit boolean;
begin
  select m.role into _role
  from public.organization_memberships m
  where m.organization_id = _org and m.user_id = auth.uid() and m.status = 'active';

  if _role is null then
    return false;
  end if;

  -- 1. per-user override
  select g.granted into _explicit
  from public.financial_permission_grants g
  where g.organization_id = _org and g.user_id = auth.uid() and g.permission = _permission;
  if found then
    return _explicit;
  end if;

  -- 2. per-org role default
  select g.granted into _explicit
  from public.financial_permission_grants g
  where g.organization_id = _org and g.role = _role and g.permission = _permission;
  if found then
    return _explicit;
  end if;

  -- 3. built-in defaults. Owner/admin hold everything. A practitioner runs the
  -- commercial day-to-day but does NOT issue refunds, grant complimentary
  -- care, or resolve reconciliation. Staff take money at the desk and see
  -- their own workspace, nothing more.
  return case _role
    when 'owner' then true
    when 'admin' then true
    when 'practitioner' then _permission in (
      'billing.view_summary', 'billing.create_invoice', 'billing.take_payment',
      'billing.adjust_price', 'catalog.manage_products', 'inventory.adjust',
      'plans.manage'
    )
    when 'staff' then _permission in (
      'billing.view_summary', 'billing.create_invoice', 'billing.take_payment'
    )
    else false
  end;
end;
$$;

-- --------------------------------------------------------- plan definitions
--
-- packages / memberships are the ORG-OWNED OFFERINGS. Their commercial terms
-- live in an immutable *_versions row so an accepted plan can never be
-- retroactively rewritten.

alter table public.packages
  add column if not exists description text,
  add column if not exists kind text not null default 'visit_credits'
    check (kind in ('visit_credits', 'product_bundle', 'lab_bundle', 'program_bundle', 'mixed')),
  add column if not exists status text not null default 'draft'
    check (status in ('draft', 'active', 'archived')),
  add column if not exists current_version_id uuid,
  add column if not exists archived_at timestamptz,
  add column if not exists version integer not null default 1,
  add column if not exists created_by uuid references auth.users(id),
  add column if not exists updated_by uuid references auth.users(id);

create table public.package_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  package_id uuid not null references public.packages(id) on delete cascade,
  version_number integer not null,
  -- commercial terms, frozen once published
  price_minor bigint not null check (price_minor >= 0),
  currency text not null default 'USD',
  credit_quantity integer not null default 0 check (credit_quantity >= 0),
  -- a single-use credit is consumed whole; multi-use allows partial draw
  credit_mode text not null default 'single_use'
    check (credit_mode in ('single_use', 'multi_use')),
  expires_after_days integer check (expires_after_days is null or expires_after_days > 0),
  -- eligibility restrictions; empty array = unrestricted
  eligible_product_ids uuid[] not null default '{}',
  eligible_location_ids uuid[] not null default '{}',
  eligible_practitioner_ids uuid[] not null default '{}',
  transfer_policy text not null default 'non_transferable'
    check (transfer_policy in ('non_transferable', 'household', 'org_discretion')),
  terms_summary text,
  status text not null default 'draft' check (status in ('draft', 'published', 'retired')),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  unique (package_id, version_number)
);

create index package_versions_org_idx on public.package_versions (organization_id, package_id);
create index package_versions_created_by_idx on public.package_versions (created_by);

alter table public.memberships
  add column if not exists description text,
  add column if not exists status text not null default 'draft'
    check (status in ('draft', 'active', 'archived')),
  add column if not exists current_version_id uuid,
  add column if not exists archived_at timestamptz,
  add column if not exists version integer not null default 1,
  add column if not exists created_by uuid references auth.users(id),
  add column if not exists updated_by uuid references auth.users(id);

create table public.membership_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  membership_id uuid not null references public.memberships(id) on delete cascade,
  version_number integer not null,
  price_minor bigint not null check (price_minor >= 0),
  currency text not null default 'USD',
  interval_unit text not null default 'month'
    check (interval_unit in ('day', 'week', 'month', 'year')),
  interval_count integer not null default 1 check (interval_count > 0),
  trial_days integer not null default 0 check (trial_days >= 0),
  -- recurring benefits granted at the start of every paid period
  included_credits integer not null default 0 check (included_credits >= 0),
  included_benefit_note text,
  minimum_commitment_periods integer not null default 0 check (minimum_commitment_periods >= 0),
  grace_period_days integer not null default 0 check (grace_period_days >= 0),
  eligible_product_ids uuid[] not null default '{}',
  eligible_location_ids uuid[] not null default '{}',
  terms_summary text,
  status text not null default 'draft' check (status in ('draft', 'published', 'retired')),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  unique (membership_id, version_number)
);

create index membership_versions_org_idx on public.membership_versions (organization_id, membership_id);
create index membership_versions_created_by_idx on public.membership_versions (created_by);

-- Patient acceptance evidence for an exact plan version. Append-only.
create table public.plan_acceptances (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  package_version_id uuid references public.package_versions(id),
  membership_version_id uuid references public.membership_versions(id),
  -- how the practice captured it; never inferred
  method text not null check (method in ('in_person', 'portal', 'signed_document', 'verbal_documented')),
  accepted_at timestamptz not null default now(),
  terms_snapshot jsonb not null default '{}'::jsonb,
  recorded_by uuid references auth.users(id),
  note text,
  created_at timestamptz not null default now(),
  check ((package_version_id is null) <> (membership_version_id is null))
);

create index plan_acceptances_org_patient_idx on public.plan_acceptances (organization_id, patient_id);
create index plan_acceptances_pkg_idx on public.plan_acceptances (package_version_id);
create index plan_acceptances_mem_idx on public.plan_acceptances (membership_version_id);
create index plan_acceptances_recorded_by_idx on public.plan_acceptances (recorded_by);

-- ------------------------------------------- patient membership subscription
--
-- Distinct from public.subscriptions (the org's own SaaS seat licence).

create table public.patient_memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  membership_id uuid not null references public.memberships(id),
  -- the EXACT version whose terms govern this subscription, pinned forever
  membership_version_id uuid not null references public.membership_versions(id),
  status text not null default 'incomplete' check (status in (
    'incomplete', 'incomplete_expired', 'trialing', 'active',
    'past_due', 'unpaid', 'paused', 'canceled', 'expired'
  )),
  -- commercial origin
  origin text not null default 'purchase'
    check (origin in ('purchase', 'complimentary')),
  complimentary_reason text,
  complimentary_authorized_by uuid references auth.users(id),
  started_at timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz,
  trial_end timestamptz,
  cancel_at_period_end boolean not null default false,
  canceled_at timestamptz,
  cancel_reason text,
  paused_at timestamptz,
  ends_at timestamptz,
  grace_until timestamptz,
  minimum_commitment_end timestamptz,
  -- processor linkage: identifiers ONLY, never card data
  processor text check (processor in ('stripe_test')),
  processor_customer_ref text,
  processor_subscription_ref text,
  environment text check (environment = 'test'),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  -- a complimentary membership must say who authorized it and why
  check (origin <> 'complimentary'
         or (complimentary_reason is not null and complimentary_authorized_by is not null))
);

create index patient_memberships_org_patient_idx
  on public.patient_memberships (organization_id, patient_id);
create index patient_memberships_status_idx
  on public.patient_memberships (organization_id, status);
create index patient_memberships_membership_idx on public.patient_memberships (membership_id);
create index patient_memberships_version_idx on public.patient_memberships (membership_version_id);
create index patient_memberships_created_by_idx on public.patient_memberships (created_by);
create index patient_memberships_comp_by_idx on public.patient_memberships (complimentary_authorized_by);
-- One live subscription per patient per membership; canceled/expired may repeat.
create unique index patient_memberships_one_live_idx
  on public.patient_memberships (organization_id, patient_id, membership_id)
  where status in ('incomplete', 'trialing', 'active', 'past_due', 'unpaid', 'paused');
-- A processor subscription maps to exactly one row (idempotent creation).
create unique index patient_memberships_processor_ref_idx
  on public.patient_memberships (processor, processor_subscription_ref)
  where processor_subscription_ref is not null;

-- Append-only subscription history.
create table public.patient_membership_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_membership_id uuid not null references public.patient_memberships(id) on delete cascade,
  kind text not null,
  from_status text,
  to_status text,
  detail text,
  actor_user_id uuid references auth.users(id),
  source text not null default 'rpc' check (source in ('rpc', 'webhook', 'system')),
  created_at timestamptz not null default now()
);

create index patient_membership_events_sub_idx
  on public.patient_membership_events (patient_membership_id, created_at desc);
create index patient_membership_events_org_idx on public.patient_membership_events (organization_id);
create index patient_membership_events_actor_idx on public.patient_membership_events (actor_user_id);

-- --------------------------------------------------------- entitlement model
--
-- An entitlement is a COMMERCIAL right with a quantity. The five quantity
-- columns are maintained ONLY by the RPCs and must always satisfy the
-- accounting identity enforced below.

create table public.entitlements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  -- exactly one source
  package_version_id uuid references public.package_versions(id),
  patient_membership_id uuid references public.patient_memberships(id) on delete cascade,
  source text not null check (source in ('package_purchase', 'membership_period', 'complimentary')),
  -- what the credit may be spent on; empty = unrestricted within the org
  eligible_product_ids uuid[] not null default '{}',
  eligible_location_ids uuid[] not null default '{}',
  eligible_practitioner_ids uuid[] not null default '{}',
  credit_mode text not null default 'single_use'
    check (credit_mode in ('single_use', 'multi_use')),
  -- quantities: granted = remaining + reserved + consumed + expired + refunded
  granted_quantity integer not null check (granted_quantity >= 0),
  remaining_quantity integer not null default 0 check (remaining_quantity >= 0),
  reserved_quantity integer not null default 0 check (reserved_quantity >= 0),
  consumed_quantity integer not null default 0 check (consumed_quantity >= 0),
  expired_quantity integer not null default 0 check (expired_quantity >= 0),
  refunded_quantity integer not null default 0 check (refunded_quantity >= 0),
  expires_at timestamptz,
  -- the invoice that paid for it (phase 8A), or null when complimentary
  source_invoice_id uuid references public.invoices(id),
  -- period identity makes renewal grants idempotent
  period_key text,
  transfer_policy text not null default 'non_transferable'
    check (transfer_policy in ('non_transferable', 'household', 'org_discretion')),
  status text not null default 'active'
    check (status in ('active', 'exhausted', 'expired', 'revoked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  constraint entitlements_quantity_identity check (
    granted_quantity = remaining_quantity + reserved_quantity + consumed_quantity
                     + expired_quantity + refunded_quantity
  ),
  constraint entitlements_one_source check (
    (package_version_id is not null)::int + (patient_membership_id is not null)::int <= 1
  )
);

create index entitlements_org_patient_idx on public.entitlements (organization_id, patient_id);
create index entitlements_status_idx on public.entitlements (organization_id, status);
create index entitlements_membership_idx on public.entitlements (patient_membership_id);
create index entitlements_pkg_version_idx on public.entitlements (package_version_id);
create index entitlements_invoice_idx on public.entitlements (source_invoice_id);
create index entitlements_created_by_idx on public.entitlements (created_by);
create index entitlements_expiring_idx
  on public.entitlements (organization_id, expires_at)
  where status = 'active';
-- EXACTLY-ONCE granting: one entitlement per (membership, period).
create unique index entitlements_membership_period_idx
  on public.entitlements (patient_membership_id, period_key)
  where patient_membership_id is not null and period_key is not null;
-- EXACTLY-ONCE granting: one entitlement per paid invoice line source.
create unique index entitlements_invoice_package_idx
  on public.entitlements (source_invoice_id, package_version_id)
  where source_invoice_id is not null and package_version_id is not null;

-- The append-only truth. Every quantity change on entitlements writes here.
create table public.entitlement_ledger (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  entitlement_id uuid not null references public.entitlements(id) on delete cascade,
  kind text not null check (kind in (
    'grant', 'reserve', 'release', 'consume', 'expire', 'refund_revoke', 'manual_restore'
  )),
  quantity integer not null check (quantity > 0),
  -- what the movement was for
  ref_type text check (ref_type in ('appointment', 'invoice', 'invoice_line', 'manual', 'renewal')),
  ref_id uuid,
  reason text,
  actor_user_id uuid references auth.users(id),
  source text not null default 'rpc' check (source in ('rpc', 'webhook', 'system')),
  created_at timestamptz not null default now()
);

create index entitlement_ledger_ent_idx
  on public.entitlement_ledger (entitlement_id, created_at desc);
create index entitlement_ledger_org_idx on public.entitlement_ledger (organization_id, created_at desc);
create index entitlement_ledger_ref_idx on public.entitlement_ledger (ref_type, ref_id);
create index entitlement_ledger_actor_idx on public.entitlement_ledger (actor_user_id);
-- A given appointment can hold at most ONE live reservation per entitlement:
-- this is what makes concurrent booking unable to double-spend a credit.
create unique index entitlement_ledger_one_reserve_per_appointment_idx
  on public.entitlement_ledger (entitlement_id, ref_id)
  where kind = 'reserve' and ref_type = 'appointment';

-- package_redemptions (0011) becomes the human-readable redemption record.
alter table public.package_redemptions
  add column if not exists entitlement_id uuid references public.entitlements(id) on delete cascade,
  add column if not exists appointment_id uuid references public.appointments(id),
  add column if not exists quantity integer not null default 1 check (quantity > 0),
  add column if not exists state text not null default 'reserved'
    check (state in ('reserved', 'consumed', 'released')),
  add column if not exists released_reason text,
  add column if not exists recorded_by uuid references auth.users(id);

create index if not exists package_redemptions_ent_idx on public.package_redemptions (entitlement_id);
create index if not exists package_redemptions_appt_idx on public.package_redemptions (appointment_id);
create index if not exists package_redemptions_org_patient_idx
  on public.package_redemptions (organization_id, patient_id);
create index if not exists package_redemptions_pkg_idx on public.package_redemptions (package_id);
create index if not exists package_redemptions_recorded_by_idx
  on public.package_redemptions (recorded_by);

-- ---------------------------------------------------- org billing policy
--
-- No-show / late-cancel credit handling is an EXPLICIT organization policy,
-- never an implicit default buried in code.

create table public.org_billing_policies (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  -- what happens to a reserved credit when the visit does not happen
  no_show_policy text not null default 'consume'
    check (no_show_policy in ('consume', 'release', 'review')),
  late_cancel_policy text not null default 'release'
    check (late_cancel_policy in ('consume', 'release', 'review')),
  late_cancel_window_hours integer not null default 24 check (late_cancel_window_hours >= 0),
  -- when the credit is actually spent
  consume_on text not null default 'completed'
    check (consume_on in ('arrived', 'completed')),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

create index org_billing_policies_updated_by_idx on public.org_billing_policies (updated_by);

-- ------------------------------------------------------- stripe linkage
--
-- Identifiers ONLY. No card data, no secrets, ever.

create table public.processor_customers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  processor text not null default 'stripe_test' check (processor = 'stripe_test'),
  customer_ref text not null,
  environment text not null default 'test' check (environment = 'test'),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  -- idempotent creation: one customer per patient per processor
  unique (organization_id, patient_id, processor),
  unique (processor, customer_ref)
);

create index processor_customers_created_by_idx on public.processor_customers (created_by);

-- --------------------------------------------------- reconciliation model
--
-- Extends the 8A webhook ledger rather than replacing it: exceptions REFERENCE
-- billing_webhook_events / payments instead of copying them.

create table public.reconciliation_exceptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  kind text not null check (kind in (
    'unmatched_internal_payment', 'unmatched_provider_event', 'amount_mismatch',
    'currency_mismatch', 'duplicate_event', 'delayed_webhook', 'failed_webhook',
    'dispute', 'refund_action_required'
  )),
  status text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  payment_id uuid references public.payments(id),
  webhook_event_id uuid references public.billing_webhook_events(id),
  patient_membership_id uuid references public.patient_memberships(id),
  -- what disagreed; PHI-free by construction
  internal_amount_minor bigint,
  provider_amount_minor bigint,
  currency text,
  detail text,
  -- provider-side settlement figures. NULL means UNAVAILABLE, never zero:
  -- balance transactions and payouts are not fetched in this phase.
  provider_fee_minor bigint,
  provider_net_minor bigint,
  provider_settlement_status text,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id),
  resolution_reason text,
  check (status <> 'resolved' or (resolved_by is not null and resolution_reason is not null))
);

create index reconciliation_exceptions_org_status_idx
  on public.reconciliation_exceptions (organization_id, status, created_at desc);
create index reconciliation_exceptions_payment_idx on public.reconciliation_exceptions (payment_id);
create index reconciliation_exceptions_webhook_idx on public.reconciliation_exceptions (webhook_event_id);
create index reconciliation_exceptions_membership_idx
  on public.reconciliation_exceptions (patient_membership_id);
create index reconciliation_exceptions_resolved_by_idx
  on public.reconciliation_exceptions (resolved_by);

create table public.reconciliation_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  exception_id uuid not null references public.reconciliation_exceptions(id) on delete cascade,
  kind text not null,
  detail text,
  actor_user_id uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index reconciliation_events_exc_idx
  on public.reconciliation_events (exception_id, created_at desc);
create index reconciliation_events_org_idx on public.reconciliation_events (organization_id);
create index reconciliation_events_actor_idx on public.reconciliation_events (actor_user_id);

-- Subscription-shaped processor events need their own linkage on the 8A ledger.
alter table public.billing_webhook_events
  add column if not exists subscription_ref text,
  add column if not exists customer_ref text,
  add column if not exists livemode boolean,
  add column if not exists signature_verified boolean not null default false;

create index if not exists billing_webhook_events_subscription_idx
  on public.billing_webhook_events (subscription_ref);

-- ------------------------------------------------- dunning / work queue
alter table public.review_queue_items drop constraint if exists review_queue_items_item_type_check;
alter table public.review_queue_items add constraint review_queue_items_item_type_check
  check (item_type = any (array[
    'lab_extraction', 'abnormal_result', 'reasoning_snapshot', 'hypothesis',
    'recommendation', 'supplement_interaction', 'protocol', 'experiment',
    'assessment', 'patient_message', 'safety_alert', 'refill_request',
    'low_adherence', 'overdue_followup', 'sync_review', 'inventory_low_stock',
    -- phase 8B financial work
    'subscription_payment_failed', 'subscription_payment_method_required',
    'membership_expiring', 'package_credits_expiring', 'payment_unreconciled',
    'payment_dispute', 'refund_action_required', 'processor_failure_repeated'
  ]));

-- --------------------------------------------------------- immutability
--
-- Append-only tables reject UPDATE and DELETE at trigger level, so no future
-- RPC (or a compromised one) can quietly rewrite financial history.

create or replace function private.plans_append_only()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  raise exception 'append-only: % rows cannot be modified or deleted', tg_table_name
    using errcode = '42501';
end;
$$;

create trigger entitlement_ledger_append_only
  before update or delete on public.entitlement_ledger
  for each row execute function private.plans_append_only();

create trigger patient_membership_events_append_only
  before update or delete on public.patient_membership_events
  for each row execute function private.plans_append_only();

create trigger reconciliation_events_append_only
  before update or delete on public.reconciliation_events
  for each row execute function private.plans_append_only();

create trigger plan_acceptances_append_only
  before update or delete on public.plan_acceptances
  for each row execute function private.plans_append_only();

/**
 * A PUBLISHED plan version is frozen. Retiring it is the only legal change,
 * so an accepted plan's terms can never be rewritten under the patient.
 */
create or replace function private.plan_version_protect()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if old.status = 'published' then
    if new.status not in ('published', 'retired') then
      raise exception 'a published plan version cannot return to draft'
        using errcode = '42501';
    end if;
    if new.price_minor is distinct from old.price_minor
       or new.currency is distinct from old.currency
       or new.terms_summary is distinct from old.terms_summary
       or new.version_number is distinct from old.version_number then
      raise exception 'the terms of a published plan version are immutable'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

create trigger package_versions_protect
  before update on public.package_versions
  for each row execute function private.plan_version_protect();

create trigger membership_versions_protect
  before update on public.membership_versions
  for each row execute function private.plan_version_protect();

/**
 * Entitlement quantities move ONLY through the RPCs, which always write a
 * ledger row in the same statement. Direct quantity edits are refused.
 */
create or replace function private.entitlement_protect()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.granted_quantity is distinct from old.granted_quantity
     or new.patient_id is distinct from old.patient_id
     or new.organization_id is distinct from old.organization_id
     or new.source is distinct from old.source
     or new.source_invoice_id is distinct from old.source_invoice_id then
    raise exception 'an entitlement''s identity and grant size are immutable'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger entitlements_protect
  before update on public.entitlements
  for each row execute function private.entitlement_protect();

-- ------------------------------------------------------------------- RLS
alter table public.financial_permission_grants enable row level security;
alter table public.package_versions enable row level security;
alter table public.membership_versions enable row level security;
alter table public.plan_acceptances enable row level security;
alter table public.patient_memberships enable row level security;
alter table public.patient_membership_events enable row level security;
alter table public.entitlements enable row level security;
alter table public.entitlement_ledger enable row level security;
alter table public.org_billing_policies enable row level security;
alter table public.processor_customers enable row level security;
alter table public.reconciliation_exceptions enable row level security;
alter table public.reconciliation_events enable row level security;

-- 0011 left packages/memberships/package_redemptions with broad FOR ALL
-- policies. Replace them with SELECT-only, exactly as phase 8A did.
drop policy if exists packages_rw on public.packages;
drop policy if exists memberships_rw on public.memberships;
drop policy if exists package_redemptions_rw on public.package_redemptions;

do $$
declare r record;
begin
  for r in
    select schemaname, tablename, policyname from pg_policies
    where schemaname = 'public'
      and tablename in ('packages', 'memberships', 'package_redemptions')
  loop
    execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

create policy packages_select on public.packages for select to authenticated
  using (private.is_org_member(organization_id));
create policy memberships_select on public.memberships for select to authenticated
  using (private.is_org_member(organization_id));
create policy package_versions_select on public.package_versions for select to authenticated
  using (private.is_org_member(organization_id));
create policy membership_versions_select on public.membership_versions for select to authenticated
  using (private.is_org_member(organization_id));
create policy org_billing_policies_select on public.org_billing_policies for select to authenticated
  using (private.is_org_member(organization_id));
create policy financial_permission_grants_select on public.financial_permission_grants
  for select to authenticated using (private.is_org_member(organization_id));
create policy reconciliation_exceptions_select on public.reconciliation_exceptions
  for select to authenticated using (private.is_org_member(organization_id));
create policy reconciliation_events_select on public.reconciliation_events
  for select to authenticated using (private.is_org_member(organization_id));

-- Patient-scoped rows additionally require patient access.
create policy package_redemptions_select on public.package_redemptions for select to authenticated
  using (private.is_org_member(organization_id) and private.can_access_patient(patient_id));
create policy plan_acceptances_select on public.plan_acceptances for select to authenticated
  using (private.is_org_member(organization_id) and private.can_access_patient(patient_id));
create policy patient_memberships_select on public.patient_memberships for select to authenticated
  using (private.is_org_member(organization_id) and private.can_access_patient(patient_id));
create policy entitlements_select on public.entitlements for select to authenticated
  using (private.is_org_member(organization_id) and private.can_access_patient(patient_id));
create policy patient_membership_events_select on public.patient_membership_events
  for select to authenticated using (private.is_org_member(organization_id));
create policy entitlement_ledger_select on public.entitlement_ledger
  for select to authenticated using (private.is_org_member(organization_id));
-- processor_customers holds provider identifiers: readable by members, but
-- never writable from a browser role.
create policy processor_customers_select on public.processor_customers
  for select to authenticated using (private.is_org_member(organization_id));

-- Writes go through SECURITY DEFINER RPCs only.
revoke insert, update, delete on
  public.packages, public.memberships, public.package_redemptions,
  public.package_versions, public.membership_versions, public.plan_acceptances,
  public.patient_memberships, public.patient_membership_events,
  public.entitlements, public.entitlement_ledger, public.org_billing_policies,
  public.processor_customers, public.reconciliation_exceptions,
  public.reconciliation_events, public.financial_permission_grants
from anon, authenticated;

revoke all on public.processor_customers from anon;

-- Guard functions are private and not executable by browser roles.
revoke all on function private.plans_append_only() from public, anon, authenticated;
revoke all on function private.plan_version_protect() from public, anon, authenticated;
revoke all on function private.entitlement_protect() from public, anon, authenticated;
revoke all on function private.has_financial_permission(uuid, text) from public, anon;

commit;
