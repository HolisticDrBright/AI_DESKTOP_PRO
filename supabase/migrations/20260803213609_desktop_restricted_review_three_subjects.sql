-- Phase 9E-A.1 follow-up: extend the restricted-review domain from a single
-- subject (`supplement_products`) to the three subject types the workspace
-- actually needs to review:
--
--   1. A preview import item — one of 979 rows currently in the eight staged
--      preview batches (of which 506 are restricted). These are the rows the
--      workspace's Restricted Review tab was supposed to be able to reach but
--      could not, because the decision table's FK was locked to committed
--      supplement_products only.
--   2. A committed catalog product (unchanged path — the FK the Phase 9E-A
--      shipping migration already established).
--   3. A committed knowledge reference — a scaffold table for the governed
--      knowledge references Phase 9E-A.2 will populate, so the decision path
--      is typed and validated NOW rather than back-filled after the surface
--      is already writing rows.
--
-- The user brief calls for `explicit nullable foreign keys with an
-- exactly-one-subject constraint OR separate typed tables over an unchecked
-- polymorphic identifier`. This migration picks the first form: three
-- nullable FKs on `catalog_restricted_review_decisions`, each pointing at
-- its own typed target, with a CHECK constraint so exactly one is set per
-- row. That preserves the append-only history table and keeps queries
-- typed without an untyped `subject_type`/`subject_id` pair.

-- ------------------------------------------------------ 1. reference scaffold
--
-- `governed_knowledge_references` is a placeholder for the reference-curation
-- surface Phase 9E-A.2 will build. It exists NOW so the review-decision FK
-- can point at a real table, and its RLS is closed by default (no policies)
-- so nothing reads or writes it outside the governed RPC path the A.2
-- curation surface will add.

create table if not exists public.governed_knowledge_references (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  claim text not null,
  citation text,
  source_kind text,
  jurisdiction text,
  restricted_flags text[] not null default '{}'::text[],
  status text not null default 'pending' check (status in ('pending','verified','retired')),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default clock_timestamp(),
  constraint governed_knowledge_references_claim_non_empty check (btrim(claim) <> '')
);

alter table public.governed_knowledge_references enable row level security;

-- Read-side org gate. Writes are the RPC's job (SECURITY DEFINER); no direct
-- INSERT/UPDATE/DELETE policy is offered.
create policy governed_knowledge_references_read_org
  on public.governed_knowledge_references for select
  using (organization_id in (
    select organization_id from public.organization_memberships
    where user_id = (select auth.uid()) and status = 'active'
  ));

comment on table public.governed_knowledge_references is
  'Governed knowledge references — the committed home for curated evidence entries. Phase 9E-A.1 scaffolds this table so the restricted-review FK is typed; Phase 9E-A.2 lands the curation surface that populates it.';

-- ------------------------------------------------- 2. extend the decisions table
--
-- Add the two new typed nullable FKs, relax the existing product_id NOT NULL,
-- and enforce that exactly one subject is present per row.

alter table public.catalog_restricted_review_decisions
  add column if not exists preview_item_id uuid
    references public.clinical_knowledge_import_items(id) on delete restrict;

alter table public.catalog_restricted_review_decisions
  add column if not exists knowledge_reference_id uuid
    references public.governed_knowledge_references(id) on delete restrict;

alter table public.catalog_restricted_review_decisions
  alter column product_id drop not null;

alter table public.catalog_restricted_review_decisions
  drop constraint if exists catalog_restricted_review_decisions_exactly_one_subject;

alter table public.catalog_restricted_review_decisions
  add constraint catalog_restricted_review_decisions_exactly_one_subject
  check (
    (case when product_id is null then 0 else 1 end)
    + (case when preview_item_id is null then 0 else 1 end)
    + (case when knowledge_reference_id is null then 0 else 1 end)
    = 1
  );

create index if not exists catalog_restricted_review_decisions_preview_item_idx
  on public.catalog_restricted_review_decisions(preview_item_id, decided_at desc)
  where preview_item_id is not null;

create index if not exists catalog_restricted_review_decisions_knowledge_reference_idx
  on public.catalog_restricted_review_decisions(knowledge_reference_id, decided_at desc)
  where knowledge_reference_id is not null;

