-- Phase 8A: Desktop-owned billing, checkout, catalog & inventory — SCHEMA.
--
-- EXTENDS the 0011 billing skeleton in place (all tables verified empty):
-- no duplicate invoice/payment/catalog concepts. Adds suppliers, locations,
-- tax rates, commercial-link separation, per-location inventory with an
-- append-only ledger, immutable finalized invoices with line snapshots,
-- payment/refund state machines with append-only histories, patient credits,
-- and a durable webhook-event ledger. Money is ALWAYS integer minor units
-- with explicit ISO currency. Insurance claims are NOT part of this phase.
--
-- Write posture: the 0011 FOR ALL policies are replaced with SELECT-only
-- policies; every write goes through SECURITY DEFINER RPCs (next migration).

begin;

-- ---------------------------------------------------------------- helpers
create or replace function private.can_manage_billing(_org uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.organization_memberships m
    where m.organization_id = _org and m.user_id = auth.uid()
      and m.status = 'active' and m.role in ('owner', 'admin', 'practitioner')
  );
$$;

-- ------------------------------------------------------- reference tables
create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  contact_email text,
  phone text,
  notes text,
  archived_at timestamptz,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  unique (organization_id, name)
);

create table public.locations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  unique (organization_id, name)
);

create table public.tax_rates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  rate_bps integer not null check (rate_bps >= 0 and rate_bps <= 10000),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  unique (organization_id, name)
);

-- ------------------------------------------------- catalog extensions
alter table public.products_services
  add column sku text,
  add column barcode text,
  add column supplier_id uuid references public.suppliers(id) on delete set null,
  add column cost_minor bigint not null default 0 check (cost_minor >= 0),
  add column tax_rate_id uuid references public.tax_rates(id) on delete set null,
  add column description text,
  add column track_inventory boolean not null default false,
  add column reorder_threshold integer not null default 0 check (reorder_threshold >= 0),
  add column catalog_product_id uuid references public.supplement_products(id) on delete set null,
  add column archived_at timestamptz,
  add column version integer not null default 1,
  add column updated_by uuid references auth.users(id);

alter table public.products_services
  drop constraint products_services_kind_check;
alter table public.products_services
  add constraint products_services_kind_check
  check (kind in ('service','visit','program','package','lab','product','supplement','adjustment','other'));
alter table public.products_services
  add constraint products_services_amount_positive check (amount_minor >= 0);
create unique index products_services_org_sku_key
  on public.products_services (organization_id, sku) where sku is not null;

-- Commercial/affiliate metadata lives APART from clinical eligibility.
create table public.product_commercial_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  product_id uuid not null references public.products_services(id) on delete cascade,
  kind text not null check (kind in ('affiliate','wholesale','info')),
  label text not null,
  url text,
  disclosure text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);

-- ---------------------------------------------------------- inventory
create table public.inventory_stock (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  location_id uuid not null references public.locations(id) on delete cascade,
  product_id uuid not null references public.products_services(id) on delete cascade,
  on_hand integer not null default 0 check (on_hand >= 0),
  reserved integer not null default 0 check (reserved >= 0),
  reorder_threshold integer not null default 0 check (reorder_threshold >= 0),
  updated_at timestamptz not null default now(),
  primary key (location_id, product_id)
);
create index inventory_stock_org_idx on public.inventory_stock (organization_id, product_id);

-- Append-only movement ledger: on_hand and reserved deltas per movement.
create table public.inventory_ledger (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  location_id uuid not null references public.locations(id) on delete cascade,
  product_id uuid not null references public.products_services(id) on delete cascade,
  kind text not null check (kind in
    ('receipt','adjustment','reservation','release','sale','return','damaged','expired')),
  on_hand_delta integer not null default 0,
  reserved_delta integer not null default 0,
  reason text,
  condition text,
  unit_cost_minor bigint,
  supplier_id uuid references public.suppliers(id) on delete set null,
  ref_type text,
  ref_id uuid,
  actor_user_id uuid references auth.users(id),
  created_at timestamptz not null default now(),
  check (on_hand_delta <> 0 or reserved_delta <> 0)
);
create index inventory_ledger_stock_idx
  on public.inventory_ledger (location_id, product_id, created_at desc);
create index inventory_ledger_org_idx
  on public.inventory_ledger (organization_id, created_at desc);

create or replace function public.inventory_ledger_immutable()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  raise exception 'the inventory ledger is append-only' using errcode = '42501';
end;
$$;
create trigger inventory_ledger_no_mutation
  before update or delete on public.inventory_ledger
  for each row execute function public.inventory_ledger_immutable();

