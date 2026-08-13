-- Acceptance: the Phase 9C curated-import safety layer and its apply paths.
--
-- Rolled back at the end; the project is unchanged after the final statement.
--
-- WHAT THIS SUITE IS FOR. Phase 9B could stage, hash, dedupe and commit
-- knowledge. It could not answer the questions that only matter once REAL
-- practitioner material is loaded, and 9C added the refusals that answer them.
-- A refusal that has never been triggered is a comment, not a control — the
-- classifier in `20260801185637` deployed cleanly and raised `malformed array
-- literal` the first time it saw a declared route, which is exactly the class
-- of defect a probe finds and a re-read does not.
--
-- THE INFERENCE BOUNDARY IS THE HEART OF IT (checks 6-9). A DECLARED value
-- carries authority; a TEXT SIGNAL does not. A product NAMED "peptide" must
-- acquire suspicion and nothing else, because inferring a legal class from a
-- name would let "Peptide Support Blend" gain a regulatory status nobody
-- assigned it — and let a genuine prescription peptide called "Recovery
-- Formula" escape one.
--
-- AND THE THREE AXES, again (checks 12-14). Absent from search, non-selectable,
-- and non-attachable are three different claims, and only the last is
-- conclusive. A product can be missing from the picker and still be attached by
-- id, which is how a "hidden" record keeps reaching patients.

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

-- ------------------------------------------------------------------ fixtures

insert into auth.users(id, email) values
  ('c9000000-0000-4000-8000-000000000001', 'p9c-importer@verify.local');
insert into public.organizations(id, name, slug) values
  ('c9000000-0000-4000-8000-000000000101', 'Import Org', 'p9c-import');
insert into public.organization_memberships(organization_id, user_id, role, status)
values ('c9000000-0000-4000-8000-000000000101',
        'c9000000-0000-4000-8000-000000000001', 'owner', 'active');
insert into public.patient_profiles(id, organization_id, first_name, last_name)
values ('c9000000-0000-4000-8000-000000000201',
        'c9000000-0000-4000-8000-000000000101', 'Import', 'Patient');
insert into public.practitioner_patient_relationships
  (organization_id, practitioner_user_id, patient_id, status)
values ('c9000000-0000-4000-8000-000000000101',
        'c9000000-0000-4000-8000-000000000001',
        'c9000000-0000-4000-8000-000000000201', 'active');

