-- Governed reference catalog and Desktop review surface.
-- This migration creates no catalog rows and grants no activation authority.

create schema if not exists clinical_reference;
create schema if not exists commercial_reference;

revoke all on schema clinical_reference from public;
revoke all on schema commercial_reference from public;

create table clinical_reference.catalog_import_batches (
  id uuid primary key default public.gen_random_uuid(),
  contract_version text not null check (char_length(btrim(contract_version)) between 1 and 100),
  source_package_id text not null check (source_package_id ~ '^[a-z0-9][a-z0-9._-]{2,127}$'),
  source_package_version text not null check (char_length(btrim(source_package_version)) between 1 and 64),
  manifest_sha256 text not null unique check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  environment text not null check (environment = 'production-clinical'),
  data_classification text not null default 'reference_only' check (data_classification = 'reference_only'),
  contains_phi boolean not null default false check (contains_phi = false),
  status text not null default 'importing' check (status in ('importing','succeeded','failed')),
  product_count integer not null default 0 check (product_count >= 0),
  protocol_template_count integer not null default 0 check (protocol_template_count >= 0),
  completed_at timestamptz,
  created_at timestamptz not null default clock_timestamp()
);

create table clinical_reference.catalog_products (
  stable_id text primary key check (stable_id ~ '^prd_[a-z0-9][a-z0-9_-]{2,95}$'),
  review_status text not null default 'needs_review'
    check (review_status in ('needs_review','approved','rejected','archived')),
  active_version integer check (active_version is null or active_version > 0),
  environment text not null check (environment = 'production-clinical'),
  data_classification text not null default 'reference_only' check (data_classification = 'reference_only'),
  contains_phi boolean not null default false check (contains_phi = false),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint catalog_product_approval_gate check (review_status <> 'approved' or active_version is not null)
);

create table clinical_reference.catalog_product_versions (
  id uuid primary key default public.gen_random_uuid(),
  product_stable_id text not null references clinical_reference.catalog_products(stable_id),
  version integer not null check (version > 0),
  display_name text not null check (char_length(btrim(display_name)) between 1 and 200),
  brand text,
  product_type text not null check (product_type in (
    'supplement','oral_peptide','practitioner_only','injectable_peptide','other'
  )),
  access_tier text not null check (access_tier in ('open','practitioner_gated','injectable','blocked')),
  declared_restricted boolean not null default false,
  direct_order_allowed boolean not null default false,
  label_sha256 text check (label_sha256 is null or label_sha256 ~ '^[0-9a-f]{64}$'),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  clinical_payload jsonb not null check (jsonb_typeof(clinical_payload) = 'object'),
  source_refs jsonb not null check (jsonb_typeof(source_refs) = 'array' and jsonb_array_length(source_refs) > 0),
  review_status text not null default 'needs_review'
    check (review_status in ('needs_review','approved','rejected','archived')),
  import_batch_id uuid not null references clinical_reference.catalog_import_batches(id),
  created_at timestamptz not null default clock_timestamp(),
  unique (product_stable_id, version),
  unique (product_stable_id, content_sha256),
  constraint catalog_product_payload_no_commercial_data check (
    not (clinical_payload ?| array['affiliateUrl','affiliateUrls','destinationUrl','discountCode','trackingCode'])
  ),
  constraint catalog_product_restriction_gate check (
    not declared_restricted or (direct_order_allowed = false and access_tier <> 'open')
  ),
  constraint catalog_product_injectable_gate check (
    access_tier <> 'injectable' or (product_type = 'injectable_peptide' and direct_order_allowed = false)
  )
);

create table clinical_reference.product_label_verifications (
  id uuid primary key default public.gen_random_uuid(),
  product_version_id uuid not null references clinical_reference.catalog_product_versions(id),
  reviewer_person_id uuid not null references clinical_core.persons(id),
  verification_note text not null check (char_length(btrim(verification_note)) between 1 and 2000),
  verified_at timestamptz not null default clock_timestamp()
);

create table clinical_reference.protocol_templates (
  stable_id text primary key check (stable_id ~ '^tpl_[a-z0-9][a-z0-9_-]{2,95}$'),
  review_status text not null default 'needs_review'
    check (review_status in ('needs_review','approved','rejected','archived')),
  active_version integer check (active_version is null or active_version > 0),
  superseded_by_stable_id text references clinical_reference.protocol_templates(stable_id),
  superseded_at timestamptz,
  superseded_reason text,
  environment text not null check (environment = 'production-clinical'),
  data_classification text not null default 'reference_only' check (data_classification = 'reference_only'),
  contains_phi boolean not null default false check (contains_phi = false),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint protocol_template_approval_gate check (review_status <> 'approved' or active_version is not null),
  constraint protocol_template_supersession_consistent check (
    (superseded_by_stable_id is null and superseded_at is null and superseded_reason is null)
    or (superseded_by_stable_id is not null and superseded_at is not null
      and char_length(btrim(superseded_reason)) between 1 and 2000)
  )
);