-- ------------------------------------------------- 3. v2 record RPC
--
-- Accepts a subject discriminator ('product' | 'preview_item' | 'knowledge_reference')
-- and the matching id, validates the subject exists AND belongs to the tenant
-- making the decision (tenant proof depends on the subject type:
--   * a preview item carries its own organization_id
--   * a knowledge reference carries its own organization_id
--   * a supplement_product is global-ish; the decision itself is tenant-scoped
--     via _organization_id and the caller's editor membership in it), then
-- inserts an append-only row. A preview-item decision NEVER commits, publishes,
-- or makes selectable — it only records the reviewer's judgement in the
-- append-only history. Commit remains a separate governed action.

create or replace function public.record_restricted_review_outcome_v2(
  _organization_id uuid,
  _subject_type text,
  _subject_id uuid,
  _outcome public.catalog_restricted_review_outcome,
  _reason text,
  _jurisdiction text default null
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  _uid uuid;
  _decision_id uuid;
  _product_id uuid;
  _preview_item_id uuid;
  _reference_id uuid;
  _subject_org uuid;
  _resource_type text;
  _resource_id text;
begin
  if _subject_type not in ('product','preview_item','knowledge_reference') then
    raise exception 'unknown subject type: %', _subject_type using errcode = '22023';
  end if;

  -- Editor role in the tenant that is making the decision (this is separate
  -- from the subject's own tenant check below — a preview item that lives in
  -- another org cannot be reviewed from this org, even if the caller happens
  -- to be an editor in both).
  _uid := private.require_knowledge_editor(_organization_id);

  if coalesce(btrim(_reason), '') = '' then
    raise exception 'a restricted-review decision requires a reason'
      using errcode = '22023';
  end if;

  if _outcome = 'clinician_reviewed_for_jurisdiction'
     and coalesce(btrim(_jurisdiction), '') = '' then
    raise exception 'clinician_reviewed_for_jurisdiction requires a jurisdiction'
      using errcode = '22023';
  end if;

  if _subject_type = 'product' then
    if not exists (select 1 from public.supplement_products where id = _subject_id) then
      raise exception 'subject product not found' using errcode = 'P0002';
    end if;
    _product_id := _subject_id;
    _resource_type := 'supplement_product';
    _resource_id := _subject_id::text;

  elsif _subject_type = 'preview_item' then
    select organization_id into _subject_org
    from public.clinical_knowledge_import_items where id = _subject_id;
    if not found then
      raise exception 'subject preview item not found' using errcode = 'P0002';
    end if;
    if _subject_org is distinct from _organization_id then
      raise exception 'subject preview item belongs to a different tenant'
        using errcode = '42501';
    end if;
    _preview_item_id := _subject_id;
    _resource_type := 'clinical_knowledge_import_item';
    _resource_id := _subject_id::text;

  elsif _subject_type = 'knowledge_reference' then
    select organization_id into _subject_org
    from public.governed_knowledge_references where id = _subject_id;
    if not found then
      raise exception 'subject knowledge reference not found' using errcode = 'P0002';
    end if;
    if _subject_org is distinct from _organization_id then
      raise exception 'subject knowledge reference belongs to a different tenant'
        using errcode = '42501';
    end if;
    _reference_id := _subject_id;
    _resource_type := 'governed_knowledge_reference';
    _resource_id := _subject_id::text;
  end if;

  insert into public.catalog_restricted_review_decisions
    (organization_id, product_id, preview_item_id, knowledge_reference_id,
     outcome, reason, jurisdiction, decided_by)
  values
    (_organization_id, _product_id, _preview_item_id, _reference_id,
     _outcome, btrim(_reason),
     nullif(btrim(_jurisdiction), ''), _uid)
  returning id into _decision_id;

  -- Audit event carries the outcome + subject type + presence of jurisdiction.
  -- It deliberately does NOT carry the reason or jurisdiction text — reasons
  -- can contain arbitrary operator prose and belong in the decision table
  -- itself, which is tenant-scoped and RLS'd. This mirrors how other clinical
  -- RPCs record actions without duplicating patient/reason content into audit.
  insert into public.audit_events
    (organization_id, actor_user_id, action, resource_type, resource_id,
     safe_message, metadata)
  values
    (_organization_id, _uid, 'catalog.restricted_review_recorded',
     _resource_type, _resource_id,
     'Restricted-review outcome recorded',
     jsonb_build_object(
       'outcome', _outcome,
       'subjectType', _subject_type,
       'has_jurisdiction', _jurisdiction is not null));

  return jsonb_build_object(
    'ok', true,
    'decisionId', _decision_id,
    'subjectType', _subject_type,
    'subjectId', _subject_id,
    'outcome', _outcome,
    'restrictionsPreserved', true);
end;
$function$;

revoke all on function public.record_restricted_review_outcome_v2(uuid, text, uuid, public.catalog_restricted_review_outcome, text, text) from public, anon;
grant execute on function public.record_restricted_review_outcome_v2(uuid, text, uuid, public.catalog_restricted_review_outcome, text, text) to authenticated;

comment on function public.record_restricted_review_outcome_v2 is
  'Record a restricted-review outcome against a product, preview item, or knowledge reference. Typed subject FK, exactly-one enforcement, tenant proof on subject.';

-- The v1 RPC stays for backward compat but delegates to v2. Do not remove.
create or replace function public.record_restricted_review_outcome(
  _organization_id uuid,
  _product_id uuid,
  _outcome public.catalog_restricted_review_outcome,
  _reason text,
  _jurisdiction text default null
)
returns jsonb
language sql
security definer
set search_path to ''
as $function$
  select public.record_restricted_review_outcome_v2(
    _organization_id, 'product', _product_id, _outcome, _reason, _jurisdiction);
$function$;

revoke all on function public.record_restricted_review_outcome(uuid, uuid, public.catalog_restricted_review_outcome, text, text) from public, anon;
grant execute on function public.record_restricted_review_outcome(uuid, uuid, public.catalog_restricted_review_outcome, text, text) to authenticated;

-- ------------------------------------------------- 4. v2 history RPC

create or replace function public.get_restricted_review_history_v2(
  _organization_id uuid,
  _subject_type text,
  _subject_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  _uid uuid := auth.uid();
  _rows jsonb;
  _current text;
begin
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not exists (
    select 1 from public.organization_memberships
    where organization_id = _organization_id
      and user_id = _uid
      and status = 'active'
  ) then
    raise exception 'not a member of this organization' using errcode = '42501';
  end if;
  if _subject_type not in ('product','preview_item','knowledge_reference') then
    raise exception 'unknown subject type: %', _subject_type using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(x order by x->>'decidedAt' desc), '[]'::jsonb) into _rows
  from (
    select jsonb_build_object(
      'id', d.id,
      'outcome', d.outcome,
      'reason', d.reason,
      'jurisdiction', d.jurisdiction,
      'decidedBy', d.decided_by,
      'decidedAt', d.decided_at
    ) as x
    from public.catalog_restricted_review_decisions d
    where d.organization_id = _organization_id
      and (
        (_subject_type = 'product' and d.product_id = _subject_id)
        or (_subject_type = 'preview_item' and d.preview_item_id = _subject_id)
        or (_subject_type = 'knowledge_reference' and d.knowledge_reference_id = _subject_id)
      )
  ) t;

  select outcome into _current
  from public.catalog_restricted_review_decisions
  where organization_id = _organization_id
    and (
      (_subject_type = 'product' and product_id = _subject_id)
      or (_subject_type = 'preview_item' and preview_item_id = _subject_id)
      or (_subject_type = 'knowledge_reference' and knowledge_reference_id = _subject_id)
    )
  order by decided_at desc limit 1;

  return jsonb_build_object(
    'subjectType', _subject_type,
    'subjectId', _subject_id,
    'organizationId', _organization_id,
    'currentOutcome', _current,
    'history', _rows);
end;
$function$;

revoke all on function public.get_restricted_review_history_v2(uuid, text, uuid) from public, anon;
grant execute on function public.get_restricted_review_history_v2(uuid, text, uuid) to authenticated;

-- v1 stays, delegates to v2.
create or replace function public.get_restricted_review_history(
  _organization_id uuid,
  _product_id uuid
)
returns jsonb
language sql
security definer
set search_path to ''
as $function$
  select public.get_restricted_review_history_v2(_organization_id, 'product', _product_id);
$function$;

revoke all on function public.get_restricted_review_history(uuid, uuid) from public, anon;
grant execute on function public.get_restricted_review_history(uuid, uuid) to authenticated;

-- ------------------------------------------------- 5. unified queue RPC
--
-- The workspace needs one call that returns all restricted subjects across
-- the three types, so the reviewer sees the whole queue in one place. The
-- rows carry a `subjectType` discriminator so the UI can label them.

create or replace function public.get_restricted_review_queue(_organization_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  _uid uuid := auth.uid();
  _items jsonb;
begin
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not exists (
    select 1 from public.organization_memberships
    where organization_id = _organization_id
      and user_id = _uid
      and status = 'active'
  ) then
    raise exception 'not a member of this organization' using errcode = '42501';
  end if;

  -- Union all three subject types. Each entry carries subjectType +
  -- subjectId, minimum-necessary display fields, and restriction flags.
  -- Deliberately no raw source text: source_raw / payload jsonb are not
  -- returned here (they can be huge and contain arbitrary operator prose).
  -- The full preview surface has its own read path with its own audit.
  select coalesce(jsonb_agg(row_to_jsonb(t)), '[]'::jsonb) into _items from (
    select
      'preview_item'::text as "subjectType",
      i.id as "subjectId",
      i.display_name as "displayName",
      i.entity_type as "entityType",
      i.restricted_flags as "restrictedFlags",
      i.missing_facts as "missingFacts",
      i.change_kind as "changeKind",
      i.status::text as "status",
      b.source_name as "sourceName",
      i.source_sheet as "sourceSheet",
      i.source_row_number as "sourceRowNumber",
      (select outcome::text from public.catalog_restricted_review_decisions d
       where d.preview_item_id = i.id and d.organization_id = _organization_id
       order by d.decided_at desc limit 1) as "currentOutcome"
    from public.clinical_knowledge_import_items i
    join public.clinical_knowledge_import_batches b on b.id = i.batch_id
    where i.organization_id = _organization_id
      and cardinality(i.restricted_flags) > 0
      and b.status in ('preview','staged','in_review')
    union all
    select
      'product'::text as "subjectType",
      p.id as "subjectId",
      p.name as "displayName",
      'supplement_product'::text as "entityType",
      p.restricted_flags as "restrictedFlags",
      '[]'::jsonb as "missingFacts",
      null::text as "changeKind",
      p.status::text as "status",
      null::text as "sourceName",
      null::text as "sourceSheet",
      null::integer as "sourceRowNumber",
      (select outcome::text from public.catalog_restricted_review_decisions d
       where d.product_id = p.id and d.organization_id = _organization_id
       order by d.decided_at desc limit 1) as "currentOutcome"
    from public.supplement_products p
    where cardinality(p.restricted_flags) > 0
    union all
    select
      'knowledge_reference'::text as "subjectType",
      r.id as "subjectId",
      r.claim as "displayName",
      'knowledge_reference'::text as "entityType",
      r.restricted_flags as "restrictedFlags",
      '[]'::jsonb as "missingFacts",
      null::text as "changeKind",
      r.status as "status",
      null::text as "sourceName",
      null::text as "sourceSheet",
      null::integer as "sourceRowNumber",
      (select outcome::text from public.catalog_restricted_review_decisions d
       where d.knowledge_reference_id = r.id and d.organization_id = _organization_id
       order by d.decided_at desc limit 1) as "currentOutcome"
    from public.governed_knowledge_references r
    where r.organization_id = _organization_id
      and cardinality(r.restricted_flags) > 0
    order by 1, 3
  ) t;

  return jsonb_build_object(
    'items', _items,
    'counts', jsonb_build_object(
      'total', jsonb_array_length(_items),
      'previewItems', (select count(*) from jsonb_array_elements(_items) e where e->>'subjectType' = 'preview_item'),
      'products', (select count(*) from jsonb_array_elements(_items) e where e->>'subjectType' = 'product'),
      'knowledgeReferences', (select count(*) from jsonb_array_elements(_items) e where e->>'subjectType' = 'knowledge_reference')
    ));
end;
$function$;

revoke all on function public.get_restricted_review_queue(uuid) from public, anon;
grant execute on function public.get_restricted_review_queue(uuid) to authenticated;

comment on function public.get_restricted_review_queue is
  'Unified restricted-review queue across preview items, catalog products, and knowledge references. Returns minimum-necessary display fields; raw source text is deliberately excluded.';

-- ------------------------------------------------ 6. carry-forward guarantee
--
-- The commit path applies preview items into governed rows. If a preview
-- item carried restricted_flags, those flags MUST land on the applied
-- supplement_product; a decision recorded against the preview item is
-- carried forward as an audit note but does NOT itself clear the
-- restriction. This function is the invariant, enforceable from tests.

create or replace function private.assert_preview_restriction_carries_forward(
  _preview_item_id uuid,
  _applied_product_id uuid
) returns void
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  _preview_flags text[];
  _applied_flags text[];
begin
  select restricted_flags into _preview_flags
  from public.clinical_knowledge_import_items where id = _preview_item_id;
  select restricted_flags into _applied_flags
  from public.supplement_products where id = _applied_product_id;

  if _preview_flags is not null and array_length(_preview_flags, 1) > 0 then
    if _applied_flags is null
       or not (_preview_flags <@ _applied_flags) then
      raise exception 'restricted flags on preview item % were not carried forward to product %',
        _preview_item_id, _applied_product_id using errcode = '55000';
    end if;
  end if;
end;
$function$;
