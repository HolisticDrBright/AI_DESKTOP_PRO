-- Phase 9A: nutrition assessment, templates, plans & adherence — RPCs.
--
-- Every caller RPC: SECURITY DEFINER, search_path pinned empty, explicit
-- auth.uid() identity, active-membership check, a clinical-role check for
-- anything that authors or approves, tenant agreement on every referenced
-- row, bounded DTOs, and typed errors: 28000 anonymous, 42501 forbidden,
-- P0002 not found, 22023 invalid, 40001 conflict. No PHI in any error text.
--
-- THE GATE THIS PHASE EXISTS FOR:
--   draft → in_review → approved → active, and a plan cannot reach `approved`
--   until safety has actually been EVALUATED and every blocking flag is either
--   resolved or overridden with a reason, a person and a time. The check lives
--   here, in the definer function, not in the browser — a client that skips the
--   safety screen still cannot approve.
--
-- REVISION NEVER OVERWRITES. `revise_nutrition_plan_version` copies an
-- approved or active version into a NEW draft. The old version keeps its
-- content, its approver and its timestamps forever; the immutability triggers
-- in the schema migration make that true even for a direct writer.
--
-- WHAT THE EVALUATOR WILL AND WILL NOT SAY. `evaluate_nutrition_plan_safety`
-- derives only flags it can actually determine from recorded data: allergens
-- that appear in the plan's own food guidance, absent demographics, a
-- paediatric age, and energy or macro targets that are internally
-- inconsistent. It does NOT claim a drug-nutrient interaction exists — no
-- governed interaction reference is loaded in this build — so recorded
-- medications raise a REVIEW PROMPT naming the count, never a finding. Every
-- other flag kind is available to a practitioner through
-- `raise_nutrition_safety_flag`, attributed to the person who raised it.

begin;

-- ------------------------------------------------------------- gates

create or replace function private.require_nutrition_read(_org uuid)
returns void language plpgsql stable security definer set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not private.is_org_member(_org) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
end;
$$;

create or replace function private.require_nutrition_author(_org uuid)
returns void language plpgsql stable security definer set search_path = ''
as $$
begin
  perform private.require_nutrition_read(_org);
  if not private.can_author_nutrition(_org) then
    raise exception 'authoring a nutrition plan requires a clinical role'
      using errcode = '42501';
  end if;
end;
$$;

create or replace function private.require_nutrition_approver(_org uuid)
returns void language plpgsql stable security definer set search_path = ''
as $$
begin
  perform private.require_nutrition_read(_org);
  if not private.can_approve_nutrition(_org) then
    raise exception 'approving a nutrition plan requires a clinical role'
      using errcode = '42501';
  end if;
end;
$$;

/** Patient access is a separate question from org membership. */
create or replace function private.require_nutrition_patient(_org uuid, _patient uuid)
returns void language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.can_access_patient(_patient) then
    raise exception 'record not found' using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from public.patient_profiles p
    where p.id = _patient and p.organization_id = _org
  ) then
    raise exception 'record not found' using errcode = 'P0002';
  end if;
end;
$$;

-- ------------------------------------------------------- content writer
--
-- Content arrives as one bounded jsonb document and REPLACES what the draft
-- version currently holds. Replacing rather than patching means the stored
-- content always equals what the author last saw; there is no partial-apply
-- state where half a meal plan is new and half is stale.

create or replace function private.write_nutrition_content(
  _org uuid, _owner_kind text, _owner_id uuid, _content jsonb
) returns void language plpgsql security definer set search_path = ''
as $$
declare
  _tv uuid := case when _owner_kind = 'template' then _owner_id end;
  _pv uuid := case when _owner_kind = 'plan' then _owner_id end;
  _phase jsonb; _rule jsonb; _day jsonb; _meal jsonb; _item jsonb;
  _recipe jsonb; _grocery jsonb; _target jsonb;
  _phase_map jsonb := '{}'::jsonb;
  _new_phase uuid; _new_day uuid; _new_meal uuid;
begin
  if _owner_kind not in ('template', 'plan') then
    raise exception 'unknown content owner' using errcode = '22023';
  end if;

  -- Meals and meal items cascade from their day, so deleting days is enough.
  delete from public.nutrition_meal_days
    where template_version_id is not distinct from _tv
      and plan_version_id is not distinct from _pv;
  delete from public.nutrition_food_rules
    where template_version_id is not distinct from _tv
      and plan_version_id is not distinct from _pv;
  delete from public.nutrition_recipes
    where template_version_id is not distinct from _tv
      and plan_version_id is not distinct from _pv;
  delete from public.nutrition_grocery_items
    where template_version_id is not distinct from _tv
      and plan_version_id is not distinct from _pv;
  delete from public.nutrition_targets
    where template_version_id is not distinct from _tv
      and plan_version_id is not distinct from _pv;
  delete from public.nutrition_phases
    where template_version_id is not distinct from _tv
      and plan_version_id is not distinct from _pv;

  for _phase in select * from jsonb_array_elements(coalesce(_content->'phases', '[]'::jsonb))
  loop
    insert into public.nutrition_phases (
      organization_id, template_version_id, plan_version_id, phase_number, name,
      description, timing_mode, relative_start_day, relative_duration_days,
      absolute_start_date, absolute_end_date, reintroduction_guidance)
    values (
      _org, _tv, _pv,
      (_phase->>'phaseNumber')::integer,
      _phase->>'name',
      _phase->>'description',
      coalesce(_phase->>'timingMode', 'relative'),
      nullif(_phase->>'relativeStartDay', '')::integer,
      nullif(_phase->>'relativeDurationDays', '')::integer,
      nullif(_phase->>'absoluteStartDate', '')::date,
      nullif(_phase->>'absoluteEndDate', '')::date,
      _phase->>'reintroductionGuidance')
    returning id into _new_phase;
    -- keyed by the author's own phase number, so rules and days can point at
    -- a phase without the client inventing database ids
    _phase_map := _phase_map || jsonb_build_object(_phase->>'phaseNumber', _new_phase);
  end loop;

  for _rule in select * from jsonb_array_elements(coalesce(_content->'foodRules', '[]'::jsonb))
  loop
    insert into public.nutrition_food_rules (
      organization_id, template_version_id, plan_version_id, phase_id,
      disposition, scope, label, canonical_source, canonical_id,
      portion_guidance, frequency_guidance, preparation_guidance,
      substitutions, condition_note, rationale, sort_order)
    values (
      _org, _tv, _pv,
      (_phase_map->>(_rule->>'phaseNumber'))::uuid,
      _rule->>'disposition',
      coalesce(_rule->>'scope', 'category'),
      _rule->>'label',
      nullif(_rule->>'canonicalSource', ''),
      nullif(_rule->>'canonicalId', ''),
      _rule->>'portionGuidance',
      _rule->>'frequencyGuidance',
      _rule->>'preparationGuidance',
      coalesce((select array_agg(value::text) from jsonb_array_elements_text(
        coalesce(_rule->'substitutions', '[]'::jsonb)) as value), '{}'),
      _rule->>'conditionNote',
      _rule->>'rationale',
      coalesce((_rule->>'sortOrder')::integer, 0));
  end loop;

  for _day in select * from jsonb_array_elements(coalesce(_content->'mealDays', '[]'::jsonb))
  loop
    insert into public.nutrition_meal_days (
      organization_id, template_version_id, plan_version_id, phase_id,
      day_number, label, notes)
    values (
      _org, _tv, _pv,
      (_phase_map->>(_day->>'phaseNumber'))::uuid,
      (_day->>'dayNumber')::integer, _day->>'label', _day->>'notes')
    returning id into _new_day;

    for _meal in select * from jsonb_array_elements(coalesce(_day->'meals', '[]'::jsonb))
    loop
      insert into public.nutrition_meals (
        organization_id, meal_day_id, meal_type, name, time_of_day, notes, sort_order)
      values (
        _org, _new_day, coalesce(_meal->>'mealType', 'meal'), _meal->>'name',
        _meal->>'timeOfDay', _meal->>'notes',
        coalesce((_meal->>'sortOrder')::integer, 0))
      returning id into _new_meal;

      for _item in select * from jsonb_array_elements(coalesce(_meal->'items', '[]'::jsonb))
      loop
        insert into public.nutrition_meal_items (
          organization_id, meal_id, label, quantity, unit,
          canonical_source, canonical_id, nutrient_source,
          energy_value, energy_unit, protein_g, carbohydrate_g, fat_g, fiber_g,
          preparation_note, substitutions, sort_order)
        values (
          _org, _new_meal, _item->>'label',
          nullif(_item->>'quantity', '')::numeric,
          nullif(_item->>'unit', ''),
          nullif(_item->>'canonicalSource', ''),
          nullif(_item->>'canonicalId', ''),
          nullif(_item->>'nutrientSource', ''),
          nullif(_item->>'energyValue', '')::numeric,
          nullif(_item->>'energyUnit', ''),
          nullif(_item->>'proteinG', '')::numeric,
          nullif(_item->>'carbohydrateG', '')::numeric,
          nullif(_item->>'fatG', '')::numeric,
          nullif(_item->>'fiberG', '')::numeric,
          _item->>'preparationNote',
          coalesce((select array_agg(value::text) from jsonb_array_elements_text(
            coalesce(_item->'substitutions', '[]'::jsonb)) as value), '{}'),
          coalesce((_item->>'sortOrder')::integer, 0));
      end loop;
    end loop;
  end loop;

  for _recipe in select * from jsonb_array_elements(coalesce(_content->'recipes', '[]'::jsonb))
  loop
    insert into public.nutrition_recipes (
      organization_id, template_version_id, plan_version_id,
      name, servings, ingredients, method, notes, sort_order)
    values (
      _org, _tv, _pv, _recipe->>'name',
      nullif(_recipe->>'servings', '')::integer,
      coalesce((select array_agg(value::text) from jsonb_array_elements_text(
        coalesce(_recipe->'ingredients', '[]'::jsonb)) as value), '{}'),
      _recipe->>'method', _recipe->>'notes',
      coalesce((_recipe->>'sortOrder')::integer, 0));
  end loop;

  for _grocery in select * from jsonb_array_elements(coalesce(_content->'groceryItems', '[]'::jsonb))
  loop
    insert into public.nutrition_grocery_items (
      organization_id, template_version_id, plan_version_id,
      category, label, quantity_note, sort_order)
    values (
      _org, _tv, _pv, coalesce(_grocery->>'category', 'other'),
      _grocery->>'label', _grocery->>'quantityNote',
      coalesce((_grocery->>'sortOrder')::integer, 0));
  end loop;

  for _target in select * from jsonb_array_elements(coalesce(_content->'targets', '[]'::jsonb))
  loop
    -- A nutrient target without a unit is a safety problem, not a rounding one.
    if coalesce(_target->>'unit', '') = '' then
      raise exception 'a nutrient target must carry a unit' using errcode = '22023';
    end if;
    insert into public.nutrition_targets (
      organization_id, patient_id, template_version_id, plan_version_id,
      nutrient, label, target_value, minimum_value, maximum_value, unit,
      period, rationale, source, created_by, updated_by)
    values (
      _org,
      (select pv.patient_id from public.nutrition_plan_versions pv where pv.id = _pv),
      _tv, _pv,
      _target->>'nutrient', _target->>'label',
      nullif(_target->>'targetValue', '')::numeric,
      nullif(_target->>'minimumValue', '')::numeric,
      nullif(_target->>'maximumValue', '')::numeric,
      _target->>'unit',
      coalesce(_target->>'period', 'daily'),
      _target->>'rationale',
      'practitioner_entered', auth.uid(), auth.uid());
  end loop;