create table clinical_reference.protocol_template_versions (
  id uuid primary key default public.gen_random_uuid(),
  template_stable_id text not null references clinical_reference.protocol_templates(stable_id),
  version integer not null check (version > 0),
  title text not null check (char_length(btrim(title)) between 1 and 200),
  summary text,
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  source_refs jsonb not null check (jsonb_typeof(source_refs) = 'array' and jsonb_array_length(source_refs) > 0),
  review_status text not null default 'needs_review'
    check (review_status in ('needs_review','approved','rejected','archived')),
  approved_at timestamptz,
  import_batch_id uuid not null references clinical_reference.catalog_import_batches(id),
  created_at timestamptz not null default clock_timestamp(),
  unique (template_stable_id, version),
  unique (template_stable_id, content_sha256),
  constraint protocol_version_approval_consistent check (
    (review_status = 'approved' and approved_at is not null)
    or (review_status <> 'approved' and approved_at is null)
  )
);

create table clinical_reference.protocol_template_items (
  id uuid primary key default public.gen_random_uuid(),
  template_version_id uuid not null references clinical_reference.protocol_template_versions(id),
  position integer not null check (position > 0),
  product_stable_id text references clinical_reference.catalog_products(stable_id),
  label text not null check (char_length(btrim(label)) between 1 and 200),
  kind text not null check (char_length(btrim(kind)) between 1 and 64),
  instructions text,
  dosage_text text,
  timing_text text,
  route text,
  dose_source_kind text,
  dose_source_ref text,
  manufacturer text,
  product_sku text,
  product_upc text,
  monitoring_requirements jsonb not null default '[]'::jsonb check (jsonb_typeof(monitoring_requirements) = 'array'),
  stopping_rules jsonb not null default '[]'::jsonb check (jsonb_typeof(stopping_rules) = 'array'),
  contraindications jsonb not null default '[]'::jsonb check (jsonb_typeof(contraindications) = 'array'),
  followup_interval_days integer check (followup_interval_days is null or followup_interval_days > 0),
  jurisdiction_sensitive boolean not null default false,
  created_at timestamptz not null default clock_timestamp(),
  unique (template_version_id, position),
  constraint protocol_item_dose_provenance check (
    coalesce(btrim(dosage_text), '') = '' or coalesce(btrim(dose_source_ref), '') <> ''
  )
);

create table clinical_reference.protocol_template_safety_reviews (
  id uuid primary key default public.gen_random_uuid(),
  template_version_id uuid not null references clinical_reference.protocol_template_versions(id),
  outcome text not null check (outcome in ('passed','concerns','blocked')),
  note text not null check (char_length(btrim(note)) between 1 and 2000),
  items_reviewed integer not null check (items_reviewed >= 0),
  unsourced_dose_count integer not null check (unsourced_dose_count >= 0),
  reviewer_person_id uuid not null references clinical_core.persons(id),
  reviewed_at timestamptz not null default clock_timestamp()
);

create table commercial_reference.affiliate_offers (
  stable_id text primary key check (stable_id ~ '^off_[a-z0-9][a-z0-9_-]{2,95}$'),
  product_stable_id text not null references clinical_reference.catalog_products(stable_id),
  review_status text not null default 'needs_review'
    check (review_status in ('needs_review','approved','rejected','archived')),
  active_version integer check (active_version is null or active_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint affiliate_offer_approval_gate check (review_status <> 'approved' or active_version is not null)
);

create table commercial_reference.affiliate_offer_versions (
  id uuid primary key default public.gen_random_uuid(),
  offer_stable_id text not null references commercial_reference.affiliate_offers(stable_id),
  version integer not null check (version > 0),
  kind text not null default 'affiliate' check (kind in ('affiliate','manufacturer','practitioner')),
  destination_url text not null check (destination_url ~ '^https://'),
  supplier_name text,
  commission_disclosure text,
  availability_status text,
  tracking_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(tracking_metadata) = 'object'),
  declared_restricted boolean not null default false,
  direct_order_allowed boolean not null default false,
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  review_status text not null default 'needs_review'
    check (review_status in ('needs_review','approved','rejected','archived')),
  environment text not null check (environment = 'production-clinical'),
  import_batch_id uuid not null references clinical_reference.catalog_import_batches(id),
  last_verified_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  unique (offer_stable_id, version),
  unique (offer_stable_id, content_sha256),
  constraint affiliate_offer_restriction_gate check (
    not declared_restricted or direct_order_allowed = false
  )
);

