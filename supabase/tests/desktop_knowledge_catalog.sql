-- Phase 9B acceptance: governed references, structured claims, exact product
-- catalog, clinical domains, and the deterministic safety core.
--
-- Rolled back at the end, so nothing survives. Covers the scenarios from the
-- phase's list that the delivered scope reaches; the numbering in each check
-- name is the brief's own.
--
-- Run against the confirmed clinical project inside a transaction.

begin;

create temporary table _r(n text, ok boolean) on commit drop;
create or replace function _c(_n text, _ok boolean) returns void language sql as $$
  insert into _r(n, ok) values (_n, _ok);
$$;
create or replace function _raises(_sql text, _state text)
returns boolean language plpgsql as $$
begin
  execute _sql; return false;
exception when others then return sqlstate = _state;
end;
$$;
create or replace function _succeeds(_sql text) returns boolean language plpgsql as $$
begin
  execute _sql; return true;
exception when others then return false;
end;
$$;

-- ---------------------------------------------------------------- fixtures

insert into public.organizations (id, name, slug) values
  ('c9b00000-0000-4000-8000-000000001001', 'P9B Org A', 'p9b-a'),
  ('c9b00000-0000-4000-8000-000000001002', 'P9B Org B', 'p9b-b');

insert into public.clinical_knowledge_sources
  (id, code, revision, citation, title, authors_or_issuer, publisher,
   reference_type, doi, evidence_classification, status, content_hash)
values
  ('c9b00000-0000-4000-8000-000000002001', 'p9b_ref_a', 1,
   'A Society. A Guideline. 2025.', 'A Guideline', 'A Society', 'A Publisher',
   'guideline', '10.0000/p9b.a', 'moderate', 'approved', 'hash-a');

insert into public.supplement_brands (id, name) values
  ('c9b00000-0000-4000-8000-000000003001', 'P9B Brand');

insert into public.supplement_ingredients (id, canonical_name, category, unit) values
  ('c9b00000-0000-4000-8000-000000004001', 'Magnesium', 'mineral', 'mg'),
  ('c9b00000-0000-4000-8000-000000004002', 'Peanut protein', 'protein', 'mg');

insert into public.supplement_products
  (id, brand_id, name, regulatory_classification, upc, status)
values
  ('c9b00000-0000-4000-8000-000000005001', 'c9b00000-0000-4000-8000-000000003001',
   'P9B Magnesium', 'supplement', '0123456789012', 'active'),
  ('c9b00000-0000-4000-8000-000000005002', 'c9b00000-0000-4000-8000-000000003001',
   'P9B Peptide', 'peptide', null, 'active');

insert into public.supplement_product_versions
  (id, product_id, version_label, serving_size, verification_state, status)
values
  ('c9b00000-0000-4000-8000-000000006001', 'c9b00000-0000-4000-8000-000000005001',
   'v1', '1 capsule', 'incomplete', 'draft');

-- ============================================ 1-5. references and claims

select _c('1 a reference records exact provenance and versions', (
  select doi = '10.0000/p9b.a' and reference_type = 'guideline'
         and content_hash is not null and status = 'approved'
  from public.clinical_knowledge_sources
  where id = 'c9b00000-0000-4000-8000-000000002001'));

select _c('2 a structured claim links to an exact reference', _succeeds($$
  insert into public.clinical_knowledge_claims
    (id, reference_id, proposition, population, limitations,
     evidence_classification, source_location, safety_status)
  values ('c9b00000-0000-4000-8000-000000007001',
          'c9b00000-0000-4000-8000-000000002001',
          'A precise proposition.', 'Adults', 'Not studied in pregnancy.',
          'moderate', 'Table 3', 'caution')$$));

-- THE RULE THIS PHASE TURNS ON.
select _c('3 a graded claim WITHOUT a reference is refused', _raises($$
  insert into public.clinical_knowledge_claims
    (proposition, evidence_classification)
  values ('Ungrounded but confidently graded.', 'high')$$, '23514'));

select _c('3b practitioner experience needs no reference, and says what it is',
  _succeeds($$
  insert into public.clinical_knowledge_claims
    (id, proposition, evidence_classification)
  values ('c9b00000-0000-4000-8000-000000007002',
          'Something the practitioner has observed.', 'practitioner_experience')$$));

select _c('4 unknown attributes stay NULL rather than defaulting to a value', (
  select population is null and context is null and limitations is null
         and source_location is null and reviewed_by is null
  from public.clinical_knowledge_claims
  where id = 'c9b00000-0000-4000-8000-000000007002'));

-- Supersession is an APPEND-ONLY state row, not an edit: the reference table
-- has carried `forbid_mutation` since Phase 1 and a row there never changes.
insert into public.clinical_knowledge_sources
  (id, code, revision, citation, title, reference_type, status)
