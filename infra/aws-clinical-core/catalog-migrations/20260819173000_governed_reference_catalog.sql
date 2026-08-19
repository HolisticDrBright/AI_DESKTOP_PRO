-- Shared AWS clinical core: independently migrated governed, non-PHI catalog and protocol references.
-- PostgreSQL/Aurora portable. No Supabase roles, auth helpers, or PostgREST.
-- Imports land needs_review. Only separately approved versions can be read by
-- the request role. Commercial destinations remain in a separate schema.

create extension if not exists pgcrypto;
create schema if not exists clinical_reference;
create schema if not exists commercial_reference;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'clinical_core_api') then
    create role clinical_core_api nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'clinical_core_migrator') then
    create role clinical_core_migrator nologin noinherit;
  end if;
  execute format('grant clinical_core_api, clinical_core_migrator to %I', current_user);
end
$$;

revoke all on schema clinical_reference from public;
revoke all on schema commercial_reference from public;
grant usage on schema clinical_reference, commercial_reference to clinical_core_api;

create table clinical_reference.catalog_import_batches (
  id uuid primary key default gen_random_uuid(),
  contract_version text not null check (contract_version = 'governed-catalog-seed/1'),
  source_package_id text not null check (source_package_id ~ '^[a-z0-9][a-z0-9._-]{2,127}$'),
  source_package_version integer not null check (source_package_version > 0),
  environment text not null check (environment in ('synthetic-staging','production-clinical')),
  data_classification text not null check (data_classification = 'reference_only'),
  contains_phi boolean not null check (contains_phi = false),
  manifest_sha256 text not null unique check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'importing' check (status in ('importing','succeeded')),
  product_count integer not null check (product_count >= 0),
  commercial_offer_count integer not null check (commercial_offer_count >= 0),
  protocol_template_count integer not null check (protocol_template_count >= 0),
  safety_rule_count integer not null default 0 check (safety_rule_count >= 0),
  knowledge_source_count integer not null default 0 check (knowledge_source_count >= 0),
  completed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  constraint catalog_import_completion_consistent check (
    (status = 'importing' and completed_at is null)
    or (status = 'succeeded' and completed_at is not null)
  )
);

create table clinical_reference.knowledge_sources (
  stable_id text primary key check (stable_id ~ '^src_[a-z0-9][a-z0-9_-]{2,95}$'),
  review_status text not null default 'needs_review' check (review_status in ('needs_review','approved','rejected','archived')),
  active_version integer check (active_version is null or active_version > 0),
  environment text not null check (environment in ('synthetic-staging','production-clinical')),
  data_classification text not null default 'reference_only' check (data_classification = 'reference_only'),
  contains_phi boolean not null default false check (contains_phi = false),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint knowledge_source_approval_gate check (
    review_status <> 'approved' or active_version is not null
  )
);

create table clinical_reference.knowledge_source_versions (
  source_stable_id text not null references clinical_reference.knowledge_sources(stable_id),
  version integer not null check (version > 0),
  citation text not null check (char_length(btrim(citation)) between 1 and 4000),
  publisher text,
  evidence_level text,
  destination_url text check (destination_url is null or destination_url ~ '^https://'),
  source_payload jsonb not null check (jsonb_typeof(source_payload) = 'object'),
  source_refs jsonb not null check (jsonb_typeof(source_refs) = 'array' and jsonb_array_length(source_refs) > 0),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  review_status text not null default 'needs_review' check (review_status = 'needs_review'),
  import_batch_id uuid not null references clinical_reference.catalog_import_batches(id),
  created_at timestamptz not null default clock_timestamp(),
  primary key (source_stable_id, version),
  unique (source_stable_id, content_sha256)
);

create table clinical_reference.safety_rules (
  stable_id text primary key check (stable_id ~ '^saf_[a-z0-9][a-z0-9_-]{2,95}$'),
  review_status text not null default 'needs_review' check (review_status in ('needs_review','approved','rejected','archived')),
  active_version integer check (active_version is null or active_version > 0),
  environment text not null check (environment in ('synthetic-staging','production-clinical')),
  data_classification text not null default 'reference_only' check (data_classification = 'reference_only'),
  contains_phi boolean not null default false check (contains_phi = false),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint safety_rule_approval_gate check (
    review_status <> 'approved' or active_version is not null
  )
);

