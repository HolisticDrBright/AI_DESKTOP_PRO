-- First attempt to fix the row_to_jsonb() resolution problem inside
-- `get_restricted_review_queue`. This migration qualifies the function as
-- `pg_catalog.row_to_jsonb`, which still could not resolve the anonymous
-- record type produced by the subquery when `search_path` is empty. The
-- superseding migration 20260803215914_desktop_restricted_review_queue_jsonb_build
-- rewrites the function to build each row with jsonb_build_object per-row
-- instead of relying on row_to_jsonb.
--
-- This file is retained in the repository so the local migrations directory
-- exactly matches the staging ledger. It is superseded by the next migration
-- and left here as ledger-preserved history rather than a live behavior.

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

  select coalesce(jsonb_agg(pg_catalog.row_to_jsonb(t)), '[]'::jsonb) into _items from (
    select
      'preview_item'::text as "subjectType",
      i.id as "subjectId",
      i.display_name as "displayName",
      i.entity_type as "entityType",
      to_jsonb(i.restricted_flags) as "restrictedFlags",
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
      to_jsonb(p.restricted_flags) as "restrictedFlags",
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
      to_jsonb(r.restricted_flags) as "restrictedFlags",
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