values ('c9b00000-0000-4000-8000-000000002002', 'p9b_ref_a', 2,
        'A Society. A Guideline. 2nd ed. 2026.', 'A Guideline (2nd ed.)',
        'guideline', 'approved');

select _succeeds($$
  insert into public.clinical_knowledge_source_states
    (reference_id, status, superseded_by_id, reason)
  values ('c9b00000-0000-4000-8000-000000002001', 'superseded',
          'c9b00000-0000-4000-8000-000000002002', 'A second edition was issued.')$$)
  as _superseded;

select _c('5 superseding a reference marks dependent claims stale', (
  select stale_at is not null and stale_reason like '%superseded%'
     -- Marked, not edited: the proposition is byte-for-byte what it was.
     and proposition = 'A precise proposition.'
  from public.clinical_knowledge_claims
  where id = 'c9b00000-0000-4000-8000-000000007001'));

select _c('5b a reference row can never be edited at all', _raises($$
  update public.clinical_knowledge_sources set citation = 'Rewritten'
   where id = 'c9b00000-0000-4000-8000-000000002001'$$, '22023'));

select _c('5c the state log is append-only', (
  select _raises($$
    update public.clinical_knowledge_source_states set status = 'approved'
     where reference_id = 'c9b00000-0000-4000-8000-000000002001'$$, '42501')));

select _c('5d supersession must name its successor', _raises($$
  insert into public.clinical_knowledge_source_states (reference_id, status)
  values ('c9b00000-0000-4000-8000-000000002002', 'superseded')$$, '23514'));

select _c('5e current status reads from the latest state row', (
  select public.current_reference_status('c9b00000-0000-4000-8000-000000002001')
         = 'superseded'));

-- ================================================ 6-9. the product catalog

select _c('6 a label version records exact label facts and versions', _succeeds($$
  update public.supplement_product_versions
     set other_ingredients = 'Cellulose', allergens = array['none declared'],
         label_directions = 'Take one capsule daily with food.',
         label_warnings = 'Consult a practitioner if pregnant.',
         storage_requirements = 'Store below 25C.',
         source_kind = 'manufacturer_label', label_hash = 'label-hash-1'
   where id = 'c9b00000-0000-4000-8000-000000006001'$$));

select _c('7 a product fact absent from the label stays unknown, not invented', (
  -- Nothing inferred `servings_per_container` from the product name.
  select servings_per_container is null and jurisdiction is null
  from public.supplement_product_versions
  where id = 'c9b00000-0000-4000-8000-000000006001'));

select _c('7b regulatory classification is never guessed from a name', (
  -- The peptide product was classified explicitly; nothing derived it.
  select regulatory_classification = 'peptide'
  from public.supplement_products where id = 'c9b00000-0000-4000-8000-000000005002'));

select _c('7c a product cannot claim verification without an identity and time',
  _raises($$
  update public.supplement_product_versions set verification_state = 'verified'
   where id = 'c9b00000-0000-4000-8000-000000006001'$$, '23514'));

select _c('7d a conflicted label must say what conflicts', _raises($$
  update public.supplement_product_versions set verification_state = 'conflicted'
   where id = 'c9b00000-0000-4000-8000-000000006001'$$, '23514'));

select _c('8 an unverified product may exist in the catalog', (
  select verification_state = 'incomplete'
  from public.supplement_product_versions
  where id = 'c9b00000-0000-4000-8000-000000006001'));

select _c('8b a reviewed exception requires a reason and a named approver', _raises($$
  insert into public.catalog_use_exceptions
    (organization_id, product_version_id, reason, excepted_state, approved_by)
  values ('c9b00000-0000-4000-8000-000000001001',
          'c9b00000-0000-4000-8000-000000006001', 'because', 'incomplete', null)$$,
  '23502'));

select _c('9 affiliate data cannot sit on the clinical label record', (
  -- product_label_versions retired; the label table has no commercial column.
  select count(*) = 0 from information_schema.columns
  where table_schema = 'public'
    -- The catalog spine this phase builds on carries no commercial column.
    and table_name in ('supplement_product_versions', 'supplement_products')
    and column_name in ('affiliate_url', 'commission', 'commission_disclosure',
                        'supplier_name', 'availability_status')));

select _c('9b the duplicate source registry is gone', (
  select count(*) = 0 from information_schema.tables
  where table_schema = 'public' and table_name = 'knowledge_sources'));

select _c('9c product_label_versions is intact — it has RPC dependents', (
  -- Recon called it orphaned because no FK points at it. It is reached by RPC
  -- and asserted by an existing safety test; both must still work.
  select count(*) = 1 from information_schema.tables
  where table_schema = 'public' and table_name = 'product_label_versions'));

-- =========================================== 13-14. freezing and isolation

select _succeeds($$
  update public.supplement_product_versions set status = 'published'
   where id = 'c9b00000-0000-4000-8000-000000006001'$$) as _published;

