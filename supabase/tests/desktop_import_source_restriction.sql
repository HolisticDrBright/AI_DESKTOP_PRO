-- Acceptance: source-level restriction propagation and commercial-only routing.
--
-- Rolled back at the end; the project is unchanged after the final statement.
--
-- WHY THIS SUITE EXISTS. Phase 9D put real practitioner material through the
-- pipeline for the first time. A local driver classified 500 rows as
-- restricted-for-clinician-review across eight files — 365 from a
-- vaccine-related workbook, 103 from a peptide-program document, and 32 more
-- from row-level text signals in the other six files. The preview RPC, given
-- the same items, classified 49. The gap was a boundary defect: source-level
-- restriction metadata carried in the operator's manifest and per-row text
-- signals broader than the RPC's own vocabulary did not survive
--   parser envelope → preview RPC → item review state.
--
-- This suite asserts the fix structurally, at the layer that decides whether a
-- restricted item can become selectable:
--
--   * A caller may declare a source restricted-by-default. Every item in the
--     batch acquires that flag AND that reason, regardless of its own name.
--   * Text classification may ADD `suspected_restricted`. It may never
--     remove a declared flag, and it may never downgrade a declared class.
--   * A caller may declare a source commercial-only. On commit, the apply
--     path refuses to write clinical fields for such a batch. The clinical
--     catalog, reasoning, safety, evidence, and protocol functions do not
--     read any commercial table; this is asserted on function bodies, not on
--     runtime results, because with an empty commercial table an output-only
--     check passes while proving nothing.
--   * A batch tracks its `deferred_count` separately from `restricted_count`.
--     A reviewer sees deferred and restricted as two different queues.

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
  ('9d000000-0000-4000-8000-000000000001', 'p9d-restrict@verify.local');
insert into public.organizations(id, name, slug) values
  ('9d000000-0000-4000-8000-000000000101', 'Restriction Org', 'p9d-restrict');
insert into public.organization_memberships(organization_id, user_id, role, status)
values ('9d000000-0000-4000-8000-000000000101',
        '9d000000-0000-4000-8000-000000000001', 'owner', 'active');