end;
$$;

/** Copy one version's content onto another. Used by revise and by adopt. */
create or replace function private.copy_nutrition_content(
  _org uuid, _from_kind text, _from_id uuid, _to_kind text, _to_id uuid
) returns void language plpgsql security definer set search_path = ''
as $$
declare
  _from_tv uuid := case when _from_kind = 'template' then _from_id end;
  _from_pv uuid := case when _from_kind = 'plan' then _from_id end;
  _to_tv uuid := case when _to_kind = 'template' then _to_id end;
  _to_pv uuid := case when _to_kind = 'plan' then _to_id end;
  _p record; _d record; _m record;
  _new_phase uuid; _new_day uuid; _new_meal uuid;
  _phase_map jsonb := '{}'::jsonb;
begin
  for _p in
    select * from public.nutrition_phases
    where template_version_id is not distinct from _from_tv
      and plan_version_id is not distinct from _from_pv
    order by phase_number
  loop
    insert into public.nutrition_phases (
      organization_id, template_version_id, plan_version_id, phase_number, name,
      description, timing_mode, relative_start_day, relative_duration_days,
      absolute_start_date, absolute_end_date, reintroduction_guidance)
    values (_org, _to_tv, _to_pv, _p.phase_number, _p.name, _p.description,
            _p.timing_mode, _p.relative_start_day, _p.relative_duration_days,
            _p.absolute_start_date, _p.absolute_end_date, _p.reintroduction_guidance)
    returning id into _new_phase;
    _phase_map := _phase_map || jsonb_build_object(_p.id::text, _new_phase);
  end loop;

  insert into public.nutrition_food_rules (
    organization_id, template_version_id, plan_version_id, phase_id, disposition,
    scope, label, canonical_source, canonical_id, portion_guidance,
    frequency_guidance, preparation_guidance, substitutions, condition_note,
    rationale, sort_order)
  select _org, _to_tv, _to_pv, (_phase_map->>(r.phase_id::text))::uuid, r.disposition,
         r.scope, r.label, r.canonical_source, r.canonical_id, r.portion_guidance,
         r.frequency_guidance, r.preparation_guidance, r.substitutions,
         r.condition_note, r.rationale, r.sort_order
  from public.nutrition_food_rules r
  where r.template_version_id is not distinct from _from_tv
    and r.plan_version_id is not distinct from _from_pv;

  for _d in
    select * from public.nutrition_meal_days
    where template_version_id is not distinct from _from_tv
      and plan_version_id is not distinct from _from_pv
    order by day_number
  loop
    insert into public.nutrition_meal_days (
      organization_id, template_version_id, plan_version_id, phase_id,
      day_number, label, notes)
    values (_org, _to_tv, _to_pv, (_phase_map->>(_d.phase_id::text))::uuid,
            _d.day_number, _d.label, _d.notes)
    returning id into _new_day;

    for _m in
      select * from public.nutrition_meals where meal_day_id = _d.id order by sort_order
    loop
      insert into public.nutrition_meals (
        organization_id, meal_day_id, meal_type, name, time_of_day, notes, sort_order)
      values (_org, _new_day, _m.meal_type, _m.name, _m.time_of_day, _m.notes, _m.sort_order)
      returning id into _new_meal;

      insert into public.nutrition_meal_items (
        organization_id, meal_id, label, quantity, unit, canonical_source,
        canonical_id, nutrient_source, energy_value, energy_unit, protein_g,
        carbohydrate_g, fat_g, fiber_g, preparation_note, substitutions, sort_order)
      select _org, _new_meal, i.label, i.quantity, i.unit, i.canonical_source,
             i.canonical_id, i.nutrient_source, i.energy_value, i.energy_unit,
             i.protein_g, i.carbohydrate_g, i.fat_g, i.fiber_g,
             i.preparation_note, i.substitutions, i.sort_order
      from public.nutrition_meal_items i where i.meal_id = _m.id;
    end loop;
  end loop;

  insert into public.nutrition_recipes (
    organization_id, template_version_id, plan_version_id, name, servings,
    ingredients, method, notes, sort_order)
  select _org, _to_tv, _to_pv, x.name, x.servings, x.ingredients, x.method,
         x.notes, x.sort_order
  from public.nutrition_recipes x
  where x.template_version_id is not distinct from _from_tv
    and x.plan_version_id is not distinct from _from_pv;

  insert into public.nutrition_grocery_items (
    organization_id, template_version_id, plan_version_id, category, label,
    quantity_note, sort_order)
  select _org, _to_tv, _to_pv, g.category, g.label, g.quantity_note, g.sort_order
  from public.nutrition_grocery_items g
  where g.template_version_id is not distinct from _from_tv
    and g.plan_version_id is not distinct from _from_pv;

  insert into public.nutrition_targets (
    organization_id, patient_id, template_version_id, plan_version_id, nutrient,
    label, target_value, minimum_value, maximum_value, unit, period, rationale,
    source, created_by, updated_by)
  select _org,
         (select pv.patient_id from public.nutrition_plan_versions pv where pv.id = _to_pv),
         _to_tv, _to_pv, t.nutrient, t.label, t.target_value, t.minimum_value,
         t.maximum_value, t.unit, t.period, t.rationale, 'practitioner_entered',
         auth.uid(), auth.uid()
  from public.nutrition_targets t
  where t.template_version_id is not distinct from _from_tv
    and t.plan_version_id is not distinct from _from_pv;
end;
$$;

-- ------------------------------------------------------------ templates

create or replace function public.upsert_nutrition_template(
  _organization_id uuid, _name text, _pattern text default 'custom',
  _summary text default null, _template_id uuid default null,
  _expected_version integer default null
) returns uuid language plpgsql security definer set search_path = ''
as $$
declare _id uuid; _current integer;
begin
  perform private.require_nutrition_author(_organization_id);
  if coalesce(trim(_name), '') = '' then
    raise exception 'a template needs a name' using errcode = '22023';
  end if;

  if _template_id is null then
    insert into public.nutrition_templates (
      organization_id, name, pattern, summary, created_by, updated_by)
    values (_organization_id, trim(_name), _pattern, _summary, auth.uid(), auth.uid())
    returning id into _id;

    insert into public.nutrition_template_events (
      organization_id, template_id, kind, to_status, actor_user_id)
    values (_organization_id, _id, 'created', 'draft', auth.uid());
    return _id;
  end if;

  select version into _current from public.nutrition_templates
   where id = _template_id and organization_id = _organization_id for update;
  if not found then
    raise exception 'record not found' using errcode = 'P0002';
  end if;
  if _expected_version is not null and _expected_version <> _current then
    raise exception 'this template changed since it was loaded' using errcode = '40001';
  end if;

  update public.nutrition_templates
     set name = trim(_name), pattern = _pattern, summary = _summary,
         version = version + 1, updated_at = now(), updated_by = auth.uid()
   where id = _template_id;
  return _template_id;
end;
$$;

