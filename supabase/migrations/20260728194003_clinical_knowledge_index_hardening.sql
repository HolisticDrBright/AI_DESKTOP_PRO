-- Cover foreign-key lookups used by tenant checks, version review, and
-- retention/deletion workflows in the clinical knowledge registry.

begin;

create index if not exists clinical_pathways_created_by_idx
  on public.clinical_pathways (created_by);
create index if not exists clinical_pathways_retired_by_idx
  on public.clinical_pathways (retired_by)
  where retired_by is not null;

create index if not exists clinical_pathway_versions_pathway_org_idx
  on public.clinical_pathway_versions (pathway_id, organization_id);
create index if not exists clinical_pathway_versions_created_by_idx
  on public.clinical_pathway_versions (created_by);
create index if not exists clinical_pathway_versions_approved_by_idx
  on public.clinical_pathway_versions (approved_by)
  where approved_by is not null;
create index if not exists clinical_pathway_versions_retired_by_idx
  on public.clinical_pathway_versions (retired_by)
  where retired_by is not null;
create index if not exists clinical_pathway_versions_superseded_by_idx
  on public.clinical_pathway_versions (superseded_by)
  where superseded_by is not null;

create index if not exists product_label_versions_created_by_idx
  on public.product_label_versions (created_by);
create index if not exists product_label_versions_verified_by_idx
  on public.product_label_versions (verified_by)
  where verified_by is not null;

create index if not exists clinical_copilot_runs_org_idx
  on public.clinical_copilot_runs (organization_id, created_at desc);
create index if not exists clinical_copilot_runs_patient_org_idx
  on public.clinical_copilot_runs (patient_id, organization_id);
create index if not exists clinical_copilot_runs_pathway_org_idx
  on public.clinical_copilot_runs (pathway_version_id, organization_id);
create index if not exists clinical_copilot_runs_encounter_idx
  on public.clinical_copilot_runs (encounter_id)
  where encounter_id is not null;
create index if not exists clinical_copilot_runs_created_by_idx
  on public.clinical_copilot_runs (created_by);
create index if not exists clinical_copilot_runs_reviewed_by_idx
  on public.clinical_copilot_runs (reviewed_by)
  where reviewed_by is not null;
create index if not exists clinical_copilot_runs_superseded_by_idx
  on public.clinical_copilot_runs (superseded_by)
  where superseded_by is not null;

create index if not exists clinical_knowledge_import_batches_created_by_idx
  on public.clinical_knowledge_import_batches (created_by);
create index if not exists clinical_knowledge_import_batches_attested_by_idx
  on public.clinical_knowledge_import_batches (no_phi_attested_by);
create index if not exists clinical_knowledge_import_items_reviewed_by_idx
  on public.clinical_knowledge_import_items (reviewed_by)
  where reviewed_by is not null;

commit;
