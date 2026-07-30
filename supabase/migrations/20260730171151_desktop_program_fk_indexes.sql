-- desktop_program_fk_indexes
--
-- Advisor follow-up for Phase 3: cover every remaining unindexed foreign key
-- on the program tables the Desktop layer owns. programs.created_by /
-- updated_by were added in 20260730155911; the organization_id / patient_id /
-- audit-stamp keys below predate Phase 3 but now sit on hot Phase 3 query and
-- RLS paths (library listing by organization, patient-chart reads by patient).
-- Legacy program_steps / program_tasks / program_conditions are deliberately
-- untouched (no production callers).

begin;

create index if not exists programs_org_idx
  on public.programs (organization_id);
create index if not exists programs_created_by_idx
  on public.programs (created_by);
create index if not exists programs_updated_by_idx
  on public.programs (updated_by);

create index if not exists program_versions_org_idx
  on public.program_versions (organization_id);

create index if not exists program_templates_org_idx
  on public.program_templates (organization_id);

create index if not exists program_enrollments_org_idx
  on public.program_enrollments (organization_id);
create index if not exists program_enrollments_patient_idx
  on public.program_enrollments (patient_id, status);
create index if not exists program_enrollments_created_by_idx
  on public.program_enrollments (created_by);
create index if not exists program_enrollments_updated_by_idx
  on public.program_enrollments (updated_by);

commit;