create or replace function public.create_nutrition_template_version(
  _organization_id uuid, _template_id uuid,
  _purpose text default null, _intended_use text default null,
  _patient_education text default null, _education_vs_advice_note text default null,
  _caution_populations text[] default '{}', _prerequisites text[] default '{}',
  _missing_information_required text[] default '{}',
  _evidence_grade text default null, _evidence_summary text default null,
  _requires_practitioner_review boolean default true,
  _copy_from_version_id uuid default null
) returns uuid language plpgsql security definer set search_path = ''
as $$
declare _next integer; _id uuid;
begin
  perform private.require_nutrition_author(_organization_id);
  if not exists (select 1 from public.nutrition_templates
                 where id = _template_id and organization_id = _organization_id) then
    raise exception 'record not found' using errcode = 'P0002';
  end if;

  select coalesce(max(version_number), 0) + 1 into _next
    from public.nutrition_template_versions where template_id = _template_id;

  insert into public.nutrition_template_versions (
    organization_id, template_id, version_number, purpose, intended_use,
    patient_education, education_vs_advice_note, caution_populations,
    prerequisites, missing_information_required, evidence_grade,
    evidence_summary, requires_practitioner_review, created_by)
  values (
    _organization_id, _template_id, _next, _purpose, _intended_use,
    _patient_education, _education_vs_advice_note,
    coalesce(_caution_populations, '{}'), coalesce(_prerequisites, '{}'),
    coalesce(_missing_information_required, '{}'), _evidence_grade,
    _evidence_summary, coalesce(_requires_practitioner_review, true), auth.uid())
  returning id into _id;

  if _copy_from_version_id is not null then
    if not exists (select 1 from public.nutrition_template_versions
                   where id = _copy_from_version_id and organization_id = _organization_id) then
      raise exception 'record not found' using errcode = 'P0002';
    end if;
    perform private.copy_nutrition_content(
      _organization_id, 'template', _copy_from_version_id, 'template', _id);
  end if;

  insert into public.nutrition_template_events (
    organization_id, template_id, template_version_id, kind, to_status, actor_user_id)
  values (_organization_id, _template_id, _id, 'version_created', 'draft', auth.uid());
  return _id;
end;
$$;

create or replace function public.save_nutrition_template_content(
  _organization_id uuid, _template_version_id uuid, _content jsonb
) returns void language plpgsql security definer set search_path = ''
as $$
declare _status text;
begin
  perform private.require_nutrition_author(_organization_id);
  select status into _status from public.nutrition_template_versions
   where id = _template_version_id and organization_id = _organization_id for update;
  if not found then
    raise exception 'record not found' using errcode = 'P0002';
  end if;
  if _status not in ('draft', 'in_review') then
    raise exception 'only a draft template version can be edited' using errcode = '40001';
  end if;
  perform private.write_nutrition_content(
    _organization_id, 'template', _template_version_id, _content);
end;
$$;

/** Record a governed reference behind a template version's evidence claim. */
create or replace function public.record_nutrition_template_reference(
  _organization_id uuid, _template_version_id uuid,
  _label text, _reference_id text default null, _detail text default null
) returns uuid language plpgsql security definer set search_path = ''
as $$
declare _id uuid;
begin
  perform private.require_nutrition_author(_organization_id);
  if not exists (select 1 from public.nutrition_template_versions
                 where id = _template_version_id and organization_id = _organization_id) then
    raise exception 'record not found' using errcode = 'P0002';
  end if;
  if coalesce(trim(_label), '') = '' then
    raise exception 'a reference needs a label' using errcode = '22023';
  end if;
  insert into public.nutrition_provenance (
    organization_id, template_version_id, kind, label, reference_id, detail)
  values (_organization_id, _template_version_id, 'governed_reference',
          trim(_label), _reference_id, _detail)
  returning id into _id;
  return _id;
end;
$$;

create or replace function public.publish_nutrition_template_version(
  _organization_id uuid, _template_version_id uuid
) returns void language plpgsql security definer set search_path = ''
as $$
declare _v public.nutrition_template_versions; _prev uuid;
begin
  perform private.require_nutrition_approver(_organization_id);
  select * into _v from public.nutrition_template_versions
   where id = _template_version_id and organization_id = _organization_id for update;
  if not found then
    raise exception 'record not found' using errcode = 'P0002';
  end if;
  if _v.status not in ('draft', 'in_review', 'approved') then
    raise exception 'this template version cannot be published from its current state'
      using errcode = '40001';
  end if;
  -- A template with nothing in it is not a template.
  if not exists (
    select 1 from public.nutrition_food_rules where template_version_id = _v.id
    union all
    select 1 from public.nutrition_meal_days where template_version_id = _v.id
  ) then
    raise exception 'a template needs food guidance or a meal plan before publishing'
      using errcode = '22023';
  end if;

  select id into _prev from public.nutrition_template_versions
   where template_id = _v.template_id and status = 'published' and id <> _v.id;

  update public.nutrition_template_versions
     set status = 'published', published_at = now(),
         reviewed_by = auth.uid(), reviewed_at = now()
   where id = _v.id;

  if _prev is not null then
    update public.nutrition_template_versions
       set status = 'superseded', superseded_by_version_id = _v.id
     where id = _prev;
  end if;

  update public.nutrition_templates
     set current_version_id = _v.id, status = 'active',
         version = version + 1, updated_at = now(), updated_by = auth.uid()
   where id = _v.template_id;

  insert into public.nutrition_template_events (
    organization_id, template_id, template_version_id, kind, from_status,
    to_status, actor_user_id)
  values (_organization_id, _v.template_id, _v.id, 'published', _v.status,
          'published', auth.uid());
end;
$$;

create or replace function public.archive_nutrition_template(
  _organization_id uuid, _template_id uuid, _reason text
) returns void language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_nutrition_author(_organization_id);
  if coalesce(trim(_reason), '') = '' then
    raise exception 'archiving needs a reason' using errcode = '22023';
  end if;
  update public.nutrition_templates
     set status = 'archived', archived_at = now(), version = version + 1,
         updated_at = now(), updated_by = auth.uid()
   where id = _template_id and organization_id = _organization_id;
  if not found then
    raise exception 'record not found' using errcode = 'P0002';
  end if;
  insert into public.nutrition_template_events (
    organization_id, template_id, kind, to_status, detail, actor_user_id)
  values (_organization_id, _template_id, 'archived', 'archived', trim(_reason), auth.uid());
end;
$$;

-- --------------------------------------------------------- patient plans