-- ---------------------------------------------------------- invoices
alter table public.invoices
  add column appointment_id uuid references public.appointments(id) on delete set null,
  add column practitioner_user_id uuid references auth.users(id),
  add column location_id uuid references public.locations(id) on delete set null,
  add column number_int integer,
  add column subtotal_minor bigint not null default 0 check (subtotal_minor >= 0),
  add column discount_minor bigint not null default 0 check (discount_minor >= 0),
  add column tax_minor bigint not null default 0 check (tax_minor >= 0),
  add column total_minor bigint not null default 0 check (total_minor >= 0),
  add column paid_minor bigint not null default 0 check (paid_minor >= 0),
  add column refunded_minor bigint not null default 0 check (refunded_minor >= 0),
  add column credit_applied_minor bigint not null default 0 check (credit_applied_minor >= 0),
  add column version integer not null default 1,
  add column finalized_at timestamptz,
  add column voided_at timestamptz,
  add column void_reason text,
  add column inventory_reserved_at timestamptz,
  add column inventory_committed_at timestamptz;

alter table public.invoices drop constraint invoices_status_check;
alter table public.invoices add constraint invoices_status_check
  check (status in ('draft','open','partially_paid','paid','void',
                    'refunded','partially_refunded','uncollectible'));
create unique index invoices_org_number_key
  on public.invoices (organization_id, number_int) where number_int is not null;
create index invoices_org_status_idx on public.invoices (organization_id, status, created_at desc);
create index invoices_patient_idx on public.invoices (patient_id, created_at desc);
create index invoices_appointment_idx on public.invoices (appointment_id) where appointment_id is not null;

alter table public.invoice_line_items
  add column kind text not null default 'product' check (kind in
    ('service','product','supplement','lab','program','package','adjustment')),
  add column name_snapshot text,
  add column sku_snapshot text,
  add column description_snapshot text,
  add column discount_minor bigint not null default 0 check (discount_minor >= 0),
  add column discount_reason text,
  add column discount_authorized_by uuid references auth.users(id),
  add column tax_rate_bps integer not null default 0 check (tax_rate_bps >= 0 and tax_rate_bps <= 10000),
  add column tax_minor bigint not null default 0 check (tax_minor >= 0),
  add column location_id uuid references public.locations(id) on delete set null,
  add column catalog_product_id uuid references public.supplement_products(id) on delete set null,
  add column verification_snapshot text,
  add column sort integer not null default 0;
create index invoice_line_items_invoice_idx on public.invoice_line_items (invoice_id, sort);

-- Finalized invoices are immutable snapshots; only the payment/credit/void
-- machinery (definer RPCs) may move the tracked-status columns.
create or replace function public.invoices_protect_finalized()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'invoices are never deleted' using errcode = '42501';
  end if;
  if old.finalized_at is not null then
    if new.patient_id is distinct from old.patient_id
      or new.organization_id is distinct from old.organization_id
      or new.appointment_id is distinct from old.appointment_id
      or new.practitioner_user_id is distinct from old.practitioner_user_id
      or new.location_id is distinct from old.location_id
      or new.currency is distinct from old.currency
      or new.number_int is distinct from old.number_int
      or new.subtotal_minor is distinct from old.subtotal_minor
      or new.discount_minor is distinct from old.discount_minor
      or new.tax_minor is distinct from old.tax_minor
      or new.total_minor is distinct from old.total_minor
      or new.finalized_at is distinct from old.finalized_at then
      raise exception 'a finalized invoice is immutable' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
create trigger invoices_finalized_guard
  before update or delete on public.invoices
  for each row execute function public.invoices_protect_finalized();

create or replace function public.invoice_lines_protect_finalized()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare _finalized timestamptz;
begin
  select finalized_at into _finalized from public.invoices
  where id = coalesce(new.invoice_id, old.invoice_id);
  if _finalized is not null then
    raise exception 'lines of a finalized invoice are immutable' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
create trigger invoice_lines_finalized_guard
  before insert or update or delete on public.invoice_line_items
  for each row execute function public.invoice_lines_protect_finalized();

create table public.invoice_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  kind text not null,
  from_status text,
  to_status text,
  detail_safe text,
  actor_user_id uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index invoice_events_invoice_idx on public.invoice_events (invoice_id, created_at);

create or replace function public.invoice_events_immutable()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  raise exception 'invoice history is append-only' using errcode = '42501';
end;
$$;
create trigger invoice_events_no_mutation
  before update or delete on public.invoice_events
  for each row execute function public.invoice_events_immutable();

