-- Phase 9B: the clinical knowledge graph and the controlled import pipeline.
--
-- IMPORT extends `clinical_knowledge_import_batches` / `_items`, which already
-- carry a source hash, a row hash, an external key, the source sheet, warnings,
-- validation errors, a reviewer and an applied reference. What they lacked is
-- the change ledger the phase requires: row provenance, a dedupe key, conflict
-- linkage, and an explicit additions / changes / conflicts / removals verdict.
--
-- THE PIPELINE NEVER INSERTS SILENTLY. A batch enters as `preview`, which
-- writes only into the staging tables; nothing reaches a governed table until a
-- reviewer commits it. Re-importing the same file is idempotent on the source
-- hash, so a second run reports `unchanged` rather than duplicating work.
--
-- THE GRAPH is a set of governed nodes plus one typed edge table. Edges carry
-- their own provenance, so "why is this lab suggested for this hypothesis?"
-- has an answer that is a row rather than an inference.
--
-- A LAB SUGGESTION IS NOT A LAB ORDER. There is no column here that could
-- become one, and nothing in this migration writes to any ordering table.

begin;

-- ================================================== import pipeline extensions

alter table public.clinical_knowledge_import_batches
  add column if not exists source_kind text check (source_kind in (
    'product_spreadsheet', 'affiliate_sheet', 'protocol_document',
    'obsidian_export', 'reference_list', 'other')),
  add column if not exists source_filename text,
  add column if not exists source_byte_size bigint,
  add column if not exists manifest_sha256 text,
  add column if not exists preview_generated_at timestamptz,
  add column if not exists committed_at timestamptz,
  add column if not exists committed_by uuid references auth.users(id),
  add column if not exists added_count integer not null default 0,
  add column if not exists changed_count integer not null default 0,
  add column if not exists unchanged_count integer not null default 0,
  add column if not exists conflict_count integer not null default 0,
  add column if not exists removed_count integer not null default 0;

create index if not exists ckib_committed_by_idx
  on public.clinical_knowledge_import_batches (committed_by);
-- NOT an index on (created_by) or (organization_id, created_at desc): the
-- Phase-1 migration already created both under its own names. Adding them again
-- produced two duplicate indexes that the performance advisor flagged, and they
-- were dropped in `desktop_knowledge_import_drop_duplicate_indexes`. Check
-- pg_indexes before indexing a table another phase built.
-- Idempotency: the same file cannot be imported twice into one organization.
create unique index if not exists ckib_source_hash_idx
  on public.clinical_knowledge_import_batches (organization_id, source_sha256)
  where source_sha256 is not null;

alter table public.clinical_knowledge_import_items
  add column if not exists source_row_number integer,
  /** Stable identity within the source, used to match a row to what exists. */
  add column if not exists dedupe_key text,
  add column if not exists change_kind text check (change_kind in (
    'add', 'change', 'unchanged', 'conflict', 'removal')),
  /** What the row would replace, and how it differs — computed at preview. */
  add column if not exists existing_ref_type text,
  add column if not exists existing_ref_id uuid,
  add column if not exists diff jsonb,
  add column if not exists conflict_with_item_id uuid
    references public.clinical_knowledge_import_items(id),
  add column if not exists conflict_reason text;

create index if not exists ckii_batch_idx
  on public.clinical_knowledge_import_items (batch_id, change_kind);
create index if not exists ckii_dedupe_idx
  on public.clinical_knowledge_import_items (organization_id, entity_type, dedupe_key);
create index if not exists ckii_conflict_idx
  on public.clinical_knowledge_import_items (conflict_with_item_id);
create index if not exists ckii_reviewed_by_idx
  on public.clinical_knowledge_import_items (reviewed_by);
create index if not exists ckii_org_idx
  on public.clinical_knowledge_import_items (organization_id);

-- Within one batch, a dedupe key appears once. Two source rows claiming the
-- same identity is a CONFLICT to resolve, not a last-writer-wins race.
create unique index if not exists ckii_batch_dedupe_idx
  on public.clinical_knowledge_import_items (batch_id, entity_type, dedupe_key)
  where dedupe_key is not null;

