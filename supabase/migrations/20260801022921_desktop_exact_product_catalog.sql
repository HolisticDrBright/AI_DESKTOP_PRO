-- Phase 9B: the exact product catalog.
--
-- EXTENDS the catalog spine that protocols and inventory already reference —
-- `supplement_brands` → `supplement_products` → `supplement_product_versions`
-- → `product_ingredient_amounts` — rather than starting a fourth registry.
--
-- Reconnaissance flagged `product_label_versions` as a fourth registry and
-- proposed retiring it. That reading was WRONG and is corrected below: it has
-- no inbound foreign key, but it is reached by RPC and asserted by an existing
-- safety test, so it stays. Its `affiliate_url` column is a real defect and is
-- recorded as outstanding rather than "fixed" by deletion.
--
-- Commercial data for this phase lives in `product_commercial_links`, which
-- hangs off the organization's `products_services` row — commerce beside
-- commerce, never beside a label fact.
--
-- THE RULE THIS MIGRATION EXISTS FOR: a product fact is either recorded from a
-- real label or it is NULL. Nothing is inferred from a product name, and
-- "unknown" is a first-class state that the UI renders as "Unknown" rather
-- than as an empty cell that reads like an absence of the thing itself.
--
-- The catalog spine carries no organization_id: a label fact is objective and
-- shared. A practice's own opinion about a product is org-owned and lives in
-- `catalog_product_notes`, isolated per tenant.

begin;

-- --------------------------------------------------------- product identity

alter table public.supplement_products
  add column if not exists sku text,
  add column if not exists upc text,
  add column if not exists manufacturer_identifier text,
  add column if not exists category text,
  -- Regulatory class is NOT inferable from a name and is never defaulted.
  add column if not exists regulatory_classification text
    check (regulatory_classification in (
      'supplement', 'food', 'medical_food', 'prescription', 'peptide',
      'device', 'service', 'other')),
  add column if not exists jurisdiction text,
  add column if not exists status text not null default 'active'
    check (status in ('active', 'discontinued', 'archived')),
  add column if not exists discontinued_at timestamptz,
  add column if not exists current_version_id uuid
    references public.supplement_product_versions(id),
  add column if not exists created_by uuid references auth.users(id),
  add column if not exists updated_by uuid references auth.users(id);

create index if not exists sp_brand_idx on public.supplement_products (brand_id);
create index if not exists sp_status_idx on public.supplement_products (status);
create index if not exists sp_category_idx on public.supplement_products (category);
create index if not exists sp_regclass_idx on public.supplement_products (regulatory_classification);
create index if not exists sp_current_version_idx on public.supplement_products (current_version_id);
create index if not exists sp_created_by_idx on public.supplement_products (created_by);
create index if not exists sp_updated_by_idx on public.supplement_products (updated_by);
create unique index if not exists sp_upc_idx on public.supplement_products (upc) where upc is not null;

-- ------------------------------------------------------------ label facts

alter table public.supplement_product_versions
  add column if not exists other_ingredients text,
  add column if not exists allergens text[],
  add column if not exists label_directions text,
  add column if not exists label_warnings text,
  add column if not exists storage_requirements text,
  add column if not exists jurisdiction text,
  -- Where the label was read from. A manufacturer page or an official filing —
  -- never a retailer listing, and never an affiliate link.
  add column if not exists source_url text,
  add column if not exists source_kind text check (source_kind in (
    'manufacturer_label', 'manufacturer_site', 'regulatory_filing',
    'practitioner_supplied', 'other')),
  add column if not exists label_hash text,
  add column if not exists label_captured_at timestamptz,

  /**
   * The verification state machine.
   *
   *   incomplete   — recorded, but required label facts are missing
   *   verified     — a person checked this against the actual label
   *   stale        — verified once, but the label has since changed or aged out
   *   discontinued — the manufacturer no longer sells it
   *   conflicted   — two sources disagree; unusable until resolved
   *
   * Default is `incomplete`, not `verified`. A row cannot become verified by
   * being created.
   */
  add column if not exists verification_state text not null default 'incomplete'
    check (verification_state in (
      'incomplete', 'verified', 'stale', 'discontinued', 'conflicted')),
  add column if not exists verified_at timestamptz,
  add column if not exists verified_by uuid references auth.users(id),
  add column if not exists verification_note text,
  add column if not exists conflict_note text,
  add column if not exists status text not null default 'draft'
    check (status in ('draft', 'published', 'superseded', 'withdrawn')),
  add column if not exists superseded_by_id uuid
    references public.supplement_product_versions(id),
  add column if not exists created_by uuid references auth.users(id),

  /** Verified means a person did it: identity and time together, or neither. */
  add constraint spv_verified_needs_identity check (
    verification_state <> 'verified'
    or (verified_at is not null and verified_by is not null)),

  /** A conflicted label has to say what conflicts. */
  add constraint spv_conflict_needs_note check (
    verification_state <> 'conflicted' or conflict_note is not null);

create index if not exists spv_product_idx on public.supplement_product_versions (product_id);
create index if not exists spv_state_idx on public.supplement_product_versions (verification_state);
create index if not exists spv_status_idx on public.supplement_product_versions (status);
create index if not exists spv_superseded_idx on public.supplement_product_versions (superseded_by_id);
create index if not exists spv_verified_by_idx on public.supplement_product_versions (verified_by);
create index if not exists spv_created_by_idx on public.supplement_product_versions (created_by);

create index if not exists pia_version_idx on public.product_ingredient_amounts (product_version_id);
create index if not exists pia_ingredient_idx on public.product_ingredient_amounts (ingredient_id);

-- ------------------------------------------- organization-owned annotations
--
-- A practice's note about a shared product. Tenant-isolated, and deliberately
-- NOT a label fact: it can never make an unverified product verified.

