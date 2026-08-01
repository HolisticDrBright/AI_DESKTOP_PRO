-- Restores public.product_label_versions, which the previous migration dropped
-- on a mistaken reading of reconnaissance.
--
-- The table has no foreign key pointing AT it, which is what the recon query
-- looked for — but it is reached by RPC (`save_product_label_version`,
-- `verify_product_label_version`) and asserted by an existing acceptance test
-- ("verified product label is immutable"). Absence of an inbound FK is not
-- absence of a dependent.
--
-- Restored from the authoritative migration, including the guard trigger. The
-- affiliate-separation defect it carries is real, but deletion does not fix it
-- — it breaks two live RPCs and a safety test. It is recorded as outstanding.

begin;

create table if not exists public.product_label_versions (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  product_code      text not null,
  version           integer not null check (version > 0),
  product_name      text not null,
  brand             text not null,
  exact_label       jsonb not null,
  label_sha256      text not null check (length(label_sha256) = 64),
  source_url        text,
  affiliate_url     text,
  status            text not null default 'pending'
                    check (status in ('pending','verified','expired','retired')),
  effective_at      timestamptz,
  expires_at        timestamptz,
  created_at        timestamptz not null default now(),
  created_by        uuid not null references auth.users(id),
  verified_at       timestamptz,
  verified_by       uuid references auth.users(id),
  verification_note text,
  unique (organization_id, product_code, version),
  unique (id, organization_id),
  check (jsonb_typeof(exact_label) = 'object'),
  check (
    (status = 'verified' and verified_at is not null and verified_by is not null)
    or status <> 'verified'
  )
);

create index if not exists product_label_versions_created_by_idx
  on public.product_label_versions (created_by);
create index if not exists product_label_versions_verified_by_idx
  on public.product_label_versions (verified_by)
  where verified_by is not null;

alter table public.product_label_versions enable row level security;

drop policy if exists product_label_versions_select on public.product_label_versions;
create policy product_label_versions_select on public.product_label_versions
  for select to authenticated using (private.is_org_member(organization_id));

drop trigger if exists product_label_version_guard on public.product_label_versions;
create trigger product_label_version_guard
  before update or delete on public.product_label_versions
  for each row execute function private.product_label_version_guard();

revoke all on table public.product_label_versions from anon, authenticated;
grant select on table public.product_label_versions to authenticated;

commit;
