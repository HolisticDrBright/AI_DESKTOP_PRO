-- Audit rows are exposed only through caller-authorized functions. Domain
-- mutation functions remain able to append rows as their definer.

begin;

revoke all privileges on table public.audit_events
from public, anon, authenticated;

commit;