create or replace function public.create_nutrition_plan(
  _organization_id uuid, _patient_id uuid, _title text,
  _source_template_version_id uuid default null
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _plan uuid; _version uuid; _tv public.nutrition_template_versions;
begin
  perform private.require_nutrition_author(_organization_id);
  perform private.require_nutrition_patient(_organization_id, _patient_id);
  if coalesce(trim(_title), '') = '' then
    raise exception 'a plan needs a title' using errcode = '22023';
  end if;

  if _source_template_version_id is not null then
    select * into _tv from public.nutrition_template_versions
     where id = _source_template_version_id and organization_id = _organization_id;
    if not found then
      raise exception 'record not found' using errcode = 'P0002';
    end if;
    -- Only a PUBLISHED template may be given to a patient. A draft has not
    -- been through review, and a plan built from one would inherit that.
    if _tv.status <> 'published' then
      raise exception 'only a published template version can start a patient plan'
        using errcode = '40001';
    end if;
  end if;

  insert into public.nutrition_plans (
    organization_id, patient_id, title, created_by, updated_by)
  values (_organization_id, _patient_id, trim(_title), auth.uid(), auth.uid())
  returning id into _plan;

  insert into public.nutrition_plan_versions (
    organization_id, plan_id, patient_id, version_number,
    source_template_id, source_template_version_id,
    source_template_name_snapshot, source_template_version_snapshot, created_by, updated_by)
  values (
    _organization_id, _plan, _patient_id, 1,
    _tv.template_id, _tv.id,
    (select t.name from public.nutrition_templates t where t.id = _tv.template_id),
    _tv.version_number, auth.uid(), auth.uid())
  returning id into _version;

  update public.nutrition_plans set current_version_id = _version where id = _plan;

  if _tv.id is not null then
    perform private.copy_nutrition_content(
      _organization_id, 'template', _tv.id, 'plan', _version);
    insert into public.nutrition_provenance (
      organization_id, plan_version_id, kind, label, reference_id, detail)
    values (_organization_id, _version, 'template_version',
            coalesce((select t.name from public.nutrition_templates t where t.id = _tv.template_id),
                     'template'),
            _tv.id::text,
            'Snapshot taken at creation; later edits to the template do not change this plan.');
  end if;

  insert into public.nutrition_plan_events (
    organization_id, plan_id, plan_version_id, kind, to_status, actor_user_id)
  values (_organization_id, _plan, _version, 'created', 'draft', auth.uid());

  return jsonb_build_object('planId', _plan, 'planVersionId', _version);
end;
$$;

create or replace function public.save_nutrition_plan_version(
  _organization_id uuid, _plan_version_id uuid, _expected_version integer,
  _goals text[] default null, _practitioner_rationale text default null,
  _patient_instructions text default null, _meal_timing_guidance text default null,
  _fasting_instructions text default null,
  _energy_target_value numeric default null, _energy_target_unit text default null,
  _protein_g numeric default null, _carbohydrate_g numeric default null,
  _fat_g numeric default null, _fiber_g numeric default null,
  _protein_pct numeric default null, _carbohydrate_pct numeric default null,
  _fat_pct numeric default null,
  _content jsonb default null, _autosave boolean default false
) returns integer language plpgsql security definer set search_path = ''
as $$
declare _v public.nutrition_plan_versions;
begin
  perform private.require_nutrition_author(_organization_id);
  select * into _v from public.nutrition_plan_versions
   where id = _plan_version_id and organization_id = _organization_id for update;
  if not found then
    raise exception 'record not found' using errcode = 'P0002';
  end if;
  perform private.require_nutrition_patient(_organization_id, _v.patient_id);

  if _v.status not in ('draft', 'in_review') then
    raise exception 'an approved plan version cannot be edited; revise it into a new draft'
      using errcode = '40001';
  end if;
  if _expected_version <> _v.version then
    raise exception 'this plan changed since it was loaded' using errcode = '40001';
  end if;
  -- An energy number without a unit is exactly the ambiguity this phase exists
  -- to remove, so it is refused rather than defaulted.
  if _energy_target_value is not null and coalesce(_energy_target_unit, '') = '' then
    raise exception 'an energy target must carry a unit' using errcode = '22023';
  end if;

  update public.nutrition_plan_versions
     set goals = coalesce(_goals, goals),
         practitioner_rationale = coalesce(_practitioner_rationale, practitioner_rationale),
         patient_instructions = coalesce(_patient_instructions, patient_instructions),
         meal_timing_guidance = coalesce(_meal_timing_guidance, meal_timing_guidance),
         fasting_instructions = coalesce(_fasting_instructions, fasting_instructions),
         energy_target_value = coalesce(_energy_target_value, energy_target_value),
         energy_target_unit = coalesce(_energy_target_unit, energy_target_unit),
         protein_g = coalesce(_protein_g, protein_g),
         carbohydrate_g = coalesce(_carbohydrate_g, carbohydrate_g),
         fat_g = coalesce(_fat_g, fat_g),
         fiber_g = coalesce(_fiber_g, fiber_g),
         protein_pct = coalesce(_protein_pct, protein_pct),
         carbohydrate_pct = coalesce(_carbohydrate_pct, carbohydrate_pct),
         fat_pct = coalesce(_fat_pct, fat_pct),
         version = version + 1,
         autosaved_at = case when _autosave then now() else autosaved_at end,
         updated_at = now(), updated_by = auth.uid()
   where id = _plan_version_id;

  if _content is not null then
    perform private.write_nutrition_content(
      _organization_id, 'plan', _plan_version_id, _content);
  end if;

  return _v.version + 1;
end;
$$;

create or replace function public.set_nutrition_plan_constraints(
  _organization_id uuid, _plan_version_id uuid, _constraints jsonb
) returns integer language plpgsql security definer set search_path = ''
as $$
declare _v public.nutrition_plan_versions; _c jsonb; _n integer := 0;
begin
  perform private.require_nutrition_author(_organization_id);
  select * into _v from public.nutrition_plan_versions
   where id = _plan_version_id and organization_id = _organization_id for update;
  if not found then
    raise exception 'record not found' using errcode = 'P0002';
  end if;
  perform private.require_nutrition_patient(_organization_id, _v.patient_id);
  if _v.status not in ('draft', 'in_review') then
    raise exception 'constraints belong to a draft version' using errcode = '40001';
  end if;

  delete from public.nutrition_constraints where plan_version_id = _plan_version_id;
  for _c in select * from jsonb_array_elements(coalesce(_constraints, '[]'::jsonb))
  loop
    insert into public.nutrition_constraints (
      organization_id, plan_version_id, kind, label, detail, severity,
      source, source_record_id, created_by)
    values (
      _organization_id, _plan_version_id, _c->>'kind', _c->>'label', _c->>'detail',
      nullif(_c->>'severity', ''),
      coalesce(_c->>'source', 'practitioner_entered'),
      nullif(_c->>'sourceRecordId', '')::uuid, auth.uid());
    _n := _n + 1;
  end loop;
  return _n;
end;
$$;

-- ------------------------------------------------------- safety review

/**
 * Recompute the derivable safety flags for a draft plan version.
 *
 * Open flags are cleared and rebuilt so the screen always reflects the CURRENT
 * plan; flags a practitioner already overrode or resolved are left alone, so a
 * documented decision is never silently discarded by a re-run.
 */
create or replace function public.evaluate_nutrition_plan_safety(
  _organization_id uuid, _plan_version_id uuid
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  _v public.nutrition_plan_versions;
  _p public.patient_profiles;
  _allergy record;
  _med_count integer;
  _age_years numeric;
  _energy_kcal numeric;
  _pct_sum numeric;
  _macro_kcal numeric;
  _blocking integer := 0;
  _review integer := 0;
begin
  perform private.require_nutrition_author(_organization_id);
  select * into _v from public.nutrition_plan_versions
   where id = _plan_version_id and organization_id = _organization_id;
  if not found then
    raise exception 'record not found' using errcode = 'P0002';
  end if;
  perform private.require_nutrition_patient(_organization_id, _v.patient_id);
  if _v.status not in ('draft', 'in_review') then
    raise exception 'safety review runs on a draft version' using errcode = '40001';
  end if;

  delete from public.nutrition_safety_flags
   where plan_version_id = _plan_version_id and status = 'open';

  select * into _p from public.patient_profiles where id = _v.patient_id;

  -- Recorded allergies. A flag is raised for EVERY active allergy so the
  -- practitioner confirms it was considered; it escalates to blocking when the
  -- allergen actually appears in food the plan tells the patient to eat.
  for _allergy in
    select a.allergen, a.severity from public.allergies a
    where a.patient_id = _v.patient_id and a.organization_id = _organization_id
      and a.deleted_at is null and coalesce(a.status, 'active') = 'active'
  loop
    if exists (
      select 1 from public.nutrition_food_rules r
      where r.plan_version_id = _plan_version_id
        and r.disposition in ('emphasize', 'include')
        and r.label ilike '%' || _allergy.allergen || '%'
      union all
      select 1 from public.nutrition_meal_items i
      join public.nutrition_meals m on m.id = i.meal_id
      join public.nutrition_meal_days d on d.id = m.meal_day_id
      where d.plan_version_id = _plan_version_id
        and i.label ilike '%' || _allergy.allergen || '%'
    ) then
      insert into public.nutrition_safety_flags (
        organization_id, plan_version_id, kind, severity, detail, evidence_ref)
      values (_organization_id, _plan_version_id, 'recorded_allergy', 'blocking',
              'A recorded allergen appears in food this plan tells the patient to eat.',
              'allergies');
      _blocking := _blocking + 1;
    else
      insert into public.nutrition_safety_flags (
        organization_id, plan_version_id, kind, severity, detail, evidence_ref)
      values (_organization_id, _plan_version_id, 'recorded_allergy', 'review',
              'An allergy is recorded in the chart. Confirm this plan accounts for it.',
              'allergies');
      _review := _review + 1;
    end if;
  end loop;

  -- Medications. This build has NO governed drug-nutrient interaction
  -- reference, so it prompts a human to check rather than asserting a finding.
  select count(*) into _med_count from public.medications m
   where m.patient_id = _v.patient_id and m.organization_id = _organization_id
     and m.deleted_at is null and coalesce(m.status, 'active') = 'active';
  if _med_count > 0 then
    insert into public.nutrition_safety_flags (
      organization_id, plan_version_id, kind, severity, detail, evidence_ref)
    values (_organization_id, _plan_version_id, 'medication_food_interaction', 'review',
            _med_count || ' active medication(s) are recorded. This build holds no governed '
            || 'drug-nutrient interaction reference, so confirm interactions yourself.',
            'medications');
    _review := _review + 1;
  end if;

  -- Demographics the plan depends on.
  if _p.date_of_birth is null or _p.sex is null then
    insert into public.nutrition_safety_flags (
      organization_id, plan_version_id, kind, severity, detail, evidence_ref)
    values (_organization_id, _plan_version_id, 'missing_demographics', 'review',
            'Date of birth or sex is not recorded, so energy and macro targets '
            || 'cannot be sanity-checked against the usual ranges.', 'patient_profiles');
    _review := _review + 1;
  else
    _age_years := extract(year from age(_p.date_of_birth));
    if _age_years < 18 then
      insert into public.nutrition_safety_flags (
        organization_id, plan_version_id, kind, severity, detail, evidence_ref)
      values (_organization_id, _plan_version_id, 'pediatric', 'blocking',
              'This patient is under 18. A paediatric nutrition plan needs explicit '
              || 'clinical sign-off before it is activated.', 'patient_profiles');
      _blocking := _blocking + 1;
    end if;
  end if;

  -- Nothing recorded about what the patient can eat.
  if not exists (select 1 from public.nutrition_constraints
                 where plan_version_id = _plan_version_id) then
    insert into public.nutrition_safety_flags (
      organization_id, plan_version_id, kind, severity, detail)
    values (_organization_id, _plan_version_id, 'missing_safety_information', 'review',
            'No allergies, intolerances, access or cooking constraints are recorded '
            || 'against this plan. Confirm the assessment was completed.');
    _review := _review + 1;
  end if;

  -- Internally inconsistent targets. These are ARITHMETIC checks on what was
  -- entered, not a judgement about what the patient needs.
  if _v.energy_target_value is not null then
    _energy_kcal := case when _v.energy_target_unit = 'kJ'
                         then _v.energy_target_value / 4.184
                         else _v.energy_target_value end;
    if _energy_kcal < 800 or _energy_kcal > 5000 then
      insert into public.nutrition_safety_flags (
        organization_id, plan_version_id, kind, severity, detail)
      values (_organization_id, _plan_version_id, 'extreme_or_inconsistent_targets', 'blocking',
              'The daily energy target is outside the range this system will approve '
              || 'without an explicit, reasoned override.');
      _blocking := _blocking + 1;
    end if;

    if _v.protein_g is not null and _v.carbohydrate_g is not null and _v.fat_g is not null then
      _macro_kcal := _v.protein_g * 4 + _v.carbohydrate_g * 4 + _v.fat_g * 9;
      if abs(_macro_kcal - _energy_kcal) > _energy_kcal * 0.25 then
        insert into public.nutrition_safety_flags (
          organization_id, plan_version_id, kind, severity, detail)
        values (_organization_id, _plan_version_id, 'extreme_or_inconsistent_targets', 'review',
                'The macro grams and the energy target disagree by more than 25 percent.');
        _review := _review + 1;
      end if;
    end if;
  end if;

  if _v.protein_pct is not null and _v.carbohydrate_pct is not null and _v.fat_pct is not null then
    _pct_sum := _v.protein_pct + _v.carbohydrate_pct + _v.fat_pct;
    if _pct_sum < 95 or _pct_sum > 105 then
      insert into public.nutrition_safety_flags (
        organization_id, plan_version_id, kind, severity, detail)
      values (_organization_id, _plan_version_id, 'extreme_or_inconsistent_targets', 'review',
              'The macronutrient percentages do not add up to 100.');
      _review := _review + 1;
    end if;
  end if;

  insert into public.nutrition_plan_events (
    organization_id, plan_id, plan_version_id, kind, detail, actor_user_id)
  values (_organization_id, _v.plan_id, _plan_version_id, 'safety_evaluated',
          _blocking || ' blocking, ' || _review || ' review', auth.uid());

  return jsonb_build_object('blocking', _blocking, 'review', _review);
end;
$$;

/** A practitioner-raised flag: the kinds a machine cannot derive honestly. */
create or replace function public.raise_nutrition_safety_flag(
  _organization_id uuid, _plan_version_id uuid, _kind text,
  _severity text, _detail text
) returns uuid language plpgsql security definer set search_path = ''
as $$
declare _id uuid; _v public.nutrition_plan_versions;
begin
  perform private.require_nutrition_author(_organization_id);
  select * into _v from public.nutrition_plan_versions
   where id = _plan_version_id and organization_id = _organization_id;
  if not found then
    raise exception 'record not found' using errcode = 'P0002';
  end if;
  perform private.require_nutrition_patient(_organization_id, _v.patient_id);
  if coalesce(trim(_detail), '') = '' then
    raise exception 'a safety flag needs a detail' using errcode = '22023';
  end if;

  insert into public.nutrition_safety_flags (
    organization_id, plan_version_id, kind, severity, detail, evidence_ref)
  values (_organization_id, _plan_version_id, _kind, coalesce(_severity, 'review'),
          trim(_detail), 'practitioner_raised')
  returning id into _id;
  return _id;
end;
$$;

create or replace function public.resolve_nutrition_safety_flag(
  _organization_id uuid, _flag_id uuid, _action text, _reason text default null
) returns void language plpgsql security definer set search_path = ''
as $$
declare _f public.nutrition_safety_flags;
begin
  perform private.require_nutrition_approver(_organization_id);
  select * into _f from public.nutrition_safety_flags
   where id = _flag_id and organization_id = _organization_id for update;
  if not found then
    raise exception 'record not found' using errcode = 'P0002';
  end if;
  if _action not in ('acknowledge', 'override', 'resolve') then
    raise exception 'unknown action' using errcode = '22023';
  end if;
  -- Overriding a safety flag is a clinical decision, and an undocumented one
  -- is worse than none: the reason is required, not encouraged.
  if _action = 'override' and coalesce(trim(_reason), '') = '' then
    raise exception 'overriding a safety flag requires a reason' using errcode = '22023';
  end if;

  update public.nutrition_safety_flags
     set status = case _action when 'acknowledge' then 'acknowledged'
                               when 'override' then 'overridden'
                               else 'resolved' end,
         override_reason = case when _action = 'override' then trim(_reason)
                                else override_reason end,
         overridden_by = case when _action = 'override' then auth.uid() else overridden_by end,
         overridden_at = case when _action = 'override' then now() else overridden_at end,
         resolved_at = case when _action = 'resolve' then now() else resolved_at end
   where id = _flag_id;

  insert into public.nutrition_plan_events (
    organization_id, plan_id, plan_version_id, kind, detail, actor_user_id)
  select _organization_id, v.plan_id, v.id, 'safety_flag_' || _action,
         _f.kind, auth.uid()
  from public.nutrition_plan_versions v where v.id = _f.plan_version_id;
end;
$$;

-- ---------------------------------------------------------- lifecycle

create or replace function public.submit_nutrition_plan_version(
  _organization_id uuid, _plan_version_id uuid
) returns void language plpgsql security definer set search_path = ''
as $$
declare _v public.nutrition_plan_versions;
begin
  perform private.require_nutrition_author(_organization_id);
  select * into _v from public.nutrition_plan_versions
   where id = _plan_version_id and organization_id = _organization_id for update;
  if not found then
    raise exception 'record not found' using errcode = 'P0002';
  end if;
  perform private.require_nutrition_patient(_organization_id, _v.patient_id);
  if _v.status <> 'draft' then
    raise exception 'only a draft version can be submitted' using errcode = '40001';
  end if;

  update public.nutrition_plan_versions
     set status = 'in_review', submitted_at = now(), version = version + 1,
         updated_at = now(), updated_by = auth.uid()
   where id = _plan_version_id;
  update public.nutrition_plans
     set status = 'in_review', updated_at = now(), updated_by = auth.uid()
   where id = _v.plan_id;

  insert into public.nutrition_plan_events (
    organization_id, plan_id, plan_version_id, kind, from_status, to_status, actor_user_id)
  values (_organization_id, _v.plan_id, _plan_version_id, 'submitted', 'draft',
          'in_review', auth.uid());
end;
$$;

/**
 * Approve — the gate.
 *
 * Refuses unless safety has actually been evaluated for this version and no
 * blocking flag is still open or merely acknowledged. Acknowledging a blocking
 * flag is not the same as deciding about it; only an override with a reason,
 * or a resolution, clears the way.
 */
create or replace function public.approve_nutrition_plan_version(
  _organization_id uuid, _plan_version_id uuid, _note text default null
) returns void language plpgsql security definer set search_path = ''
as $$
declare _v public.nutrition_plan_versions; _blocking integer;
begin
  perform private.require_nutrition_approver(_organization_id);
  select * into _v from public.nutrition_plan_versions
   where id = _plan_version_id and organization_id = _organization_id for update;
  if not found then
    raise exception 'record not found' using errcode = 'P0002';
  end if;
  perform private.require_nutrition_patient(_organization_id, _v.patient_id);
  if _v.status <> 'in_review' then
    raise exception 'only a version in review can be approved' using errcode = '40001';
  end if;

  if not exists (
    select 1 from public.nutrition_plan_events
    where plan_version_id = _plan_version_id and kind = 'safety_evaluated'
  ) then
    raise exception 'safety review has not been run for this version' using errcode = '40001';
  end if;

  select count(*) into _blocking from public.nutrition_safety_flags
   where plan_version_id = _plan_version_id and severity = 'blocking'
     and status in ('open', 'acknowledged');
  if _blocking > 0 then
    raise exception 'this version has % unresolved blocking safety flag(s)', _blocking
      using errcode = '40001';
  end if;

  update public.nutrition_plan_versions
     set status = 'approved', approved_at = now(), approved_by = auth.uid(),
         version = version + 1, updated_at = now(), updated_by = auth.uid()
   where id = _plan_version_id;
  update public.nutrition_plans
     set status = 'approved', updated_at = now(), updated_by = auth.uid()
   where id = _v.plan_id;

  insert into public.nutrition_plan_events (
    organization_id, plan_id, plan_version_id, kind, from_status, to_status,
    detail, actor_user_id)
  values (_organization_id, _v.plan_id, _plan_version_id, 'approved', 'in_review',
          'approved', _note, auth.uid());
end;
$$;

create or replace function public.activate_nutrition_plan_version(
  _organization_id uuid, _plan_version_id uuid
) returns void language plpgsql security definer set search_path = ''
as $$
declare _v public.nutrition_plan_versions; _prior uuid;
begin
  perform private.require_nutrition_approver(_organization_id);
  select * into _v from public.nutrition_plan_versions
   where id = _plan_version_id and organization_id = _organization_id for update;
  if not found then
    raise exception 'record not found' using errcode = 'P0002';
  end if;
  perform private.require_nutrition_patient(_organization_id, _v.patient_id);
  if _v.status <> 'approved' then
    raise exception 'only an approved version can be activated' using errcode = '40001';
  end if;

  -- Another live plan for the same patient is a clinical hazard, so it is
  -- superseded here rather than left to collide with the unique index.
  select id into _prior from public.nutrition_plans
   where organization_id = _organization_id and patient_id = _v.patient_id
     and status = 'active' and id <> _v.plan_id
   for update;
  if _prior is not null then
    update public.nutrition_plan_versions
       set status = 'superseded', superseded_by_version_id = _plan_version_id
     where plan_id = _prior and status = 'active';
    update public.nutrition_plans
       set status = 'completed', updated_at = now(), updated_by = auth.uid()
     where id = _prior;
    insert into public.nutrition_plan_events (
      organization_id, plan_id, kind, from_status, to_status, detail, actor_user_id)
    values (_organization_id, _prior, 'superseded', 'active', 'completed',
            'superseded by a newer active plan', auth.uid());
  end if;

  -- An earlier version of THIS plan steps aside too.
  update public.nutrition_plan_versions
     set status = 'superseded', superseded_by_version_id = _plan_version_id
   where plan_id = _v.plan_id and status = 'active' and id <> _plan_version_id;

  update public.nutrition_plan_versions
     set status = 'active', activated_at = now(), activated_by = auth.uid()
   where id = _plan_version_id;
  update public.nutrition_plans
     set status = 'active', current_version_id = _plan_version_id,
         version = version + 1, updated_at = now(), updated_by = auth.uid()
   where id = _v.plan_id;

  insert into public.nutrition_plan_events (
    organization_id, plan_id, plan_version_id, kind, from_status, to_status, actor_user_id)
  values (_organization_id, _v.plan_id, _plan_version_id, 'activated', 'approved',
          'active', auth.uid());
end;
$$;

create or replace function public.set_nutrition_plan_lifecycle(
  _organization_id uuid, _plan_id uuid, _action text, _reason text default null
) returns void language plpgsql security definer set search_path = ''
as $$
declare _p public.nutrition_plans; _to text; _current uuid;
begin
  perform private.require_nutrition_approver(_organization_id);
  select * into _p from public.nutrition_plans
   where id = _plan_id and organization_id = _organization_id for update;
  if not found then
    raise exception 'record not found' using errcode = 'P0002';
  end if;
  perform private.require_nutrition_patient(_organization_id, _p.patient_id);

  _to := case _action
           when 'pause' then 'paused'
           when 'resume' then 'active'
           when 'complete' then 'completed'
           when 'discontinue' then 'discontinued'
         end;
  if _to is null then
    raise exception 'unknown action' using errcode = '22023';
  end if;
  if _action = 'discontinue' and coalesce(trim(_reason), '') = '' then
    raise exception 'discontinuing a plan requires a reason' using errcode = '22023';
  end if;
  if _action = 'pause' and _p.status <> 'active' then
    raise exception 'only an active plan can be paused' using errcode = '40001';
  end if;
  if _action = 'resume' and _p.status <> 'paused' then
    raise exception 'only a paused plan can be resumed' using errcode = '40001';
  end if;
  -- Resuming into a patient who has since been given another live plan would
  -- hit the one-active-plan index; say so in the phase's own vocabulary.
  if _action = 'resume' and exists (
    select 1 from public.nutrition_plans o
    where o.organization_id = _organization_id and o.patient_id = _p.patient_id
      and o.status = 'active' and o.id <> _plan_id
  ) then
    raise exception 'this patient already has an active plan' using errcode = '40001';
  end if;
  if _p.status in ('completed', 'discontinued') then
    raise exception 'this plan is already closed' using errcode = '40001';
  end if;

  _current := _p.current_version_id;
  update public.nutrition_plans
     set status = _to, version = version + 1, updated_at = now(), updated_by = auth.uid()
   where id = _plan_id;
  update public.nutrition_plan_versions
     set status = _to,
         paused_at = case when _to = 'paused' then now() else paused_at end,
         completed_at = case when _to = 'completed' then now() else completed_at end,
         discontinued_at = case when _to = 'discontinued' then now() else discontinued_at end,
         discontinued_reason = case when _to = 'discontinued' then trim(_reason)
                                    else discontinued_reason end
   where id = _current;

  insert into public.nutrition_plan_events (
    organization_id, plan_id, plan_version_id, kind, from_status, to_status,
    detail, actor_user_id)
  values (_organization_id, _plan_id, _current, _action, _p.status, _to,
          nullif(trim(coalesce(_reason, '')), ''), auth.uid());
end;
$$;

/**
 * Revise: copy an approved or active version into a NEW draft.
 *
 * The version being revised is not touched at all — not its content, not its
 * approver, not its timestamps. That is the whole point: the plan the patient
 * was actually given stays readable exactly as it was.
 */
create or replace function public.revise_nutrition_plan_version(
  _organization_id uuid, _plan_version_id uuid, _reason text
) returns uuid language plpgsql security definer set search_path = ''
as $$
declare _v public.nutrition_plan_versions; _next integer; _new uuid;
begin
  perform private.require_nutrition_author(_organization_id);
  select * into _v from public.nutrition_plan_versions
   where id = _plan_version_id and organization_id = _organization_id;
  if not found then
    raise exception 'record not found' using errcode = 'P0002';
  end if;
  perform private.require_nutrition_patient(_organization_id, _v.patient_id);
  if _v.status not in ('approved', 'active', 'paused') then
    raise exception 'only an approved or active version can be revised' using errcode = '40001';
  end if;
  if coalesce(trim(_reason), '') = '' then
    raise exception 'a revision needs a reason' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.nutrition_plan_versions
    where plan_id = _v.plan_id and status in ('draft', 'in_review')
  ) then
    raise exception 'this plan already has an open draft' using errcode = '40001';
  end if;

  select coalesce(max(version_number), 0) + 1 into _next
    from public.nutrition_plan_versions where plan_id = _v.plan_id;

  insert into public.nutrition_plan_versions (
    organization_id, plan_id, patient_id, version_number,
    source_template_id, source_template_version_id, source_template_name_snapshot,
    source_template_version_snapshot, goals, practitioner_rationale,
    patient_instructions, meal_timing_guidance, fasting_instructions,
    energy_target_value, energy_target_unit, protein_g, carbohydrate_g, fat_g,
    fiber_g, protein_pct, carbohydrate_pct, fat_pct, created_by, updated_by)
  values (
    _organization_id, _v.plan_id, _v.patient_id, _next,
    _v.source_template_id, _v.source_template_version_id,
    _v.source_template_name_snapshot, _v.source_template_version_snapshot,
    _v.goals, _v.practitioner_rationale, _v.patient_instructions,
    _v.meal_timing_guidance, _v.fasting_instructions, _v.energy_target_value,
    _v.energy_target_unit, _v.protein_g, _v.carbohydrate_g, _v.fat_g, _v.fiber_g,
    _v.protein_pct, _v.carbohydrate_pct, _v.fat_pct, auth.uid(), auth.uid())
  returning id into _new;

  perform private.copy_nutrition_content(_organization_id, 'plan', _plan_version_id, 'plan', _new);

  insert into public.nutrition_constraints (
    organization_id, plan_version_id, kind, label, detail, severity, source,
    source_record_id, created_by)
  select _organization_id, _new, c.kind, c.label, c.detail, c.severity, c.source,
         c.source_record_id, auth.uid()
  from public.nutrition_constraints c where c.plan_version_id = _plan_version_id;

  insert into public.nutrition_plan_events (
    organization_id, plan_id, plan_version_id, kind, to_status, detail, actor_user_id)
  values (_organization_id, _v.plan_id, _new, 'revised', 'draft', trim(_reason), auth.uid());

  return _new;
end;
$$;

create or replace function public.add_nutrition_amendment(
  _organization_id uuid, _plan_version_id uuid, _body text, _reason text
) returns uuid language plpgsql security definer set search_path = ''
as $$
declare _next integer; _id uuid; _v public.nutrition_plan_versions;
begin
  perform private.require_nutrition_author(_organization_id);
  select * into _v from public.nutrition_plan_versions
   where id = _plan_version_id and organization_id = _organization_id;
  if not found then
    raise exception 'record not found' using errcode = 'P0002';
  end if;
  perform private.require_nutrition_patient(_organization_id, _v.patient_id);
  if coalesce(trim(_body), '') = '' or coalesce(trim(_reason), '') = '' then
    raise exception 'an amendment needs a body and a reason' using errcode = '22023';
  end if;

  select coalesce(max(amendment_number), 0) + 1 into _next
    from public.nutrition_amendments where plan_version_id = _plan_version_id;

  insert into public.nutrition_amendments (
    organization_id, plan_version_id, amendment_number, body, reason, authored_by)
  values (_organization_id, _plan_version_id, _next, trim(_body), trim(_reason), auth.uid())
  returning id into _id;

  insert into public.nutrition_plan_events (
    organization_id, plan_id, plan_version_id, kind, detail, actor_user_id)
  values (_organization_id, _v.plan_id, _plan_version_id, 'amended', trim(_reason), auth.uid());
  return _id;
end;
$$;

-- --------------------------------------------------- adherence & outcomes

create or replace function public.record_nutrition_checkin(
  _organization_id uuid, _patient_id uuid, _observed_on date, _source text,
  _plan_version_id uuid default null,
  _meal_plan_adherence_pct numeric default null,
  _diet_adherence_pct numeric default null,
  _hunger_rating integer default null, _satiety_rating integer default null,
  _energy_rating integer default null, _digestive_tolerance integer default null,
  _symptoms text[] default '{}', _patient_note text default null,
  _weight_value numeric default null, _weight_unit text default null
) returns uuid language plpgsql security definer set search_path = ''
as $$
declare _id uuid;
begin
  perform private.require_nutrition_read(_organization_id);
  perform private.require_nutrition_patient(_organization_id, _patient_id);
  -- Adherence is always something someone REPORTED. There is no path that
  -- lets the system record a check-in with no stated origin.
  if _source is null or _source not in
     ('patient_reported', 'practitioner_recorded', 'imported_device', 'imported_app') then
    raise exception 'a check-in must say where it came from' using errcode = '22023';
  end if;
  if _weight_value is not null and coalesce(_weight_unit, '') = '' then
    raise exception 'a weight must carry a unit' using errcode = '22023';
  end if;
  if _observed_on > current_date then
    raise exception 'a check-in cannot be recorded for a future date' using errcode = '22023';
  end if;

  insert into public.nutrition_checkins (
    organization_id, patient_id, plan_version_id, observed_on,
    meal_plan_adherence_pct, diet_adherence_pct, hunger_rating, satiety_rating,
    energy_rating, digestive_tolerance, symptoms, patient_note, weight_value,
    weight_unit, source, created_by)
  values (
    _organization_id, _patient_id, _plan_version_id, _observed_on,
    _meal_plan_adherence_pct, _diet_adherence_pct, _hunger_rating, _satiety_rating,
    _energy_rating, _digestive_tolerance, coalesce(_symptoms, '{}'), _patient_note,
    _weight_value, nullif(_weight_unit, ''), _source, auth.uid())
  on conflict (patient_id, observed_on, source) do update
    set meal_plan_adherence_pct = excluded.meal_plan_adherence_pct,
        diet_adherence_pct = excluded.diet_adherence_pct,
        hunger_rating = excluded.hunger_rating,
        satiety_rating = excluded.satiety_rating,
        energy_rating = excluded.energy_rating,
        digestive_tolerance = excluded.digestive_tolerance,
        symptoms = excluded.symptoms,
        patient_note = excluded.patient_note,
        weight_value = excluded.weight_value,
        weight_unit = excluded.weight_unit,
        review_state = 'unreviewed'
  returning id into _id;
  return _id;
end;
$$;

create or replace function public.review_nutrition_checkin(
  _organization_id uuid, _checkin_id uuid, _state text
) returns void language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_nutrition_author(_organization_id);
  if _state not in ('reviewed', 'needs_followup') then
    raise exception 'unknown review state' using errcode = '22023';
  end if;
  update public.nutrition_checkins
     set review_state = _state, reviewed_by = auth.uid(), reviewed_at = now()
   where id = _checkin_id and organization_id = _organization_id;
  if not found then
    raise exception 'record not found' using errcode = 'P0002';
  end if;
end;
$$;

/** Provenance for a provider lookup. Stores a hash, never a response body. */
create or replace function public.record_nutrition_provider_lookup(
  _organization_id uuid, _capability text, _response_hash text,
  _outcome text default 'ok', _query_text text default null,
  _provider_reference text default null, _normalized_label text default null,
  _http_status integer default null, _provider_data_timestamp timestamptz default null,
  _review_state text default 'not_required'
) returns uuid language plpgsql security definer set search_path = ''
as $$
declare _id uuid;
begin
  perform private.require_nutrition_read(_organization_id);
  if coalesce(trim(_response_hash), '') = '' then
    raise exception 'a provider lookup must record a response hash' using errcode = '22023';
  end if;
  insert into public.nutrition_provider_lookups (
    organization_id, capability, query_text, provider_reference, response_hash,
    provider_data_timestamp, normalized_label, http_status, outcome, review_state,
    created_by)
  values (
    _organization_id, _capability, _query_text, _provider_reference,
    trim(_response_hash), _provider_data_timestamp, _normalized_label,
    _http_status, coalesce(_outcome, 'ok'), coalesce(_review_state, 'not_required'),
    auth.uid())
  returning id into _id;
  return _id;
end;
$$;

create or replace function public.review_nutrition_provider_lookup(
  _organization_id uuid, _lookup_id uuid, _state text
) returns void language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_nutrition_author(_organization_id);
  if _state not in ('confirmed', 'rejected') then
    raise exception 'unknown review state' using errcode = '22023';
  end if;
  update public.nutrition_provider_lookups
     set review_state = _state, reviewed_by = auth.uid(), reviewed_at = now()
   where id = _lookup_id and organization_id = _organization_id
     and review_state = 'awaiting_review';
  if not found then
    raise exception 'record not found' using errcode = 'P0002';
  end if;
end;
$$;

-- ---------------------------------------------------------------- reads

create or replace function public.list_nutrition_templates(
  _organization_id uuid, _include_archived boolean default false
) returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare _out jsonb;
begin
  perform private.require_nutrition_read(_organization_id);
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', t.id, 'name', t.name, 'pattern', t.pattern, 'summary', t.summary,
    'status', t.status, 'isStarter', t.is_starter, 'version', t.version,
    'currentVersionId', t.current_version_id,
    'versions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', v.id, 'versionNumber', v.version_number, 'status', v.status,
        'purpose', v.purpose, 'intendedUse', v.intended_use,
        'requiresPractitionerReview', v.requires_practitioner_review,
        'cautionPopulations', v.caution_populations,
        'prerequisites', v.prerequisites,
        'missingInformationRequired', v.missing_information_required,
        'evidenceGrade', v.evidence_grade, 'evidenceSummary', v.evidence_summary,
        'educationVsAdviceNote', v.education_vs_advice_note,
        'publishedAt', v.published_at)
        order by v.version_number desc)
      from public.nutrition_template_versions v where v.template_id = t.id), '[]'::jsonb))
    order by t.is_starter desc, t.name), '[]'::jsonb) into _out
  from public.nutrition_templates t
  where t.organization_id = _organization_id
    and (_include_archived or t.status <> 'archived');
  return jsonb_build_object('templates', _out);
