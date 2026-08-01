-- Phase 9A acceptance: nutrition assessment, templates, plans, safety, adherence.
--
-- 44 checks, all passing on staging. Rolled back at the end. Proves the parts
-- of the 34-scenario brief that a browser cannot reach: grant surface and
-- definer posture, anonymous refusal,
-- storage-level immutability of published templates and approved plans, the
-- one-active-plan guarantee, content-ownership shape, the documented-override
-- rule, adherence honesty, and append-only history.
--
-- The scenarios that need a signed-in identity — the approval gate refusing an
-- unevaluated version, and refusing one with an unresolved blocking flag — are
-- proven in the browser suite, because auth.uid() is null here.
--
-- Run against the staging project inside a transaction; ROLLBACK is the last
-- statement, so nothing survives.

begin;

create temporary table _r(n text, ok boolean) on commit drop;
create or replace function _c(_n text, _ok boolean) returns void language sql as $$
  insert into _r(n, ok) values (_n, _ok);
$$;

/** Run a statement and report whether it raised the SQLSTATE we expect. */
create or replace function _raises(_sql text, _state text)
returns boolean language plpgsql as $$
begin
  execute _sql;
  return false;
exception when others then
  return sqlstate = _state;
end;
$$;

/** Run a statement and report whether it succeeded. */
create or replace function _succeeds(_sql text) returns boolean language plpgsql as $$
begin
  execute _sql;
  return true;
exception when others then
  return false;
end;
$$;

-- The 27 caller RPCs this phase adds.
create temporary table _fns(name text) on commit drop;
insert into _fns(name) values
  ('upsert_nutrition_template'),('create_nutrition_template_version'),
  ('save_nutrition_template_content'),('record_nutrition_template_reference'),
  ('publish_nutrition_template_version'),('archive_nutrition_template'),
  ('install_nutrition_starter_template'),
  ('create_nutrition_plan'),('save_nutrition_plan_version'),
  ('set_nutrition_plan_constraints'),('evaluate_nutrition_plan_safety'),
  ('raise_nutrition_safety_flag'),('resolve_nutrition_safety_flag'),
  ('submit_nutrition_plan_version'),('approve_nutrition_plan_version'),
  ('activate_nutrition_plan_version'),('set_nutrition_plan_lifecycle'),
  ('revise_nutrition_plan_version'),('add_nutrition_amendment'),
  ('record_nutrition_checkin'),('review_nutrition_checkin'),
  ('record_nutrition_provider_lookup'),('review_nutrition_provider_lookup'),
  ('list_nutrition_templates'),('get_nutrition_version_content'),
  ('get_patient_nutrition'),('get_nutrition_adherence_summary');

-- The 19 tables this phase adds.
create temporary table _tbls(name text) on commit drop;
insert into _tbls(name) values
  ('nutrition_templates'),('nutrition_template_versions'),('nutrition_plans'),
  ('nutrition_plan_versions'),('nutrition_phases'),('nutrition_food_rules'),
  ('nutrition_meal_days'),('nutrition_meals'),('nutrition_meal_items'),
  ('nutrition_recipes'),('nutrition_grocery_items'),('nutrition_constraints'),
  ('nutrition_safety_flags'),('nutrition_provenance'),('nutrition_amendments'),
  ('nutrition_checkins'),('nutrition_plan_events'),('nutrition_template_events'),
  ('nutrition_provider_lookups');

-- ---------------------------------------------------------------- fixtures
insert into public.organizations (id, name, slug) values
  ('e9a00000-0000-4000-8000-000000001001','P9A Org A','p9a-a');

insert into public.patient_profiles
  (id, organization_id, mrn, first_name, last_name, date_of_birth, sex, status) values
  ('e9a00000-0000-4000-8000-000000002001','e9a00000-0000-4000-8000-000000001001',
   'P9A-1','Alpha','Patient','1980-01-01','female','active');

-- A template with a PUBLISHED version and a DRAFT version, so the freeze can
-- be shown to apply per-version rather than per-template.
insert into public.nutrition_templates (id, organization_id, name, pattern, status) values
  ('e9a00000-0000-4000-8000-000000003001','e9a00000-0000-4000-8000-000000001001',
   'P9A Template','low_fodmap','active');

