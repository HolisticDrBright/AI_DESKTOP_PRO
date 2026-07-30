-- Defense in depth for the provider callback ledger.
-- Applied migration version: 20260730002121.
--
-- `public.provider_callback_events` is worker infrastructure: it is written
-- and advanced only by the `worker_*` SECURITY DEFINER functions, which are
-- granted to `service_role` alone. Migration 0023 enabled RLS and
-- deliberately created no policies, so browser roles already read zero rows —
-- but Supabase's default table grants left `anon` and `authenticated` holding
-- SELECT/INSERT/UPDATE/DELETE/TRUNCATE on the table. RLS was the only thing
-- standing between a browser role and this ledger.
--
-- This mirrors what `desktop_audit_table_privileges` did for `audit_events`:
-- make the RPC-only posture explicit in the grant table, not just in RLS.
-- The definer functions are unaffected — they execute as the owner.

begin;

revoke all on table public.provider_callback_events from anon, authenticated;

commit;
