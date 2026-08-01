-- Phase 9B acceptance: protocol template lifecycle.
--
-- Rolled back at the end; the project is unchanged after the final statement.
--
-- What this proves:
--   * an unsourced dose BLOCKS publication and the refusal names the item —
--     the notice the UI shows is not merely advisory;
--   * a safety review is an append-only record that cannot be edited or
--     deleted, and it stores the unsourced count it actually observed;
--   * duplicating carries dose provenance forward, and editing the duplicate
--     never touches the template it came from;
--   * compare calls out a DOSE change specifically and works across templates,
--     which is what "compare this duplicate to its original" needs;
--   * superseding points forward without deleting, refuses cycles, and cannot
--     be applied twice;
--   * the patient-instruction preview shows only what was recorded — an item
--     with no dose shows no dose.

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
create or replace function _raises_msg(_sql text, _needle text)
returns boolean language plpgsql as $fn$
begin
  execute _sql; return false;
exception when others then return position(_needle in sqlerrm) > 0;
end;
$fn$;
create or replace function _id(_key text) returns uuid language sql stable as $fn$
  select v from _k where k = _key;
$fn$;

-- ---------------------------------------------------------------- fixtures

insert into auth.users(id, email) values
  ('eb000000-0000-4000-8000-000000000001', 'tpl-practitioner@verify.local'),
  ('eb000000-0000-4000-8000-000000000002', 'tpl-outsider@verify.local');

insert into public.organizations(id, name, slug) values
  ('eb000000-0000-4000-8000-000000000101', 'Tpl Org', 'p9b-tpl'),
  ('eb000000-0000-4000-8000-000000000102', 'Tpl Other', 'p9b-tpl-other');

insert into public.organization_memberships(organization_id, user_id, role, status) values
  ('eb000000-0000-4000-8000-000000000101',
   'eb000000-0000-4000-8000-000000000001', 'practitioner', 'active'),
  ('eb000000-0000-4000-8000-000000000102',
   'eb000000-0000-4000-8000-000000000002', 'practitioner', 'active');

-- A patient and a patient protocol, so check 17 has a version of its own to
-- point at. Depending on whatever patient rows happen to exist would make that
-- check pass or vanish depending on the state of the project.
insert into public.patient_profiles(id, organization_id, first_name, last_name) values
  ('eb000000-0000-4000-8000-000000000201',
   'eb000000-0000-4000-8000-000000000101', 'Template', 'Patient');
insert into public.practitioner_patient_relationships
  (organization_id, practitioner_user_id, patient_id, status) values
  ('eb000000-0000-4000-8000-000000000101',
   'eb000000-0000-4000-8000-000000000001',
   'eb000000-0000-4000-8000-000000000201', 'active');