insert into public.nutrition_template_versions
  (id, organization_id, template_id, version_number, status, purpose, published_at) values
  ('e9a00000-0000-4000-8000-000000004001','e9a00000-0000-4000-8000-000000001001',
   'e9a00000-0000-4000-8000-000000003001',1,'published','Original purpose',now()),
  ('e9a00000-0000-4000-8000-000000004002','e9a00000-0000-4000-8000-000000001001',
   'e9a00000-0000-4000-8000-000000003001',2,'draft','Draft purpose',null);

insert into public.nutrition_food_rules
  (id, organization_id, template_version_id, disposition, label) values
  ('e9a00000-0000-4000-8000-000000005002','e9a00000-0000-4000-8000-000000001001',
   'e9a00000-0000-4000-8000-000000004002','emphasize','Draft rule');

-- Content on the PUBLISHED version has to be inserted before it is published,
-- which is exactly how the RPC layer does it. Insert while draft, then publish.
insert into public.nutrition_template_versions
  (id, organization_id, template_id, version_number, status) values
  ('e9a00000-0000-4000-8000-000000004003','e9a00000-0000-4000-8000-000000001001',
   'e9a00000-0000-4000-8000-000000003001',3,'draft');
insert into public.nutrition_food_rules
  (id, organization_id, template_version_id, disposition, label) values
  ('e9a00000-0000-4000-8000-000000005001','e9a00000-0000-4000-8000-000000001001',
   'e9a00000-0000-4000-8000-000000004003','emphasize','Published rule');
update public.nutrition_template_versions set status = 'published', published_at = now()
 where id = 'e9a00000-0000-4000-8000-000000004003';

-- A plan with an ACTIVE version and a DRAFT version.
insert into public.nutrition_plans
  (id, organization_id, patient_id, title, status) values
  ('e9a00000-0000-4000-8000-000000006001','e9a00000-0000-4000-8000-000000001001',
   'e9a00000-0000-4000-8000-000000002001','P9A Plan','active');

insert into public.nutrition_plan_versions
  (id, organization_id, plan_id, patient_id, version_number, status,
   source_template_id, source_template_version_id, source_template_name_snapshot,
   source_template_version_snapshot, patient_instructions, energy_target_value,
   energy_target_unit) values
  ('e9a00000-0000-4000-8000-000000007001','e9a00000-0000-4000-8000-000000001001',
   'e9a00000-0000-4000-8000-000000006001','e9a00000-0000-4000-8000-000000002001',
   1,'draft','e9a00000-0000-4000-8000-000000003001',
   'e9a00000-0000-4000-8000-000000004001','P9A Template',1,
   'Original instructions',2000,'kcal');

insert into public.nutrition_plan_versions
  (id, organization_id, plan_id, patient_id, version_number, status) values
  ('e9a00000-0000-4000-8000-000000007002','e9a00000-0000-4000-8000-000000001001',
   'e9a00000-0000-4000-8000-000000006001','e9a00000-0000-4000-8000-000000002001',
   2,'draft');

-- Content and assessment go on while version 1 is still a draft, then it is
-- activated — the same order the RPC layer uses.
insert into public.nutrition_meal_days
  (id, organization_id, plan_version_id, day_number) values
  ('e9a00000-0000-4000-8000-000000008001','e9a00000-0000-4000-8000-000000001001',
   'e9a00000-0000-4000-8000-000000007001',1);
insert into public.nutrition_meals (id, organization_id, meal_day_id, meal_type) values
  ('e9a00000-0000-4000-8000-000000008101','e9a00000-0000-4000-8000-000000001001',
   'e9a00000-0000-4000-8000-000000008001','breakfast');
insert into public.nutrition_meal_items (id, organization_id, meal_id, label) values
  ('e9a00000-0000-4000-8000-000000008201','e9a00000-0000-4000-8000-000000001001',
   'e9a00000-0000-4000-8000-000000008101','Oats');
