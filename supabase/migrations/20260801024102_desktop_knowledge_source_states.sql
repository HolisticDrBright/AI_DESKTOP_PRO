-- Reference lifecycle, reconciled with the Phase-1 append-only guarantee.
--
-- clinical_knowledge_sources has carried `private.forbid_mutation` since the
-- Phase-1 registry: ANY update raises 22023. The two triggers the references
-- migration added to it could therefore never fire — they read like a
-- guarantee while being unreachable, which is worse than not having them.
--
-- The Phase-1 model is the better one and is kept: a reference row NEVER
-- changes. A new edition is a new row (code + revision already support that).
-- Lifecycle becomes an append-only STATE LOG beside the row, and supersession
-- marks dependent claims stale on insert.

begin;

drop trigger if exists clinical_knowledge_sources_protect on public.clinical_knowledge_sources;
drop trigger if exists clinical_knowledge_sources_cascade_stale on public.clinical_knowledge_sources;
drop function if exists private.knowledge_reference_protect();
drop function if exists private.knowledge_cascade_stale();

create table public.clinical_knowledge_source_states (
  id uuid primary key default gen_random_uuid(),
  reference_id uuid not null
    references public.clinical_knowledge_sources(id) on delete cascade,
  status text not null
    check (status in ('draft', 'approved', 'superseded', 'withdrawn', 'expired')),
  reason text,
  superseded_by_id uuid references public.clinical_knowledge_sources(id),
  actor_user_id uuid references auth.users(id),
  created_at timestamptz not null default now(),
  -- Superseding names the successor; the others do not pretend to.
  check (status <> 'superseded' or superseded_by_id is not null)
);

create index ckss_reference_idx
  on public.clinical_knowledge_source_states (reference_id, created_at desc);
create index ckss_superseded_by_idx
  on public.clinical_knowledge_source_states (superseded_by_id);
create index ckss_actor_idx on public.clinical_knowledge_source_states (actor_user_id);

alter table public.clinical_knowledge_source_states enable row level security;

create policy knowledge_source_states_select
  on public.clinical_knowledge_source_states
  for select to authenticated using (auth.uid() is not null);

revoke insert, update, delete
  on public.clinical_knowledge_source_states from anon, authenticated;

create trigger clinical_knowledge_source_states_append_only
  before update or delete on public.clinical_knowledge_source_states
  for each row execute function private.knowledge_append_only();

/**
 * The current status of a reference: its latest state row, or the status it
 * was created with when no state has been recorded.
 */
create or replace function public.current_reference_status(_reference_id uuid)
returns text language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (select s.status from public.clinical_knowledge_source_states s
      where s.reference_id = _reference_id
      order by s.created_at desc, s.id desc limit 1),
    (select r.status from public.clinical_knowledge_sources r where r.id = _reference_id));
$$;

revoke all on function public.current_reference_status(uuid) from public, anon;
grant execute on function public.current_reference_status(uuid) to authenticated;

/**
 * Recording a superseded, withdrawn or expired state marks every claim citing
 * that reference STALE — not deleted, not edited. The practitioner keeps
 * reading the same words and additionally learns the ground moved.
 */
create or replace function private.knowledge_state_cascade_stale()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.status in ('superseded', 'withdrawn', 'expired') then
    update public.clinical_knowledge_claims
       set stale_at = now(),
           stale_reason = 'The reference behind this claim became ' || new.status || '.'
     where reference_id = new.reference_id and stale_at is null;
  end if;
  return new;
end;
$$;

create trigger clinical_knowledge_source_states_cascade
  after insert on public.clinical_knowledge_source_states
  for each row execute function private.knowledge_state_cascade_stale();

revoke all on function private.knowledge_state_cascade_stale()
  from public, anon, authenticated;

-- The foreign key the acceptance suite caught with no covering index.
create index if not exists platform_curators_granted_by_idx
  on public.platform_curators (granted_by);

commit;