-- ---------------------------------------------------------- payments
alter table public.payments
  alter column status set default 'pending';
alter table public.payments
  add constraint payments_status_check
  check (status in ('pending','succeeded','failed','canceled','disputed')),
  add column method text not null default 'external' check (method in
    ('card_test','cash','check','bank_transfer','external','credit')),
  add column reference text,
  add column received_by uuid references auth.users(id),
  add column environment text check (environment in ('test')),
  add column failure_code_safe text,
  add column version integer not null default 1,
  add constraint payments_amount_positive check (amount_minor > 0);
create index payments_invoice_idx on public.payments (invoice_id, created_at);
create index payments_org_idx on public.payments (organization_id, created_at desc);

-- A payment's financial identity is frozen at insert; only the state
-- machine columns may move, and never out of a terminal state except
-- succeeded -> disputed (processor evidence).
create or replace function public.payments_protect()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'payments are never deleted' using errcode = '42501';
  end if;
  if new.amount_minor is distinct from old.amount_minor
    or new.currency is distinct from old.currency
    or new.invoice_id is distinct from old.invoice_id
    or new.patient_id is distinct from old.patient_id
    or new.organization_id is distinct from old.organization_id
    or new.method is distinct from old.method
    or new.idempotency_key is distinct from old.idempotency_key then
    raise exception 'a payment''s financial identity is immutable' using errcode = '42501';
  end if;
  if old.status in ('succeeded','failed','canceled')
    and new.status is distinct from old.status
    and not (old.status = 'succeeded' and new.status = 'disputed') then
    raise exception 'a completed payment cannot change state' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger payments_guard
  before update or delete on public.payments
  for each row execute function public.payments_protect();

create table public.payment_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  payment_id uuid not null references public.payments(id) on delete cascade,
  from_status text,
  to_status text not null,
  source text not null check (source in ('rpc','webhook','reconciliation')),
  provider_event_id text,
  detail_safe text,
  created_at timestamptz not null default now()
);
create index payment_events_payment_idx on public.payment_events (payment_id, created_at);
create trigger payment_events_no_mutation
  before update or delete on public.payment_events
  for each row execute function public.invoice_events_immutable();

-- ---------------------------------------------------------- refunds
alter table public.refunds
  add column status text not null default 'succeeded' check (status in ('pending','succeeded','failed')),
  add column method text not null default 'external' check (method in
    ('card_test','cash','check','bank_transfer','external','credit')),
  add column authorized_by uuid references auth.users(id),
  add column environment text check (environment in ('test')),
  add constraint refunds_amount_positive check (amount_minor > 0);
create index refunds_payment_idx on public.refunds (payment_id, created_at);

create trigger refunds_no_mutation
  before update or delete on public.refunds
  for each row execute function public.invoice_events_immutable();

-- ------------------------------------------------------ patient credits
create table public.patient_credit_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  kind text not null check (kind in ('grant','apply','release')),
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null default 'USD',
  invoice_id uuid references public.invoices(id) on delete set null,
  reason text,
  actor_user_id uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index patient_credit_entries_patient_idx
  on public.patient_credit_entries (patient_id, created_at);
create trigger patient_credit_entries_no_mutation
  before update or delete on public.patient_credit_entries
  for each row execute function public.invoice_events_immutable();

-- ---------------------------------------------- webhook / reconciliation
-- Durable processor-event ledger: dedup, out-of-order record, audit trail.
-- PHI-free and secret-free by construction (ids, type, amounts only).
create table public.billing_webhook_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  provider text not null check (provider in ('stripe_test')),
  event_id text not null,
  event_type text not null,
  payment_id uuid references public.payments(id) on delete set null,
  invoice_id uuid references public.invoices(id) on delete set null,
  amount_minor bigint,
  currency text,
  outcome text not null check (outcome in
    ('processed','duplicate','ignored','refused','out_of_order')),
  detail_safe text,
  received_at timestamptz not null default now(),
  unique (provider, event_id)
);
create index billing_webhook_events_org_idx
  on public.billing_webhook_events (organization_id, received_at desc);

-- ---------------------------------------------------------- review queue
alter table public.review_queue_items drop constraint review_queue_items_item_type_check;
alter table public.review_queue_items add constraint review_queue_items_item_type_check
  check (item_type in ('lab_extraction','abnormal_result','reasoning_snapshot','hypothesis',
    'recommendation','supplement_interaction','protocol','experiment','assessment',
    'patient_message','safety_alert','refill_request','low_adherence','overdue_followup',
    'sync_review','inventory_low_stock'));