select set_config('request.jwt.claims',
  '{"sub":"eb000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

insert into _k(k, v)
select 'patientVersion', (public.create_protocol_draft(
  'eb000000-0000-4000-8000-000000000101',
  'eb000000-0000-4000-8000-000000000201',
  'A patient protocol', null)->>'versionId')::uuid;

insert into _k(k, v)
select 'tplA', (public.create_protocol_template(
  'eb000000-0000-4000-8000-000000000101',
  'Sleep support', 'First template', null)->>'templateId')::uuid;
insert into _k(k, v)
select 'verA', (select id from public.protocol_versions where template_id = _id('tplA'));

select _c('1. a new template starts as a draft with no safety review', (
  select d->>'status' = 'draft' and jsonb_array_length(d->'safetyReviews') = 0
  from (select public.get_protocol_template_detail(_id('tplA')) d) q));

-- ============================================ an unsourced dose blocks publish

select public.save_protocol_draft(_id('verA'), jsonb_build_object(
  'title', 'Sleep support',
  'items', jsonb_build_array(
    jsonb_build_object('kind', 'product', 'label', 'Magnesium',
                       'dosageText', '400 mg'))));

select _c('2. an unsourced dose is counted and named in the safety notice', (
  select (d->>'unsourcedDoseCount')::int = 1
     and d->>'safetyNotice' ilike '%Publication is blocked%'
  from (select public.get_protocol_template_detail(_id('tplA')) d) q));

-- The notice above would be a lie if publication merely warned. It does not.
select _c('3. publication is actually blocked, not merely warned about (55000)',
  _raises(format($q$select public.approve_protocol_template_version(%L)$q$,
    _id('verA')), '55000'));

select _c('4. the block names the offending item', _raises_msg(
  format($q$select public.approve_protocol_template_version(%L)$q$, _id('verA')),
  'Magnesium'));

-- ==================================================== the safety review log

select _c('5. a safety review needs an outcome from the fixed set (22023)', _raises(
  format($q$select public.record_protocol_template_safety_review(
    %L, 'looks-fine', 'n')$q$, _id('verA')), '22023'));

select _c('6. a safety review needs a note (22023)', _raises(
  format($q$select public.record_protocol_template_safety_review(
    %L, 'passed', '  ')$q$, _id('verA')), '22023'));

select _c('7. a review records the unsourced count it actually observed', (
  select (public.record_protocol_template_safety_review(
    _id('verA'), 'concerns', 'Dose has no source yet')
    ->>'unsourcedDoseCount')::int = 1));

select _c('8. a safety review is append-only (42501)', _raises(
  $q$update public.protocol_template_safety_reviews set outcome = 'passed'$q$,
  '42501'));

select _c('9. a safety review cannot be deleted either (42501)', _raises(
  $q$delete from public.protocol_template_safety_reviews$q$, '42501'));

-- ==================================================== naming the source unblocks

select public.save_protocol_draft(_id('verA'), jsonb_build_object(
  'title', 'Sleep support',
  'items', jsonb_build_array(
    jsonb_build_object('kind', 'product', 'label', 'Magnesium',
      'dosageText', '400 mg',
      'doseSourceKind', 'practitioner_protocol',
      'doseSourceRef', 'Supplied practitioner protocol, 2026'))));

select _c('10. once every dose names a source, the notice says so', (
  select (public.get_protocol_template_detail(_id('tplA'))->>'safetyNotice')
    = 'Every recorded dose names its source.'));

select _c('11. publication then succeeds', (
  select (public.approve_protocol_template_version(_id('verA')))->>'status'
    = 'approved'));

-- ==================================================== duplicate and isolate

insert into _k(k, v)
select 'tplB', (public.create_protocol_template(
  'eb000000-0000-4000-8000-000000000101',
  'Sleep support v2', 'Duplicate', _id('verA'))->>'templateId')::uuid;
insert into _k(k, v)
select 'verB', (select id from public.protocol_versions where template_id = _id('tplB'));

select _c('12. a duplicate copies the items and their dose provenance', (
  select it.dosage_text = '400 mg'
     and it.dose_source_kind = 'practitioner_protocol'
  from public.protocol_items it where it.version_id = _id('verB')));

select _c('13. editing the duplicate never touches the source template', (
  select (select count(*) from public.protocol_items
          where version_id = _id('verA')) = 1
  from (select public.save_protocol_draft(_id('verB'), jsonb_build_object(
    'title', 'Sleep support v2',
    'items', jsonb_build_array(
      jsonb_build_object('kind', 'product', 'label', 'Magnesium',
        'dosageText', '600 mg',
        'doseSourceKind', 'practitioner_protocol',
        'doseSourceRef', 'Supplied, 2026'),
      jsonb_build_object('kind', 'lifestyle',
        'label', 'Wind-down routine'))))) s));

-- ==================================================== compare

select _c('14. compare reports the dose change explicitly', (
  select (c->>'doseChangeCount')::int = 1
     and c->'changed'->0->>'label' = 'Magnesium'
     and c->'changed'->0->'from'->>'dosageText' = '400 mg'
     and c->'changed'->0->'to'->>'dosageText' = '600 mg'
  from (select public.compare_protocol_template_versions(
    _id('verA'), _id('verB')) c) q));

select _c('15. compare works ACROSS templates and says they differ', (
  select (c->>'sameTemplate')::boolean = false
     and c->'added'->0->>'label' = 'Wind-down routine'
     and jsonb_array_length(c->'added') = 1
  from (select public.compare_protocol_template_versions(
    _id('verA'), _id('verB')) c) q));

select _c('16. compare warns that a rename reads as remove + add', (
  select (public.compare_protocol_template_versions(_id('verA'), _id('verB'))
          ->>'matchNote') ilike '%renamed item%'));

-- Patient protocol versions reach through `can_access_patient`; routing them
-- down the template path would sidestep that check entirely.
select _c('17. a PATIENT protocol version cannot be compared this way (22023)',
  _raises(format($q$select public.compare_protocol_template_versions(%L, %L)$q$,
    _id('verA'), _id('patientVersion')), '22023'));

-- ==================================================== patient preview

select _c('18. the patient preview carries only what was recorded', (
  select p->>'dose' = '600 mg' and (p->>'doseIsSourced')::boolean
  from (select jsonb_array_elements(
    public.get_protocol_template_detail(_id('tplB'))
    ->'patientInstructionPreview') p) q
  where p->>'label' = 'Magnesium'));

select _c('19. an item with no dose shows no dose in the preview', (
  select p->>'dose' is null
  from (select jsonb_array_elements(
    public.get_protocol_template_detail(_id('tplB'))
    ->'patientInstructionPreview') p) q
  where p->>'label' = 'Wind-down routine'));

select _c('20. the preview says it is generated and not stored or sent', (
  select (public.get_protocol_template_detail(_id('tplB'))->>'previewNotice')
    ilike '%not stored and not sent anywhere%'));

-- ==================================================== supersede

select public.approve_protocol_template_version(_id('verB'));

select _c('21. superseding needs a reason (22023)', _raises(
  format($q$select public.supersede_protocol_template(%L, %L, '  ')$q$,
    _id('tplA'), _id('tplB')), '22023'));

select _c('22. a template cannot supersede itself (22023)', _raises(
  format($q$select public.supersede_protocol_template(%L, %L, 'why')$q$,
    _id('tplA'), _id('tplA')), '22023'));

select _c('23. superseding records the successor and a reason', (
  select (public.supersede_protocol_template(_id('tplA'), _id('tplB'),
    'Replaced by the 2026 revision'))->>'supersededBy' = _id('tplB')::text));

-- The point of supersession rather than deletion: protocols already started
-- from this template have to keep resolving.
select _c('24. the superseded template stays READABLE, not deleted', (
  select d->>'templateId' = _id('tplA')::text
     and d->>'supersededById' = _id('tplB')::text
     and d->>'supersededReason' = 'Replaced by the 2026 revision'
  from (select public.get_protocol_template_detail(_id('tplA')) d) q));

select _c('25. superseding twice is refused (55000)', _raises(
  format($q$select public.supersede_protocol_template(%L, %L, 'again')$q$,
    _id('tplA'), _id('tplB')), '55000'));

select _c('26. a cycle is refused (22023)', _raises(
  format($q$select public.supersede_protocol_template(%L, %L, 'cycle')$q$,
    _id('tplB'), _id('tplA')), '22023'));

-- ==================================================== access control

select set_config('request.jwt.claims',
  '{"sub":"eb000000-0000-4000-8000-000000000002","role":"authenticated"}', true);

select _c('27. an outsider cannot read another org template (42501)', _raises(
  format($q$select public.get_protocol_template_detail(%L)$q$, _id('tplA')),
  '42501'));

select _c('28. an outsider cannot supersede another org template (42501)', _raises(
  format($q$select public.supersede_protocol_template(%L, %L, 'x')$q$,
    _id('tplB'), _id('tplA')), '42501'));

select _c('29. an outsider cannot record a safety review (42501)', _raises(
  format($q$select public.record_protocol_template_safety_review(
    %L, 'passed', 'x')$q$, _id('verB')), '42501'));

select set_config('request.jwt.claims', null, true);

select _c('30. an anonymous caller is refused (28000)', _raises(
  format($q$select public.get_protocol_template_detail(%L)$q$, _id('tplA')),
  '28000'));

select _c('31. anon holds execute on none of the new template RPCs', (
  select not bool_or(has_function_privilege('anon', p.oid, 'execute'))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in (
    'get_protocol_template_detail', 'supersede_protocol_template',
    'compare_protocol_template_versions',
    'record_protocol_template_safety_review')));

select _c('32. clients cannot write safety reviews directly', (
  select not bool_or(has_table_privilege(
    r, 'public.protocol_template_safety_reviews', p))
  from unnest(array['anon','authenticated']) r,
       unnest(array['insert','update','delete']) p));

-- ---------------------------------------------------------------- results
--
-- `never_evaluated` counts checks whose expression came back NULL, usually a
-- subquery that matched no row. Reporting those as neither passed nor failed
-- is how a check silently stops testing anything.

select count(*) filter (where ok) as passed,
       count(*) filter (where ok is false) as failed,
       count(*) filter (where ok is null) as never_evaluated,
       count(*) as total,
       coalesce(string_agg(n, ' | ') filter (where ok is not true), '(none)')
         as problems
from _r;

rollback;