insert into public.nutrition_constraints
  (id, organization_id, plan_version_id, kind, label) values
  ('e9a00000-0000-4000-8000-000000008301','e9a00000-0000-4000-8000-000000001001',
   'e9a00000-0000-4000-8000-000000007001','allergy','Peanut');
insert into public.nutrition_safety_flags
  (id, organization_id, plan_version_id, kind, severity, detail, status) values
  ('e9a00000-0000-4000-8000-000000009001','e9a00000-0000-4000-8000-000000001001',
   'e9a00000-0000-4000-8000-000000007001','recorded_allergy','blocking','A flag','open');

update public.nutrition_plan_versions set status = 'active', activated_at = now()
 where id = 'e9a00000-0000-4000-8000-000000007001';

insert into public.nutrition_plan_events
  (id, organization_id, plan_id, plan_version_id, kind) values
  ('e9a00000-0000-4000-8000-00000000a001','e9a00000-0000-4000-8000-000000001001',
   'e9a00000-0000-4000-8000-000000006001','e9a00000-0000-4000-8000-000000007001','activated');

insert into public.nutrition_amendments
  (id, organization_id, plan_version_id, amendment_number, body, reason) values
  ('e9a00000-0000-4000-8000-00000000b001','e9a00000-0000-4000-8000-000000001001',
   'e9a00000-0000-4000-8000-000000007001',1,'Amendment body','Amendment reason');

insert into public.nutrition_provider_lookups
  (id, organization_id, capability, response_hash) values
  ('e9a00000-0000-4000-8000-00000000c001','e9a00000-0000-4000-8000-000000001001',
   'food_search','abc123');

-- ================================================ 1. grant surface & posture

select _c('1.1 all 27 caller RPCs are granted to authenticated', (
  select count(distinct p.proname) = 27
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in (select name from _fns)
    and has_function_privilege('authenticated', p.oid, 'EXECUTE')));

select _c('1.2 no caller RPC is executable by anon', (
  select count(*) = 0
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in (select name from _fns)
    and has_function_privilege('anon', p.oid, 'EXECUTE')));

select _c('1.3 every caller RPC is SECURITY DEFINER with an empty search_path', (
  select bool_and(p.prosecdef and array_to_string(p.proconfig, ',') = 'search_path=""')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in (select name from _fns)));

select _c('1.4 no private nutrition helper is executable by authenticated', (
  select count(*) = 0
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'private' and p.proname like '%nutrition%'
    and has_function_privilege('authenticated', p.oid, 'EXECUTE')));

select _c('1.5 anon and authenticated hold no direct write on any nutrition table', (
  select count(*) = 0 from information_schema.role_table_grants
  where table_schema = 'public'
    and (table_name in (select name from _tbls)
         or table_name in ('nutrition_targets', 'food_logs'))
    and grantee in ('anon', 'authenticated')
    and privilege_type in ('INSERT', 'UPDATE', 'DELETE')));

select _c('1.6 RLS is enabled on all 19 new tables', (
  select count(*) = 19 from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname in (select name from _tbls)
    and c.relrowsecurity));

-- ================================================== 2. anonymous refusal

select _c('2.1 a read RPC refuses an anonymous caller with 28000', _raises(
  $$select public.get_patient_nutrition(
      'e9a00000-0000-4000-8000-000000001001'::uuid,
      'e9a00000-0000-4000-8000-000000002001'::uuid)$$, '28000'));

select _c('2.2 a write RPC refuses an anonymous caller with 28000', _raises(
  $$select public.create_nutrition_plan(
      'e9a00000-0000-4000-8000-000000001001'::uuid,
      'e9a00000-0000-4000-8000-000000002001'::uuid, 'Anon plan')$$, '28000'));

-- =========================================== 3. template freeze & evidence

select _c('3.1 a published template version''s declared fields are frozen', _raises(
  $$update public.nutrition_template_versions set purpose = 'Rewritten'
     where id = 'e9a00000-0000-4000-8000-000000004003'$$, '42501'));

select _c('3.2 a published template version cannot return to draft', _raises(
  $$update public.nutrition_template_versions set status = 'draft'
     where id = 'e9a00000-0000-4000-8000-000000004003'$$, '42501'));