end;
$$;

create or replace function public.get_nutrition_version_content(
  _organization_id uuid, _template_version_id uuid default null,
  _plan_version_id uuid default null
) returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare _tv uuid := _template_version_id; _pv uuid := _plan_version_id; _patient uuid;
begin
  perform private.require_nutrition_read(_organization_id);
  if (_tv is null) = (_pv is null) then
    raise exception 'ask for exactly one version' using errcode = '22023';
  end if;
  if _pv is not null then
    select patient_id into _patient from public.nutrition_plan_versions
     where id = _pv and organization_id = _organization_id;
    if not found then
      raise exception 'record not found' using errcode = 'P0002';
    end if;
    perform private.require_nutrition_patient(_organization_id, _patient);
  elsif not exists (select 1 from public.nutrition_template_versions
                    where id = _tv and organization_id = _organization_id) then
    raise exception 'record not found' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'phases', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'phaseNumber', p.phase_number, 'name', p.name,
        'description', p.description, 'timingMode', p.timing_mode,
        'relativeStartDay', p.relative_start_day,
        'relativeDurationDays', p.relative_duration_days,
        'absoluteStartDate', p.absolute_start_date,
        'absoluteEndDate', p.absolute_end_date,
        'reintroductionGuidance', p.reintroduction_guidance)
        order by p.phase_number)
      from public.nutrition_phases p
      where p.template_version_id is not distinct from _tv
        and p.plan_version_id is not distinct from _pv), '[]'::jsonb),
    'foodRules', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id, 'phaseId', r.phase_id, 'disposition', r.disposition,
        'scope', r.scope, 'label', r.label, 'canonicalSource', r.canonical_source,
        'canonicalId', r.canonical_id, 'portionGuidance', r.portion_guidance,
        'frequencyGuidance', r.frequency_guidance,
        'preparationGuidance', r.preparation_guidance,
        'substitutions', r.substitutions, 'conditionNote', r.condition_note,
        'rationale', r.rationale, 'sortOrder', r.sort_order)
        order by r.disposition, r.sort_order, r.label)
      from public.nutrition_food_rules r
      where r.template_version_id is not distinct from _tv
        and r.plan_version_id is not distinct from _pv), '[]'::jsonb),
    'mealDays', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', d.id, 'phaseId', d.phase_id, 'dayNumber', d.day_number,
        'label', d.label, 'notes', d.notes,
        'meals', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', m.id, 'mealType', m.meal_type, 'name', m.name,
            'timeOfDay', m.time_of_day, 'notes', m.notes, 'sortOrder', m.sort_order,
            'items', coalesce((
              select jsonb_agg(jsonb_build_object(
                'id', i.id, 'label', i.label, 'quantity', i.quantity, 'unit', i.unit,
                'canonicalSource', i.canonical_source, 'canonicalId', i.canonical_id,
                'nutrientSource', i.nutrient_source, 'energyValue', i.energy_value,
                'energyUnit', i.energy_unit, 'proteinG', i.protein_g,
                'carbohydrateG', i.carbohydrate_g, 'fatG', i.fat_g, 'fiberG', i.fiber_g,
                'preparationNote', i.preparation_note,
                'substitutions', i.substitutions, 'sortOrder', i.sort_order)
                order by i.sort_order, i.label)
              from public.nutrition_meal_items i where i.meal_id = m.id), '[]'::jsonb))
            order by m.sort_order)
          from public.nutrition_meals m where m.meal_day_id = d.id), '[]'::jsonb))
        order by d.day_number)
      from public.nutrition_meal_days d
      where d.template_version_id is not distinct from _tv
        and d.plan_version_id is not distinct from _pv), '[]'::jsonb),
    'recipes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'name', x.name, 'servings', x.servings,
        'ingredients', x.ingredients, 'method', x.method, 'notes', x.notes)
        order by x.sort_order, x.name)
      from public.nutrition_recipes x
      where x.template_version_id is not distinct from _tv
        and x.plan_version_id is not distinct from _pv), '[]'::jsonb),
    'groceryItems', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', g.id, 'category', g.category, 'label', g.label,
        'quantityNote', g.quantity_note)
        order by g.category, g.sort_order, g.label)
      from public.nutrition_grocery_items g
      where g.template_version_id is not distinct from _tv
        and g.plan_version_id is not distinct from _pv), '[]'::jsonb),
    'targets', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', t.id, 'nutrient', t.nutrient, 'label', t.label,
        'targetValue', t.target_value, 'minimumValue', t.minimum_value,
        'maximumValue', t.maximum_value, 'unit', t.unit, 'period', t.period,
        'rationale', t.rationale)
        order by t.nutrient)
      from public.nutrition_targets t
      where t.template_version_id is not distinct from _tv
        and t.plan_version_id is not distinct from _pv), '[]'::jsonb),
    'provenance', coalesce((
      select jsonb_agg(jsonb_build_object(
        'kind', pr.kind, 'label', pr.label, 'referenceId', pr.reference_id,
        'detail', pr.detail, 'recordedAt', pr.recorded_at)
        order by pr.recorded_at)
      from public.nutrition_provenance pr
      where pr.template_version_id is not distinct from _tv
        and pr.plan_version_id is not distinct from _pv), '[]'::jsonb));