create index catalog_product_versions_batch_idx on clinical_reference.catalog_product_versions(import_batch_id);
create index product_label_verifications_version_idx
  on clinical_reference.product_label_verifications(product_version_id, verified_at desc);
create index protocol_template_versions_batch_idx on clinical_reference.protocol_template_versions(import_batch_id);
create index protocol_template_items_version_idx
  on clinical_reference.protocol_template_items(template_version_id, position);
create index protocol_template_items_product_idx on clinical_reference.protocol_template_items(product_stable_id);
create index protocol_template_reviews_version_idx
  on clinical_reference.protocol_template_safety_reviews(template_version_id, reviewed_at desc);
create index affiliate_offers_product_idx on commercial_reference.affiliate_offers(product_stable_id);
create index affiliate_offer_versions_batch_idx on commercial_reference.affiliate_offer_versions(import_batch_id);

create or replace function clinical_reference.reject_immutable_catalog_history()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = '55000', message = 'catalog_history_append_only';
end
$$;

create trigger catalog_product_versions_append_only before update or delete
  on clinical_reference.catalog_product_versions for each row
  execute function clinical_reference.reject_immutable_catalog_history();
create trigger product_label_verifications_append_only before update or delete
  on clinical_reference.product_label_verifications for each row
  execute function clinical_reference.reject_immutable_catalog_history();
create trigger protocol_template_versions_append_only before update or delete
  on clinical_reference.protocol_template_versions for each row
  execute function clinical_reference.reject_immutable_catalog_history();
create trigger protocol_template_items_append_only before update or delete
  on clinical_reference.protocol_template_items for each row
  execute function clinical_reference.reject_immutable_catalog_history();
create trigger protocol_template_reviews_append_only before update or delete
  on clinical_reference.protocol_template_safety_reviews for each row
  execute function clinical_reference.reject_immutable_catalog_history();
create trigger affiliate_offer_versions_append_only before update or delete
  on commercial_reference.affiliate_offer_versions for each row
  execute function clinical_reference.reject_immutable_catalog_history();

alter table clinical_reference.catalog_import_batches enable row level security;
alter table clinical_reference.catalog_products enable row level security;
alter table clinical_reference.catalog_product_versions enable row level security;
alter table clinical_reference.product_label_verifications enable row level security;
alter table clinical_reference.protocol_templates enable row level security;
alter table clinical_reference.protocol_template_versions enable row level security;
alter table clinical_reference.protocol_template_items enable row level security;
alter table clinical_reference.protocol_template_safety_reviews enable row level security;
alter table commercial_reference.affiliate_offers enable row level security;
alter table commercial_reference.affiliate_offer_versions enable row level security;

revoke all on all tables in schema clinical_reference from public;
revoke all on all tables in schema commercial_reference from public;

create or replace function clinical_private.require_catalog_member(_organization_id uuid, _admin boolean default false)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  perform clinical_private.assert_production_context(_organization_id, 'clinical_data', 'workforce');
  if not exists (
    select 1 from clinical_core.organization_memberships membership
    where membership.organization_id = _organization_id
      and membership.person_id = clinical_private.actor_person_id()
      and membership.status = 'active'
      and (not _admin or membership.role in ('owner','admin'))
  ) then
    raise exception using errcode = '42501', message =
      case when _admin then 'organization_admin_required' else 'active_membership_required' end;
  end if;
end
$$;

