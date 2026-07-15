-- ============================================================
-- 0011 Addendum: billing, insurance claims, automations, connectors, telehealth
-- Monetary amounts are integer minor units + ISO currency (never floats).
-- ledger_entries / claim_status_events / automation_runs are append-only.
-- Applied + verified against project urcjiehlxoehievobezf.
-- ============================================================

create table public.products_services (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null, kind text check (kind in ('visit','program','package','lab','product','other')),
  amount_minor bigint not null default 0, currency text not null default 'USD', is_active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), created_by uuid references auth.users(id)
);
create table public.fee_schedules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null, definition jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.packages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null, sessions_included int, amount_minor bigint not null default 0, currency text not null default 'USD',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null, amount_minor bigint not null default 0, currency text not null default 'USD', interval text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  plan_tier text, seats int, status text not null default 'active', processor text, processor_ref text,
  amount_minor bigint not null default 0, currency text not null default 'USD', current_period_end timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  number text, status text not null default 'draft' check (status in ('draft','open','paid','void','uncollectible')),
  amount_minor bigint not null default 0, currency text not null default 'USD', due_at timestamptz,
  processor text, processor_ref text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create table public.invoice_line_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  invoice_id uuid references public.invoices(id) on delete cascade,
  product_service_id uuid references public.products_services(id) on delete set null,
  description text, quantity numeric not null default 1, unit_amount_minor bigint not null default 0,
  amount_minor bigint not null default 0, currency text not null default 'USD', created_at timestamptz not null default now()
);
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  invoice_id uuid references public.invoices(id) on delete set null,
  amount_minor bigint not null, currency text not null default 'USD',
  status text not null default 'succeeded', processor text, processor_ref text, idempotency_key text,
  paid_at timestamptz not null default now(), created_at timestamptz not null default now(),
  unique (organization_id, processor, idempotency_key)
);
create table public.refunds (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  payment_id uuid references public.payments(id) on delete set null,
  amount_minor bigint not null, currency text not null default 'USD', reason text,
  processor_ref text, idempotency_key text, created_at timestamptz not null default now()
);
create table public.superbills (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  file_ref text, generated_at timestamptz not null default now(), created_at timestamptz not null default now()
);
create table public.package_redemptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  package_id uuid references public.packages(id) on delete set null,
  redeemed_at timestamptz not null default now(), created_at timestamptz not null default now()
);
create table public.ledger_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid references public.patient_profiles(id) on delete set null,
  entry_type text not null, account text not null, debit_minor bigint not null default 0, credit_minor bigint not null default 0,
  currency text not null default 'USD', ref_type text, ref_id uuid, occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index ledger_org_idx on public.ledger_entries (organization_id, occurred_at desc);
create table public.insurance_payers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  name text not null, payer_id text, created_at timestamptz not null default now()
);
create table public.insurance_policies (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  payer_id uuid references public.insurance_payers(id) on delete set null,
  member_id text, group_number text, status text not null default 'active',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create table public.insurance_claims (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  policy_id uuid references public.insurance_policies(id) on delete set null,
  status text not null default 'draft', total_minor bigint not null default 0, currency text not null default 'USD',
  clearinghouse text, clearinghouse_ref text, idempotency_key text, submitted_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz,
  unique (organization_id, clearinghouse, idempotency_key)
);
create table public.claim_line_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  claim_id uuid references public.insurance_claims(id) on delete cascade,
  cpt text, icd10 text, units numeric, amount_minor bigint not null default 0, currency text not null default 'USD',
  created_at timestamptz not null default now()
);
create table public.claim_status_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid references public.patient_profiles(id) on delete set null,
  claim_id uuid references public.insurance_claims(id) on delete cascade,
  status text not null, detail text, occurred_at timestamptz not null default now(), created_at timestamptz not null default now()
);
create table public.eras (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  payer_id uuid references public.insurance_payers(id) on delete set null,
  clearinghouse_ref text, received_at timestamptz, payload jsonb, created_at timestamptz not null default now()
);
create table public.automation_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null, trigger_type text not null check (trigger_type in ('new_abnormal_lab','adherence_below_threshold','lab_uploaded','intake_completed','appointment_booked','experiment_completed')),
  conditions jsonb not null default '[]'::jsonb, actions jsonb not null default '[]'::jsonb,
  version text not null default 'v1', is_active boolean not null default false, requires_review boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), created_by uuid references auth.users(id)
);
create table public.automation_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid references public.patient_profiles(id) on delete set null,
  automation_rule_id uuid references public.automation_rules(id) on delete set null,
  rule_version text, triggered_by text, status text not null default 'completed',
  actions_taken jsonb not null default '[]'::jsonb, safe_error_message text, ran_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index automation_runs_org_idx on public.automation_runs (organization_id, ran_at desc);
create table public.connectors (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null, kind text, scopes jsonb not null default '[]'::jsonb,
  auth_reference text, sync_status text not null default 'idle', last_sync_at timestamptz, next_sync_at timestamptz,
  error_state text, safe_error_message text, webhook_secret_ref text, adapter_version text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), created_by uuid references auth.users(id)
);
create table public.connector_sync_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  connector_id uuid references public.connectors(id) on delete cascade,
  status text not null default 'queued', idempotency_key text, started_at timestamptz, completed_at timestamptz,
  error_code text, safe_error_message text, created_at timestamptz not null default now()
);
create table public.telehealth_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  appointment_id uuid references public.appointments(id) on delete set null,
  provider text, external_session_id text, join_url text, status text not null default 'scheduled',
  started_at timestamptz, ended_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);

do $$ declare t text;
begin
  foreach t in array array['invoices','invoice_line_items','payments','refunds','superbills','package_redemptions',
    'insurance_policies','insurance_claims','claim_line_items','claim_status_events','telehealth_sessions']
  loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('create policy %I_access on public.%I for all using (private.can_access_patient(patient_id)) with check (private.can_access_patient(patient_id));', t, t);
  end loop;
  foreach t in array array['products_services','fee_schedules','packages','memberships','subscriptions',
    'ledger_entries','insurance_payers','eras','automation_rules','automation_runs','connectors','connector_sync_jobs']
  loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('create policy %I_admin on public.%I for all using (private.is_org_admin(organization_id)) with check (private.is_org_admin(organization_id));', t, t);
  end loop;
  foreach t in array array['products_services','fee_schedules','packages','memberships','subscriptions','invoices',
    'insurance_policies','insurance_claims','automation_rules','connectors','telehealth_sessions']
  loop
    execute format('create trigger %I_set_updated_at before update on public.%I for each row execute function public.set_updated_at();', t, t);
  end loop;
end $$;