-- The Phase-1 importer only ever knew two entity kinds and two applied targets.
-- The operator sources this phase must accept — product spreadsheets, protocol
-- documents, Obsidian exports, reference lists — need more, so the vocabularies
-- are WIDENED. Widening a check constraint cannot invalidate an existing row.
alter table public.clinical_knowledge_import_items
  drop constraint clinical_knowledge_import_items_entity_type_check,
  add constraint clinical_knowledge_import_items_entity_type_check
    check (entity_type in (
      'pathway', 'product_label', 'catalog_product', 'knowledge_reference',
      'knowledge_claim', 'lab_suggestion', 'interpretation_rule',
      'intervention_class', 'protocol_template', 'graph_edge'));

alter table public.clinical_knowledge_import_items
  drop constraint clinical_knowledge_import_items_applied_ref_type_check,
  add constraint clinical_knowledge_import_items_applied_ref_type_check
    check (applied_ref_type in (
      'clinical_pathway_version', 'product_label_version',
      'supplement_product_version', 'clinical_knowledge_source',
      'clinical_knowledge_claim', 'clinical_lab_suggestion',
      'clinical_interpretation_rule', 'clinical_intervention_class',
      'protocol_template_version', 'clinical_graph_edge'));

-- A practitioner spreadsheet is routinely longer than 250 rows. The old cap
-- would have forced an operator to hand-split their own file, which is exactly
-- the kind of manual step that produces a mis-split import. Raised, not removed:
-- an unbounded batch is a denial-of-service shape.
alter table public.clinical_knowledge_import_batches
  drop constraint clinical_knowledge_import_batches_item_count_check,
  add constraint clinical_knowledge_import_batches_item_count_check
    check (item_count >= 1 and item_count <= 5000);

-- `preview` is the new ENTRY state and the heart of "no silent insertion": a
-- previewed batch has been parsed, hashed, diffed and classified, and has
-- written nothing outside the staging tables. `staged` and `in_review` are kept
-- so Phase-1 batches and the existing acceptance suite remain valid.
alter table public.clinical_knowledge_import_batches
  drop constraint clinical_knowledge_import_batches_status_check,
  add constraint clinical_knowledge_import_batches_status_check
    check (status in (
      'preview', 'staged', 'in_review', 'committed', 'completed', 'cancelled'));

-- ==================================================== governed graph nodes

/** A lab or assessment a practitioner might consider. NOT an order. */
create table public.clinical_lab_suggestions (
  id uuid primary key default gen_random_uuid(),
  -- null organization_id = platform-governed
  organization_id uuid references public.organizations(id) on delete cascade,
  code text not null,
  name text not null,
  domain_code text,
  domain_version integer,

  /** The clinical question this addresses — the reason it would be ordered. */
  clinical_question text not null,
  /** Which hypotheses it helps distinguish. */
  hypotheses text[] not null default '{}',
  prerequisites text[] not null default '{}',
  limitations text,

  intent text not null check (intent in (
    'screening', 'confirmatory', 'monitoring', 'exploratory')),

  reference_id uuid references public.clinical_knowledge_sources(id),
  claim_id uuid references public.clinical_knowledge_claims(id),
  evidence_classification text not null default 'unclassified'
    check (evidence_classification in (
      'high', 'moderate', 'low', 'very_low', 'practitioner_experience', 'unclassified')),

  review_status text not null default 'draft'
    check (review_status in ('draft', 'in_review', 'approved', 'superseded', 'withdrawn')),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  version integer not null default 1,
  superseded_by_id uuid references public.clinical_lab_suggestions(id),

  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  foreign key (domain_code, domain_version)
    references public.clinical_domains(code, version),

  /** Same rule as claims: graded means cited. */
  constraint lab_graded_needs_reference check (
    evidence_classification in ('practitioner_experience', 'unclassified')
    or reference_id is not null)
);