create table clinical_reference.safety_rule_versions (
  rule_stable_id text not null references clinical_reference.safety_rules(stable_id),
  version integer not null check (version > 0),
  severity text not null check (char_length(btrim(severity)) between 1 and 100),
  blocks_recommendation boolean not null,
  rule_payload jsonb not null check (jsonb_typeof(rule_payload) = 'object'),
  source_refs jsonb not null check (jsonb_typeof(source_refs) = 'array' and jsonb_array_length(source_refs) > 0),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  review_status text not null default 'needs_review' check (review_status = 'needs_review'),
  import_batch_id uuid not null references clinical_reference.catalog_import_batches(id),
  created_at timestamptz not null default clock_timestamp(),
  primary key (rule_stable_id, version),
  unique (rule_stable_id, content_sha256)
);

create table clinical_reference.catalog_products (
  stable_id text primary key check (stable_id ~ '^prd_[a-z0-9][a-z0-9_-]{2,95}$'),
  review_status text not null default 'needs_review' check (review_status in ('needs_review','approved','rejected','archived')),
  active_version integer check (active_version is null or active_version > 0),
  environment text not null check (environment in ('synthetic-staging','production-clinical')),
  data_classification text not null default 'reference_only' check (data_classification = 'reference_only'),
  contains_phi boolean not null default false check (contains_phi = false),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint catalog_product_approval_gate check (
    review_status <> 'approved' or active_version is not null
  )
);

create table clinical_reference.catalog_product_versions (
  product_stable_id text not null references clinical_reference.catalog_products(stable_id),
  version integer not null check (version > 0),
  display_name text not null check (char_length(btrim(display_name)) between 1 and 200),
  product_type text not null check (product_type in ('supplement','oral_peptide','practitioner_only','injectable_peptide')),
  access_tier text not null check (access_tier in ('open','practitioner_gated','injectable')),
  declared_restricted boolean not null,
  direct_order_allowed boolean not null default false,
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  clinical_payload jsonb not null check (jsonb_typeof(clinical_payload) = 'object'),
  source_refs jsonb not null check (jsonb_typeof(source_refs) = 'array' and jsonb_array_length(source_refs) > 0),
  review_status text not null default 'needs_review' check (review_status = 'needs_review'),
  import_batch_id uuid not null references clinical_reference.catalog_import_batches(id),
  created_at timestamptz not null default clock_timestamp(),
  primary key (product_stable_id, version),
  unique (product_stable_id, content_sha256),
  constraint catalog_product_version_restriction_gate check (
    not declared_restricted or (direct_order_allowed = false and access_tier <> 'open')
  ),
  constraint catalog_product_version_injectable_gate check (
    access_tier <> 'injectable' or (product_type = 'injectable_peptide' and direct_order_allowed = false)
  ),
  constraint catalog_product_payload_no_commercial_data check (
    not (clinical_payload ?| array['affiliateUrl','affiliateUrls','destinationUrl','discountCode','trackingCode'])
  )
);

create table clinical_reference.protocol_templates (
  stable_id text primary key check (stable_id ~ '^tpl_[a-z0-9][a-z0-9_-]{2,95}$'),
  review_status text not null default 'needs_review' check (review_status in ('needs_review','approved','rejected','archived')),
  active_version integer check (active_version is null or active_version > 0),
  environment text not null check (environment in ('synthetic-staging','production-clinical')),
  data_classification text not null default 'reference_only' check (data_classification = 'reference_only'),
  contains_phi boolean not null default false check (contains_phi = false),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint protocol_template_approval_gate check (
    review_status <> 'approved' or active_version is not null
  )
);