create or replace function clinical_core.get_product_catalog(
  _organization_id uuid, _query text default null, _status text default null, _limit integer default 100
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare _products jsonb; _counts jsonb; _queue jsonb; _n integer;
begin
  perform clinical_private.require_catalog_member(_organization_id, false);
  if _status is not null and _status not in ('draft','published','superseded','withdrawn') then
    raise exception using errcode = '22023', message = 'catalog_status_invalid';
  end if;
  _n := least(greatest(coalesce(_limit, 100), 1), 500);
  with latest as (
    select distinct on (version.product_stable_id) version.*
    from clinical_reference.catalog_product_versions version
    join clinical_reference.catalog_products product on product.stable_id = version.product_stable_id
    where product.environment = 'production-clinical' and product.contains_phi = false
      and (_query is null or btrim(_query) = '' or version.display_name ilike '%' || btrim(_query) || '%'
        or coalesce(version.brand, '') ilike '%' || btrim(_query) || '%'
        or version.product_stable_id ilike '%' || btrim(_query) || '%')
      and (_status is null or case version.review_status
        when 'approved' then 'published' when 'archived' then 'superseded'
        when 'rejected' then 'withdrawn' else 'draft' end = _status)
    order by version.product_stable_id, version.version desc
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'labelVersionId', latest.id, 'productCode', latest.product_stable_id,
    'productName', latest.display_name, 'brand', latest.brand, 'version', latest.version,
    'status', case latest.review_status when 'approved' then 'published' when 'archived' then 'superseded'
      when 'rejected' then 'withdrawn' else 'draft' end,
    'labelSha256', latest.label_sha256, 'sourceUrl', latest.clinical_payload->>'sourceUrl',
    'effectiveAt', latest.clinical_payload->>'effectiveAt', 'expiresAt', latest.clinical_payload->>'expiresAt',
    'verifiedAt', verification.verified_at,
    'verificationState', case when verification.verified_at is null then 'unverified' else 'verified' end,
    'versionCount', (select count(*) from clinical_reference.catalog_product_versions history
      where history.product_stable_id = latest.product_stable_id),
    'ingredientCount', jsonb_array_length(coalesce(latest.clinical_payload->'ingredientRows','[]'::jsonb)),
    'hasWarnings', coalesce(nullif(btrim(latest.clinical_payload->>'warnings'),''), null) is not null,
    'commercialLinkCount', (select count(*) from commercial_reference.affiliate_offers offer
      join commercial_reference.affiliate_offer_versions offer_version
        on offer_version.offer_stable_id = offer.stable_id and offer_version.version = offer.active_version
      where offer.product_stable_id = latest.product_stable_id and offer.review_status = 'approved'
        and offer_version.review_status = 'approved' and offer_version.direct_order_allowed
        and not offer_version.declared_restricted),
    'commercialDisclosureComplete', not exists (
      select 1 from commercial_reference.affiliate_offers offer
      join commercial_reference.affiliate_offer_versions offer_version
        on offer_version.offer_stable_id = offer.stable_id and offer_version.version = offer.active_version
      where offer.product_stable_id = latest.product_stable_id and offer.review_status = 'approved'
        and offer_version.review_status = 'approved' and offer_version.kind = 'affiliate'
        and coalesce(btrim(offer_version.commission_disclosure),'') = '')
  ) order by latest.display_name, latest.product_stable_id), '[]'::jsonb) into _products
  from (select * from latest limit _n) latest
  left join lateral (select verified_at from clinical_reference.product_label_verifications verification
    where verification.product_version_id = latest.id order by verified_at desc limit 1) verification on true;

  with latest as (
    select distinct on (version.product_stable_id) version.*
    from clinical_reference.catalog_product_versions version
    order by version.product_stable_id, version.version desc
  ) select jsonb_build_object('total',count(*),
    'verified',count(*) filter (where exists (select 1 from clinical_reference.product_label_verifications verification
      where verification.product_version_id=latest.id)),
    'unverified',count(*) filter (where not exists (select 1 from clinical_reference.product_label_verifications verification
      where verification.product_version_id=latest.id)),
    'published',count(*) filter (where review_status='approved'),
    'draft',count(*) filter (where review_status='needs_review')) into _counts from latest;

  select coalesce(jsonb_agg(jsonb_build_object(
    'itemId',version.id,'displayName',version.display_name,'externalKey',version.product_stable_id,
    'changeKind','catalog_import','sourceName',batch.source_package_id,'validationErrors','[]'::jsonb,
    'conflictReason',null,'createdAt',version.created_at) order by version.created_at), '[]'::jsonb)
  into _queue from clinical_reference.catalog_product_versions version
  join clinical_reference.catalog_import_batches batch on batch.id=version.import_batch_id
  where version.review_status='needs_review';

  return jsonb_build_object('clinical',jsonb_build_object('products',_products,'counts',_counts),
    'reviewQueue',_queue,'generatedAt',clock_timestamp(),
    'emptyStateMessage','No governed product labels have been imported and approved for production.',
    'commercialPolicy','Commercial destinations are isolated and cannot affect clinical eligibility, ranking, safety, or evidence.',
    'unknownPolicy','Uncaptured label fields remain Unknown and are never inferred from a product name.');
end
$$;

