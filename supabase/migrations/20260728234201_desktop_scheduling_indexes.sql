-- Support appointment actor lookups without changing scheduling semantics.
create index if not exists appointments_created_by_idx
  on public.appointments (created_by)
  where created_by is not null;

create index if not exists appointments_updated_by_idx
  on public.appointments (updated_by)
  where updated_by is not null;
