-- Genuine append-only enforcement for restricted-review decisions.
--
-- The original migration added an RLS policy `USING(false)` on UPDATE
-- and DELETE. That works for the `authenticated` role but a SECURITY
-- DEFINER function running as postgres bypasses RLS entirely, and so
-- does any operator with elevated credentials — which means the "no
-- update, no delete" guarantee was only skin-deep.
--
-- The rest of the append-only knowledge surface uses a trigger
-- (private.knowledge_append_only) that RAISES 42501 unconditionally
-- for UPDATE and DELETE, and triggers fire regardless of role. Add the
-- same trigger here so the guarantee holds for every caller.

create trigger catalog_restricted_review_decisions_append_only
before update or delete on public.catalog_restricted_review_decisions
for each row execute function private.knowledge_append_only();