end;
$$;

create or replace function public.get_patient_nutrition(
  _organization_id uuid, _patient_id uuid
) returns jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  perform private.require_nutrition_read(_organization_id);
  perform private.require_nutrition_patient(_organization_id, _patient_id);

  return jsonb_build_object(
    'plans', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'title', p.title, 'status', p.status, 'version', p.version,
        'currentVersionId', p.current_version_id, 'createdAt', p.created_at,
        'versions', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', v.id, 'versionNumber', v.version_number, 'status', v.status,
            'version', v.version, 'goals', v.goals,
            'practitionerRationale', v.practitioner_rationale,
            'patientInstructions', v.patient_instructions,
            'mealTimingGuidance', v.meal_timing_guidance,
            'fastingInstructions', v.fasting_instructions,
            'energyTargetValue', v.energy_target_value,
            'energyTargetUnit', v.energy_target_unit,
            'proteinG', v.protein_g, 'carbohydrateG', v.carbohydrate_g,
            'fatG', v.fat_g, 'fiberG', v.fiber_g,
            'proteinPct', v.protein_pct, 'carbohydratePct', v.carbohydrate_pct,
            'fatPct', v.fat_pct,
            'sourceTemplateName', v.source_template_name_snapshot,
            'sourceTemplateVersion', v.source_template_version_snapshot,
            'sourceTemplateVersionId', v.source_template_version_id,
            'detachedAt', v.detached_at,
            'submittedAt', v.submitted_at, 'approvedAt', v.approved_at,
            'activatedAt', v.activated_at, 'discontinuedReason', v.discontinued_reason,
            'autosavedAt', v.autosaved_at,
            'constraints', coalesce((
              select jsonb_agg(jsonb_build_object(
                'id', c.id, 'kind', c.kind, 'label', c.label, 'detail', c.detail,
                'severity', c.severity, 'source', c.source) order by c.kind, c.label)
              from public.nutrition_constraints c where c.plan_version_id = v.id), '[]'::jsonb),
            'safetyFlags', coalesce((
              select jsonb_agg(jsonb_build_object(
                'id', f.id, 'kind', f.kind, 'severity', f.severity, 'detail', f.detail,
                'status', f.status, 'evidenceRef', f.evidence_ref,
                'overrideReason', f.override_reason, 'overriddenAt', f.overridden_at)
                order by f.severity desc, f.created_at)
              from public.nutrition_safety_flags f where f.plan_version_id = v.id), '[]'::jsonb),
            'amendments', coalesce((
              select jsonb_agg(jsonb_build_object(
                'number', a.amendment_number, 'body', a.body, 'reason', a.reason,
                'createdAt', a.created_at) order by a.amendment_number)
              from public.nutrition_amendments a where a.plan_version_id = v.id), '[]'::jsonb),
            'safetyEvaluated', exists (
              select 1 from public.nutrition_plan_events e
              where e.plan_version_id = v.id and e.kind = 'safety_evaluated'))
            order by v.version_number desc)
          from public.nutrition_plan_versions v where v.plan_id = p.id), '[]'::jsonb),
        'events', coalesce((
          select jsonb_agg(jsonb_build_object(
            'kind', e.kind, 'fromStatus', e.from_status, 'toStatus', e.to_status,
            'detail', e.detail, 'createdAt', e.created_at)
            order by e.created_at desc)
          from public.nutrition_plan_events e where e.plan_id = p.id), '[]'::jsonb))
        order by p.created_at desc)
      from public.nutrition_plans p
      where p.organization_id = _organization_id and p.patient_id = _patient_id), '[]'::jsonb),
    'checkins', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', k.id, 'observedOn', k.observed_on, 'source', k.source,
        'mealPlanAdherencePct', k.meal_plan_adherence_pct,
        'dietAdherencePct', k.diet_adherence_pct,
        'hungerRating', k.hunger_rating, 'satietyRating', k.satiety_rating,
        'energyRating', k.energy_rating, 'digestiveTolerance', k.digestive_tolerance,
        'symptoms', k.symptoms, 'patientNote', k.patient_note,
        'weightValue', k.weight_value, 'weightUnit', k.weight_unit,
        'reviewState', k.review_state, 'planVersionId', k.plan_version_id)
        order by k.observed_on desc)
      from public.nutrition_checkins k
      where k.organization_id = _organization_id and k.patient_id = _patient_id), '[]'::jsonb));
