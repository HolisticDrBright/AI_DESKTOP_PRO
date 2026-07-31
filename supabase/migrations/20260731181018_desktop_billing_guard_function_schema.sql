-- Phase 8A follow-up: move the billing guard trigger functions out of the
-- PostgREST-exposed public schema into private, matching every other
-- desktop-owned phase (programs, inbox, sync). Security advisors flagged
-- the public placement as anon/authenticated-executable SECURITY DEFINER
-- functions. ALTER FUNCTION ... SET SCHEMA preserves the function OID, so
-- the existing triggers stay bound without recreation.

begin;

alter function public.inventory_ledger_immutable() set schema private;
alter function public.invoices_protect_finalized() set schema private;
alter function public.invoice_lines_protect_finalized() set schema private;
alter function public.invoice_events_immutable() set schema private;
alter function public.payments_protect() set schema private;

revoke execute on function private.inventory_ledger_immutable() from public, anon, authenticated;
revoke execute on function private.invoices_protect_finalized() from public, anon, authenticated;
revoke execute on function private.invoice_lines_protect_finalized() from public, anon, authenticated;
revoke execute on function private.invoice_events_immutable() from public, anon, authenticated;
revoke execute on function private.payments_protect() from public, anon, authenticated;

commit;