select _c('3.3 content under a published template version cannot be edited', _raises(
  $$update public.nutrition_food_rules set label = 'Rewritten rule'
     where id = 'e9a00000-0000-4000-8000-000000005001'$$, '42501'));

select _c('3.4 content cannot be ADDED to a published template version either', _raises(
  $$insert into public.nutrition_food_rules
      (organization_id, template_version_id, disposition, label)
    values ('e9a00000-0000-4000-8000-000000001001',
            'e9a00000-0000-4000-8000-000000004003', 'avoid', 'Snuck in later')$$, '42501'));

-- The guard is a DEFERRED constraint trigger, so it fires at commit — and this
-- suite never commits. `set constraints ... immediate` forces the pending
-- check to run now, which is the only way to observe it from inside a
-- rolled-back transaction. Without that, this check passes vacuously.
select _c('3.5 PUBLISHING as evidence-based without a reference is refused', _raises($$
  do $x$
  declare _v uuid;
  begin
    insert into public.nutrition_template_versions
      (organization_id, template_id, version_number, status, evidence_grade)
    values ('e9a00000-0000-4000-8000-000000001001',
            'e9a00000-0000-4000-8000-000000003001', 90, 'published', 'governed_reference')
    returning id into _v;
    set constraints public.nutrition_template_evidence_guard immediate;
  end $x$;$$, '22023'));

select _c('3.6 the same grade WITH a governed reference commits', _succeeds($$
  do $x$
  declare _v uuid;
  begin
    insert into public.nutrition_template_versions
      (organization_id, template_id, version_number, status, evidence_grade)
    values ('e9a00000-0000-4000-8000-000000001001',
            'e9a00000-0000-4000-8000-000000003001', 91, 'published', 'governed_reference')
    returning id into _v;
    insert into public.nutrition_provenance
      (organization_id, template_version_id, kind, label)
    values ('e9a00000-0000-4000-8000-000000001001', _v, 'governed_reference', 'A citation');
    set constraints public.nutrition_template_evidence_guard immediate;
  end $x$;$$));

-- A DRAFT may hold the intent before its citations are attached; enforcing at
-- insert made that workflow impossible, which is the defect this proves fixed.
select _c('3.7 a DRAFT may carry the grade before its citations are attached',
  _succeeds($$
  do $x$
  begin
    insert into public.nutrition_template_versions
      (organization_id, template_id, version_number, status, evidence_grade)
    values ('e9a00000-0000-4000-8000-000000001001',
            'e9a00000-0000-4000-8000-000000003001', 92, 'draft', 'governed_reference');
    set constraints public.nutrition_template_evidence_guard immediate;
  end $x$;$$));

-- ================================================ 4. plan freeze & versions

select _c('4.1 an active plan version''s clinical content is frozen', _raises(
  $$update public.nutrition_plan_versions set patient_instructions = 'Rewritten'
     where id = 'e9a00000-0000-4000-8000-000000007001'$$, '42501'));

select _c('4.2 an active plan version cannot return to draft', _raises(
  $$update public.nutrition_plan_versions set status = 'draft'
     where id = 'e9a00000-0000-4000-8000-000000007001'$$, '42501'));

select _c('4.3 lifecycle stamps may still be set on a frozen version', _succeeds(
  $$update public.nutrition_plan_versions set status = 'paused', paused_at = now()
     where id = 'e9a00000-0000-4000-8000-000000007001'$$));

select _c('4.4 the freeze is per-version — a sibling draft is still editable', _succeeds(
  $$update public.nutrition_plan_versions set patient_instructions = 'Draft edit'
     where id = 'e9a00000-0000-4000-8000-000000007002'$$));

select _c('4.5 a meal day under a frozen plan version cannot be changed', _raises(
  $$update public.nutrition_meal_days set label = 'Rewritten'
     where id = 'e9a00000-0000-4000-8000-000000008001'$$, '42501'));

select _c('4.6 a meal item under a frozen version cannot be changed either', _raises(
  $$update public.nutrition_meal_items set label = 'Peanut butter'
     where id = 'e9a00000-0000-4000-8000-000000008201'$$, '42501'));