select set_config('request.jwt.claims',
  '{"sub":"c9000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- ======================================================== 1-5 source inventory
--
-- The inventory exists so that "we imported the product database" and "we could
-- not find the product database" stop looking identical afterwards. That only
-- holds if it cannot be filled in optimistically.

select _c('1. a file recorded as available must carry a real digest', _raises($q$
  select public.record_import_source_file(
    'c9000000-0000-4000-8000-000000000101'::uuid, 'products.xlsx', 'spreadsheet',
    'available', null, 4096, null)
$q$, '22023'));

select _c('2. a file recorded as unavailable must say why', _raises($q$
  select public.record_import_source_file(
    'c9000000-0000-4000-8000-000000000101'::uuid, 'missing.xlsx', 'spreadsheet',
    'unavailable', null, null, null)
$q$, '22023'));

select _c('3. a declared name may not be a path', _raises($q$
  select public.record_import_source_file(
    'c9000000-0000-4000-8000-000000000101'::uuid, '/Users/me/clinical/products.xlsx',
    'spreadsheet', 'unavailable', null, null, 'not readable')
$q$, '23514'));

select public.record_import_source_file(
  'c9000000-0000-4000-8000-000000000101', 'products.xlsx', 'spreadsheet',
  'available', repeat('a', 64), 4096, null);
select public.record_import_source_file(
  'c9000000-0000-4000-8000-000000000101', 'protocols.docx', 'document',
  'unavailable', null, null, 'Declared by the operator; the file was never supplied.');

select _c('4. the inventory counts what was declared, read and not read', (
  select (public.get_import_source_inventory('c9000000-0000-4000-8000-000000000101')
          ->'counts'->>'declared')::int = 2
     and (public.get_import_source_inventory('c9000000-0000-4000-8000-000000000101')
          ->'counts'->>'available')::int = 1
     and (public.get_import_source_inventory('c9000000-0000-4000-8000-000000000101')
          ->'counts'->>'unavailable')::int = 1));

select _c('5. an unreadable file survives as a record, with its reason', (
  select exists (
    select 1 from jsonb_array_elements(
      public.get_import_source_inventory('c9000000-0000-4000-8000-000000000101')
      ->'files') f
    where f ->> 'declaredName' = 'protocols.docx'
      and f ->> 'availability' = 'unavailable'
      and length(coalesce(f ->> 'unavailableReason', '')) > 20)));

-- ================================================ 6-9 the inference boundary
--
-- Declared values carry authority. Text signals raise suspicion and nothing
-- else. Check 8 is the one that caught the array-literal defect.

select _c('6. a DECLARED regulatory classification becomes that exact flag', (
  select private.import_restricted_flags('catalog_product',
    '{"name":"Recovery Formula","regulatoryClassification":"peptide"}'::jsonb)
    @> array['peptide']));

select _c('7. the word "peptide" in a NAME raises suspicion and never a class', (
  select private.import_restricted_flags('catalog_product',
    '{"name":"Peptide Support Blend"}'::jsonb) = array['suspected_restricted']));

select _c('8. a DECLARED parenteral route becomes parenteral_therapy', (
  select private.import_restricted_flags('catalog_product',
    '{"name":"Glutathione","route":"iv"}'::jsonb) @> array['parenteral_therapy']));

select _c('9. an unremarkable product is flagged as nothing at all', (
  select private.import_restricted_flags('catalog_product',
    '{"name":"Magnesium Glycinate","form":"capsule"}'::jsonb) = '{}'::text[]));

-- ============================================== 10-16 what an import produces

select public.preview_knowledge_import(
  'c9000000-0000-4000-8000-000000000101', 'product_spreadsheet',
  'Operator product sheet', '9c.1',
  jsonb_build_array(
    jsonb_build_object(
      'entityType', 'catalog_product',
      'displayName', 'Curcumin Complex',
      'sourceSheet', 'Products',
      'sourceRaw', jsonb_build_object(
        'Product Name', ' Curcumin Complex ', 'Mfr', 'Acme Labs',
        'Item #', 'AC-100', 'Serving', '2 capsules'),
      'payload', jsonb_build_object(
        'name', 'Curcumin Complex', 'brand', 'Acme Labs', 'sku', 'AC-100',
        'form', 'capsule', 'servingSize', '2 capsules',
        'ingredients', jsonb_build_array(
          jsonb_build_object('name', 'Curcumin', 'amount', '500', 'unit', 'mg')),
        'sourceUrl', 'https://example.invalid/curcumin',
        'regulatoryClassification', 'supplement')),
    jsonb_build_object(
      'entityType', 'catalog_product',
      'displayName', 'Glutathione Push',
      'sourceSheet', 'Products',
      'sourceRaw', jsonb_build_object('Product Name', 'Glutathione Push',
                                      'Route', 'IV'),
      'payload', jsonb_build_object(
        'name', 'Glutathione Push', 'brand', 'Acme Labs', 'sku', 'AC-200',
        'route', 'iv'))),
  true, 'products.xlsx', 4096, null);

select _c('10. a restricted row is counted as restricted at preview time', (
  select restricted_count = 1 and added_count = 2
  from public.clinical_knowledge_import_batches
  where organization_id = 'c9000000-0000-4000-8000-000000000101'
    and source_name = 'Operator product sheet'));

select public.commit_knowledge_import(
  (select id from public.clinical_knowledge_import_batches
   where organization_id = 'c9000000-0000-4000-8000-000000000101'
     and source_name = 'Operator product sheet'),
  null, 'Committed by the acceptance suite');

select _c('11. an imported product exists and is NOT active', (
  select count(*) = 2 and bool_and(p.status in ('incomplete', 'needs_review'))
  from public.supplement_products p
  where p.sku in ('AC-100', 'AC-200')));

-- The three axes. Only the third is conclusive.

select _c('12. axis one — an imported product is absent from catalog search', (
  select jsonb_array_length(
    public.search_protocol_catalog('c9000000-0000-4000-8000-000000000101',
      'Curcumin', 50) -> 'products') = 0));

select _c('13. axis two — it is not selectable', (
  select not private.catalog_product_is_selectable(
    (select id from public.supplement_products where sku = 'AC-100'))));

-- One draft, reused by checks 14 and 30. `create_protocol_draft` allows a
-- patient only one open draft at a time, and that rule is not this suite's to
-- work around.
create temp table _ids(k text primary key, v uuid) on commit drop;

insert into _ids(k, v)
select 'draft_version',
  (public.create_protocol_draft('c9000000-0000-4000-8000-000000000101',
    'c9000000-0000-4000-8000-000000000201', 'Attach probe', null)
   ->>'versionId')::uuid;

select _c('14. axis three — it cannot be ATTACHED to a draft by id (55000)',
  _raises(format($q$select public.save_protocol_draft(%L::uuid, %L::jsonb)$q$,
    (select v from _ids where k = 'draft_version'),
    jsonb_build_object('items', jsonb_build_array(jsonb_build_object(
      'kind', 'product', 'label', 'Curcumin Complex',
      'catalogProductId',
      (select id from public.supplement_products where sku = 'AC-100'))))::text),
    '55000'));

select _c('15. the restricted row carried its declared route into the product', (
  select restricted_flags @> array['parenteral_therapy']
  from public.supplement_products where sku = 'AC-200'));

select _c('16. a row the source left blank is INCOMPLETE, not quietly complete', (
  select status = 'incomplete' from public.supplement_products where sku = 'AC-200'));

-- ==================================================== 17-20 provenance is real

select _c('17. every imported product carries a provenance record', (
  select count(*) = 2 from public.clinical_import_provenance pr
  join public.supplement_products p on p.id = pr.ref_id
  where pr.ref_type = 'supplement_product' and p.sku in ('AC-100', 'AC-200')));

select _c('18. provenance keeps the VERBATIM source cell, not just the tidy one', (
  select pr.raw_values ->> 'Product Name' = ' Curcumin Complex '
     and pr.normalized_values ->> 'name' = 'Curcumin Complex'
  from public.clinical_import_provenance pr
  join public.supplement_products p on p.id = pr.ref_id
  where pr.ref_type = 'supplement_product' and p.sku = 'AC-100'));

select _c('19. provenance names the file, sheet and line', (
  select pr.source_file_name = 'products.xlsx' and pr.source_sheet = 'Products'
     and pr.source_row_number = 1
  from public.clinical_import_provenance pr
  join public.supplement_products p on p.id = pr.ref_id
  where pr.ref_type = 'supplement_product' and p.sku = 'AC-100'));

select _c('20. provenance cannot be rewritten (42501)', _raises($q$
  update public.clinical_import_provenance set source_sheet = 'Elsewhere'
  where ref_type = 'supplement_product'
$q$, '42501'));

select _c('21. facts the source omitted are recorded as absence', (
  select pr.missing_facts @> '["serving size"]'::jsonb
  from public.clinical_import_provenance pr
  join public.supplement_products p on p.id = pr.ref_id
  where pr.ref_type = 'supplement_product' and p.sku = 'AC-200'));

-- ====================================================== 22-24 clearing a flag

select _c('22. clearing a restriction requires a stated reason (22023)',
  _raises(format($q$
    select public.clear_catalog_product_restriction(%L::uuid, '')
  $q$, (select id from public.supplement_products where sku = 'AC-200')), '22023'));

select _c('23. an unflagged product cannot be "cleared" (55000)', _raises(format($q$
  select public.clear_catalog_product_restriction(%L::uuid, 'nothing to clear')
$q$, (select id from public.supplement_products where sku = 'AC-100')), '55000'));

select public.clear_catalog_product_restriction(
  (select id from public.supplement_products where sku = 'AC-200'),
  'Reviewed against the state formulary; permitted in this jurisdiction.');

-- Clearance is not approval. The product is cleared and STILL not selectable,
-- because its review state was never completed — two independent gates, and
-- satisfying one must not silently satisfy the other.
select _c('24. clearance is attributable, and is NOT approval', (
  select p.restricted_cleared_by is not null
     and coalesce(btrim(p.restricted_clearance_note), '') <> ''
     and not private.catalog_product_is_selectable(p.id)
  from public.supplement_products p where p.sku = 'AC-200'));

-- ========================================================= 25-28 the ambiguity
--
-- A row that matches no governed identity but closely resembles a governed
-- product is neither an add nor a change. Applying it blind either duplicates a
-- product or overwrites the wrong one; both are silent, and both reach patients.

select public.preview_knowledge_import(
  'c9000000-0000-4000-8000-000000000101', 'product_spreadsheet',
  'Second operator sheet', '9c.1',
  jsonb_build_array(jsonb_build_object(
    'entityType', 'catalog_product',
    'displayName', 'Curcumin Complex',
    'payload', jsonb_build_object(
      'name', 'Curcumin Complex', 'brand', 'Acme Labs', 'sku', 'AC-999',
      'form', 'capsule'))),
  true, 'products-v2.xlsx', 2048, null);

select _c('25. a near-identical row is staged AMBIGUOUS, not added', (
  select change_kind = 'ambiguous' and status = 'skipped'
     and jsonb_array_length(candidate_matches) = 1
  from public.clinical_knowledge_import_items
  where organization_id = 'c9000000-0000-4000-8000-000000000101'
    and payload ->> 'sku' = 'AC-999'));

select _c('26. the ambiguous row names what it resembles', (
  select candidate_matches -> 0 ->> 'name' = 'Curcumin Complex'
  from public.clinical_knowledge_import_items
  where payload ->> 'sku' = 'AC-999'));

select _c('27. a commit refuses while an ambiguity is unresolved (55000)',
  _raises(format($q$select public.commit_knowledge_import(%L::uuid, null, null)$q$,
    (select id from public.clinical_knowledge_import_batches
     where source_name = 'Second operator sheet')), '55000'));

select _c('28. a reviewer cannot point the row at a product it never raised',
  _raises(format($q$
    select public.resolve_knowledge_import_ambiguity(%L::uuid, 'same_as_existing',
      'pointing at an uncompared product', %L::uuid)
  $q$,
    (select id from public.clinical_knowledge_import_items
     where payload ->> 'sku' = 'AC-999'),
    (select id from public.supplement_products where sku = 'AC-200')), '22023'));

-- ============================================= 29-31 the label-identity gate
--
-- A reviewer completes the product's review state — so it is now selectable and
-- attachable — but nobody has verified the exact label against the
-- manufacturer. That is the state this gate exists for, and it is the state a
-- busy reviewer will actually produce.

update public.supplement_products set status = 'active' where sku = 'AC-100';

select _c('29. once reviewed, the product IS selectable and attachable', (
  select private.catalog_product_is_selectable(id)
  from public.supplement_products where sku = 'AC-100'));

select public.save_protocol_draft(
  (select v from _ids where k = 'draft_version'),
  jsonb_build_object('items', jsonb_build_array(jsonb_build_object(
    'kind', 'product', 'label', 'Curcumin Complex',
    'catalogProductId',
    (select id from public.supplement_products where sku = 'AC-100')))));

-- No dosage text on the item, so the Part 9 dose-provenance gate passes and
-- what fails is unambiguously the label-identity gate.
select _c('30. approval refuses an imported product with no verified label (55000)',
  _raises(format($q$select public.approve_protocol_version(%L::uuid, 'probe')$q$,
    (select v from _ids where k = 'draft_version')), '55000'));

-- A product entered by hand was entered by someone holding the bottle. It has
-- no provenance row, so the gate does not fire — widening it would retroactively
-- invalidate protocols approved under the earlier rule.
insert into public.supplement_products(id, name, sku, status)
values ('c9000000-0000-4000-8000-000000000301', 'Hand Entered Product',
        'HAND-1', 'active');

select _c('31. a hand-entered product is untouched by the gate', (
  select private.catalog_product_is_selectable(
    'c9000000-0000-4000-8000-000000000301')
   and not exists (
    select 1 from public.clinical_import_provenance
    where ref_type = 'supplement_product'
      and ref_id = 'c9000000-0000-4000-8000-000000000301')));

-- ================================================ 32 the standing catalog rule
--
-- Restated here rather than left to the other suite: this phase ADDS a write
-- path into `supplement_products`, and the rule it must not break is that
-- nothing synthetic or unreviewed reaches the picker.

select _c('32. nothing this import created is offered by the picker', (
  select bool_and(jsonb_array_length(
    public.search_protocol_catalog('c9000000-0000-4000-8000-000000000101',
      term, 50) -> 'products') = 0)
  from unnest(array['Glutathione', 'AC-200', 'AC-999']) term));

-- ============================================== 33-35 the structural rules
--
-- The import-graph suite asserts these for the Phase 9B tables. A rule that
-- holds for one set of tables and not the next has stopped being a rule, so the
-- Phase 9C tables are held to it here.

select _c('33. every single-column FK on the new tables has a leading index', (
  select count(*) = 0 from (
    select c.conname from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    join unnest(c.conkey) as k(attnum) on true
    where c.contype = 'f' and n.nspname = 'public'
      and t.relname in ('clinical_import_source_files',
                        'clinical_import_provenance')
      and array_length(c.conkey, 1) = 1
      and not exists (select 1 from pg_index i
        where i.indrelid = c.conrelid and (i.indkey::smallint[])[0] = k.attnum)
  ) missing));

select _c('34. the new tables have RLS and no direct authenticated writes', (
  select bool_and(c.relrowsecurity)
    and not bool_or(has_table_privilege('authenticated', c.oid, 'insert'))
    and not bool_or(has_table_privilege('authenticated', c.oid, 'update'))
    and not bool_or(has_table_privilege('authenticated', c.oid, 'delete'))
  from pg_class c where c.oid in (
    'public.clinical_import_source_files'::regclass,
    'public.clinical_import_provenance'::regclass)));

select _c('35. every new RPC is security definer with an empty search_path', (
  select bool_and(p.prosecdef and 'search_path=""' = any(p.proconfig))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in
    ('record_import_source_file', 'get_import_source_inventory',
     'clear_catalog_product_restriction', 'resolve_knowledge_import_ambiguity')));

-- ================================= 36-45 the review surface (Phase 9C reads)
--
-- The safety layer refuses. A reviewer cannot act on a refusal they cannot
-- see, so these assert that the reads put the refusal, its reason and the
-- evidence on one screen — and that the one write which lifts a refusal
-- refuses in exactly the case where lifting it would be wrong.

select _c('36. the preview returns the verbatim source row beside the payload', (
  select i ->> 'sourceRaw' is not null
     and (i -> 'sourceRaw' ->> 'Product Name') = ' Curcumin Complex '
  from jsonb_array_elements(
    public.get_knowledge_import_preview(
      (select id from public.clinical_knowledge_import_batches
       where source_name = 'Operator product sheet')) -> 'items') i
  where i ->> 'displayName' = 'Curcumin Complex'));

select _c('37. the preview names the restricted flags and the missing facts', (
  select (i -> 'restrictedFlags') @> '["parenteral_therapy"]'::jsonb
     and (i -> 'missingFacts') @> '["serving size"]'::jsonb
     and length(coalesce(i ->> 'restrictedReason', '')) > 20
  from jsonb_array_elements(
    public.get_knowledge_import_preview(
      (select id from public.clinical_knowledge_import_batches
       where source_name = 'Operator product sheet')) -> 'items') i
  where i ->> 'displayName' = 'Glutathione Push'));

select _c('38. the ambiguous row carries its candidates through the preview read', (
  select jsonb_array_length(i -> 'candidateMatches') = 1
  from jsonb_array_elements(
    public.get_knowledge_import_preview(
      (select id from public.clinical_knowledge_import_batches
       where source_name = 'Second operator sheet')) -> 'items') i
  where i ->> 'changeKind' = 'ambiguous'));

-- By this point check 29 has completed AC-100's review (it is `active` with no
-- flags, so it has left the queue) and check 24 cleared AC-200's restriction
-- without completing its review. One product is still waiting, which is the
-- state the queue exists to show.
select _c('39. the review queue lists only import-derived products, with a block reason', (
  select (q -> 'counts' ->> 'total')::int = 1
     and (q -> 'products' -> 0 ->> 'sku') = 'AC-200'
     and length(coalesce(q -> 'products' -> 0 ->> 'blockReason', '')) > 20
  from public.get_catalog_review_queue('c9000000-0000-4000-8000-000000000101') q));

