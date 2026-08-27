alter table clinical_reference.catalog_import_batches
  add column product_label_count integer not null default 0 check (product_label_count >= 0);

create table clinical_reference.product_labels (
  stable_id text primary key check (stable_id ~ '^lbl_[a-z0-9][a-z0-9_-]{2,95}$'),
  product_stable_id text not null unique references clinical_reference.catalog_products(stable_id),
  review_status text not null default 'needs_review'
    check (review_status in ('needs_review','approved','rejected','archived')),
  active_version integer check (active_version is null or active_version > 0),
  environment text not null check (environment in ('synthetic-staging','production-clinical')),
  data_classification text not null default 'reference_only' check (data_classification = 'reference_only'),
  contains_phi boolean not null default false check (contains_phi = false),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint product_label_approval_gate check (
    review_status <> 'approved' or active_version is not null
  )
);

create table clinical_reference.product_label_versions (
  label_stable_id text not null references clinical_reference.product_labels(stable_id),
  version integer not null check (version > 0),
  label_found boolean not null,
  physical_label_required boolean not null,
  substantive_conflict boolean not null,
  practitioner_decision_required boolean not null,
  label_payload jsonb not null check (jsonb_typeof(label_payload) = 'object'),
  crosscheck_payload jsonb not null check (jsonb_typeof(crosscheck_payload) = 'object'),
  source_refs jsonb not null check (jsonb_typeof(source_refs) = 'array' and jsonb_array_length(source_refs) > 0),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  review_status text not null default 'needs_review' check (review_status = 'needs_review'),
  import_batch_id uuid not null references clinical_reference.catalog_import_batches(id),
  created_at timestamptz not null default clock_timestamp(),
  primary key (label_stable_id, version),
  unique (label_stable_id, content_sha256)
);

create table clinical_reference.protocol_template_steps (
  step_stable_id text not null check (step_stable_id ~ '^stp_[a-z0-9][a-z0-9_-]{2,95}$'),
  template_stable_id text not null,
  template_version integer not null,
  sequence integer not null check (sequence > 0),
  phase text not null check (char_length(btrim(phase)) between 1 and 100),
  instructions text not null check (char_length(btrim(instructions)) between 1 and 8000),
  prerequisites text not null check (char_length(btrim(prerequisites)) between 1 and 4000),
  monitoring text not null check (char_length(btrim(monitoring)) between 1 and 4000),
  stop_criteria text not null check (char_length(btrim(stop_criteria)) between 1 and 4000),
  conditional_logic text not null check (char_length(btrim(conditional_logic)) between 1 and 4000),
  adjustment_logic text,
  duration text,
  timing text,
  intervention_id text,
  product_stable_id text references clinical_reference.catalog_products(stable_id),
  source_refs jsonb not null check (jsonb_typeof(source_refs) = 'array' and jsonb_array_length(source_refs) > 0),
  created_at timestamptz not null default clock_timestamp(),
  primary key (template_stable_id, template_version, step_stable_id),
  unique (template_stable_id, template_version, sequence),
  foreign key (template_stable_id, template_version)
    references clinical_reference.protocol_template_versions(template_stable_id, version)
);

alter table clinical_reference.catalog_review_events
  drop constraint if exists catalog_review_events_subject_type_check;
alter table clinical_reference.catalog_review_events
  add constraint catalog_review_events_subject_type_check check (
    subject_type in ('product_version','product_label_version','protocol_template_version',
      'affiliate_offer_version','safety_rule_version','knowledge_source_version')
  );

create index product_label_versions_batch_idx
  on clinical_reference.product_label_versions(import_batch_id);
create index protocol_template_steps_product_idx
  on clinical_reference.protocol_template_steps(product_stable_id);

create trigger product_label_versions_append_only
before update or delete on clinical_reference.product_label_versions
for each row execute function clinical_reference.reject_immutable_catalog_history();

create trigger protocol_template_steps_append_only
before update or delete on clinical_reference.protocol_template_steps
for each row execute function clinical_reference.reject_immutable_catalog_history();

alter table clinical_reference.product_labels enable row level security;
alter table clinical_reference.product_label_versions enable row level security;
alter table clinical_reference.protocol_template_steps enable row level security;

create policy product_labels_read_approved on clinical_reference.product_labels
for select to clinical_core_api
using (
  review_status = 'approved' and active_version is not null and contains_phi = false
  and environment = nullif(current_setting('clinical.catalog.environment', true), '')
);

create policy product_label_versions_read_active on clinical_reference.product_label_versions
for select to clinical_core_api
using (
  exists (
    select 1 from clinical_reference.product_labels l
    where l.stable_id = product_label_versions.label_stable_id
      and l.review_status = 'approved'
      and l.active_version = product_label_versions.version
      and l.contains_phi = false
      and l.environment = nullif(current_setting('clinical.catalog.environment', true), '')
  )
);

create policy protocol_template_steps_read_active on clinical_reference.protocol_template_steps
for select to clinical_core_api
using (
  exists (
    select 1 from clinical_reference.protocol_templates t
    where t.stable_id = protocol_template_steps.template_stable_id
      and t.review_status = 'approved'
      and t.active_version = protocol_template_steps.template_version
      and t.contains_phi = false
      and t.environment = nullif(current_setting('clinical.catalog.environment', true), '')
  )
);

revoke all on clinical_reference.product_labels,
  clinical_reference.product_label_versions,
  clinical_reference.protocol_template_steps
from public, clinical_core_api;

grant select on clinical_reference.product_labels,
  clinical_reference.product_label_versions,
  clinical_reference.protocol_template_steps
to clinical_core_api;

grant all on clinical_reference.product_labels,
  clinical_reference.product_label_versions,
  clinical_reference.protocol_template_steps
to clinical_core_migrator;

comment on table clinical_reference.product_label_versions is
  'Immutable product-label and independent cross-check evidence. Conflict flags require a corrected version before approval.';
comment on table clinical_reference.protocol_template_steps is
  'Immutable ordered authored protocol steps, including assessment and monitoring steps without a product.';
