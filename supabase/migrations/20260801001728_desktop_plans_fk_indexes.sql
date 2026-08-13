-- Phase 8B follow-up: index the five foreign keys that were only ever the
-- SECOND column of a composite index.
--
-- (organization_id, patient_id) serves the common org+patient lookup, but a
-- lookup or cascade by patient alone cannot use it, and the Supabase advisors
-- flag it as an unindexed foreign key. Indexes only — no contract change.
--
-- Found by the phase-8B acceptance suite's FK-coverage check.

create index if not exists entitlements_patient_idx
  on public.entitlements (patient_id);
create index if not exists patient_memberships_patient_idx
  on public.patient_memberships (patient_id);
create index if not exists plan_acceptances_patient_idx
  on public.plan_acceptances (patient_id);
create index if not exists processor_customers_patient_idx
  on public.processor_customers (patient_id);
create index if not exists financial_permission_grants_user_idx
  on public.financial_permission_grants (user_id);