select _c('40. the queue''s block reason IS the attach refusal, not a paraphrase', (
  select (e ->> 'blockReason')
       = private.catalog_product_block_reason((e ->> 'productId')::uuid)
  from public.get_catalog_review_queue('c9000000-0000-4000-8000-000000000101') q,
       jsonb_array_elements(q -> 'products') e
  where e ->> 'sku' = 'AC-200'));

select _c('41. a hand-entered product never appears in the review queue', (
  select not exists (
    select 1 from public.get_catalog_review_queue(
      'c9000000-0000-4000-8000-000000000101') q,
      jsonb_array_elements(q -> 'products') e
    where e ->> 'productId' = 'c9000000-0000-4000-8000-000000000301')));

select _c('42. completing a review requires a stated reason (22023)',
  _raises(format($q$
    select public.complete_catalog_product_review(%L::uuid, '   ')
  $q$, (select id from public.supplement_products where sku = 'AC-200')), '22023'));

-- The refusal that matters most: an `incomplete` product must not become
-- selectable because someone typed a sentence. It names what the source
-- omitted rather than saying "invalid".
select _c('43. an INCOMPLETE product cannot complete its review (55000)',
  _raises(format($q$
    select public.complete_catalog_product_review(%L::uuid, 'looks fine')
  $q$, (select id from public.supplement_products where sku = 'AC-200')), '55000'));

select _c('44. provenance is readable, and reports itself as immutable', (
  select (p ->> 'immutable')::boolean
     and (p ->> 'total')::int = 2
     and (select bool_and(length(coalesce(r ->> 'sourceFileName', '')) > 0)
          from jsonb_array_elements(p -> 'records') r)
  from public.get_import_provenance('c9000000-0000-4000-8000-000000000101') p));

select _c('45. an outsider can read none of the Phase 9C review surface', (
  select _raises($q$
    select public.get_catalog_review_queue('00000000-0000-4000-8000-0000000000ff')
  $q$, '42501')
     and _raises($q$
    select public.get_import_provenance('00000000-0000-4000-8000-0000000000ff')
  $q$, '42501')
     and _raises($q$
    select public.get_import_source_inventory('00000000-0000-4000-8000-0000000000ff')
  $q$, '42501')));

-- ---------------------------------------------------------------- results

select count(*) filter (where ok) as passed,
       count(*) filter (where ok is false) as failed,
       count(*) filter (where ok is null) as never_evaluated,
       count(*) as total,
       coalesce(string_agg(n, ' | ') filter (where ok is not true), '(none)')
         as problems
from _r;

rollback;
