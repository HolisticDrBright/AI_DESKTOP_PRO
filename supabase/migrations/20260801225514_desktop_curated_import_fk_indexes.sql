-- Leading indexes for the FKs the Phase 9C tables added.
--
-- `20260801185637` indexed the columns it expected to be read by (organization,
-- digest, ref, batch, item) and left the three attribution columns unindexed.
-- Those are exactly the columns a cascade has to scan when a user row is
-- touched, and the import-graph suite already asserts this property for the
-- Phase 9B tables — a rule that holds for one set of tables and not the next is
-- a rule that has stopped being one.

begin;

create index if not exists cisf_declared_by_idx
  on public.clinical_import_source_files (declared_by);

create index if not exists cip_imported_by_idx
  on public.clinical_import_provenance (imported_by);

create index if not exists sp_restricted_cleared_by_idx
  on public.supplement_products (restricted_cleared_by);

commit;