create table clinical_reference.protocol_template_versions (
  template_stable_id text not null references clinical_reference.protocol_templates(stable_id),
  version integer not null check (version > 0),
  title text not null check (char_length(btrim(title)) between 1 and 200),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  summary text,
  source_refs jsonb not null check (jsonb_typeof(source_refs) = 'array' and jsonb_array_length(source_refs) > 0),
  review_status text not null default 'needs_review' check (review_status = 'needs_review'),
  import_batch_id uuid not null references clinical_reference.catalog_import_batches(id),
  created_at timestamptz not null default clock_timestamp(),
  primary key (template_stable_id, version),
  unique (template_stable_id, content_sha256)
);

create table clinical_reference.protocol_template_items (
  template_stable_id text not null,
  template_version integer not null,
  position integer not null check (position > 0),
  product_stable_id text not null references clinical_reference.catalog_products(stable_id),
  instructions text,
  dosage_text text,
  dose_source_ref text,
  monitoring_requirements jsonb not null default '[]'::jsonb check (jsonb_typeof(monitoring_requirements) = 'array'),
  stopping_rules jsonb not null default '[]'::jsonb check (jsonb_typeof(stopping_rules) = 'array'),
  contraindications jsonb not null default '[]'::jsonb check (jsonb_typeof(contraindications) = 'array'),
  created_at timestamptz not null default clock_timestamp(),
  primary key (template_stable_id, template_version, position),
  foreign key (template_stable_id, template_version)
    references clinical_reference.protocol_template_versions(template_stable_id, version),
  constraint protocol_item_dose_provenance check (
    coalesce(btrim(dosage_text), '') = '' or coalesce(btrim(dose_source_ref), '') <> ''
  )
);

create table clinical_reference.catalog_review_events (
  id uuid primary key default gen_random_uuid(),
  subject_type text not null check (subject_type in ('product_version','protocol_template_version','affiliate_offer_version','safety_rule_version','knowledge_source_version')),
  subject_stable_id text not null,
  subject_version integer not null check (subject_version > 0),
  outcome text not null check (outcome in ('approved','rejected','changes_requested')),
  reviewer_person_id uuid not null,
  reason text not null check (char_length(btrim(reason)) between 1 and 2000),
  reviewed_at timestamptz not null default clock_timestamp()
);

create table commercial_reference.affiliate_offers (
  stable_id text primary key check (stable_id ~ '^off_[a-z0-9][a-z0-9_-]{2,95}$'),
  review_status text not null default 'needs_review' check (review_status in ('needs_review','approved','rejected','archived')),
  active_version integer check (active_version is null or active_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint affiliate_offer_approval_gate check (
    review_status <> 'approved' or active_version is not null
  )
);

create table commercial_reference.affiliate_offer_versions (
  offer_stable_id text not null references commercial_reference.affiliate_offers(stable_id),
  version integer not null check (version > 0),
  product_stable_id text not null check (product_stable_id ~ '^prd_[a-z0-9][a-z0-9_-]{2,95}$'),
  destination_url text not null check (destination_url ~ '^https://'),
  tracking_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(tracking_metadata) = 'object'),
  declared_restricted boolean not null,
  direct_order_allowed boolean not null default false,
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  review_status text not null default 'needs_review' check (review_status in ('needs_review','approved','rejected','archived')),
  environment text not null check (environment in ('synthetic-staging','production-clinical')),
  import_batch_id uuid not null references clinical_reference.catalog_import_batches(id),
  created_at timestamptz not null default clock_timestamp(),
  primary key (offer_stable_id, version),
  unique (offer_stable_id, content_sha256),
  constraint affiliate_offer_restriction_gate check (
    not declared_restricted or direct_order_allowed = false
  )
);

create index catalog_product_versions_batch_idx
  on clinical_reference.catalog_product_versions(import_batch_id);
create index knowledge_source_versions_batch_idx
  on clinical_reference.knowledge_source_versions(import_batch_id);
create index safety_rule_versions_batch_idx
  on clinical_reference.safety_rule_versions(import_batch_id);
create index protocol_template_versions_batch_idx
  on clinical_reference.protocol_template_versions(import_batch_id);
create index protocol_template_items_product_idx
  on clinical_reference.protocol_template_items(product_stable_id);