-- NOT `unique (organization_id, code, version)`. In SQL two NULLs are never
-- equal, so a plain unique constraint would police organization rows and let
-- PLATFORM-GOVERNED rows (organization_id is null) duplicate freely — the exact
-- rows that most need to be unique. Two partial indexes cover both cases.
create unique index cls_org_code_idx
  on public.clinical_lab_suggestions (organization_id, code, version)
  where organization_id is not null;
create unique index cls_platform_code_idx
  on public.clinical_lab_suggestions (code, version)
  where organization_id is null;

create index cls_org_idx on public.clinical_lab_suggestions (organization_id);
create index cls_domain_idx on public.clinical_lab_suggestions (domain_code, domain_version);
create index cls_reference_idx on public.clinical_lab_suggestions (reference_id);
create index cls_claim_idx on public.clinical_lab_suggestions (claim_id);
create index cls_status_idx on public.clinical_lab_suggestions (review_status);
create index cls_superseded_idx on public.clinical_lab_suggestions (superseded_by_id);
create index cls_reviewed_by_idx on public.clinical_lab_suggestions (reviewed_by);
create index cls_created_by_idx on public.clinical_lab_suggestions (created_by);

/** A versioned rule for reading a biomarker. */
create table public.clinical_interpretation_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  biomarker_code text not null,
  name text not null,
  /** Structured condition; the RPC layer evaluates it, never the browser. */
  condition jsonb not null,
  interpretation text not null,
  caveats text,
  population text,
  reference_id uuid references public.clinical_knowledge_sources(id),
  claim_id uuid references public.clinical_knowledge_claims(id),
  evidence_classification text not null default 'unclassified'
    check (evidence_classification in (
      'high', 'moderate', 'low', 'very_low', 'practitioner_experience', 'unclassified')),
  review_status text not null default 'draft'
    check (review_status in ('draft', 'in_review', 'approved', 'superseded', 'withdrawn')),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  version integer not null default 1,
  superseded_by_id uuid references public.clinical_interpretation_rules(id),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  constraint rule_graded_needs_reference check (
    evidence_classification in ('practitioner_experience', 'unclassified')
    or reference_id is not null)
);

create index cir_org_idx on public.clinical_interpretation_rules (organization_id);
create index cir_biomarker_idx on public.clinical_interpretation_rules (biomarker_code);
create index cir_reference_idx on public.clinical_interpretation_rules (reference_id);
create index cir_claim_idx on public.clinical_interpretation_rules (claim_id);
create index cir_status_idx on public.clinical_interpretation_rules (review_status);
create index cir_superseded_idx on public.clinical_interpretation_rules (superseded_by_id);
create index cir_reviewed_by_idx on public.clinical_interpretation_rules (reviewed_by);
create index cir_created_by_idx on public.clinical_interpretation_rules (created_by);

/** A class of intervention, with its monitoring and stopping requirements. */
create table public.clinical_intervention_classes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  code text not null,
  name text not null,
  description text,
  category text,
  /** Prescription, peptide, IV, device and similar always need review. */
  jurisdiction_sensitive boolean not null default false,
  requires_permission text,
  monitoring_requirements text[] not null default '{}',
  stopping_rules text[] not null default '{}',
  contraindications text[] not null default '{}',
  followup_interval_days integer,
  reference_id uuid references public.clinical_knowledge_sources(id),
  claim_id uuid references public.clinical_knowledge_claims(id),
  evidence_classification text not null default 'unclassified'
    check (evidence_classification in (
      'high', 'moderate', 'low', 'very_low', 'practitioner_experience', 'unclassified')),
  review_status text not null default 'draft'
    check (review_status in ('draft', 'in_review', 'approved', 'superseded', 'withdrawn')),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  constraint intervention_graded_needs_reference check (
    evidence_classification in ('practitioner_experience', 'unclassified')
    or reference_id is not null)
);

create unique index cic_org_code_idx
  on public.clinical_intervention_classes (organization_id, code, version)
  where organization_id is not null;
