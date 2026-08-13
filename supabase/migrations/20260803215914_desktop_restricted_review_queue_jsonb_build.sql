-- Fix: rebuild items using jsonb_build_object per row instead of row_to_jsonb,
-- which is not reachable when search_path is empty even when qualified. This
-- keeps the SECURITY DEFINER hardening intact without depending on record-type
-- resolution against an empty search_path.

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

  select coalesce(jsonb_agg(row order by row->>'subjectType', row->>'displayName'), '[]'::jsonb) into _items from (
    select jsonb_build_object(
      'subjectType', 'preview_item',
      'subjectId', i.id,
      'displayName', i.display_name,
      'entityType', i.entity_type,
      'restrictedFlags', to_jsonb(i.restricted_flags),
      'missingFacts', i.missing_facts,
      'changeKind', i.change_kind,
      'status', i.status::text,
      'sourceName', b.source_name,
      'sourceSheet', i.source_sheet,
      'sourceRowNumber', i.source_row_number,
      'currentOutcome', (
        select outcome::text from public.catalog_restricted_review_decisions d
        where d.preview_item_id = i.id and d.organization_id = _organization_id
        order by d.decided_at desc limit 1)
    ) as row
    from public.clinical_knowledge_import_items i
    join public.clinical_knowledge_import_batches b on b.id = i.batch_id
    where i.organization_id = _organization_id
      and cardinality(i.restricted_flags) > 0
      and b.status in ('preview','staged','in_review')
    union all
    select jsonb_build_object(
      'subjectType', 'product',
      'subjectId', p.id,
      'displayName', p.name,
      'entityType', 'supplement_product',
      'restrictedFlags', to_jsonb(p.restricted_flags),
      'missingFacts', '[]'::jsonb,
      'changeKind', null,
      'status', p.status::text,
      'sourceName', null,
      'sourceSheet', null,
      'sourceRowNumber', null,
      'currentOutcome', (
        select outcome::text from public.catalog_restricted_review_decisions d
        where d.product_id = p.id and d.organization_id = _organization_id
        order by d.decided_at desc limit 1)
    ) as row
    from public.supplement_products p
    where cardinality(p.restricted_flags) > 0
    union all
    select jsonb_build_object(
      'subjectType', 'knowledge_reference',
      'subjectId', r.id,
      'displayName', r.claim,
      'entityType', 'knowledge_reference',
      'restrictedFlags', to_jsonb(r.restricted_flags),
      'missingFacts', '[]'::jsonb,
      'changeKind', null,
      'status', r.status,
      'sourceName', null,
      'sourceSheet', null,
      'sourceRowNumber', null,
      'currentOutcome', (
        select outcome::text from public.catalog_restricted_review_decisions d
        where d.knowledge_reference_id = r.id and d.organization_id = _organization_id
        order by d.decided_at desc limit 1)
    ) as row
    from public.governed_knowledge_references r
    where r.organization_id = _organization_id
      and cardinality(r.restricted_flags) > 0
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