-- --------------------------------------------------------- RLS posture
-- Replace the 0011 broad FOR ALL policies with SELECT-only; ALL writes go
-- through the definer RPC boundary in the companion migration.
drop policy if exists invoices_access on public.invoices;
drop policy if exists invoice_line_items_access on public.invoice_line_items;
drop policy if exists payments_access on public.payments;
drop policy if exists refunds_access on public.refunds;
drop policy if exists products_services_admin on public.products_services;

drop policy if exists invoices_select on public.invoices;
create policy invoices_select on public.invoices
  for select to authenticated using (private.can_access_patient(patient_id));
drop policy if exists invoice_line_items_select on public.invoice_line_items;
create policy invoice_line_items_select on public.invoice_line_items
  for select to authenticated using (private.can_access_patient(patient_id));
drop policy if exists payments_select on public.payments;
create policy payments_select on public.payments
  for select to authenticated using (private.can_access_patient(patient_id));
drop policy if exists refunds_select on public.refunds;
create policy refunds_select on public.refunds
  for select to authenticated using (private.can_access_patient(patient_id));
drop policy if exists products_services_select on public.products_services;
create policy products_services_select on public.products_services
  for select to authenticated using (private.is_org_member(organization_id));

alter table public.suppliers enable row level security;
alter table public.locations enable row level security;
alter table public.tax_rates enable row level security;
alter table public.product_commercial_links enable row level security;
alter table public.inventory_stock enable row level security;
alter table public.inventory_ledger enable row level security;
alter table public.invoice_events enable row level security;
alter table public.payment_events enable row level security;
alter table public.patient_credit_entries enable row level security;
alter table public.billing_webhook_events enable row level security;

drop policy if exists suppliers_select on public.suppliers;
create policy suppliers_select on public.suppliers
  for select to authenticated using (private.is_org_member(organization_id));
drop policy if exists locations_select on public.locations;
create policy locations_select on public.locations
  for select to authenticated using (private.is_org_member(organization_id));
drop policy if exists tax_rates_select on public.tax_rates;
create policy tax_rates_select on public.tax_rates
  for select to authenticated using (private.is_org_member(organization_id));
drop policy if exists product_commercial_links_select on public.product_commercial_links;
create policy product_commercial_links_select on public.product_commercial_links
  for select to authenticated using (private.is_org_member(organization_id));
drop policy if exists inventory_stock_select on public.inventory_stock;
create policy inventory_stock_select on public.inventory_stock
  for select to authenticated using (private.is_org_member(organization_id));
drop policy if exists inventory_ledger_select on public.inventory_ledger;
create policy inventory_ledger_select on public.inventory_ledger
  for select to authenticated using (private.is_org_member(organization_id));
drop policy if exists invoice_events_select on public.invoice_events;
create policy invoice_events_select on public.invoice_events
  for select to authenticated using (private.is_org_member(organization_id));
drop policy if exists payment_events_select on public.payment_events;
create policy payment_events_select on public.payment_events
  for select to authenticated using (private.is_org_member(organization_id));
drop policy if exists patient_credit_entries_select on public.patient_credit_entries;
create policy patient_credit_entries_select on public.patient_credit_entries
  for select to authenticated using (private.can_access_patient(patient_id));
drop policy if exists billing_webhook_events_select on public.billing_webhook_events;
create policy billing_webhook_events_select on public.billing_webhook_events
  for select to authenticated using (
    organization_id is not null and private.is_org_member(organization_id));

revoke insert, update, delete on public.products_services from anon, authenticated;
revoke insert, update, delete on public.invoices from anon, authenticated;
revoke insert, update, delete on public.invoice_line_items from anon, authenticated;
revoke insert, update, delete on public.payments from anon, authenticated;
revoke insert, update, delete on public.refunds from anon, authenticated;
revoke all on public.suppliers from anon, authenticated;
revoke all on public.locations from anon, authenticated;
revoke all on public.tax_rates from anon, authenticated;
revoke all on public.product_commercial_links from anon, authenticated;
revoke all on public.inventory_stock from anon, authenticated;
revoke all on public.inventory_ledger from anon, authenticated;
revoke all on public.invoice_events from anon, authenticated;
revoke all on public.payment_events from anon, authenticated;
revoke all on public.patient_credit_entries from anon, authenticated;
revoke all on public.billing_webhook_events from anon, authenticated;
grant select on public.suppliers, public.locations, public.tax_rates,
  public.product_commercial_links, public.inventory_stock, public.inventory_ledger,
  public.invoice_events, public.payment_events, public.patient_credit_entries,
  public.billing_webhook_events to authenticated;

commit;