select set_config('request.jwt.claims',
  '{"sub":"9d000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- ============================================ 1-6 source-level restriction

-- A source declared restricted-by-default marks every item in its batch.
-- The reason is preserved on every item, so the reviewer can see WHY the
-- flag is there — the reason is per-source, not per-row.
select public.preview_knowledge_import(
  '9d000000-0000-4000-8000-000000000101'::uuid, 'product_spreadsheet',
  'Vaccine-related workbook', '9d.1',
  jsonb_build_array(
    jsonb_build_object(
      'entityType', 'knowledge_reference',
      'displayName', 'Mitochondrial Support (Nutrient / Cofactor)',
      'payload', jsonb_build_object(
        'code', 'src-src-v-mito',
        'title', 'Mitochondrial Support (Nutrient / Cofactor)',
        'referenceType', 'practitioner_document_table_row',
        'subjectLabel', 'CoQ10',
        'mechanism', 'ETC Complex I/III support',
        'suggestedDose', '200-400 mg/day')),
    jsonb_build_object(
      'entityType', 'knowledge_reference',
      'displayName', 'Endothelial Support (Nutrient / Cofactor)',
      'payload', jsonb_build_object(
        'code', 'src-src-v-endo',
        'title', 'Endothelial Support (Nutrient / Cofactor)',
        'referenceType', 'practitioner_document_table_row',
        'subjectLabel', 'L-Arginine',
        'mechanism', 'NO substrate',
        'suggestedDose', '2-6 g/day'))),
  true, 'vaccine-workbook.xlsx', 4096, null,
  array['vaccine_related']::text[],
  'vaccine-related material — every item in this workbook requires clinician review before use',
  false);

select _c('1. source-level restriction applies to every item in the batch', (
  select count(*) = 2 and bool_and('vaccine_related' = any(restricted_flags))
  from public.clinical_knowledge_import_items i
  join public.clinical_knowledge_import_batches b on b.id = i.batch_id
  where b.organization_id = '9d000000-0000-4000-8000-000000000101'
    and b.source_name = 'Vaccine-related workbook'));

select _c('2. source-level restriction carries its reason to every item', (
  select count(*) = 2
  from public.clinical_knowledge_import_items i
  join public.clinical_knowledge_import_batches b on b.id = i.batch_id
  where b.source_name = 'Vaccine-related workbook'
    and i.restricted_reason ilike '%clinician review%'));

select _c('3. source-level restriction is counted in the batch summary', (
  select restricted_count = 2 and source_restricted_flags = array['vaccine_related']::text[]
  from public.clinical_knowledge_import_batches
  where source_name = 'Vaccine-related workbook'));

-- Text signals on items in this batch ADD suspected_restricted (per Phase 9C's
-- inference boundary). Adding cannot remove the declared source flag.
select public.preview_knowledge_import(
  '9d000000-0000-4000-8000-000000000101'::uuid, 'protocol_document',
  'Peptide program document', '9d.1',
  jsonb_build_array(
    jsonb_build_object(
      'entityType', 'knowledge_reference',
      'displayName', 'Peptide protocols for cognitive support',
      'payload', jsonb_build_object(
        'code', 'src-p-cog',
        'title', 'Peptide protocols for cognitive support',
        'referenceType', 'practitioner_document'))),
  true, 'peptide-program.docx', 2048, null,
  array['peptide']::text[],
  'peptide-program material — every item requires clinician review',
  false);

select _c('4. text-scanned suspected_restricted is ADDED, not replaced', (
  select restricted_flags @> array['peptide', 'suspected_restricted']::text[]
  from public.clinical_knowledge_import_items i
  join public.clinical_knowledge_import_batches b on b.id = i.batch_id
  where b.source_name = 'Peptide program document'));

-- Item-level `restrictedFlags` in the payload continues to work as before,
-- and text signals add — they do not remove.
select public.preview_knowledge_import(
  '9d000000-0000-4000-8000-000000000101'::uuid, 'product_spreadsheet',
  'Mixed sheet', '9d.1',
  jsonb_build_array(
    jsonb_build_object(
      'entityType', 'catalog_product',
      'displayName', 'Prescribed peptide (declared)',
      'payload', jsonb_build_object(
        'name', 'Recovery Formula',
        'brand', 'Acme',
        'sku', 'MIX-1',
        'regulatoryClassification', 'peptide'))),
  true, 'mixed.xlsx', 1024, null,
  null::text[], null, false);

select _c('5. declared class survives a benign-looking name (no text-signal downgrade)', (
  select restricted_flags @> array['peptide']::text[]
     and not ('suspected_restricted' = any(restricted_flags))
  from public.clinical_knowledge_import_items i
  join public.clinical_knowledge_import_batches b on b.id = i.batch_id
  where b.source_name = 'Mixed sheet'
    and (payload ->> 'sku') = 'MIX-1'));

-- ============================================================== 6-8 deferred

-- An item that carries `warnings` counts as DEFERRED. Deferred and restricted
-- are distinct concepts: a deferred item is one the reviewer must read
-- carefully; a restricted item requires clinician sign-off.
select public.preview_knowledge_import(
  '9d000000-0000-4000-8000-000000000101'::uuid, 'product_spreadsheet',
  'Deferred-warnings sheet', '9d.1',
  jsonb_build_array(
    jsonb_build_object(
      'entityType', 'knowledge_reference',
      'displayName', 'Dose text preserved as reference',
      'payload', jsonb_build_object(
        'code', 'src-def-1',
        'title', 'Dose text preserved as reference',
        'referenceType', 'practitioner_reference_row',
        'suggestedDose', '200-400 mg/day'),
      'warnings', jsonb_build_array(
        'Suggested-dose text preserved as reference metadata.')),
    jsonb_build_object(
      'entityType', 'knowledge_reference',
      'displayName', 'Clean reference',
      'payload', jsonb_build_object(
        'code', 'src-def-2', 'title', 'Clean reference',
        'referenceType', 'practitioner_reference_row'))),
  true, 'deferred.xlsx', 512, null, null::text[], null, false);

select _c('6. an item with warnings is counted in deferred_count on the batch', (
  select deferred_count = 1 and restricted_count = 0
  from public.clinical_knowledge_import_batches
  where source_name = 'Deferred-warnings sheet'));

select _c('7. an item warning is preserved on the row', (
  select warnings::text like '%reference metadata%'
  from public.clinical_knowledge_import_items i
  join public.clinical_knowledge_import_batches b on b.id = i.batch_id
  where b.source_name = 'Deferred-warnings sheet'
    and (payload ->> 'code') = 'src-def-1'));

-- Deferred is not restricted; commit is not blocked by a deferred item.
-- Applyable rows carry status 'needs_review'; only conflict/unchanged/ambiguous
-- are staged as 'skipped'. A warnings entry alone does not skip the item.
select _c('8. deferred item is applyable (needs_review, no restricted flag)', (
  select i.status = 'needs_review' and i.restricted_flags = '{}'
  from public.clinical_knowledge_import_items i
  join public.clinical_knowledge_import_batches b on b.id = i.batch_id
  where b.source_name = 'Deferred-warnings sheet'
    and (i.payload ->> 'code') = 'src-def-1'));

-- ================================================== 9-13 commercial-only

-- A caller may declare a source `commercial_only=true`. On commit, the
-- apply path refuses to write clinical fields — no new supplement_products
-- row is created, and any incoming URL does not enter a clinical field.
select public.preview_knowledge_import(
  '9d000000-0000-4000-8000-000000000101'::uuid, 'affiliate_sheet',
  'Affiliate links', '9d.1',
  jsonb_build_array(
    jsonb_build_object(
      'entityType', 'catalog_product',
      'displayName', 'Ignite +',
      'payload', jsonb_build_object(
        'name', 'Ignite +',
        'brand', 'Healthgevity',
        'sourceUrl', 'https://healthgev.example/products/ignite',
        'discountCode', 'PROMO10'))),
  true, 'affiliate-links.xlsx', 1024, null,
  null::text[], null, true);

select _c('9. a commercial_only batch records that flag on the batch row', (
  select commercial_only = true
  from public.clinical_knowledge_import_batches
  where source_name = 'Affiliate links'));

-- Commit REFUSES a commercial-only batch outright. Its rows must be attached
-- to existing clinical products through the commercial-links path
-- (save_product_label_version), never routed through the clinical apply
-- path where a URL would land as `supplement_products.source_url`.
select _c('10. commit of a commercial_only batch is REFUSED (55000)',
  _raises(format($q$
    select public.commit_knowledge_import(%L::uuid, null, 'commercial commit probe')
  $q$, (select id from public.clinical_knowledge_import_batches
        where source_name = 'Affiliate links')), '55000'));

-- No clinical read/reason/safety/rank function reads a commercial table. A
-- runtime output-only assertion passes trivially with an empty commercial
-- table; this assertion is on the function BODY.
-- `get_product_catalog` deliberately COUNTS commercial links for the
-- governance UI ("3 commercial links recorded"); it never reads their
-- content, and it never influences eligibility/safety/ranking/evidence.
-- The list below matches `desktop_knowledge_import_graph.sql` check 7 so
-- the two suites police the same boundary in the same way.
select _c('11. no clinical eligibility/safety/ranking/evidence function reads a commercial table', (
  select count(*) = 0
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private')
    and p.proname in ('evaluate_protocol_safety', 'check_protocol_interactions',
      'review_protocol_item_interactions', 'search_protocol_catalog',
      'protocol_version_json', 'current_reference_status',
      'catalog_verification_status', 'get_patient_protocol')
    and p.prosrc ~ '(product_label_commercial_links|protocol_commercial_links|public\.product_commercial_links)'));

-- commit_knowledge_import must know about commercial_only; that awareness
-- is what routes commercial batches away from the clinical apply path.
select _c('12. commit_knowledge_import checks commercial_only on the batch', (
  select p.prosrc ~ 'commercial_only'
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'commit_knowledge_import'));

-- Restated: a restricted item can never become selectable. This is the whole
-- point of routing an item into restricted_review — if the axis was slipping,
-- a restricted product would end up in the picker.
insert into public.supplement_products(id, name, sku, status, restricted_flags)
values ('9d000000-0000-4000-8000-000000000301', 'Restricted probe', 'RP-1', 'active',
        array['vaccine_related']);

select _c('13. an active product with a restricted flag is NOT selectable', (
  select not private.catalog_product_is_selectable('9d000000-0000-4000-8000-000000000301'::uuid)));

-- ================================== 14-20 aggregate + monotonic invariants
--
-- The user's spec adds accounting invariants that must hold end-to-end:
--   * received = added + changed + unchanged + conflict + ambiguous + removals
--   * conflicted items REMAIN candidates and REMAIN restricted
--   * restrictions from any layer (client-declared, source-level, server text)
--     compose via UNION — no layer can suppress an earlier layer's finding
--   * parser-deferred warnings survive under item identity and are counted
--     separately from missing-facts / conflict / restriction

-- Fixture batch: 5 items, one restricted on client-declared flags,
-- one already conflicting on identity, one carrying a parser warning,
-- one with a suspected-name text signal, one clean.
select public.preview_knowledge_import(
  '9d000000-0000-4000-8000-000000000101'::uuid, 'product_spreadsheet',
  'Invariants sheet', '9d.1',
  jsonb_build_array(
    -- 1: client-declared restrictedFlags (via payload.restrictedFlags)
    jsonb_build_object('entityType', 'catalog_product', 'displayName', 'Injected client flag',
      'payload', jsonb_build_object('name', 'Injected client flag', 'brand', 'X', 'sku', 'INV-1',
        'restrictedFlags', jsonb_build_array('suspected_restricted'))),
    -- 2: conflict — same dedupe key as #3
    jsonb_build_object('entityType', 'catalog_product', 'displayName', 'Duplicate first',
      'payload', jsonb_build_object('name', 'Duplicate identity', 'brand', 'X', 'sku', 'INV-DUP',
        'regulatoryClassification', 'peptide')),
    -- 3: conflict pair with #2 — SAME sku, DIFFERENT name; must also be restricted
    jsonb_build_object('entityType', 'catalog_product', 'displayName', 'Duplicate second',
      'payload', jsonb_build_object('name', 'Duplicate identity alt', 'brand', 'X', 'sku', 'INV-DUP',
        'regulatoryClassification', 'peptide')),
    -- 4: parser-deferred warning
    jsonb_build_object('entityType', 'knowledge_reference', 'displayName', 'Warning row',
      'payload', jsonb_build_object('code', 'inv-warn', 'title', 'Warning row', 'referenceType', 'row'),
      'warnings', jsonb_build_array('Suggested-dose text preserved as reference metadata.')),
    -- 5: clean
    jsonb_build_object('entityType', 'catalog_product', 'displayName', 'Clean row',
      'payload', jsonb_build_object('name', 'Clean row', 'brand', 'X', 'sku', 'INV-CLEAN'))),
  true, 'invariants.xlsx', 1024, null,
  array['peptide']::text[],
  'source declared restricted-by-default (peptide program probe)',
  false);

select _c('14. received = added + changed + unchanged + conflict + ambiguous', (
  select item_count = (added_count + changed_count + unchanged_count + conflict_count + ambiguous_count)
  from public.clinical_knowledge_import_batches
  where source_name = 'Invariants sheet'));

select _c('15. total items row-count matches item_count', (
  select b.item_count = (select count(*) from public.clinical_knowledge_import_items i where i.batch_id = b.id)
  from public.clinical_knowledge_import_batches b
  where b.source_name = 'Invariants sheet'));

-- Conflicted items remain items with restrictions. If a downstream layer
-- silently drops a conflict from restricted-count, the count breaks.
select _c('16. conflicted items retain their restricted_flags (source-level union)', (
  select bool_and('peptide' = any(i.restricted_flags))
  from public.clinical_knowledge_import_items i
  join public.clinical_knowledge_import_batches b on b.id = i.batch_id
  where b.source_name = 'Invariants sheet'
    and i.change_kind = 'conflict'));

-- Monotonic union: client-declared flags + declared regulatoryClassification +
-- source-level flag + text scan hits — nothing suppresses anything.
select _c('17. client-declared restrictedFlags survive to the item row', (
  select i.restricted_flags @> array['suspected_restricted', 'peptide']::text[]
  from public.clinical_knowledge_import_items i
  join public.clinical_knowledge_import_batches b on b.id = i.batch_id
  where b.source_name = 'Invariants sheet'
    and (i.payload ->> 'sku') = 'INV-1'));

-- restricted_count on the batch must count every distinct restricted item,
-- INCLUDING those with change_kind='conflict'. If the counter skipped
-- conflicts, this test would fail.
select _c('18. batch restricted_count includes conflicted items', (
  select restricted_count = (
    select count(*) from public.clinical_knowledge_import_items i
    where i.batch_id = b.id and i.restricted_flags <> '{}')
  from public.clinical_knowledge_import_batches b
  where b.source_name = 'Invariants sheet'));

-- Parser-deferred: warnings survive item identity intact.
select _c('19. parser-deferred warning survives on the row it started on', (
  select jsonb_array_length(i.warnings) = 1
     and i.warnings::text ilike '%reference metadata%'
  from public.clinical_knowledge_import_items i
  join public.clinical_knowledge_import_batches b on b.id = i.batch_id
  where b.source_name = 'Invariants sheet'
    and (i.payload ->> 'code') = 'inv-warn'));

-- deferred_count is DISTINCT from restricted_count and missing_facts. The
-- batch above has exactly one warning-bearing item.
select _c('20. batch deferred_count counts warning-bearing items only', (
  select deferred_count = (
    select count(*) from public.clinical_knowledge_import_items i
    where i.batch_id = b.id and jsonb_array_length(i.warnings) > 0)
  from public.clinical_knowledge_import_batches b
  where b.source_name = 'Invariants sheet'));

-- ---------------------------------------------------------------- results

select count(*) filter (where ok) as passed,
       count(*) filter (where ok is false) as failed,
       count(*) filter (where ok is null) as never_evaluated,
       count(*) as total,
       coalesce(string_agg(n, ' | ') filter (where ok is not true), '(none)')
         as problems
from _r;

rollback;