create or replace function clinical_core.get_product_label_detail(_label_version_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare _version clinical_reference.catalog_product_versions%rowtype;
  _versions jsonb; _imports jsonb; _commercial jsonb; _verified_at timestamptz; _note text;
begin
  perform clinical_private.require_catalog_member(clinical_private.organization_id(), false);
  select * into _version from clinical_reference.catalog_product_versions where id=_label_version_id;
  if not found then raise exception using errcode='P0002', message='product_label_version_not_found'; end if;
  select verification.verified_at, verification.verification_note into _verified_at,_note
    from clinical_reference.product_label_verifications verification
    where verification.product_version_id=_version.id order by verification.verified_at desc limit 1;
  select coalesce(jsonb_agg(jsonb_build_object('labelVersionId',history.id,'version',history.version,
    'status',case history.review_status when 'approved' then 'published' when 'archived' then 'superseded'
      when 'rejected' then 'withdrawn' else 'draft' end,'labelSha256',history.label_sha256,
    'effectiveAt',history.clinical_payload->>'effectiveAt','expiresAt',history.clinical_payload->>'expiresAt',
    'verifiedAt',verification.verified_at,'verificationNote',verification.verification_note,
    'createdAt',history.created_at) order by history.version desc),'[]'::jsonb) into _versions
  from clinical_reference.catalog_product_versions history
  left join lateral (select verified_at,verification_note from clinical_reference.product_label_verifications v
    where v.product_version_id=history.id order by verified_at desc limit 1) verification on true
  where history.product_stable_id=_version.product_stable_id;
  select coalesce(jsonb_agg(jsonb_build_object('itemId',_version.id,'sourceName',batch.source_package_id,
    'sourceFilename',null,'sourceSha256',batch.manifest_sha256,'changeKind','catalog_import',
    'status',batch.status,'reviewedAt',_verified_at,'importedAt',batch.completed_at)),'[]'::jsonb)
    into _imports from clinical_reference.catalog_import_batches batch where batch.id=_version.import_batch_id;
  select coalesce(jsonb_agg(jsonb_build_object('id',offer_version.id,'kind',offer_version.kind,
    'url',offer_version.destination_url,'supplierName',offer_version.supplier_name,
    'commissionDisclosure',offer_version.commission_disclosure,
    'availabilityStatus',offer_version.availability_status,'lastVerifiedAt',offer_version.last_verified_at,
    'revokedAt',null,'revokedReason',null,'recordedAt',offer_version.created_at)
    order by offer_version.created_at desc),'[]'::jsonb) into _commercial
  from commercial_reference.affiliate_offers offer
  join commercial_reference.affiliate_offer_versions offer_version
    on offer_version.offer_stable_id=offer.stable_id and offer_version.version=offer.active_version
  where offer.product_stable_id=_version.product_stable_id and offer.review_status='approved'
    and offer_version.review_status='approved' and offer_version.direct_order_allowed
    and not offer_version.declared_restricted
    and (offer_version.kind <> 'affiliate' or coalesce(btrim(offer_version.commission_disclosure),'') <> '');
  return jsonb_build_object('clinical',jsonb_build_object(
    'labelVersionId',_version.id,'productCode',_version.product_stable_id,'productName',_version.display_name,
    'brand',_version.brand,'version',_version.version,
    'status',case _version.review_status when 'approved' then 'published' when 'archived' then 'superseded'
      when 'rejected' then 'withdrawn' else 'draft' end,
    'labelSha256',_version.label_sha256,'sourceUrl',_version.clinical_payload->>'sourceUrl',
    'effectiveAt',_version.clinical_payload->>'effectiveAt','expiresAt',_version.clinical_payload->>'expiresAt',
    'verifiedAt',_verified_at,'verificationNote',_note,
    'verificationState',case when _verified_at is null then 'unverified' else 'verified' end,
    'servingSize',_version.clinical_payload->>'servingSize',
    'servingsPerContainer',_version.clinical_payload->>'servingsPerContainer',
    'ingredients',_version.clinical_payload->>'ingredients',
    'ingredientRows',coalesce(_version.clinical_payload->'ingredientRows','[]'::jsonb),
    'otherIngredients',_version.clinical_payload->>'otherIngredients','allergens',_version.clinical_payload->>'allergens',
    'directions',_version.clinical_payload->>'directions','warnings',_version.clinical_payload->>'warnings',
    'storage',_version.clinical_payload->>'storage','jurisdiction',_version.clinical_payload->>'jurisdiction',
    'sku',_version.clinical_payload->>'sku','upc',_version.clinical_payload->>'upc','versions',_versions,
    'catalogMappings',jsonb_build_array(jsonb_build_object('productId',_version.product_stable_id,
      'name',_version.display_name,'form',_version.clinical_payload->>'form',
      'sku',_version.clinical_payload->>'sku','upc',_version.clinical_payload->>'upc')),
    'importHistory',_imports),
    'commercial',jsonb_build_object('links',_commercial,'disclosureComplete',true,
      'notice','Commercial information is isolated and never changes clinical eligibility, ranking, safety, or evidence.'),
    'unknownPolicy','Fields not captured from the exact label remain Unknown.');
end
$$;

create or replace function clinical_core.verify_product_label_version(
  _label_version_id uuid, _verification_note text
) returns void language plpgsql security definer set search_path = '' as $$
begin
  perform clinical_private.require_catalog_member(clinical_private.organization_id(), true);
  if coalesce(char_length(btrim(_verification_note)),0) not between 1 and 2000 then
    raise exception using errcode='22023', message='verification_note_required';
  end if;
  if not exists(select 1 from clinical_reference.catalog_product_versions where id=_label_version_id) then
    raise exception using errcode='P0002', message='product_label_version_not_found';
  end if;
  insert into clinical_reference.product_label_verifications
    (product_version_id,reviewer_person_id,verification_note)
  values (_label_version_id,clinical_private.actor_person_id(),btrim(_verification_note));
end
$$;

create or replace function clinical_core.get_protocol_template_detail(_template_id text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare _template clinical_reference.protocol_templates%rowtype; _versions jsonb; _items jsonb;
  _reviews jsonb; _current_id uuid; _approved_id uuid; _unsourced integer;
begin
  perform clinical_private.require_catalog_member(clinical_private.organization_id(), false);
  select * into _template from clinical_reference.protocol_templates where stable_id=_template_id;
  if not found then raise exception using errcode='P0002', message='protocol_template_not_found'; end if;
  select id into _current_id from clinical_reference.protocol_template_versions
    where template_stable_id=_template.stable_id order by version desc limit 1;
  select id into _approved_id from clinical_reference.protocol_template_versions
    where template_stable_id=_template.stable_id and review_status='approved' order by version desc limit 1;
  select coalesce(jsonb_agg(jsonb_build_object('versionId',version.id,'version',version.version,
    'status',version.review_status,'title',version.title,'approvedAt',version.approved_at,
    'createdAt',version.created_at,'itemCount',(select count(*) from clinical_reference.protocol_template_items item
      where item.template_version_id=version.id)) order by version.version desc),'[]'::jsonb) into _versions
    from clinical_reference.protocol_template_versions version where version.template_stable_id=_template.stable_id;
  select coalesce(jsonb_agg(jsonb_build_object('itemId',item.id,'label',item.label,'kind',item.kind,
    'position',item.position,'dosageText',item.dosage_text,'timingText',item.timing_text,'route',item.route,
    'doseSourceKind',item.dose_source_kind,'doseSourceRef',item.dose_source_ref,
    'manufacturer',item.manufacturer,'labelVersion',product_version.version::text,
    'productSku',item.product_sku,'productUpc',item.product_upc,'labelSha256',product_version.label_sha256,
    'verificationStatus',case when verification.id is null then 'unverified' else 'structured_verified' end,
    'interventionClassCode',null,'monitoringRequirements',item.monitoring_requirements,
    'stoppingRules',item.stopping_rules,'contraindications',item.contraindications,
    'followupIntervalDays',item.followup_interval_days,'jurisdictionSensitive',item.jurisdiction_sensitive)
    order by item.position),'[]'::jsonb) into _items
  from clinical_reference.protocol_template_items item
  left join clinical_reference.catalog_products product on product.stable_id=item.product_stable_id
  left join clinical_reference.catalog_product_versions product_version
    on product_version.product_stable_id=product.stable_id and product_version.version=product.active_version
  left join lateral (select id from clinical_reference.product_label_verifications v
    where v.product_version_id=product_version.id order by verified_at desc limit 1) verification on true
  where item.template_version_id=_current_id;
  select coalesce(jsonb_agg(jsonb_build_object('reviewId',review.id,'versionId',review.template_version_id,
    'outcome',review.outcome,'note',review.note,'itemsReviewed',review.items_reviewed,
    'unsourcedDoseCount',review.unsourced_dose_count,'reviewedAt',review.reviewed_at)
    order by review.reviewed_at desc),'[]'::jsonb) into _reviews
  from clinical_reference.protocol_template_safety_reviews review
  join clinical_reference.protocol_template_versions version on version.id=review.template_version_id
  where version.template_stable_id=_template.stable_id;
  select count(*) into _unsourced from clinical_reference.protocol_template_items item
    where item.template_version_id=_current_id and coalesce(btrim(item.dosage_text),'') <> ''
      and coalesce(btrim(item.dose_source_ref),'') = '';
  return jsonb_build_object('templateId',_template.stable_id,
    'name',coalesce((select title from clinical_reference.protocol_template_versions where id=_current_id),_template.stable_id),
    'description',(select summary from clinical_reference.protocol_template_versions where id=_current_id),
    'status',_template.review_status,'archivedAt',case when _template.review_status='archived' then _template.updated_at else null end,
    'supersededById',_template.superseded_by_stable_id,'supersededAt',_template.superseded_at,
    'supersededReason',_template.superseded_reason,'currentVersionId',_current_id,'approvedVersionId',_approved_id,
    'versions',_versions,'items',_items,'safetyReviews',_reviews,'unsourcedDoseCount',_unsourced,
    'patientInstructionPreview',(select coalesce(jsonb_agg(jsonb_build_object('label',item.label,'kind',item.kind,
      'instruction',item.instructions,'dose',item.dosage_text,'timing',item.timing_text,
      'stopIf',item.stopping_rules,'doseIsSourced',coalesce(btrim(item.dosage_text),'')=''
        or coalesce(btrim(item.dose_source_ref),'')<>'') order by item.position),'[]'::jsonb)
      from clinical_reference.protocol_template_items item where item.template_version_id=_current_id),
    'previewNotice','Preview is derived from the current governed template version and is not a patient order.',
    'safetyNotice','Clinical review is required before a template can be used for patient care.');
end
$$;

create or replace function clinical_core.compare_protocol_template_versions(
  _left_version_id uuid, _right_version_id uuid
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare _left clinical_reference.protocol_template_versions%rowtype;
  _right clinical_reference.protocol_template_versions%rowtype; _added jsonb; _removed jsonb; _changed jsonb;
begin
  perform clinical_private.require_catalog_member(clinical_private.organization_id(), false);
  select * into _left from clinical_reference.protocol_template_versions where id=_left_version_id;
  if not found then raise exception using errcode='P0002', message='left_template_version_not_found'; end if;
  select * into _right from clinical_reference.protocol_template_versions where id=_right_version_id;
  if not found then raise exception using errcode='P0002', message='right_template_version_not_found'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('label',item.label,'kind',item.kind,
    'dosageText',item.dosage_text,'doseSourceKind',item.dose_source_kind) order by item.position),'[]'::jsonb)
    into _added from clinical_reference.protocol_template_items item where item.template_version_id=_right.id
    and not exists(select 1 from clinical_reference.protocol_template_items prior
      where prior.template_version_id=_left.id and prior.label=item.label);
  select coalesce(jsonb_agg(jsonb_build_object('label',item.label,'kind',item.kind,
    'dosageText',item.dosage_text,'doseSourceKind',item.dose_source_kind) order by item.position),'[]'::jsonb)
    into _removed from clinical_reference.protocol_template_items item where item.template_version_id=_left.id
    and not exists(select 1 from clinical_reference.protocol_template_items next
      where next.template_version_id=_right.id and next.label=item.label);
  select coalesce(jsonb_agg(jsonb_build_object('label',prior.label,
    'doseChanged',prior.dosage_text is distinct from next.dosage_text,
    'from',jsonb_build_object('dosageText',prior.dosage_text,'timingText',prior.timing_text,'route',prior.route,
      'doseSourceKind',prior.dose_source_kind,'stoppingRules',prior.stopping_rules,
      'monitoringRequirements',prior.monitoring_requirements),
    'to',jsonb_build_object('dosageText',next.dosage_text,'timingText',next.timing_text,'route',next.route,
      'doseSourceKind',next.dose_source_kind,'stoppingRules',next.stopping_rules,
      'monitoringRequirements',next.monitoring_requirements)) order by prior.position),'[]'::jsonb) into _changed
  from clinical_reference.protocol_template_items prior
  join clinical_reference.protocol_template_items next on next.template_version_id=_right.id and next.label=prior.label
  where prior.template_version_id=_left.id and (prior.dosage_text is distinct from next.dosage_text
    or prior.timing_text is distinct from next.timing_text or prior.route is distinct from next.route
    or prior.dose_source_kind is distinct from next.dose_source_kind
    or prior.stopping_rules is distinct from next.stopping_rules
    or prior.monitoring_requirements is distinct from next.monitoring_requirements
    or prior.contraindications is distinct from next.contraindications);
  return jsonb_build_object('sameTemplate',_left.template_stable_id=_right.template_stable_id,
    'left',jsonb_build_object('versionId',_left.id,'templateId',_left.template_stable_id,
      'version',_left.version,'status',_left.review_status,'title',_left.title),
    'right',jsonb_build_object('versionId',_right.id,'templateId',_right.template_stable_id,
      'version',_right.version,'status',_right.review_status,'title',_right.title),
    'added',_added,'removed',_removed,'changed',_changed,
    'doseChangeCount',(select count(*) from jsonb_array_elements(_changed) change
      where (change->>'doseChanged')::boolean),
    'matchNote','Items are matched by label; a rename appears as one removal and one addition.');
end
$$;

create or replace function clinical_core.record_protocol_template_safety_review(
  _version_id uuid, _outcome text, _note text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare _review_id uuid; _items integer; _unsourced integer;
begin
  perform clinical_private.require_catalog_member(clinical_private.organization_id(), true);
  if _outcome not in ('passed','concerns','blocked') then
    raise exception using errcode='22023', message='safety_review_outcome_invalid';
  end if;
  if coalesce(char_length(btrim(_note)),0) not between 1 and 2000 then
    raise exception using errcode='22023', message='safety_review_note_required';
  end if;
  if not exists(select 1 from clinical_reference.protocol_template_versions where id=_version_id) then
    raise exception using errcode='P0002', message='protocol_template_version_not_found';
  end if;
  select count(*),count(*) filter (where coalesce(btrim(dosage_text),'')<>''
    and coalesce(btrim(dose_source_ref),'')='') into _items,_unsourced
    from clinical_reference.protocol_template_items where template_version_id=_version_id;
  if _outcome='passed' and _unsourced>0 then
    raise exception using errcode='22023', message='unsourced_dose_blocks_passed_review';
  end if;
  insert into clinical_reference.protocol_template_safety_reviews
    (template_version_id,outcome,note,items_reviewed,unsourced_dose_count,reviewer_person_id)
  values (_version_id,_outcome,btrim(_note),_items,_unsourced,clinical_private.actor_person_id())
  returning id into _review_id;
  return jsonb_build_object('ok',true,'reviewId',_review_id,'outcome',_outcome,
    'unsourcedDoseCount',_unsourced,'message','Append-only template safety review recorded.');
end
$$;

create or replace function clinical_core.supersede_protocol_template(
  _template_id text, _successor_template_id text, _reason text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare _template clinical_reference.protocol_templates%rowtype;
  _successor clinical_reference.protocol_templates%rowtype;
begin
  perform clinical_private.require_catalog_member(clinical_private.organization_id(), true);
  if _template_id=_successor_template_id then
    raise exception using errcode='22023', message='template_cannot_supersede_itself';
  end if;
  if coalesce(char_length(btrim(_reason)),0) not between 1 and 2000 then
    raise exception using errcode='22023', message='supersession_reason_required';
  end if;
  select * into _template from clinical_reference.protocol_templates where stable_id=_template_id for update;
  if not found then raise exception using errcode='P0002', message='protocol_template_not_found'; end if;
  if _template.superseded_by_stable_id is not null then
    raise exception using errcode='55000', message='protocol_template_already_superseded';
  end if;
  select * into _successor from clinical_reference.protocol_templates where stable_id=_successor_template_id;
  if not found then raise exception using errcode='P0002', message='successor_template_not_found'; end if;
  if _successor.review_status<>'approved' then
    raise exception using errcode='22023', message='approved_successor_required';
  end if;
  if exists(with recursive chain as (
    select _successor.stable_id as stable_id,_successor.superseded_by_stable_id as next_id,1 as depth
    union all select template.stable_id,template.superseded_by_stable_id,chain.depth+1
      from chain join clinical_reference.protocol_templates template on template.stable_id=chain.next_id
      where chain.depth<64
  ) select 1 from chain where stable_id=_template_id or next_id=_template_id) then
    raise exception using errcode='22023', message='protocol_template_supersession_cycle';
  end if;
  update clinical_reference.protocol_templates set superseded_by_stable_id=_successor_template_id,
    superseded_at=clock_timestamp(),superseded_reason=btrim(_reason),review_status='archived',
    updated_at=clock_timestamp() where stable_id=_template_id;
  return jsonb_build_object('ok',true,'templateId',_template_id,'supersededBy',_successor_template_id,
    'message','Template superseded without deleting its version history.');
end
$$;

revoke all on function clinical_private.require_catalog_member(uuid,boolean) from public;
revoke all on function clinical_core.get_product_catalog(uuid,text,text,integer) from public;
revoke all on function clinical_core.get_product_label_detail(uuid) from public;
revoke all on function clinical_core.verify_product_label_version(uuid,text) from public;
revoke all on function clinical_core.get_protocol_template_detail(text) from public;
revoke all on function clinical_core.compare_protocol_template_versions(uuid,uuid) from public;
revoke all on function clinical_core.record_protocol_template_safety_review(uuid,text,text) from public;
revoke all on function clinical_core.supersede_protocol_template(text,text,text) from public;