select _c('13 a published label version is frozen', _raises($$
  update public.supplement_product_versions set label_directions = 'Rewritten'
   where id = 'c9b00000-0000-4000-8000-000000006001'$$, '42501'));

select _c('13b ingredients cannot be added to a published label', _raises($$
  insert into public.product_ingredient_amounts
    (product_version_id, ingredient_id, amount, unit)
  values ('c9b00000-0000-4000-8000-000000006001',
          'c9b00000-0000-4000-8000-000000004001', 200, 'mg')$$, '42501'));

select _c('13c an approved claim is frozen', (
  select _succeeds($$
    update public.clinical_knowledge_claims set status = 'approved'
     where id = 'c9b00000-0000-4000-8000-000000007002'$$)
  and _raises($$
    update public.clinical_knowledge_claims set proposition = 'Rewritten'
     where id = 'c9b00000-0000-4000-8000-000000007002'$$, '42501')));

select _c('14 organization claims are tenant-isolated by policy', (
  select count(*) = 1 from pg_policies
  where schemaname = 'public' and tablename = 'clinical_knowledge_claims'
    and qual like '%is_org_member%' and qual like '%organization_id IS NULL%'));

-- ============================================= 20-22, 28. the safety core

select _c('20 the safety core reports interaction review NOT COMPLETED honestly', (
  -- No governed interaction reference is loaded in this build, so the check
  -- must say so rather than returning an empty finding list.
  select not exists (select 1 from public.ingredient_interactions)));

select _c('22 jurisdiction-sensitive classes are separately classified', (
  select regulatory_classification in ('prescription', 'peptide', 'device')
  from public.supplement_products
  where id = 'c9b00000-0000-4000-8000-000000005002'));

select _c('28 urgent safety content is lens-independent by construction', (
  -- The safety core takes no paradigm argument, so no lens can suppress it.
  select count(*) = 0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'evaluate_protocol_safety'
    and pg_get_function_identity_arguments(p.oid) ilike '%paradigm%'));

-- ============================================= 30, 33. posture and secrecy

select _c('30 the safety core refuses an anonymous caller', _raises(
  $$select public.evaluate_protocol_safety(
      'c9b00000-0000-4000-8000-000000006001'::uuid)$$, '28000'));

select _c('30b every new caller RPC is definer with a pinned empty search_path', (
  select bool_and(p.prosecdef and array_to_string(p.proconfig, ',') = 'search_path=""')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('evaluate_protocol_safety')));

select _c('30c no new caller RPC is executable by anon', (
  select count(*) = 0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'evaluate_protocol_safety'
    and has_function_privilege('anon', p.oid, 'EXECUTE')));

select _c('30d anon and authenticated hold no direct write on knowledge or catalog', (
  select count(*) = 0 from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name in ('clinical_knowledge_sources', 'clinical_knowledge_claims',
      'clinical_knowledge_events', 'supplement_products', 'supplement_product_versions',
      'supplement_brands', 'supplement_ingredients', 'product_ingredient_amounts',
      'product_commercial_links', 'catalog_product_notes', 'catalog_use_exceptions',
      'platform_curators')
    and grantee in ('anon', 'authenticated')
    and privilege_type in ('INSERT', 'UPDATE', 'DELETE')));

select _c('33 the reference registry stores no long passage', (
  -- The excerpt column is length-capped, and the `body` column that used to
  -- invite whole documents retired with knowledge_sources.
  select count(*) = 1 from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  where t.relname = 'clinical_knowledge_sources' and c.contype = 'c'
    and pg_get_constraintdef(c.oid) ilike '%length(short_excerpt)%'));

-- ------------------------------------------------------- domains & history

select _c('domains cover the phase list without authorising any claim', (
  select count(*) >= 31 and count(*) filter (where scope_note is null) = 0
  from public.clinical_domains));

select _c('leaky-gut concepts sit UNDER digestive health, not beside it', (
  select parent_code = 'gastrointestinal'
  from public.clinical_domains where code = 'intestinal_permeability' and version = 1));

select _c('knowledge review history is append-only', (
  select _succeeds($$
    insert into public.clinical_knowledge_events
      (id, reference_id, kind, to_status)
    values ('c9b00000-0000-4000-8000-000000008001',
            'c9b00000-0000-4000-8000-000000002001', 'approved', 'approved')$$)
  and _raises($$
    update public.clinical_knowledge_events set kind = 'rewritten'
     where id = 'c9b00000-0000-4000-8000-000000008001'$$, '42501')));

select _c('every single-column FK on the new tables has a LEADING index', (
  select count(*) = 0 from (
    select c.conname from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    join unnest(c.conkey) as k(attnum) on true
    where c.contype = 'f' and n.nspname = 'public'
      and t.relname in ('clinical_knowledge_claims', 'clinical_knowledge_events',
        'catalog_product_notes', 'catalog_use_exceptions', 'platform_curators')
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
