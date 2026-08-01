-- Drop two indexes this phase added that already existed under Phase-1 names.
--
-- `clinical_knowledge_import_batches` already carried
-- `clinical_knowledge_import_batches_created_by_idx` and
-- `..._org_idx (organization_id, created_at desc)`. The graph/import migration
-- added byte-identical copies as `ckib_created_by_idx` and `ckib_org_idx`.
--
-- Duplicate indexes are not free: every insert and update maintains both, and
-- they mislead the next person into thinking two different access paths were
-- intended. Found by the performance advisor immediately after apply.

begin;

drop index if exists public.ckib_created_by_idx;
drop index if exists public.ckib_org_idx;

commit;