create index catalog_review_events_subject_idx
  on clinical_reference.catalog_review_events(subject_type, subject_stable_id, subject_version, reviewed_at desc);
create index affiliate_offers_product_idx
  on commercial_reference.affiliate_offer_versions(product_stable_id);
create index affiliate_offers_batch_idx
  on commercial_reference.affiliate_offer_versions(import_batch_id);

create or replace function clinical_reference.reject_immutable_catalog_history()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'catalog_history_append_only' using errcode = '55000';
end
$$;

create trigger catalog_product_versions_append_only
before update or delete on clinical_reference.catalog_product_versions
for each row execute function clinical_reference.reject_immutable_catalog_history();

create trigger knowledge_source_versions_append_only
before update or delete on clinical_reference.knowledge_source_versions
for each row execute function clinical_reference.reject_immutable_catalog_history();

create trigger safety_rule_versions_append_only
before update or delete on clinical_reference.safety_rule_versions
for each row execute function clinical_reference.reject_immutable_catalog_history();

create trigger protocol_template_versions_append_only
before update or delete on clinical_reference.protocol_template_versions
for each row execute function clinical_reference.reject_immutable_catalog_history();

create trigger protocol_template_items_append_only
before update or delete on clinical_reference.protocol_template_items
for each row execute function clinical_reference.reject_immutable_catalog_history();

create trigger catalog_review_events_append_only
before update or delete on clinical_reference.catalog_review_events
for each row execute function clinical_reference.reject_immutable_catalog_history();

create trigger affiliate_offer_versions_append_only
before update or delete on commercial_reference.affiliate_offer_versions
for each row execute function clinical_reference.reject_immutable_catalog_history();

alter table clinical_reference.catalog_import_batches enable row level security;
alter table clinical_reference.knowledge_sources enable row level security;
alter table clinical_reference.knowledge_source_versions enable row level security;
alter table clinical_reference.safety_rules enable row level security;
alter table clinical_reference.safety_rule_versions enable row level security;
alter table clinical_reference.catalog_products enable row level security;
alter table clinical_reference.catalog_product_versions enable row level security;
alter table clinical_reference.protocol_templates enable row level security;
alter table clinical_reference.protocol_template_versions enable row level security;
alter table clinical_reference.protocol_template_items enable row level security;
alter table clinical_reference.catalog_review_events enable row level security;
alter table commercial_reference.affiliate_offers enable row level security;
alter table commercial_reference.affiliate_offer_versions enable row level security;

create policy catalog_products_read_approved on clinical_reference.catalog_products
for select to clinical_core_api
using (
  review_status = 'approved' and active_version is not null and contains_phi = false
  and environment = nullif(current_setting('clinical.catalog.environment', true), '')
);

create policy knowledge_sources_read_approved on clinical_reference.knowledge_sources
for select to clinical_core_api
using (
  review_status = 'approved' and active_version is not null and contains_phi = false
  and environment = nullif(current_setting('clinical.catalog.environment', true), '')
);

create policy knowledge_source_versions_read_active on clinical_reference.knowledge_source_versions
for select to clinical_core_api
using (
  exists (
    select 1 from clinical_reference.knowledge_sources s
    where s.stable_id = knowledge_source_versions.source_stable_id
      and s.review_status = 'approved'
      and s.active_version = knowledge_source_versions.version
      and s.contains_phi = false
      and s.environment = nullif(current_setting('clinical.catalog.environment', true), '')
  )
);

create policy safety_rules_read_approved on clinical_reference.safety_rules
for select to clinical_core_api
using (
  review_status = 'approved' and active_version is not null and contains_phi = false
  and environment = nullif(current_setting('clinical.catalog.environment', true), '')
);

create policy safety_rule_versions_read_active on clinical_reference.safety_rule_versions
for select to clinical_core_api
using (
  exists (
    select 1 from clinical_reference.safety_rules r
    where r.stable_id = safety_rule_versions.rule_stable_id
      and r.review_status = 'approved'
      and r.active_version = safety_rule_versions.version
      and r.contains_phi = false
      and r.environment = nullif(current_setting('clinical.catalog.environment', true), '')
  )
);

