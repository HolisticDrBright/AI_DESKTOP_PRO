-- Phase 9B Part 9 acceptance: the protocol knowledge extension.
--
-- Rolled back at the end; the project is unchanged after the final statement.
--
-- What this proves, in the order it matters:
--   * exact product identity is FROZEN onto the item from the catalog row, and
--     cannot be supplied by the caller;
--   * monitoring requirements, stopping rules and contraindications are
--     SNAPSHOTTED from the governed intervention class — later edits to that
--     class do not rewrite protocols already approved against it;
--   * an item with no governed class gets EMPTY, not invented, governance;
--   * a dose with no recorded source blocks APPROVAL and names the item;
--   * a governed source moving MARKS the protocol stale and never edits it;
--   * re-review is recorded without erasing the fact that the ground moved;
--   * `get_protocol_knowledge` reads no commercial table;
--   * a revision carries the snapshot forward rather than silently losing it.
--
-- The staleness checks deliberately read the protocol's own text back after
-- the cascade. A test that only asserted the flag was set would pass even if
-- the cascade had rewritten the protocol, which is the failure this design
-- exists to prevent.
--
-- CALLER IDENTITY is set through `request.jwt.claims` alone, without switching
-- into the `authenticated` DB role. Every RPC here is SECURITY DEFINER and
-- authorizes on `auth.uid()` and org membership, so the claim is what actually
-- decides the outcome; the DB role only controls direct table access, which
-- `authenticated` deliberately does not have. Switching roles would therefore
-- change nothing about what is being tested while making the assertions unable
-- to read ground truth. The role's lack of privilege is asserted directly in
-- checks 2 and 4 instead of being relied on implicitly.

begin;

create temp table _r(n text, ok boolean) on commit drop;
create temp table _k(k text primary key, v uuid) on commit drop;

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
-- Parameter deliberately NOT named `_k`: that is the table's name, and the
-- parameter would win, turning `where k = _k` into `where k = k`.
create or replace function _id(_key text) returns uuid language sql stable as $fn$
  select v from _k where k = _key;
$fn$;
/** True when running `_sql` fails with a message containing `_needle`. */
create or replace function _raises_msg(_sql text, _needle text)
returns boolean language plpgsql as $fn$
begin
  execute _sql; return false;
exception when others then return position(_needle in sqlerrm) > 0;
end;
$fn$;

-- ---------------------------------------------------------------- fixtures

insert into auth.users(id, email) values
  ('e9000000-0000-4000-8000-000000000001', 'p9-prescriber@verify.local'),
  ('e9000000-0000-4000-8000-000000000002', 'p9-outsider@verify.local');

insert into public.organizations(id, name, slug) values
  ('e9000000-0000-4000-8000-000000000101', 'Knowledge Org', 'p9-knowledge'),
  ('e9000000-0000-4000-8000-000000000102', 'Other Org', 'p9-knowledge-other');

insert into public.organization_memberships(organization_id, user_id, role, status) values
  ('e9000000-0000-4000-8000-000000000101',
   'e9000000-0000-4000-8000-000000000001', 'practitioner', 'active'),
  ('e9000000-0000-4000-8000-000000000102',
   'e9000000-0000-4000-8000-000000000002', 'practitioner', 'active');

insert into public.patient_profiles(id, organization_id, first_name, last_name) values
  ('e9000000-0000-4000-8000-000000000201',
   'e9000000-0000-4000-8000-000000000101', 'Knowledge', 'Patient');

insert into public.practitioner_patient_relationships
  (organization_id, practitioner_user_id, patient_id, status) values
  ('e9000000-0000-4000-8000-000000000101',
   'e9000000-0000-4000-8000-000000000001',
   'e9000000-0000-4000-8000-000000000201', 'active');

-- An exact product with a captured label. SKU/UPC live on the product; the
-- label hash and capture time live on the version.
insert into public.supplement_brands(id, name) values
  ('e9000000-0000-4000-8000-000000000301', 'Verified Labs');
insert into public.supplement_products(id, brand_id, name, form, sku, upc) values
  ('e9000000-0000-4000-8000-000000000302', 'e9000000-0000-4000-8000-000000000301',
   'Magnesium Glycinate', 'capsule', 'VL-MAG-120', '012345678905');
-- `verified` requires a named verifier and a time: the schema refuses a
-- product that claims verification nobody performed.
insert into public.supplement_product_versions
  (id, product_id, version_label, serving_size, label_hash, label_captured_at,
   verification_state, verified_at, verified_by, source_kind)
