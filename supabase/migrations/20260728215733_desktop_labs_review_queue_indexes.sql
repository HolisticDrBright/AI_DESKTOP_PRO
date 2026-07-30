-- Query-path hardening for the Desktop-owned labs and review-queue reads.

begin;

drop policy if exists biomarker_definitions_read on public.biomarker_definitions;
create policy biomarker_definitions_read
on public.biomarker_definitions
for select
to authenticated
using ((select auth.uid()) is not null);

create index if not exists biomarker_obs_org_patient_observed_idx
  on public.biomarker_observations (organization_id, patient_id, observed_at desc)
  where deleted_at is null;

create index if not exists biomarker_obs_lab_document_idx
  on public.biomarker_observations (lab_document_id)
  where lab_document_id is not null and deleted_at is null;

create index if not exists lab_documents_org_patient_created_idx
  on public.lab_documents (organization_id, patient_id, created_at desc)
  where deleted_at is null;

create index if not exists review_queue_org_created_active_idx
  on public.review_queue_items (organization_id, created_at desc)
  where deleted_at is null and status <> 'dismissed';

create index if not exists review_queue_patient_idx
  on public.review_queue_items (patient_id)
  where patient_id is not null and deleted_at is null;

commit;