select _c('4.7 the assessment behind a frozen version cannot be rewritten', _raises(
  $$update public.nutrition_constraints set label = 'Not peanut after all'
     where id = 'e9a00000-0000-4000-8000-000000008301'$$, '42501'));

select _c('4.8 at most one ACTIVE plan per patient', _raises($$
  insert into public.nutrition_plans (organization_id, patient_id, title, status)
  values ('e9a00000-0000-4000-8000-000000001001',
          'e9a00000-0000-4000-8000-000000002001', 'Second live plan', 'active')$$,
  '23505'));

select _c('4.9 a plan carries the source template snapshot, not just a pointer', (
  select source_template_name_snapshot = 'P9A Template'
     and source_template_version_snapshot = 1
     and detached_at is not null
  from public.nutrition_plan_versions
  where id = 'e9a00000-0000-4000-8000-000000007001'));

-- ============================================= 5. content ownership & shape

select _c('5.1 a content row cannot belong to a template AND a plan version', _raises($$
  insert into public.nutrition_food_rules
    (organization_id, template_version_id, plan_version_id, disposition, label)
  values ('e9a00000-0000-4000-8000-000000001001',
          'e9a00000-0000-4000-8000-000000004002',
          'e9a00000-0000-4000-8000-000000007002', 'include', 'Ambiguous')$$, '23514'));

select _c('5.2 a content row must belong to one of them', _raises($$
  insert into public.nutrition_food_rules (organization_id, disposition, label)
  values ('e9a00000-0000-4000-8000-000000001001', 'include', 'Orphan')$$, '23514'));

select _c('5.3 a conditional food rule must say what it is conditional on', _raises($$
  insert into public.nutrition_food_rules
    (organization_id, template_version_id, disposition, label)
  values ('e9a00000-0000-4000-8000-000000001001',
          'e9a00000-0000-4000-8000-000000004002', 'conditional', 'Coffee')$$, '23514'));

select _c('5.4 a phase cannot mix relative and absolute timing', _raises($$
  insert into public.nutrition_phases
    (organization_id, template_version_id, phase_number, name, timing_mode,
     relative_start_day, absolute_start_date)
  values ('e9a00000-0000-4000-8000-000000001001',
          'e9a00000-0000-4000-8000-000000004002', 1, 'Muddled', 'relative',
          1, '2026-01-01')$$, '23514'));

select _c('5.5 an energy target must be labelled kcal or kJ', _raises($$
  insert into public.nutrition_plan_versions
    (organization_id, plan_id, patient_id, version_number,
     energy_target_value, energy_target_unit)
  values ('e9a00000-0000-4000-8000-000000001001',
          'e9a00000-0000-4000-8000-000000006001',
          'e9a00000-0000-4000-8000-000000002001', 80, 2000, 'calories')$$, '23514'));

select _c('5.6 a nutrient target cannot be stored without a unit', (
  -- `unit` is NOT NULL on nutrition_targets, so an unlabelled number cannot
  -- reach storage at all.
  select is_nullable = 'NO' from information_schema.columns
  where table_schema = 'public' and table_name = 'nutrition_targets'
    and column_name = 'unit'));

-- ================================================== 6. safety flag overrides

select _c('6.1 an override with no reason is refused', _raises($$
  update public.nutrition_safety_flags
     set status = 'overridden', overridden_by = null, overridden_at = now()
   where id = 'e9a00000-0000-4000-8000-000000009001'$$, '23514'));

select _c('6.2 an override with a reason but no identity or time is refused', _raises($$
  update public.nutrition_safety_flags
     set status = 'overridden', override_reason = 'Clinically appropriate'
   where id = 'e9a00000-0000-4000-8000-000000009001'$$, '23514'));

-- Two STATEMENTS, not one expression: SQL does not promise to evaluate the
-- operands of `and` in order, so folding the write and the read-back together
-- let the check run against the pre-update row.
select _succeeds($$
  update public.nutrition_safety_flags
     set status = 'overridden', override_reason = 'Clinically appropriate',
         overridden_by = (select id from auth.users order by id limit 1),
         overridden_at = now()
   where id = 'e9a00000-0000-4000-8000-000000009001'$$) as _override_applied;

