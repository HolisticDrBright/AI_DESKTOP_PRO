-- Phase 9B acceptance: commercial separation, the controlled import pipeline,
-- and the governed knowledge graph.
--
-- Rolled back at the end; the project is unchanged after the final statement.
--
-- The separation checks are deliberately written to catch the TWO mistakes this
-- phase actually made, not just the one it set out to fix:
--   * a commercial COLUMN left on a clinical table (the original defect), and
--   * a function still naming a column that had been dropped (the regression),
--     which plpgsql happily keeps in a function body until the day it runs.
-- A test that only looks for commercial TABLE names catches neither.

begin;

create temp table _r(n text, ok boolean) on commit drop;
create or replace function _c(_n text, _ok boolean) returns void language sql as $fn$
  insert into _r(n, ok) values (_n, _ok);
$fn$;
create or replace function _raises(_sql text, _state text)
returns boolean language plpgsql as $fn$
begin
  execute _sql; return false;
exception when others then return sqlstate = _state;
end;
$fn$;

-- ---------------------------------------------------------------- fixtures

insert into auth.users(id, email) values
  ('d9b00000-0000-4000-8000-000000000001', 'p9b-curator@verify.local'),
  ('d9b00000-0000-4000-8000-000000000002', 'p9b-outsider@verify.local');

insert into public.organizations(id, name, slug) values
  ('d9b00000-0000-4000-8000-000000000101', 'Import Org', 'p9b-import'),
  ('d9b00000-0000-4000-8000-000000000102', 'Other Org', 'p9b-import-other');

insert into public.organization_memberships(organization_id, user_id, role, status) values
  ('d9b00000-0000-4000-8000-000000000101',
   'd9b00000-0000-4000-8000-000000000001', 'practitioner', 'active'),
  ('d9b00000-0000-4000-8000-000000000102',
   'd9b00000-0000-4000-8000-000000000002', 'practitioner', 'active');

insert into public.clinical_knowledge_sources
  (id, code, revision, citation, title, authors_or_issuer, publisher,
   reference_type, evidence_classification, status, content_hash)
values
  ('d9b00000-0000-4000-8000-000000000201', 'p9b_import_ref', 1,
   'A Society. Import Test Guideline. 2025.', 'Import Test Guideline',
   'A Society', 'A Publisher', 'guideline', 'moderate', 'approved', 'hash-import');

-- ================================================= commercial separation

select _c('1. no clinical table carries a commercial column', (
  select count(*) = 0 from information_schema.columns
  where table_schema = 'public'
    and column_name ~* 'affiliate|commission|payout|referral'
    and table_name not in ('product_commercial_links',
                           'product_label_commercial_links',
                           'protocol_commercial_links')));

select _c('2. product_label_versions has no affiliate_url column', (
  select count(*) = 0 from information_schema.columns
  where table_schema = 'public' and table_name = 'product_label_versions'
    and column_name = 'affiliate_url'));

select _c('3. protocol_items has no affiliate_url column', (
  select count(*) = 0 from information_schema.columns
  where table_schema = 'public' and table_name = 'protocol_items'
    and column_name = 'affiliate_url'));