values
  ('e9000000-0000-4000-8000-000000000303', 'e9000000-0000-4000-8000-000000000302',
   'Rev A', '2 capsules', 'sha256-label-rev-a', '2026-06-01T00:00:00Z',
   'verified', '2026-06-02T00:00:00Z', 'e9000000-0000-4000-8000-000000000001',
   'manufacturer_label');

-- A governed reference, and a platform-governed intervention class citing it.
insert into public.clinical_knowledge_sources
  (id, code, revision, citation, title, authors_or_issuer, publisher,
   reference_type, evidence_classification, status, content_hash)
values
  ('e9000000-0000-4000-8000-000000000401', 'p9_dose_ref', 1,
   'A Society. Dosing Guidance. 2025.', 'Dosing Guidance',
   'A Society', 'A Publisher', 'guideline', 'moderate', 'approved', 'hash-p9-ref');

insert into public.clinical_intervention_classes
  (id, organization_id, code, name, jurisdiction_sensitive,
   monitoring_requirements, stopping_rules, contraindications,
   followup_interval_days, reference_id, evidence_classification, review_status)
values
  ('e9000000-0000-4000-8000-000000000501', null, 'oral_magnesium',
   'Oral magnesium', false,
   array['Serum magnesium at 8 weeks'],
   array['Stop if diarrhoea persists beyond 72 hours'],
   array['Severe renal impairment'],
   56, 'e9000000-0000-4000-8000-000000000401', 'moderate', 'approved');

-- =========================================================== structure

select _c('1. protocol_version_sources exists and is org-scoped', (
  select count(*) = 1 from information_schema.columns
  where table_schema = 'public' and table_name = 'protocol_version_sources'
    and column_name = 'organization_id'));

select _c('2. anon can execute neither Part 9 RPC', (
  select not bool_or(has_function_privilege('anon', p.oid, 'execute'))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('get_protocol_knowledge', 'acknowledge_protocol_stale_sources')));

select _c('3. both Part 9 RPCs pin an empty search_path', (
  select bool_and(p.prosecdef and 'search_path=""' = any(p.proconfig))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('get_protocol_knowledge', 'acknowledge_protocol_stale_sources')));

select _c('4. clients cannot write dependency edges directly', (
  select not bool_or(has_table_privilege(r, 'public.protocol_version_sources', p))
  from unnest(array['anon','authenticated']) r,
       unnest(array['insert','update','delete']) p));

-- The wiring is the whole point of Part 9; assert it structurally so a future
-- rewrite of these RPCs cannot quietly drop it.
select _c('5. approve_protocol_version calls the dose provenance gate', (
  select position('protocol_dose_provenance_gate' in
    pg_get_functiondef('public.approve_protocol_version(uuid, text)'::regprocedure)) > 0));

select _c('6. every item-copying RPC carries the governance snapshot forward', (
  select bool_and(position('stopping_rules' in pg_get_functiondef(f::regprocedure)) > 0
                  and position('label_sha256' in pg_get_functiondef(f::regprocedure)) > 0)
  from unnest(array[
    'public.save_protocol_draft(uuid, jsonb, timestamptz)',
    'public.create_protocol_draft(uuid, uuid, text, uuid)',
    'public.revise_protocol_version(uuid)',
    'public.create_protocol_template(uuid, text, text, uuid)']) f));

-- ============================================== authoring as the practitioner