create unique index cic_platform_code_idx
  on public.clinical_intervention_classes (code, version)
  where organization_id is null;

create index cic_org_idx on public.clinical_intervention_classes (organization_id);
create index cic_reference_idx on public.clinical_intervention_classes (reference_id);
create index cic_claim_idx on public.clinical_intervention_classes (claim_id);
create index cic_status_idx on public.clinical_intervention_classes (review_status);
create index cic_reviewed_by_idx on public.clinical_intervention_classes (reviewed_by);
create index cic_created_by_idx on public.clinical_intervention_classes (created_by);

-- ==================================================== the graph edge table
--
-- One typed edge table rather than a table per relationship. Every edge carries
-- its own provenance, so a question's "why did this appear?" is a row.

create table public.clinical_graph_edges (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,

  from_kind text not null check (from_kind in (
    'domain', 'symptom', 'missing_information', 'question', 'hypothesis',
    'lab_suggestion', 'biomarker', 'interpretation_rule', 'intervention_class',
    'diet_template', 'protocol_template', 'product', 'claim', 'reference',
    'safety_escalation', 'monitoring_requirement', 'stopping_rule')),
  from_ref text not null,
  relation text not null check (relation in (
    'supports', 'conflicts_with', 'distinguishes', 'suggests', 'requires',
    'monitors', 'stops_when', 'contraindicates', 'escalates_to',
    'interprets', 'belongs_to', 'cites', 'follows_up_after')),
  to_kind text not null check (to_kind in (
    'domain', 'symptom', 'missing_information', 'question', 'hypothesis',
    'lab_suggestion', 'biomarker', 'interpretation_rule', 'intervention_class',
    'diet_template', 'protocol_template', 'product', 'claim', 'reference',
    'safety_escalation', 'monitoring_requirement', 'stopping_rule')),
  to_ref text not null,

  /** Why this edge exists. An edge without provenance is an opinion. */
  reference_id uuid references public.clinical_knowledge_sources(id),
  claim_id uuid references public.clinical_knowledge_claims(id),
  evidence_classification text not null default 'unclassified'
    check (evidence_classification in (
      'high', 'moderate', 'low', 'very_low', 'practitioner_experience', 'unclassified')),
  rationale text,
  paradigm_code text references public.clinical_paradigms(code),

  review_status text not null default 'draft'
    check (review_status in ('draft', 'in_review', 'approved', 'superseded', 'withdrawn')),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),

  constraint edge_graded_needs_reference check (
    evidence_classification in ('practitioner_experience', 'unclassified')
    or reference_id is not null)
);

create unique index cge_org_edge_idx
  on public.clinical_graph_edges
    (organization_id, from_kind, from_ref, relation, to_kind, to_ref)
  where organization_id is not null;
create unique index cge_platform_edge_idx
  on public.clinical_graph_edges (from_kind, from_ref, relation, to_kind, to_ref)
  where organization_id is null;

create index cge_org_idx on public.clinical_graph_edges (organization_id);
create index cge_from_idx on public.clinical_graph_edges (from_kind, from_ref);
create index cge_to_idx on public.clinical_graph_edges (to_kind, to_ref);
create index cge_relation_idx on public.clinical_graph_edges (relation);
create index cge_reference_idx on public.clinical_graph_edges (reference_id);
create index cge_claim_idx on public.clinical_graph_edges (claim_id);
create index cge_paradigm_idx on public.clinical_graph_edges (paradigm_code);
create index cge_status_idx on public.clinical_graph_edges (review_status);
create index cge_reviewed_by_idx on public.clinical_graph_edges (reviewed_by);
create index cge_created_by_idx on public.clinical_graph_edges (created_by);

-- ============================================ differentiating question detail

alter table public.differential_questions
  /** What the practitioner is permitted to do with an answer. A question that
      implies an action without naming it is how scope creep starts. */
  add column if not exists permitted_followup text[] not null default '{}',
  add column if not exists answer_states text[] not null default '{}',
  add column if not exists is_urgent boolean not null default false,
  add column if not exists claim_id uuid references public.clinical_knowledge_claims(id);