-- THE REGRESSION GUARD. A dropped column can survive inside a plpgsql body
-- indefinitely, because bodies are not resolved against the catalog until they
-- execute. Only `save_product_label_version` may name it, and only as its
-- parameter `_affiliate_url` — which is how the RPC keeps its Phase-1 signature.
select _c('4. no function still writes the dropped affiliate_url column', (
  select coalesce(bool_and(p.proname = 'save_product_label_version'), true)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private') and p.prosrc ~ 'affiliate_url'));

-- Only the parameter spelling `_affiliate_url` may appear. A bare
-- `affiliate_url` preceded by anything other than an underscore would be a
-- column reference.
select _c('5. save_product_label_version names it only as a parameter', (
  select p.prosrc !~ '[^_]affiliate_url'
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'save_product_label_version'));

-- The clinical read path must not serve commercial data. This is what makes
-- "an affiliate link cannot influence ranking" structural: there is nothing to
-- rank by, because the clinical payload does not contain one.
select _c('6. the protocol version payload carries no affiliate field', (
  select p.prosrc !~* 'affiliate'
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'private' and p.proname = 'protocol_version_json'));

select _c('7. no clinical eligibility/safety/ranking/evidence function reads a commercial table', (
  select count(*) = 0
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private')
    and p.proname in ('evaluate_protocol_safety', 'check_protocol_interactions',
      'review_protocol_item_interactions', 'search_protocol_catalog',
      'protocol_version_json', 'current_reference_status',
      'catalog_verification_status', 'get_patient_protocol')
    and p.prosrc ~ '(product_label_commercial_links|protocol_commercial_links|public\.product_commercial_links)'));

-- ============================================ commercial routing, behaviourally

select set_config('request.jwt.claims',
  '{"sub":"d9b00000-0000-4000-8000-000000000001","role":"authenticated"}', true);

do $blk$
declare _res jsonb; _lv uuid; _links jsonb;
begin
  _res := public.save_product_label_version(
    'd9b00000-0000-4000-8000-000000000101', 'p9b-prod', 'P9B Product', 'P9B Brand',
    jsonb_build_object('servingSize', '1 capsule', 'ingredients', 'Magnesium 100 mg'),
    'https://example.test/label', 'https://example.test/affiliate');
  _lv := (_res ->> 'labelVersionId')::uuid;

  perform _c('9. an affiliate argument still saves the clinical label version',
    _lv is not null);

  -- The affiliate URL went somewhere, and that somewhere is the commercial model.
  perform _c('10. the affiliate URL landed in the commercial model', (
    select count(*) = 1 from public.product_label_commercial_links
    where label_version_id = _lv and kind = 'affiliate'
      and url = 'https://example.test/affiliate'));

  perform _c('11. it was recorded with an explicit undisclosed-pending-review note', (
    select commission_disclosure is not null
    from public.product_label_commercial_links where label_version_id = _lv));

  _links := public.list_label_commercial_links(_lv);
  perform _c('12. the commercial read is a separate call that states its own limits',
    (_links ->> 'disclaimer') ilike '%not read by any clinical%');

  perform _c('13. a commercial link cannot be edited after the fact', _raises(
    format('update public.product_label_commercial_links set url = %L where label_version_id = %L',
           'https://example.test/changed', _lv), '42501'));

  perform _c('14. a commercial link cannot be deleted', _raises(
    format('delete from public.product_label_commercial_links where label_version_id = %L', _lv),
    '42501'));

  -- An undisclosed affiliate relationship is the failure mode this whole
  -- separation exists to prevent, so the disclosure is a constraint.
  perform _c('8. an affiliate link without a commission disclosure is refused', _raises(
    format($f$insert into public.product_label_commercial_links
      (organization_id, label_version_id, kind, url)
    values (%L, %L, 'affiliate', 'https://example.test/buy')$f$,
    'd9b00000-0000-4000-8000-000000000101', _lv), '23514'));
end $blk$;

-- ================================================== the import pipeline

do $blk$
declare
  _p jsonb; _batch uuid; _items jsonb;
  _before_labels integer; _after_labels integer;
begin
  select count(*) into _before_labels from public.product_label_versions;

  _items := jsonb_build_array(
    jsonb_build_object('entityType', 'product_label', 'displayName', 'Row one',
      'payload', jsonb_build_object(
        'productCode', 'imp-001', 'productName', 'Imported One', 'brand', 'B',
        'sourceUrl', 'https://example.test/1',
        'exactLabel', jsonb_build_object('servingSize', '1 cap', 'ingredients', 'X 1 mg'))),
    jsonb_build_object('entityType', 'lab_suggestion', 'displayName', 'A lab',
      'payload', jsonb_build_object(
        'code', 'imp-lab', 'name', 'Imported Lab', 'intent', 'screening',
        'clinicalQuestion', 'Does this distinguish A from B?',
        'evidenceClassification', 'moderate', 'referenceCode', 'p9b_import_ref')),
    -- a deliberately invalid row: graded but citing nothing
    jsonb_build_object('entityType', 'lab_suggestion', 'displayName', 'Ungrounded lab',
      'payload', jsonb_build_object(
        'code', 'imp-lab-bad', 'name', 'Ungrounded', 'intent', 'screening',
        'clinicalQuestion', 'Q', 'evidenceClassification', 'high')));

  _p := public.preview_knowledge_import(
    'd9b00000-0000-4000-8000-000000000101', 'product_spreadsheet',
    'Practitioner sheet', 'v1', _items, true, 'sheet.xlsx', 4096, null);
  _batch := (_p ->> 'batchId')::uuid;

  perform _c('15. preview reports a batch and classifies every row',
    (_p ->> 'added')::int = 3 and (_p ->> 'changed')::int = 0);

  -- THE CENTRAL CLAIM OF THE WHOLE PIPELINE.
  select count(*) into _after_labels from public.product_label_versions;
  perform _c('16. PREVIEW WRITES NOTHING GOVERNED', _after_labels = _before_labels);

  perform _c('17. preview says so in its own message',
    (_p ->> 'message') ilike '%No governed record has been created%');

  perform _c('18. a graded row citing no reference is a validation error', (
    select count(*) = 1 from public.clinical_knowledge_import_items
    where batch_id = _batch and jsonb_array_length(validation_errors) > 0
      and validation_errors::text ilike '%requires a governed reference%'));

  -- Committing while a row is invalid must refuse, not quietly drop the row.
  perform _c('19. commit refuses while any staged row has validation errors',
    _raises(format('select public.commit_knowledge_import(%L)', _batch), '55000'));

  -- Reject the invalid row the way an operator would, then commit.
  update public.clinical_knowledge_import_items
  set status = 'rejected', review_note = 'Ungrounded claim; returned to source'
  where batch_id = _batch and jsonb_array_length(validation_errors) > 0;

  perform _c('20. commit refuses when the confirmed counts do not match staging',
    _raises(format(
      'select public.commit_knowledge_import(%L, ''{"added":99,"changed":0}''::jsonb)',
      _batch), '40001'));

  _p := public.commit_knowledge_import(
    _batch, jsonb_build_object('added', 3, 'changed', 0), 'Reviewed and committed');

  perform _c('21. commit applies exactly the rows that survived review',
    (_p ->> 'applied')::int = 2);

  perform _c('22. imported content enters as a NON-APPROVED draft',
    (_p ->> 'approvalState') = 'draft'
    and (select bool_and(review_status = 'draft')
         from public.clinical_lab_suggestions
         where organization_id = 'd9b00000-0000-4000-8000-000000000101'));

  perform _c('23. the governed label row now exists (commit did what preview did not)', (
    select count(*) = 1 from public.product_label_versions
    where organization_id = 'd9b00000-0000-4000-8000-000000000101'
      and product_code = 'imp-001'));

  perform _c('24. the applied lab suggestion kept its exact citation', (
    select reference_id = 'd9b00000-0000-4000-8000-000000000201'
    from public.clinical_lab_suggestions where code = 'imp-lab'));

  -- FILE-LEVEL IDEMPOTENCY: the same bytes again.
  _p := public.preview_knowledge_import(
    'd9b00000-0000-4000-8000-000000000101', 'product_spreadsheet',
    'Practitioner sheet', 'v1', _items, true, 'sheet.xlsx', 4096, null);

  perform _c('25. re-importing the same file is idempotent, not duplicated',
    (_p ->> 'idempotent')::boolean is true
    and (_p ->> 'batchId')::uuid = _batch);

  perform _c('26. no second batch was created for identical bytes', (
    select count(*) = 1 from public.clinical_knowledge_import_batches
    where organization_id = 'd9b00000-0000-4000-8000-000000000101'));

  perform _c('27. a committed batch cannot be cancelled', _raises(
    format('select public.cancel_knowledge_import(%L, %L)', _batch, 'changed my mind'),
    '55000'));
end $blk$;

-- ROW-LEVEL IDEMPOTENCY and CHANGE DETECTION: same identity, different content.
do $blk$
declare _p jsonb; _batch uuid; _items jsonb;
begin
  _items := jsonb_build_array(
    jsonb_build_object('entityType', 'lab_suggestion', 'displayName', 'A lab',
      'payload', jsonb_build_object(
        'code', 'imp-lab', 'name', 'Imported Lab', 'intent', 'screening',
        'clinicalQuestion', 'Does this distinguish A from B?',
        'evidenceClassification', 'moderate', 'referenceCode', 'p9b_import_ref')),
    jsonb_build_object('entityType', 'lab_suggestion', 'displayName', 'A changed lab',
      'payload', jsonb_build_object(
        'code', 'imp-lab-2', 'name', 'Second Lab', 'intent', 'monitoring',
        'clinicalQuestion', 'A different question',
        'evidenceClassification', 'practitioner_experience')));

  _p := public.preview_knowledge_import(
    'd9b00000-0000-4000-8000-000000000101', 'product_spreadsheet',
    'Practitioner sheet v2', 'v1', _items, true, 'sheet2.xlsx', 4096, null);
  _batch := (_p ->> 'batchId')::uuid;

  perform _c('28. an unchanged row is reported as unchanged, not re-added',
    (_p ->> 'unchanged')::int = 1 and (_p ->> 'added')::int = 1);

  perform _c('29. an unchanged row is staged as skipped and needs no decision', (
    select count(*) = 1 from public.clinical_knowledge_import_items
    where batch_id = _batch and change_kind = 'unchanged' and status = 'skipped'));

  -- REMOVAL REPORTING: imp-001 was imported from this source kind and is absent.
  perform _c('30. a key absent from a later file of the same kind is reported as a removal',
    (_p ->> 'removals')::int >= 1);

  perform _c('31. removals are reported but never performed', (
    select count(*) = 1 from public.product_label_versions
    where product_code = 'imp-001')
    and (public.get_knowledge_import_preview(_batch) ->> 'removalPolicy')
        ilike '%never deletes%');

  -- Unreferenced practitioner content is accepted, and is accepted AS
  -- practitioner experience. It is not blocked, and it is not quietly promoted.
  perform _c('32. unreferenced practitioner content stages cleanly as practitioner_experience', (
    select validation_errors = '[]'::jsonb
       and payload ->> 'evidenceClassification' = 'practitioner_experience'
    from public.clinical_knowledge_import_items
    where batch_id = _batch and dedupe_key = 'imp-lab-2'));
end $blk$;

-- INTRA-BATCH CONFLICT: two rows of one file claiming one identity.
do $blk$
declare _p jsonb; _batch uuid; _conflict uuid;
begin
  _p := public.preview_knowledge_import(
    'd9b00000-0000-4000-8000-000000000101', 'reference_list',
    'Conflicting sheet', 'v1',
    jsonb_build_array(
      jsonb_build_object('entityType', 'intervention_class', 'displayName', 'First',
        'payload', jsonb_build_object('code', 'dup-code', 'name', 'First name')),
      jsonb_build_object('entityType', 'intervention_class', 'displayName', 'Second',
        'payload', jsonb_build_object('code', 'dup-code', 'name', 'Second name'))),
    true, 'conflict.xlsx', 128, null);
  _batch := (_p ->> 'batchId')::uuid;

  perform _c('33. two source rows claiming one identity are a conflict, not a race',
    (_p ->> 'conflicts')::int = 1);

  perform _c('34. the conflict names the row it collides with', (
    select conflict_with_item_id is not null and conflict_reason is not null
    from public.clinical_knowledge_import_items
    where batch_id = _batch and change_kind = 'conflict'));

  perform _c('35. commit refuses while a conflict is unresolved',
    _raises(format('select public.commit_knowledge_import(%L)', _batch), '55000'));

  select id into _conflict from public.clinical_knowledge_import_items
   where batch_id = _batch and change_kind = 'conflict';

  perform _c('36. resolving a conflict requires a reason', _raises(
    format('select public.resolve_knowledge_import_conflict(%L, %L, %L)',
           _conflict, 'skip', ''), '22023'));

  perform public.resolve_knowledge_import_conflict(
    _conflict, 'skip', 'Duplicate row in the source sheet; the first row is correct.');

  _p := public.commit_knowledge_import(_batch);
  perform _c('37. once resolved, commit proceeds and applies only the kept row',
    (_p ->> 'applied')::int = 1);
end $blk$;

-- `take_incoming` is the resolution that has to demote before it promotes,
-- because the applyable-row index is checked per statement.
do $blk$
declare _p jsonb; _batch uuid; _conflict uuid; _superseded uuid;
begin
  _p := public.preview_knowledge_import(
    'd9b00000-0000-4000-8000-000000000101', 'obsidian_export',
    'Take-incoming sheet', 'v1',
    jsonb_build_array(
      jsonb_build_object('entityType', 'intervention_class', 'displayName', 'Older',
        'payload', jsonb_build_object('code', 'ti-code', 'name', 'Older name')),
      jsonb_build_object('entityType', 'intervention_class', 'displayName', 'Newer',
        'payload', jsonb_build_object('code', 'ti-code', 'name', 'Newer name'))),
    true, 'ti.xlsx', 128, null);
  _batch := (_p ->> 'batchId')::uuid;

  select id, conflict_with_item_id into _conflict, _superseded
  from public.clinical_knowledge_import_items
  where batch_id = _batch and change_kind = 'conflict';

  perform public.resolve_knowledge_import_conflict(
    _conflict, 'take_incoming', 'The later row is the corrected one.');

  perform _c('37b. take_incoming demotes the row it supersedes', (
    select status = 'skipped' from public.clinical_knowledge_import_items
    where id = _superseded));

  _p := public.commit_knowledge_import(_batch);
  perform _c('37c. take_incoming applies exactly one row, the chosen one',
    (_p ->> 'applied')::int = 1
    and (select count(*) = 1 from public.clinical_intervention_classes
         where code = 'ti-code' and name = 'Newer name'));
end $blk$;

-- ============================================== authority and graph integrity

select _c('38. an import batch cannot be previewed by a non-member', (
  select _raises($q$select public.preview_knowledge_import(
    'd9b00000-0000-4000-8000-000000000102', 'other', 'x', 'v1',
    '[{"entityType":"pathway","payload":{}}]'::jsonb, true)$q$, '42501')));

select set_config('request.jwt.claims', '{"role":"anon"}', true);

select _c('39. anonymous cannot reach any import or commercial RPC', (
  select not bool_or(has_function_privilege('anon', p.oid, 'execute'))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in
    ('preview_knowledge_import', 'commit_knowledge_import',
     'get_knowledge_import_preview', 'resolve_knowledge_import_conflict',
     'cancel_knowledge_import', 'list_label_commercial_links',
     'list_protocol_commercial_links')));

select _c('40. every new import/commercial RPC pins an empty search_path', (
  select bool_and(p.prosecdef and 'search_path=""' = any(p.proconfig))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in
    ('preview_knowledge_import', 'commit_knowledge_import',
     'get_knowledge_import_preview', 'resolve_knowledge_import_conflict',
     'cancel_knowledge_import', 'list_label_commercial_links',
     'list_protocol_commercial_links')));

select _c('41. graph tables have RLS and no direct authenticated writes', (
  select bool_and(c.relrowsecurity)
    and not bool_or(has_table_privilege('authenticated', c.oid, 'insert'))
    and not bool_or(has_table_privilege('authenticated', c.oid, 'update'))
    and not bool_or(has_table_privilege('authenticated', c.oid, 'delete'))
  from pg_class c where c.oid in (
    'public.clinical_lab_suggestions'::regclass,
    'public.clinical_interpretation_rules'::regclass,
    'public.clinical_intervention_classes'::regclass,
    'public.clinical_graph_edges'::regclass,
    'public.clinical_knowledge_import_state'::regclass,
    'public.protocol_commercial_links'::regclass,
    'public.product_label_commercial_links'::regclass)));

-- A graded row without a citation must be impossible at the STORAGE layer too,
-- not merely refused by the importer. Otherwise any other write path could
-- create one.
select _c('42. a graded lab suggestion cannot be stored without a reference', _raises($q$
  insert into public.clinical_lab_suggestions
    (code, name, clinical_question, intent, evidence_classification)
  values ('ungrounded', 'Ungrounded', 'Q', 'screening', 'high')$q$, '23514'));

select _c('43. a graded graph edge cannot be stored without a reference', _raises($q$
  insert into public.clinical_graph_edges
    (from_kind, from_ref, relation, to_kind, to_ref, evidence_classification)
  values ('hypothesis', 'h1', 'suggests', 'lab_suggestion', 'l1', 'high')$q$, '23514'));

select _c('44. an interpretation rule graded without a reference is refused', _raises($q$
  insert into public.clinical_interpretation_rules
    (biomarker_code, name, condition, interpretation, evidence_classification)
  values ('tsh', 'R', '{}'::jsonb, 'I', 'low')$q$, '23514'));

-- Platform-governed rows must be unique too. A plain UNIQUE constraint would
-- not police them, because two NULL organization_ids are never equal.
do $blk$
begin
  insert into public.clinical_intervention_classes (code, name)
  values ('platform-dup', 'First');
  perform _c('45. a platform-governed code cannot be duplicated', _raises($q$
    insert into public.clinical_intervention_classes (code, name)
    values ('platform-dup', 'Second')$q$, '23505'));
end $blk$;

do $blk$
declare _id uuid;
begin
  insert into public.clinical_lab_suggestions
    (code, name, clinical_question, intent, review_status)
  values ('frozen-lab', 'Frozen', 'Q', 'screening', 'approved')
  returning id into _id;

  perform _c('46. approved graph content cannot be edited', _raises(
    format('update public.clinical_lab_suggestions set name = %L where id = %L',
           'Renamed', _id), '42501'));

  perform _c('47. approved graph content cannot be deleted', _raises(
    format('delete from public.clinical_lab_suggestions where id = %L', _id), '42501'));

  perform _c('48. approved graph content cannot be returned to draft', _raises(
    format('update public.clinical_lab_suggestions set review_status = %L where id = %L',
           'draft', _id), '42501'));
end $blk$;

-- A lab suggestion is not a lab order. Nothing in the graph may become one.
select _c('49. no graph table carries an ordering, billing or fulfilment column', (
  select count(*) = 0 from information_schema.columns
  where table_schema = 'public'
    and table_name in ('clinical_lab_suggestions', 'clinical_interpretation_rules',
                       'clinical_intervention_classes', 'clinical_graph_edges')
    and column_name ~* 'order|requisition|price|invoice|charge|fulfil|dispatch'));

select _c('50. every single-column FK on the new tables has a leading index', (
  select count(*) = 0 from (
    select c.conname from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    join unnest(c.conkey) as k(attnum) on true
    where c.contype = 'f' and n.nspname = 'public'
      and t.relname in ('clinical_lab_suggestions', 'clinical_interpretation_rules',
        'clinical_intervention_classes', 'clinical_graph_edges',
        'clinical_knowledge_import_state', 'protocol_commercial_links',
        'product_label_commercial_links')
      and array_length(c.conkey, 1) = 1
      and not exists (select 1 from pg_index i
        where i.indrelid = c.conrelid and (i.indkey::smallint[])[0] = k.attnum)
  ) missing));

-- ---------------------------------------------------------------- results
select count(*) filter (where ok) as passed,
       count(*) filter (where not ok) as failed,
       count(*) as total,
       coalesce(string_agg(n, ' | ') filter (where not ok), '(none)') as failures
from _r;

rollback;