create table public.catalog_product_notes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  product_id uuid not null references public.supplement_products(id) on delete cascade,
  note text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  unique (organization_id, product_id)
);

create index cpn_org_idx on public.catalog_product_notes (organization_id);
create index cpn_product_idx on public.catalog_product_notes (product_id);
create index cpn_created_by_idx on public.catalog_product_notes (created_by);
create index cpn_updated_by_idx on public.catalog_product_notes (updated_by);

-- ------------------------------------------------- reviewed-use exceptions
--
-- An unverified, stale, conflicted or discontinued product MAY appear in the
-- catalog — hiding it would just push practitioners to a worse source. What it
-- may not do is enter an APPROVED protocol without someone signing for that
-- decision by name, with a reason, against a specific product version.

create table public.catalog_use_exceptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  product_version_id uuid not null
    references public.supplement_product_versions(id) on delete cascade,
  reason text not null,
  /** The state being excepted, recorded so a later reader sees what was known. */
  excepted_state text not null,
  approved_by uuid not null references auth.users(id),
  approved_at timestamptz not null default now(),
  expires_on date,
  revoked_at timestamptz,
  revoked_by uuid references auth.users(id),
  revoked_reason text,
  created_at timestamptz not null default now()
);

create index cue_org_idx on public.catalog_use_exceptions (organization_id);
create index cue_version_idx on public.catalog_use_exceptions (product_version_id);
create index cue_approved_by_idx on public.catalog_use_exceptions (approved_by);
create index cue_revoked_by_idx on public.catalog_use_exceptions (revoked_by);
-- At most one live exception per organization per product version.
create unique index cue_one_live_idx
  on public.catalog_use_exceptions (organization_id, product_version_id)
  where revoked_at is null;

-- ------------------------------------------------------- commercial data
--
-- Kept where it already lived: hanging off the ORGANIZATION's products_services
-- row, not off the platform catalog. Extended with what the phase requires, and
-- nothing here is readable by the clinical eligibility path.

alter table public.product_commercial_links
  add column if not exists supplier_name text,
  add column if not exists commission_disclosure text,
  add column if not exists last_verified_at timestamptz,
  add column if not exists availability_status text
    check (availability_status in ('available', 'out_of_stock', 'discontinued', 'unknown')),
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists updated_by uuid references auth.users(id);

create index if not exists pcl_product_idx on public.product_commercial_links (product_id);
create index if not exists pcl_org_idx on public.product_commercial_links (organization_id);
create index if not exists pcl_created_by_idx on public.product_commercial_links (created_by);
create index if not exists pcl_updated_by_idx on public.product_commercial_links (updated_by);

-- ------------------------------------------------------------ immutability

/**
 * A PUBLISHED label version is frozen. A label fact that could change after
 * publication would silently rewrite the meaning of every protocol citing it.
 */
create or replace function private.catalog_label_protect()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if old.status in ('published', 'superseded', 'withdrawn') then
    if new.serving_size is distinct from old.serving_size
       or new.other_ingredients is distinct from old.other_ingredients
       or new.allergens is distinct from old.allergens
       or new.label_directions is distinct from old.label_directions
       or new.label_warnings is distinct from old.label_warnings
       or new.label_hash is distinct from old.label_hash
       or new.version_label is distinct from old.version_label then
      raise exception 'a published label version is immutable; supersede it instead'
        using errcode = '42501';
    end if;
    if new.status = 'draft' then
      raise exception 'a published label version cannot return to draft'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

create trigger supplement_product_versions_protect
  before update on public.supplement_product_versions
  for each row execute function private.catalog_label_protect();

/**
 * Ingredient amounts belong to a label version and are frozen with it —
 * otherwise the amounts could be edited underneath a published label.
 */
create or replace function private.catalog_amounts_protect()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare _frozen boolean; _v uuid;
begin
  _v := case when tg_op = 'DELETE' then old.product_version_id else new.product_version_id end;
  select status in ('published', 'superseded', 'withdrawn') into _frozen
    from public.supplement_product_versions where id = _v;
  if coalesce(_frozen, false) then
    raise exception 'the ingredients of a published label version cannot be changed'
      using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger product_ingredient_amounts_protect
  before insert or update or delete on public.product_ingredient_amounts
  for each row execute function private.catalog_amounts_protect();

-- ------------------------------------------------------------------- RLS

alter table public.catalog_product_notes enable row level security;
alter table public.catalog_use_exceptions enable row level security;

create policy catalog_notes_select on public.catalog_product_notes
  for select to authenticated using (private.is_org_member(organization_id));

create policy catalog_exceptions_select on public.catalog_use_exceptions
  for select to authenticated using (private.is_org_member(organization_id));

revoke insert, update, delete on
  public.catalog_product_notes, public.catalog_use_exceptions,
  public.supplement_products, public.supplement_product_versions,
  public.supplement_brands, public.supplement_ingredients,
  public.product_ingredient_amounts, public.product_commercial_links
from anon, authenticated;

revoke all on function private.catalog_label_protect() from public, anon, authenticated;
revoke all on function private.catalog_amounts_protect() from public, anon, authenticated;

-- ------------------------------------- product_label_versions is NOT dropped
--
-- Reconnaissance called it orphaned because no foreign key points at it. That
-- was wrong: it is reached by RPC (`save_product_label_version`,
-- `verify_product_label_version`) and asserted by an existing acceptance test.
-- Absence of an inbound FK is not absence of a dependent.
--
-- Its `affiliate_url` column really does put commercial data on a clinical
-- record, but deleting the table does not fix that — it breaks two live RPCs
-- and a safety test. The defect is recorded as outstanding in the authority
-- map, with the migration path stated there.

commit;
