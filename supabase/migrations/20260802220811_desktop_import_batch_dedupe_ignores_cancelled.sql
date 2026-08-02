-- Phase 9D follow-up — the batch dedupe index must ignore cancelled batches.
--
-- `ckib_source_hash_idx` was defined UNIQUE on (organization_id,
-- source_sha256) with no status filter. When Phase 9D re-previewed after
-- the source-restriction fix, the new-hash batches for the two
-- restricted-by-default files collided with the just-cancelled batches
-- of the same file (whose old hash was the items-only hash — different
-- from the new one) — wait no, THAT collision would be a different
-- source_sha256.
--
-- The collision that fired: cancelling a batch does not free its hash.
-- The next preview of the SAME items+flags gets 23505 unique_violation
-- and PostgREST returns 409. That is wrong: a cancelled batch is meant
-- to be re-openable, and the RPC's own logic already checks for an
-- existing `status = 'preview'` batch before inserting.
--
-- Fix: replace the unique index with a partial unique on
-- `status <> 'cancelled'`. Cancelled batches remain as immutable audit
-- rows but no longer occupy the dedupe slot.

drop index if exists public.ckib_source_hash_idx;

create unique index ckib_source_hash_idx
  on public.clinical_knowledge_import_batches (organization_id, source_sha256)
  where source_sha256 is not null and status <> 'cancelled';