end;
$$;

/**
 * Adherence summary. Reports only what was actually reported: the window, how
 * many days had a check-in, and the mean of those. A day with no check-in is
 * counted as MISSING, never as zero adherence — inventing a zero would turn
 * silence into a clinical finding.
 */
create or replace function public.get_nutrition_adherence_summary(
  _organization_id uuid, _patient_id uuid, _days integer default 30
) returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare _from date; _reported integer; _out jsonb;
begin
  perform private.require_nutrition_read(_organization_id);
  perform private.require_nutrition_patient(_organization_id, _patient_id);
  if _days is null or _days < 1 or _days > 365 then
    raise exception 'the window must be between 1 and 365 days' using errcode = '22023';
  end if;
  _from := current_date - (_days - 1);

  -- DAYS reported, not rows: two sources on one day is still one day covered.
  select count(distinct observed_on) into _reported from public.nutrition_checkins
   where organization_id = _organization_id and patient_id = _patient_id
     and observed_on >= _from;

  select jsonb_build_object(
    'windowDays', _days,
    'from', _from,
    'to', current_date,
    'daysReported', _reported,
    'daysMissing', _days - least(_reported, _days),
    'meanMealPlanAdherencePct', (
      select round(avg(meal_plan_adherence_pct), 1) from public.nutrition_checkins
      where organization_id = _organization_id and patient_id = _patient_id
        and observed_on >= _from and meal_plan_adherence_pct is not null),
    'meanDietAdherencePct', (
      select round(avg(diet_adherence_pct), 1) from public.nutrition_checkins
      where organization_id = _organization_id and patient_id = _patient_id
        and observed_on >= _from and diet_adherence_pct is not null),
    'meanDigestiveTolerance', (
      select round(avg(digestive_tolerance), 1) from public.nutrition_checkins
      where organization_id = _organization_id and patient_id = _patient_id
        and observed_on >= _from and digestive_tolerance is not null),
    'needsFollowup', (
      select count(*) from public.nutrition_checkins
      where organization_id = _organization_id and patient_id = _patient_id
        and observed_on >= _from and review_state = 'needs_followup'),
    'unreviewed', (
      select count(*) from public.nutrition_checkins
      where organization_id = _organization_id and patient_id = _patient_id
        and observed_on >= _from and review_state = 'unreviewed')
  ) into _out;
  return _out;