select set_config('request.jwt.claims',
  '{"sub":"e9000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

insert into _k(k, v)
select 'version', (public.create_protocol_draft(
  'e9000000-0000-4000-8000-000000000101',
  'e9000000-0000-4000-8000-000000000201',
  'Knowledge protocol', null)->>'versionId')::uuid;

-- Two items: one governed (exact product + class + label-sourced dose), one
-- bare (no class, no product, no dose).
select public.save_protocol_draft(_id('version'), jsonb_build_object(
  'title', 'Knowledge protocol',
  'items', jsonb_build_array(
    jsonb_build_object(
      'kind', 'product', 'label', 'Magnesium Glycinate',
      'catalogProductId', 'e9000000-0000-4000-8000-000000000302',
      'catalogProductVersionId', 'e9000000-0000-4000-8000-000000000303',
      -- Deliberately lying about identity: the RPC must ignore all of these
      -- and take the catalog's values instead.
      'productSku', 'ATTACKER-SKU', 'productUpc', '999999999999',
      'labelSha256', 'sha256-attacker',
      'interventionClassId', 'e9000000-0000-4000-8000-000000000501',
      'dosageText', '400 mg elemental at bedtime',
      'doseSourceKind', 'product_label',
      'doseSourceRef', 'Verified Labs Magnesium Glycinate, Rev A'),
    jsonb_build_object(
      'kind', 'lifestyle', 'label', 'Evening wind-down routine'))));

select _c('7. exact product identity is frozen from the catalog, not the caller', (
  select it.product_sku = 'VL-MAG-120' and it.product_upc = '012345678905'
     and it.label_sha256 = 'sha256-label-rev-a'
     and it.label_captured_at = '2026-06-01T00:00:00Z'
  from public.protocol_items it
  where it.version_id = _id('version') and it.kind = 'product'));

select _c('8. governance is snapshotted from the governed class', (
  select it.monitoring_requirements = array['Serum magnesium at 8 weeks']
     and it.stopping_rules = array['Stop if diarrhoea persists beyond 72 hours']
     and it.contraindications = array['Severe renal impairment']
     and it.followup_interval_days = 56
     and it.intervention_class_code = 'oral_magnesium'
  from public.protocol_items it
  where it.version_id = _id('version') and it.kind = 'product'));

-- The honest-empty rule. An item with no governed class must NOT acquire
-- governance from anywhere, and must not be given a reassuring default.
select _c('9. an item with no governed class gets empty governance, not invented', (
  select it.monitoring_requirements = '{}'::text[]
     and it.stopping_rules = '{}'::text[]
     and it.contraindications = '{}'::text[]
     and it.followup_interval_days is null
     and it.intervention_class_code is null
     and it.dose_source_kind is null
  from public.protocol_items it
  where it.version_id = _id('version') and it.kind = 'lifestyle'));

select _c('10. dependency edges are derived for every governed source', (
  select count(*) filter (where source_kind = 'catalog_product_version') = 1
     and count(*) filter (where source_kind = 'intervention_class') = 1
  from public.protocol_version_sources where version_id = _id('version')));

select _c('11. a foreign org''s intervention class is refused', _raises(
  format($q$select public.save_protocol_draft(%L, %L::jsonb)$q$,
    _id('version'), jsonb_build_object('items', jsonb_build_array(
      jsonb_build_object('kind','product','label','X',
        'interventionClassId','e9000000-0000-4000-8000-000000000999')))::text),
  'P0002'));

-- ==================================================== the dose provenance gate

-- Re-save with a dose that names no source at all.
select public.save_protocol_draft(_id('version'), jsonb_build_object(
  'title', 'Knowledge protocol',
  'items', jsonb_build_array(
    jsonb_build_object(
      'kind', 'product', 'label', 'Unsourced Magnesium',
      'dosageText', '400 mg at bedtime'))));

select _c('12. a dose with no source blocks approval (55000)', _raises(
  format($q$select public.approve_protocol_version(%L, 'note')$q$, _id('version')),
  '55000'));

-- "A dose is missing its source somewhere" is not actionable. The message has
-- to name the item, or the practitioner has to hunt for it.
select _c('13. the refusal names the offending item rather than counting it',
  _raises_msg(
    format($q$select public.approve_protocol_version(%L, 'note')$q$, _id('version')),
    'Unsourced Magnesium'));

select _c('14. a draft may still HOLD an unsourced dose — only approval refuses', (
  select count(*) = 1 from public.protocol_items
  where version_id = _id('version') and dosage_text = '400 mg at bedtime'));

-- Now record the source and approve for real.
select public.save_protocol_draft(_id('version'), jsonb_build_object(
  'title', 'Knowledge protocol',
  'items', jsonb_build_array(
    jsonb_build_object(
      'kind', 'product', 'label', 'Magnesium Glycinate',
      'catalogProductId', 'e9000000-0000-4000-8000-000000000302',
      'catalogProductVersionId', 'e9000000-0000-4000-8000-000000000303',
      'interventionClassId', 'e9000000-0000-4000-8000-000000000501',
      'dosageText', '400 mg elemental at bedtime',
      'doseSourceKind', 'product_label',
      'doseSourceRef', 'Verified Labs Magnesium Glycinate, Rev A'),
    jsonb_build_object(
      'kind', 'monitoring', 'label', 'Serum magnesium at 8 weeks',
      'doseSourceKind', 'governed_reference',
      'doseSourceRef', 'A Society. Dosing Guidance. 2025.',
      'doseSourceReferenceId', 'e9000000-0000-4000-8000-000000000401'))));

select _c('15. a sourced dose approves cleanly', (
  select (public.approve_protocol_version(_id('version'), 'Reviewed'))->>'status'
         = 'approved'));

select _c('16. an approved version keeps its dependency edges', (
  select count(*) >= 2 from public.protocol_version_sources
  where version_id = _id('version')));

-- ==================================================== the staleness cascade

select set_config('request.jwt.claims', null, true);

-- Capture what the protocol SAYS before the ground moves, so we can prove the
-- cascade marked it without touching a word of it.
create temp table _before as
select id, label, dosage_text, monitoring_requirements, stopping_rules
from public.protocol_items where version_id = (select v from _k where k = 'version');

-- The exact product version is reformulated: it leaves `verified`.
update public.supplement_product_versions
set verification_state = 'stale'
where id = 'e9000000-0000-4000-8000-000000000303';

select _c('17. a product leaving verified marks dependent protocols stale', (
  select v.source_stale_at is not null and v.stale_source_count >= 1
  from public.protocol_versions v where v.id = _id('version')));

select _c('18. the stale reason names the product state, not a generic warning', (
  select v.source_stale_reason ilike '%stale%'
     and v.source_stale_reason ilike '%protocol is unchanged%'
  from public.protocol_versions v where v.id = _id('version')));

select _c('19. staleness marks and NEVER edits the protocol text', (
  select count(*) = 0 from (
    select id, label, dosage_text, monitoring_requirements, stopping_rules
    from public.protocol_items where version_id = _id('version')
    except all
    select id, label, dosage_text, monitoring_requirements, stopping_rules
    from _before) diff));

select _c('20. the approved version is not withdrawn or deactivated', (
  select v.status = 'approved' from public.protocol_versions v
  where v.id = _id('version')));

-- A governed reference reaching a terminal state does the same thing.
-- `withdrawn` rather than `superseded`: the schema requires a superseding
-- reference for the latter, and inventing a second guideline just to satisfy
-- a constraint would put a fake citation in the fixture.
insert into public.clinical_knowledge_source_states
  (reference_id, status, reason)
values ('e9000000-0000-4000-8000-000000000401', 'withdrawn', 'Withdrawn by the issuer');

select _c('21. a withdrawn reference stales protocols that cite it', (
  select count(*) = 1 from public.protocol_version_sources
  where version_id = _id('version')
    and source_kind = 'knowledge_reference' and stale_at is not null));

select _c('22. a second moving source raises the count', (
  select v.stale_source_count >= 2 from public.protocol_versions v
  where v.id = _id('version')));

-- ================================================== acknowledging a re-review

select set_config('request.jwt.claims',
  '{"sub":"e9000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

select _c('23. a re-review needs a note (22023)', _raises(
  format($q$select public.acknowledge_protocol_stale_sources(%L, '   ')$q$,
    _id('version')), '22023'));

select _c('24. a re-review is recorded', (
  select (public.acknowledge_protocol_stale_sources(
    _id('version'), 'Confirmed the new label matches the prescribed dose.'))->>'ok'
    = 'true'));

select _c('25. the staleness flag SURVIVES the re-review, deliberately', (
  select v.source_stale_at is not null and v.stale_reviewed_at is not null
     and v.stale_reviewed_by = 'e9000000-0000-4000-8000-000000000001'
  from public.protocol_versions v where v.id = _id('version')));

select _c('26. the re-review is auditable', (
  select count(*) = 1 from public.audit_events
  where action = 'protocol.stale_sources_reviewed'
    and resource_id = _id('version')::text));

-- ==================================================== reading the knowledge

select _c('27. get_protocol_knowledge returns items, sources and staleness', (
  select k->>'versionId' = _id('version')::text
     and jsonb_array_length(k->'items') = 2
     and jsonb_array_length(k->'sources') >= 2
     and (k->>'sourceStaleAt') is not null
  from (select public.get_protocol_knowledge(_id('version')) as k) q));

select _c('28. it carries the exact identity and the snapshot, not a join', (
  select it->>'productSku' = 'VL-MAG-120'
     and it->>'labelSha256' = 'sha256-label-rev-a'
     and (it->'stoppingRules')->>0 = 'Stop if diarrhoea persists beyond 72 hours'
  from (
    select jsonb_array_elements(public.get_protocol_knowledge(_id('version'))->'items') as it
  ) q where it->>'kind' = 'product'));

select _c('29. it states the dose policy rather than implying one', (
  select (public.get_protocol_knowledge(_id('version'))->>'dosePolicy')
         ilike '%nothing is inferred from a product name%'));

select _c('30. it states that staleness never edits the protocol', (
  select (public.get_protocol_knowledge(_id('version'))->>'stalePolicy')
         ilike '%never edits, withdraws or deletes%'));

-- The commercial firewall, asserted on the function body rather than on output:
-- an empty commercial table would make an output-only check pass vacuously.
select _c('31. get_protocol_knowledge reads no commercial table', (
  select position('commercial' in
    pg_get_functiondef('public.get_protocol_knowledge(uuid)'::regprocedure)) = 0));

select _c('32. it exposes no affiliate or commission field', (
  select (public.get_protocol_knowledge(_id('version'))::text) !~* 'affiliate|commission|payout'));

-- ==================================================== revision carries forward

-- Materialised into `_k` rather than called inside a WHERE clause: a volatile
-- function there has no defined evaluation count, so the test could create two
-- revisions or none.
insert into _k(k, v)
select 'revision',
  ((public.revise_protocol_version(_id('version')))->>'versionId')::uuid;

select _c('33. a revision carries the governance snapshot forward', (
  select it.stopping_rules = array['Stop if diarrhoea persists beyond 72 hours']
     and it.contraindications = array['Severe renal impairment']
     and it.product_sku = 'VL-MAG-120'
     and it.label_sha256 = 'sha256-label-rev-a'
  from public.protocol_items it
  where it.version_id = _id('revision') and it.kind = 'product'));

select _c('34. the revision gets its own dependency edges', (
  select count(*) >= 2 from public.protocol_version_sources
  where version_id = _id('revision')));

-- ================================== the snapshot is a snapshot, not a join
--
-- Proved on a DRAFT class, because an approved one cannot be edited at all
-- (asserted separately below). If the item joined to the class instead of
-- copying from it, editing the class here would rewrite a protocol that was
-- already written — the exact defect the snapshot design exists to prevent.

select set_config('request.jwt.claims', null, true);

insert into public.clinical_intervention_classes
  (id, organization_id, code, name, stopping_rules, evidence_classification,
   review_status)
values
  ('e9000000-0000-4000-8000-000000000502', null, 'draft_class', 'Draft class',
   array['Original rule'], 'practitioner_experience', 'draft');

select set_config('request.jwt.claims',
  '{"sub":"e9000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

select public.save_protocol_draft(_id('revision'), jsonb_build_object(
  'title', 'Snapshot probe',
  'items', jsonb_build_array(
    jsonb_build_object('kind', 'lifestyle', 'label', 'Probe item',
      'interventionClassId', 'e9000000-0000-4000-8000-000000000502'))));

select set_config('request.jwt.claims', null, true);

update public.clinical_intervention_classes
set stopping_rules = array['REWRITTEN AFTER THE FACT']
where id = 'e9000000-0000-4000-8000-000000000502';

select _c('35. editing the class does NOT rewrite a protocol already written', (
  select it.stopping_rules = array['Original rule']
  from public.protocol_items it
  where it.version_id = _id('revision') and it.label = 'Probe item'));

select _c('36. an APPROVED governed class cannot be edited at all (42501)', _raises(
  $q$update public.clinical_intervention_classes
     set stopping_rules = array['x']
     where id = 'e9000000-0000-4000-8000-000000000501'$q$, '42501'));

-- ==================================================== access control

select set_config('request.jwt.claims',
  '{"sub":"e9000000-0000-4000-8000-000000000002","role":"authenticated"}', true);

select _c('37. an outsider cannot read another org''s protocol knowledge', _raises(
  format($q$select public.get_protocol_knowledge(%L)$q$, _id('version')), '42501'));

select _c('38. an outsider cannot acknowledge another org''s stale sources', _raises(
  format($q$select public.acknowledge_protocol_stale_sources(%L, 'note')$q$,
    _id('version')), '42501'));

select set_config('request.jwt.claims', null, true);

select _c('39. an anonymous caller is refused (28000)', _raises(
  format($q$select public.get_protocol_knowledge(%L)$q$, _id('version')), '28000'));

-- ---------------------------------------------------------------- results

select count(*) filter (where ok) as passed,
       count(*) filter (where not ok) as failed,
       count(*) as total,
       coalesce(string_agg(n, ' | ') filter (where not ok), '(none)') as failures
from _r;

rollback;