create index if not exists dq_claim_idx on public.differential_questions (claim_id);
create index if not exists dq_urgent_idx on public.differential_questions (organization_id, is_urgent)
  where is_urgent;

-- ================================================ protocol dose provenance
--
-- NEVER INVENT A DOSE. A dose needs an exact product label, a supplied
-- practitioner protocol, or a governed source — and the row has to say which.

alter table public.protocol_items
  add column if not exists dose_source_kind text check (dose_source_kind in (
    'product_label', 'practitioner_protocol', 'governed_reference')),
  add column if not exists dose_source_ref text,
  add column if not exists dose_source_reference_id uuid
    references public.clinical_knowledge_sources(id),
  add column if not exists intervention_class_id uuid
    references public.clinical_intervention_classes(id);

create index if not exists pi_dose_reference_idx
  on public.protocol_items (dose_source_reference_id);
create index if not exists pi_intervention_class_idx
  on public.protocol_items (intervention_class_id);

-- ------------------------------------------------------------------- RLS

alter table public.clinical_lab_suggestions enable row level security;
alter table public.clinical_interpretation_rules enable row level security;
alter table public.clinical_intervention_classes enable row level security;
alter table public.clinical_graph_edges enable row level security;

create policy lab_suggestions_select on public.clinical_lab_suggestions
  for select to authenticated
  using (organization_id is null or private.is_org_member(organization_id));
create policy interpretation_rules_select on public.clinical_interpretation_rules
  for select to authenticated
  using (organization_id is null or private.is_org_member(organization_id));
create policy intervention_classes_select on public.clinical_intervention_classes
  for select to authenticated
  using (organization_id is null or private.is_org_member(organization_id));
create policy graph_edges_select on public.clinical_graph_edges
  for select to authenticated
  using (organization_id is null or private.is_org_member(organization_id));

revoke insert, update, delete on
  public.clinical_lab_suggestions, public.clinical_interpretation_rules,
  public.clinical_intervention_classes, public.clinical_graph_edges
from anon, authenticated;

-- ------------------------------------------------------------ immutability

/**
 * Approved graph content is frozen; supersede rather than edit.
 *
 * Covers DELETE as well as UPDATE. An immutability guard that only watches
 * UPDATE is trivially defeated by deleting the row — and because every write
 * here arrives through a SECURITY DEFINER function, the table-level `revoke
 * delete` does not stand in the way. Freezing edits while permitting erasure
 * would make the audit trail a matter of good intentions.
 */
create or replace function private.graph_content_protect()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.review_status in ('approved', 'superseded', 'withdrawn') then
      raise exception 'approved knowledge cannot be deleted; withdraw it instead'
        using errcode = '42501';
    end if;
    return old;
  end if;

  if old.review_status in ('approved', 'superseded', 'withdrawn') then
    if to_jsonb(new) - 'review_status' - 'superseded_by_id' - 'reviewed_at' - 'reviewed_by'
       is distinct from
       to_jsonb(old) - 'review_status' - 'superseded_by_id' - 'reviewed_at' - 'reviewed_by' then
      raise exception 'approved knowledge is immutable; supersede it instead'
        using errcode = '42501';
    end if;
    if new.review_status in ('draft', 'in_review') then
      raise exception 'approved knowledge cannot return to draft' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

create trigger clinical_lab_suggestions_protect
  before update or delete on public.clinical_lab_suggestions
  for each row execute function private.graph_content_protect();
create trigger clinical_interpretation_rules_protect
  before update or delete on public.clinical_interpretation_rules
  for each row execute function private.graph_content_protect();
create trigger clinical_intervention_classes_protect
  before update or delete on public.clinical_intervention_classes
  for each row execute function private.graph_content_protect();
create trigger clinical_graph_edges_protect
  before update or delete on public.clinical_graph_edges
  for each row execute function private.graph_content_protect();

revoke all on function private.graph_content_protect() from public, anon, authenticated;

commit;