end;
$$;

-- ------------------------------------------------------------- privileges

do $$
declare fn text;
begin
  for fn in select unnest(array[
    'public.upsert_nutrition_template(uuid, text, text, text, uuid, integer)',
    'public.create_nutrition_template_version(uuid, uuid, text, text, text, text, text[], text[], text[], text, text, boolean, uuid)',
    'public.save_nutrition_template_content(uuid, uuid, jsonb)',
    'public.record_nutrition_template_reference(uuid, uuid, text, text, text)',
    'public.publish_nutrition_template_version(uuid, uuid)',
    'public.archive_nutrition_template(uuid, uuid, text)',
    'public.create_nutrition_plan(uuid, uuid, text, uuid)',
    'public.save_nutrition_plan_version(uuid, uuid, integer, text[], text, text, text, text, numeric, text, numeric, numeric, numeric, numeric, numeric, numeric, numeric, jsonb, boolean)',
    'public.set_nutrition_plan_constraints(uuid, uuid, jsonb)',
    'public.evaluate_nutrition_plan_safety(uuid, uuid)',
    'public.raise_nutrition_safety_flag(uuid, uuid, text, text, text)',
    'public.resolve_nutrition_safety_flag(uuid, uuid, text, text)',
    'public.submit_nutrition_plan_version(uuid, uuid)',
    'public.approve_nutrition_plan_version(uuid, uuid, text)',
    'public.activate_nutrition_plan_version(uuid, uuid)',
    'public.set_nutrition_plan_lifecycle(uuid, uuid, text, text)',
    'public.revise_nutrition_plan_version(uuid, uuid, text)',
    'public.add_nutrition_amendment(uuid, uuid, text, text)',
    'public.record_nutrition_checkin(uuid, uuid, date, text, uuid, numeric, numeric, integer, integer, integer, integer, text[], text, numeric, text)',
    'public.review_nutrition_checkin(uuid, uuid, text)',
    'public.record_nutrition_provider_lookup(uuid, text, text, text, text, text, text, integer, timestamptz, text)',
    'public.review_nutrition_provider_lookup(uuid, uuid, text)',
    'public.list_nutrition_templates(uuid, boolean)',
    'public.get_nutrition_version_content(uuid, uuid, uuid)',
    'public.get_patient_nutrition(uuid, uuid)',
    'public.get_nutrition_adherence_summary(uuid, uuid, integer)'
  ]) loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end $$;

revoke all on function private.require_nutrition_read(uuid) from public, anon;
revoke all on function private.require_nutrition_author(uuid) from public, anon;
revoke all on function private.require_nutrition_approver(uuid) from public, anon;
revoke all on function private.require_nutrition_patient(uuid, uuid) from public, anon;
revoke all on function private.write_nutrition_content(uuid, text, uuid, jsonb)
  from public, anon, authenticated;
revoke all on function private.copy_nutrition_content(uuid, text, uuid, text, uuid)
  from public, anon, authenticated;

commit;
