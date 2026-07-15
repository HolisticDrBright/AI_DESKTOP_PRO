-- ============================================================================
-- 0012 · Access hardening
-- ============================================================================
-- Forward-only. Four changes, all verified by
-- tests/practitioner_assignment_access.sql after apply:
--
--  1. WRITE-ROLE GATE — closes the confirmed finding that the bulk
--     `FOR ALL … can_access_patient()` policies let a patient's own login
--     write clinical rows. Every bulk policy is split into:
--        SELECT  → can_access_patient(patient_id) [+ deleted_at is null]
--        WRITE   → private.can_write_patient_data(patient_id)
--                  (= can_access_patient AND practitioner/admin/owner role
--                   in the patient's organization)
--     The patient-self READ lane is preserved. DELIBERATE EXCLUSIONS —
--     patient-rights surfaces stay patient-writable by design (they exist
--     for patient agency): data_sharing_authorizations,
--     record_export_requests, record_deletion_requests. Future
--     patient-writable tables (journals, symptoms, device data) are opened
--     per-table when the mobile app plugs in (ADR 0002).
--
--  2. SOFT-DELETE VISIBILITY — soft-deleted rows (deleted_at is not null)
--     are excluded from SELECT on every patient-scoped table that has the
--     column, plus patient_profiles / practitioner_profiles /
--     practitioner_patient_relationships. UPDATE deliberately does NOT
--     filter deleted_at so a practitioner can restore (un-delete) a row.
--
--  3. INVITATION TOKEN HASHING — invitations.token (plaintext credential)
--     is replaced by token_hash (sha-256). The app generates the token,
--     stores only the hash, and the claim flow compares hashes via
--     private.hash_invitation_token(). Rollback note: dropping the plaintext
--     column is irreversible by design; outstanding invitations (0 rows at
--     apply time) would be re-issued.
--
--  4. updated_by NORMALIZATION — organizations, organization_memberships,
--     practitioner_profiles gain updated_by to match the audit-column
--     convention used everywhere else.
-- ============================================================================

-- ------------------------------------------------------------ 1. write gate
create or replace function private.can_write_patient_data(_patient_id uuid)
returns boolean language sql stable security definer set search_path = 'pg_catalog','public' as $$
  select private.can_access_patient(_patient_id)
     and exists (
       select 1 from public.patient_profiles p
       where p.id = _patient_id
         and ( private.is_org_admin(p.organization_id)
            or private.has_org_role(p.organization_id, 'practitioner') )
     );
$$;
revoke all on function private.can_write_patient_data(uuid) from public;
grant execute on function private.can_write_patient_data(uuid) to authenticated, service_role;

-- Split every uniform bulk policy (`<table>_access`, FOR ALL, patient-gated).
-- The three patient-rights tables use different policy names and are skipped
-- by construction.
do $$
declare
  pol record;
  has_deleted boolean;
  sel_expr text;
begin
  for pol in
    select p.tablename
    from pg_policies p
    where p.schemaname = 'public'
      and p.policyname = p.tablename || '_access'
      and p.cmd = 'ALL'
      and p.qual ilike '%can_access_patient%'
  loop
    select exists (
      select 1 from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = pol.tablename
        and c.column_name = 'deleted_at'
    ) into has_deleted;

    sel_expr := 'private.can_access_patient(patient_id)'
      || case when has_deleted then ' and deleted_at is null' else '' end;

    execute format('drop policy %I on public.%I', pol.tablename || '_access', pol.tablename);
    execute format(
      'create policy %I on public.%I for select using (%s)',
      pol.tablename || '_select', pol.tablename, sel_expr);
    execute format(
      'create policy %I on public.%I for insert with check (private.can_write_patient_data(patient_id))',
      pol.tablename || '_insert', pol.tablename);
    execute format(
      'create policy %I on public.%I for update using (private.can_write_patient_data(patient_id)) with check (private.can_write_patient_data(patient_id))',
      pol.tablename || '_update', pol.tablename);
    execute format(
      'create policy %I on public.%I for delete using (private.can_write_patient_data(patient_id))',
      pol.tablename || '_delete', pol.tablename);
  end loop;
end $$;

-- --------------------------------------- 2. soft-delete on the access model
drop policy patient_select on public.patient_profiles;
create policy patient_select on public.patient_profiles
  for select using (private.can_access_patient(id) and deleted_at is null);

drop policy prof_select on public.practitioner_profiles;
create policy prof_select on public.practitioner_profiles
  for select using (private.is_org_member(organization_id) and deleted_at is null);

drop policy ppr_select on public.practitioner_patient_relationships;
create policy ppr_select on public.practitioner_patient_relationships
  for select using (
    (private.is_org_admin(organization_id) or practitioner_user_id = auth.uid())
    and deleted_at is null
  );

-- -------------------------------------------------- 3. invitation token hash
create or replace function private.hash_invitation_token(_token text)
returns text language sql immutable
set search_path = 'pg_catalog','public','extensions' as $$
  select encode(digest(_token, 'sha256'), 'hex');
$$;
revoke all on function private.hash_invitation_token(text) from public;
grant execute on function private.hash_invitation_token(text) to authenticated, service_role;

alter table public.invitations add column token_hash text;
update public.invitations
  set token_hash = private.hash_invitation_token(token)
  where token is not null;
alter table public.invitations alter column token_hash set not null;
alter table public.invitations add constraint invitations_token_hash_key unique (token_hash);
alter table public.invitations drop column token;

-- ------------------------------------------------- 4. updated_by everywhere
alter table public.organizations            add column updated_by uuid references auth.users(id);
alter table public.organization_memberships add column updated_by uuid references auth.users(id);
alter table public.practitioner_profiles    add column updated_by uuid references auth.users(id);

-- --------------------------------------------- migration-history bootstrap
-- Migrations 0001–0012 were applied to the live project via the management
-- API (MCP execute_sql), which does not write the CLI's history table.
-- Record them so `supabase migration list` / `db push` on a fresh checkout
-- converges with the live project (see supabase/README.md).
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (
  version text primary key,
  statements text[],
  name text
);
insert into supabase_migrations.schema_migrations (version, name) values
  ('20260715000001','tenancy_foundation'),
  ('20260715000002','patient_access_model'),
  ('20260715000003','privacy_foundation'),
  ('20260715000004','clinical_core'),
  ('20260715000005','labs_biomarkers'),
  ('20260715000006','reasoning_and_health_twin'),
  ('20260715000007','supplement_intelligence'),
  ('20260715000008','experiments'),
  ('20260715000009','operations_programs_assessments'),
  ('20260715000010','safety_knowledge_jobs_outcomes'),
  ('20260715000011','billing_claims_automations_connectors'),
  ('20260715000012','access_hardening')
on conflict (version) do nothing;