create policy catalog_product_versions_read_active on clinical_reference.catalog_product_versions
for select to clinical_core_api
using (
  exists (
    select 1 from clinical_reference.catalog_products p
    where p.stable_id = catalog_product_versions.product_stable_id
      and p.review_status = 'approved'
      and p.active_version = catalog_product_versions.version
      and p.contains_phi = false
      and p.environment = nullif(current_setting('clinical.catalog.environment', true), '')
  )
);

create policy protocol_templates_read_approved on clinical_reference.protocol_templates
for select to clinical_core_api
using (
  review_status = 'approved' and active_version is not null and contains_phi = false
  and environment = nullif(current_setting('clinical.catalog.environment', true), '')
);

create policy protocol_template_versions_read_active on clinical_reference.protocol_template_versions
for select to clinical_core_api
using (
  exists (
    select 1 from clinical_reference.protocol_templates t
    where t.stable_id = protocol_template_versions.template_stable_id
      and t.review_status = 'approved'
      and t.active_version = protocol_template_versions.version
      and t.contains_phi = false
      and t.environment = nullif(current_setting('clinical.catalog.environment', true), '')
  )
);

create policy protocol_template_items_read_active on clinical_reference.protocol_template_items
for select to clinical_core_api
using (
  exists (
    select 1 from clinical_reference.protocol_template_versions v
    join clinical_reference.protocol_templates t
      on t.stable_id = v.template_stable_id and t.active_version = v.version
    where v.template_stable_id = protocol_template_items.template_stable_id
      and v.version = protocol_template_items.template_version
      and t.review_status = 'approved'
      and t.contains_phi = false
      and t.environment = nullif(current_setting('clinical.catalog.environment', true), '')
  )
);

create policy affiliate_offers_read_approved on commercial_reference.affiliate_offers
for select to clinical_core_api
using (review_status = 'approved' and active_version is not null);

create policy affiliate_offer_versions_read_active on commercial_reference.affiliate_offer_versions
for select to clinical_core_api
using (
  direct_order_allowed = true
  and declared_restricted = false
  and exists (
    select 1 from commercial_reference.affiliate_offers o
    where o.stable_id = affiliate_offer_versions.offer_stable_id
      and o.review_status = 'approved'
      and o.active_version = affiliate_offer_versions.version
  )
  and environment = nullif(current_setting('clinical.catalog.environment', true), '')
);

revoke all on all tables in schema clinical_reference from public, clinical_core_api;
revoke all on all tables in schema commercial_reference from public, clinical_core_api;
revoke all on all functions in schema clinical_reference from public, clinical_core_api;

grant select on clinical_reference.catalog_products,
  clinical_reference.catalog_product_versions,
  clinical_reference.knowledge_sources,
  clinical_reference.knowledge_source_versions,
  clinical_reference.safety_rules,
  clinical_reference.safety_rule_versions,
  clinical_reference.protocol_templates,
  clinical_reference.protocol_template_versions,
  clinical_reference.protocol_template_items
to clinical_core_api;

grant select on commercial_reference.affiliate_offers,
  commercial_reference.affiliate_offer_versions
to clinical_core_api;

grant all on all tables in schema clinical_reference to clinical_core_migrator;
grant all on all tables in schema commercial_reference to clinical_core_migrator;
grant usage, select on all sequences in schema clinical_reference to clinical_core_migrator;
grant usage, select on all sequences in schema commercial_reference to clinical_core_migrator;

comment on schema clinical_reference is
  'Non-PHI governed catalog and protocol references. Imported rows are unapproved by default.';
comment on schema commercial_reference is
  'Commercial destinations kept outside clinical expressions and returned separately by the API.';
comment on table clinical_reference.catalog_import_batches is
  'Idempotent catalog package ledger keyed by canonical manifest SHA-256.';
comment on table clinical_reference.catalog_review_events is
  'Append-only named review evidence. Import alone never constitutes approval.';
comment on column clinical_reference.catalog_review_events.reviewer_person_id is
  'Stable workforce person UUID. The production identity migration adds the deferred foreign-key relationship.';