-- Reads the row back, so an update that matched nothing cannot read as a pass.
select _c('6.3 a fully documented override — reason, identity and time — commits', (
  select status = 'overridden' and override_reason is not null
         and overridden_by is not null and overridden_at is not null
  from public.nutrition_safety_flags
  where id = 'e9a00000-0000-4000-8000-000000009001'));

select _c('6.4 an invented safety-flag kind is refused', _raises($$
  insert into public.nutrition_safety_flags
    (organization_id, plan_version_id, kind, detail)
  values ('e9a00000-0000-4000-8000-000000001001',
          'e9a00000-0000-4000-8000-000000007002', 'vibes', 'Made up')$$, '23514'));

-- ==================================================== 7. adherence honesty

select _c('7.1 a check-in with no stated source is refused', _raises($$
  insert into public.nutrition_checkins
    (organization_id, patient_id, observed_on, source)
  values ('e9a00000-0000-4000-8000-000000001001',
          'e9a00000-0000-4000-8000-000000002001', current_date, null)$$, '23502'));

select _c('7.2 an invented check-in source is refused', _raises($$
  insert into public.nutrition_checkins
    (organization_id, patient_id, observed_on, source)
  values ('e9a00000-0000-4000-8000-000000001001',
          'e9a00000-0000-4000-8000-000000002001', current_date, 'assumed')$$, '23514'));

select _c('7.3 an impossible adherence percentage is refused', _raises($$
  insert into public.nutrition_checkins
    (organization_id, patient_id, observed_on, source, meal_plan_adherence_pct)
  values ('e9a00000-0000-4000-8000-000000001001',
          'e9a00000-0000-4000-8000-000000002001', current_date,
          'patient_reported', 140)$$, '23514'));

select _c('7.4 a weight must be labelled kg or lb', _raises($$
  insert into public.nutrition_checkins
    (organization_id, patient_id, observed_on, source, weight_value, weight_unit)
  values ('e9a00000-0000-4000-8000-000000001001',
          'e9a00000-0000-4000-8000-000000002001', current_date - 1,
          'patient_reported', 70, 'stone')$$, '23514'));

-- ================================================= 8. append-only history

select _c('8.1 plan events cannot be updated', _raises($$
  update public.nutrition_plan_events set kind = 'rewritten'
   where id = 'e9a00000-0000-4000-8000-00000000a001'$$, '42501'));

select _c('8.2 plan events cannot be deleted', _raises($$
  delete from public.nutrition_plan_events
   where id = 'e9a00000-0000-4000-8000-00000000a001'$$, '42501'));

select _c('8.3 amendments cannot be rewritten', _raises($$
  update public.nutrition_amendments set body = 'Rewritten'
   where id = 'e9a00000-0000-4000-8000-00000000b001'$$, '42501'));

select _c('8.4 provider lookups cannot be deleted', _raises($$
  delete from public.nutrition_provider_lookups
   where id = 'e9a00000-0000-4000-8000-00000000c001'$$, '42501'));

-- ============================================ 9. provider provenance & keys

select _c('9.1 a provider lookup cannot be recorded without a response hash', _raises($$
  insert into public.nutrition_provider_lookups (organization_id, capability)
  values ('e9a00000-0000-4000-8000-000000001001', 'food_search')$$, '23502'));

select _c('9.2 every single-column FK on the new tables has a LEADING index', (
  select count(*) = 0 from (
    select c.conname
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    join unnest(c.conkey) as k(attnum) on true
    where c.contype = 'f' and n.nspname = 'public'
      and t.relname in (select name from _tbls)
      and array_length(c.conkey, 1) = 1
      -- LEADING column: being second in a composite index does not help a
      -- lookup or a cascade by this column alone.
      and not exists (
        select 1 from pg_index i
        where i.indrelid = c.conrelid and (i.indkey::smallint[])[0] = k.attnum)
  ) missing));

-- ---------------------------------------------------------------- results
select n as check, ok from _r order by n;
select count(*) filter (where ok) as passed,
       count(*) filter (where not ok) as failed,
       count(*) as total from _r;

rollback;
