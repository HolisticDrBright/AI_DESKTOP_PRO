-- decided_at needs strict monotonic ordering within a transaction.
--
-- The original migration set `default now()`, but `now()` returns the
-- transaction start time — every decision inserted inside the same
-- transaction ends up with the same timestamp, and
-- `order by decided_at desc limit 1` returns an arbitrary row instead of
-- the last-inserted one. That broke get_restricted_review_history's
-- "currentOutcome" claim, because five outcomes recorded in a row could
-- surface any of them as the current one.
--
-- clock_timestamp() returns the actual wall-clock reading at each call,
-- so each insert gets a distinct timestamp and "latest" is well defined.

alter table public.catalog_restricted_review_decisions
  alter column decided_at set default clock_timestamp();
