-- Phase 9B: move commercial data off the clinical label record, for good.
--
-- `product_label_versions.affiliate_url` sat on the same row as the clinical
-- label. The previous attempt to fix this by deleting the table was wrong — it
-- is reached by RPC and asserted by a Phase-1 safety test. This is the correct
-- fix, and it keeps every existing caller working.
--
--   1. a new APPEND-ONLY commercial model, `product_label_commercial_links`;
--   2. history preserved — every existing affiliate_url is copied across
--      before the column goes, with its original row and timestamp;
--   3. the column dropped;
--   4. `save_product_label_version` keeps its EXACT signature, including the
--      affiliate argument, and routes it to the commercial model instead. No
--      caller changes, and the Phase-1 acceptance test still passes.
--
-- Append-only is the right shape here: a commercial relationship is a
-- historical fact about a point in time. Superseding one records a new row;
-- nothing is edited, so "what were we disclosing in March?" stays answerable.
--
-- THE SEPARATION IS STRUCTURAL, NOT PROCEDURAL. After this migration no
-- clinical table carries a commercial column, and the acceptance suite proves
-- that no clinical function body references a commercial table.

begin;

create table public.product_label_commercial_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  label_version_id uuid not null
    references public.product_label_versions(id) on delete cascade,

  kind text not null default 'affiliate'
    check (kind in ('affiliate', 'supplier', 'retailer', 'other')),
  url text,
  supplier_name text,
  /** Required for an affiliate relationship: undisclosed commission is the
      failure mode this whole separation exists to prevent. */
  commission_disclosure text,
  availability_status text
    check (availability_status in ('available', 'out_of_stock', 'discontinued', 'unknown')),
  last_verified_at timestamptz,

  /** Append-only supersession: a newer row replaces an older one by pointing
      back at it. The older row keeps saying what it always said. */
  supersedes_id uuid references public.product_label_commercial_links(id),
  revoked_at timestamptz,
  revoked_reason text,

  recorded_at timestamptz not null default now(),
  recorded_by uuid references auth.users(id),

  constraint plcl_affiliate_needs_disclosure check (
    kind <> 'affiliate' or url is null or commission_disclosure is not null)
);

create index plcl_org_idx on public.product_label_commercial_links (organization_id);
create index plcl_label_idx on public.product_label_commercial_links (label_version_id, recorded_at desc);
create index plcl_supersedes_idx on public.product_label_commercial_links (supersedes_id);
create index plcl_recorded_by_idx on public.product_label_commercial_links (recorded_by);

alter table public.product_label_commercial_links enable row level security;

create policy product_label_commercial_links_select
  on public.product_label_commercial_links
  for select to authenticated using (private.is_org_member(organization_id));

revoke insert, update, delete
  on public.product_label_commercial_links from anon, authenticated;

create trigger product_label_commercial_links_append_only
  before update or delete on public.product_label_commercial_links
  for each row execute function private.knowledge_append_only();

-- ------------------------------------------------------- preserve history
--
-- Copy every existing affiliate_url across before the column is dropped. Zero
-- rows today, but the migration is written to be correct against a populated
-- database — that is the difference between a migration and a convenience.

insert into public.product_label_commercial_links
  (organization_id, label_version_id, kind, url, commission_disclosure,
   recorded_at, recorded_by)
select v.organization_id, v.id, 'affiliate', v.affiliate_url,
       'Migrated from product_label_versions.affiliate_url. The original record '
         || 'carried no disclosure text; treat it as undisclosed pending review.',
       v.created_at, v.created_by
from public.product_label_versions v
where v.affiliate_url is not null;

alter table public.product_label_versions drop column affiliate_url;

-- ------------------------------------------------- keep the caller contract
--
-- Same signature, same arguments, same return shape. The affiliate argument now
-- lands in the commercial model. A caller that passed one keeps working; the
-- clinical row simply no longer carries it.

create or replace function public.save_product_label_version(
  _organization_id uuid, _product_code text, _product_name text, _brand text,
  _exact_label jsonb, _source_url text default null, _affiliate_url text default null
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _uid uuid; _version integer; _id uuid;
begin
  _uid := private.require_knowledge_editor(_organization_id);
  if coalesce(btrim(_product_code),'') = '' or coalesce(btrim(_product_name),'') = ''
     or coalesce(btrim(_brand),'') = '' or jsonb_typeof(_exact_label) <> 'object' then
    raise exception 'product identity and exact label object are required' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      _organization_id::text || ':product-label:' || lower(btrim(_product_code)), 0));

  select coalesce(max(version),0)+1 into _version from public.product_label_versions
    where organization_id = _organization_id and product_code = lower(btrim(_product_code));

  insert into public.product_label_versions
    (organization_id, product_code, version, product_name, brand, exact_label,
     label_sha256, source_url, created_by)
  values (_organization_id, lower(btrim(_product_code)), _version, btrim(_product_name),
          btrim(_brand), _exact_label, private.sha256_hex(_exact_label::text),
          _source_url, _uid)
  returning id into _id;

  -- Commercial data goes to the commercial model, never onto the label row.
  if _affiliate_url is not null and btrim(_affiliate_url) <> '' then
    insert into public.product_label_commercial_links
      (organization_id, label_version_id, kind, url, commission_disclosure, recorded_by)
    values (_organization_id, _id, 'affiliate', btrim(_affiliate_url),
            'Recorded via save_product_label_version without explicit disclosure text. '
              || 'Review and complete the disclosure before this link is shown.',
            _uid);
  end if;

  return jsonb_build_object('labelVersionId', _id, 'version', _version);
end;
$$;

revoke all on function public.save_product_label_version(uuid, text, text, text, jsonb, text, text)
  from public, anon;
grant execute on function public.save_product_label_version(uuid, text, text, text, jsonb, text, text)
  to authenticated;

/**
 * Read commercial links for a label version.
 *
 * Deliberately a SEPARATE function from every clinical read. Nothing in the
 * clinical path calls it, which is what makes "commercial data cannot affect
 * eligibility" checkable rather than merely asserted.
 */
create or replace function public.list_label_commercial_links(_label_version_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare _org uuid; _out jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  select organization_id into _org from public.product_label_versions
   where id = _label_version_id;
  if _org is null then
    raise exception 'record not found' using errcode = 'P0002';
  end if;
  if not private.is_org_member(_org) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', l.id, 'kind', l.kind, 'url', l.url, 'supplierName', l.supplier_name,
    'commissionDisclosure', l.commission_disclosure,
    'availabilityStatus', l.availability_status,
    'lastVerifiedAt', l.last_verified_at, 'revokedAt', l.revoked_at,
    'recordedAt', l.recorded_at) order by l.recorded_at desc), '[]'::jsonb)
  into _out
  from public.product_label_commercial_links l
  where l.label_version_id = _label_version_id;

  return jsonb_build_object(
    'labelVersionId', _label_version_id,
    'links', _out,
    'disclaimer', 'Commercial information is recorded for disclosure only. It is '
      || 'not read by any clinical eligibility, ranking, safety or evidence path.');
end;
$$;

revoke all on function public.list_label_commercial_links(uuid) from public, anon;
grant execute on function public.list_label_commercial_links(uuid) to authenticated;

commit;
