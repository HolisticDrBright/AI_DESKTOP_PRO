-- ============================================================
-- 0003 Privacy & audit foundation (Phase 1 gate)
-- consents, data_sharing_authorizations, privacy_acknowledgements,
-- audit_events (append-only), access_events (append-only),
-- breach_notifications, record_export_requests, record_deletion_requests.
-- Applied + verified against project urcjiehlxoehievobezf (advisor: 0 findings).
-- ============================================================

create table public.consents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  consent_type text not null,
  status text not null default 'granted' check (status in ('granted','revoked','expired')),
  version text, document_url text,
  granted_at timestamptz not null default now(), revoked_at timestamptz,
  source text not null default 'manual', source_record_id text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create index consents_patient_idx on public.consents (patient_id);
create trigger consents_set_updated_at before update on public.consents for each row execute function public.set_updated_at();

create table public.data_sharing_authorizations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  grantee_type text not null check (grantee_type in ('practitioner','organization','external')),
  grantee_ref text, scope text not null,
  status text not null default 'active' check (status in ('active','revoked','expired')),
  expires_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id), deleted_at timestamptz
);
create index dsa_patient_idx on public.data_sharing_authorizations (patient_id);
create trigger dsa_set_updated_at before update on public.data_sharing_authorizations for each row execute function public.set_updated_at();

create table public.privacy_acknowledgements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  document text not null, version text not null,
  acknowledged_at timestamptz not null default now(), created_at timestamptz not null default now()
);
create index priv_ack_user_idx on public.privacy_acknowledgements (user_id);

-- audit_events / access_events: append-only. Writes are server-side
-- (service_role bypasses RLS). Org admins read; nobody may update/delete.
create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete set null,
  patient_id uuid references public.patient_profiles(id) on delete set null,
  actor_user_id uuid references auth.users(id) on delete set null,
  action text not null, resource_type text, resource_id text,
  ip_address inet, user_agent text, safe_message text,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(), created_at timestamptz not null default now()
);
create index audit_events_org_idx on public.audit_events (organization_id, occurred_at desc);
create index audit_events_patient_idx on public.audit_events (patient_id, occurred_at desc);

create table public.access_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete set null,
  patient_id uuid references public.patient_profiles(id) on delete set null,
  actor_user_id uuid references auth.users(id) on delete set null,
  access_type text not null, resource_type text, resource_id text,
  occurred_at timestamptz not null default now(), created_at timestamptz not null default now()
);
create index access_events_org_idx on public.access_events (organization_id, occurred_at desc);
create index access_events_patient_idx on public.access_events (patient_id, occurred_at desc);

create table public.breach_notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid references public.patient_profiles(id) on delete set null,
  description text not null,
  severity text not null default 'medium' check (severity in ('low','medium','high','critical')),
  status text not null default 'open' check (status in ('open','investigating','notified','closed')),
  detected_at timestamptz not null default now(), notified_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);
create trigger breach_set_updated_at before update on public.breach_notifications for each row execute function public.set_updated_at();

create table public.record_export_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  requested_by uuid references auth.users(id),
  status text not null default 'pending' check (status in ('pending','processing','completed','failed')),
  format text not null default 'json' check (format in ('json','pdf','fhir')),
  file_ref text, requested_at timestamptz not null default now(), completed_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index rer_patient_idx on public.record_export_requests (patient_id);
create trigger rer_set_updated_at before update on public.record_export_requests for each row execute function public.set_updated_at();

create table public.record_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  requested_by uuid references auth.users(id),
  status text not null default 'pending' check (status in ('pending','approved','processing','completed','rejected')),
  reason text, requested_at timestamptz not null default now(), completed_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index rdr_patient_idx on public.record_deletion_requests (patient_id);
create trigger rdr_set_updated_at before update on public.record_deletion_requests for each row execute function public.set_updated_at();

-- RLS
alter table public.consents enable row level security;
alter table public.data_sharing_authorizations enable row level security;
alter table public.privacy_acknowledgements enable row level security;
alter table public.audit_events enable row level security;
alter table public.access_events enable row level security;
alter table public.breach_notifications enable row level security;
alter table public.record_export_requests enable row level security;
alter table public.record_deletion_requests enable row level security;

create policy consents_access on public.consents for all
  using (private.can_access_patient(patient_id)) with check (private.can_access_patient(patient_id));
create policy dsa_access on public.data_sharing_authorizations for all
  using (private.can_access_patient(patient_id)) with check (private.can_access_patient(patient_id));
create policy priv_ack_select on public.privacy_acknowledgements for select
  using (user_id = auth.uid() or private.is_org_admin(organization_id));
create policy priv_ack_insert on public.privacy_acknowledgements for insert
  with check (user_id = auth.uid());
create policy audit_events_read on public.audit_events for select
  using (private.is_org_admin(organization_id));
create policy access_events_read on public.access_events for select
  using (private.is_org_admin(organization_id));
create policy breach_admin on public.breach_notifications for all
  using (private.is_org_admin(organization_id)) with check (private.is_org_admin(organization_id));
create policy rer_access on public.record_export_requests for all
  using (private.can_access_patient(patient_id)) with check (private.can_access_patient(patient_id));
create policy rdr_access on public.record_deletion_requests for all
  using (private.can_access_patient(patient_id)) with check (private.can_access_patient(patient_id));
