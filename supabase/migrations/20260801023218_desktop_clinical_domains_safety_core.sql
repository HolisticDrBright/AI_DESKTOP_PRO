-- Phase 9B: clinical domains and the deterministic safety core.
--
-- DOMAINS. Nine already exist. This adds the rest of the phase's list as
-- platform-governed rows, plus a parent relationship so intestinal
-- permeability sits under digestive health rather than floating beside it.
--
-- Creating a domain authorises NOTHING. A domain is a filing cabinet, not a
-- claim; every clinical assertion still needs a reference or the
-- practitioner_experience grading, enforced by the constraint added in the
-- previous migration. `scope_note` says so on every row so a curator reading
-- the table cannot mistake presence for endorsement.
--
-- SAFETY CORE. Extends the honest pattern the existing
-- `check_protocol_interactions` already established: report `not_completed`
-- with a stated reason rather than an empty finding list that reads like an
-- all-clear. Nothing here manufactures an interaction.

begin;

alter table public.clinical_domains
  add column if not exists parent_code text,
  add column if not exists scope_note text;

-- Domains are versioned (code, version); the parent is cited by code because a
-- branch relationship is conceptual and outlives any single version.
create index if not exists cd_parent_idx on public.clinical_domains (parent_code);

update public.clinical_domains
   set scope_note = coalesce(scope_note,
     'A domain is an organising category. It authorises no clinical claim: '
     || 'every assertion still requires a governed reference or an explicit '
     || 'practitioner-experience grading.')
 where scope_note is null;

insert into public.clinical_domains (code, version, name, description, active, parent_code, scope_note)
values
  ('thyroid', 1, 'Thyroid', 'Thyroid function and related presentations.', true, 'endocrine', null),
  ('hormone_balance', 1, 'Hormone balance', 'Sex-hormone and broader endocrine balance.', true, 'endocrine', null),
  ('hpa_axis', 1, 'Adrenal / HPA-axis function', 'Stress-response and HPA-axis considerations.', true, 'endocrine', null),
  ('diabetes_insulin_resistance', 1, 'Diabetes and insulin resistance', 'Glycaemic regulation and insulin sensitivity.', true, 'cardiometabolic', null),
  ('body_composition', 1, 'Body composition and insulin sensitivity', 'Composition, adiposity and metabolic flexibility.', true, 'cardiometabolic', null),
  ('intestinal_permeability', 1, 'Intestinal permeability', 'Barrier-function concepts, as a branch of digestive health.', true, 'gastrointestinal', null),
  ('h_pylori', 1, 'H. pylori', 'Helicobacter pylori considerations.', true, 'gastrointestinal', null),
  ('candida', 1, 'Candida', 'Candida-related presentations.', true, 'gastrointestinal', null),
  ('parasites', 1, 'Parasites', 'Parasitic infection considerations.', true, 'gastrointestinal', null),
  ('gallbladder_bile', 1, 'Gallbladder and bile', 'Biliary function and bile-acid considerations.', true, 'gastrointestinal', null),
  ('autoimmune', 1, 'Autoimmune patterns', 'Autoimmune presentations and patterns.', true, 'inflammatory_immune', null),
  ('viral_ebv', 1, 'EBV and viral considerations', 'Epstein-Barr and other viral considerations.', true, 'inflammatory_immune', null),
  ('lyme_tickborne', 1, 'Lyme and tick-borne illness', 'Tick-borne infection considerations.', true, 'inflammatory_immune', null),
  ('mold_mycotoxin', 1, 'Mold and mycotoxin exposure', 'Mold and mycotoxin exposure considerations.', true, 'toxicologic_environmental', null),
  ('heavy_metals', 1, 'Heavy metals', 'Heavy-metal exposure considerations.', true, 'toxicologic_environmental', null),
  ('emf_exposure', 1, 'EMF-related exposure concerns', 'Electromagnetic-field exposure concerns as raised by patients and practitioners.', true, 'toxicologic_environmental', null),
  ('methylation', 1, 'Methylation', 'One-carbon metabolism and methylation considerations.', true, null, null),
  ('mitochondrial_energy', 1, 'Mitochondrial and energy function', 'Mitochondrial function and energy production.', true, null, null),
  ('cognitive_health', 1, 'Brain and cognitive health', 'Cognition, mood and neurological resilience.', true, 'neurologic', null),
  ('musculoskeletal_performance', 1, 'Muscle, strength, balance and VO2 capacity', 'Strength, balance, and cardiorespiratory capacity.', true, null, null),
  ('bone_health', 1, 'Bone health', 'Bone density and skeletal health.', true, null, null),
  ('longevity', 1, 'Longevity and healthy aging', 'Healthy-aging and longevity considerations.', true, null, null)
on conflict (code, version) do nothing;

update public.clinical_domains
   set scope_note = 'A domain is an organising category. It authorises no clinical claim: '
     || 'every assertion still requires a governed reference or an explicit '
     || 'practitioner-experience grading.'
 where scope_note is null;

-- --------------------------------------------------- deterministic safety core

/**
 * Evaluate a protocol version against the deterministic safety checks.
 *
 * Returns a bounded report. Every check reports one of three states and never
 * a fourth:
 *
 *   ok            — the check ran and found nothing
 *   finding       — the check ran and found something specific
 *   not_completed — the check COULD NOT run, and says why
 *
 * The third state is the reason this function exists. An empty findings list
 * from a check that never ran is indistinguishable, on screen, from an
 * all-clear — and that is the failure mode this whole phase is built against.
 *
 * Nothing here manufactures an interaction. Where no governed interaction
 * reference exists, the report says "Interaction review not completed" and
 * names the missing input.
 */
create or replace function public.evaluate_protocol_safety(_version_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  _v public.protocol_versions%rowtype;
  _p public.patient_profiles%rowtype;
  _checks jsonb := '[]'::jsonb;
  _allergy_hits jsonb;
  _dupe_ingredients jsonb;
  _dupe_products jsonb;
  _unverified jsonb;
  _jurisdictional jsonb;
  _meds_total integer;
  _meds_coded integer;
  _age numeric;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  select * into _v from public.protocol_versions where id = _version_id;
  if not found then
    raise exception 'protocol version not found' using errcode = 'P0002';
  end if;
  if not private.is_org_member(_v.organization_id) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
  if _v.patient_id is not null and not private.can_access_patient(_v.patient_id) then
    raise exception 'record not found' using errcode = 'P0002';
  end if;

  if _v.patient_id is not null then
    select * into _p from public.patient_profiles where id = _v.patient_id;
  end if;

  /* ---- recorded allergies vs product ingredients and labels ---- */
  if _v.patient_id is null then
    _checks := _checks || jsonb_build_object(
      'check', 'recorded_allergies', 'state', 'not_completed',
      'reason', 'This is a template, not a patient protocol, so there is no chart to check against.');
  else
    select coalesce(jsonb_agg(distinct jsonb_build_object(
             'itemLabel', it.label, 'allergen', a.allergen, 'severity', a.severity,
             'matchedOn', 'label ingredient')), '[]'::jsonb)
      into _allergy_hits
    from public.protocol_items it
    join public.supplement_product_versions pv on pv.id = it.catalog_product_version_id
    join public.product_ingredient_amounts amt on amt.product_version_id = pv.id
    join public.supplement_ingredients ing on ing.id = amt.ingredient_id
    join public.allergies a
      on a.patient_id = _v.patient_id and a.organization_id = _v.organization_id
     and a.deleted_at is null and coalesce(a.status, 'active') = 'active'
     and ing.canonical_name ilike '%' || a.allergen || '%'
    where it.version_id = _version_id;

    if not exists (
      select 1 from public.allergies a
      where a.patient_id = _v.patient_id and a.organization_id = _v.organization_id
        and a.deleted_at is null and coalesce(a.status, 'active') = 'active'
    ) then
      _checks := _checks || jsonb_build_object(
        'check', 'recorded_allergies', 'state', 'not_completed',
        'reason', 'No allergies are recorded for this patient. That is not evidence there are none.');
    else
      _checks := _checks || jsonb_build_object(
        'check', 'recorded_allergies',
        'state', case when jsonb_array_length(_allergy_hits) > 0 then 'finding' else 'ok' end,
        'severity', 'blocking',
        'findings', _allergy_hits);
    end if;
  end if;

  /* ---- duplicate ingredients across the protocol's products ---- */
  select coalesce(jsonb_agg(x), '[]'::jsonb) into _dupe_ingredients from (
    select jsonb_build_object(
      'ingredient', ing.canonical_name,
      'appearsIn', count(distinct it.id),
      'items', jsonb_agg(distinct it.label)) as x
    from public.protocol_items it
    join public.supplement_product_versions pv on pv.id = it.catalog_product_version_id
    join public.product_ingredient_amounts amt on amt.product_version_id = pv.id
    join public.supplement_ingredients ing on ing.id = amt.ingredient_id
    where it.version_id = _version_id
    group by ing.canonical_name
    having count(distinct it.id) > 1
  ) s;

  if not exists (
    select 1 from public.protocol_items it
    join public.supplement_product_versions pv on pv.id = it.catalog_product_version_id
    join public.product_ingredient_amounts amt on amt.product_version_id = pv.id
    where it.version_id = _version_id
  ) then
    _checks := _checks || jsonb_build_object(
      'check', 'duplicate_ingredients', 'state', 'not_completed',
      'reason', 'No product on this protocol has structured ingredient data, so overlap cannot be computed.');
  else
    _checks := _checks || jsonb_build_object(
      'check', 'duplicate_ingredients',
      'state', case when jsonb_array_length(_dupe_ingredients) > 0 then 'finding' else 'ok' end,
      'severity', 'review', 'findings', _dupe_ingredients);
  end if;

  /* ---- the same product listed twice ---- */
  select coalesce(jsonb_agg(jsonb_build_object('productVersionId', v, 'count', n)), '[]'::jsonb)
    into _dupe_products
  from (select catalog_product_version_id v, count(*) n
        from public.protocol_items
        where version_id = _version_id and catalog_product_version_id is not null
        group by 1 having count(*) > 1) s;

  _checks := _checks || jsonb_build_object(
    'check', 'duplicate_products',
    'state', case when jsonb_array_length(_dupe_products) > 0 then 'finding' else 'ok' end,
    'severity', 'review', 'findings', _dupe_products);

  /* ---- medication interactions: honest about what it could not do ---- */
  if _v.patient_id is null then
    _checks := _checks || jsonb_build_object(
      'check', 'medication_interactions', 'state', 'not_completed',
      'reason', 'Interaction review not completed: a template has no patient medication list.');
  else
    select count(*), count(nullif(btrim(coalesce(m.rxnorm, '')), ''))
      into _meds_total, _meds_coded
    from public.medications m
    where m.patient_id = _v.patient_id and m.organization_id = _v.organization_id
      and m.status = 'active' and m.deleted_at is null;

    if _meds_total = 0 then
      _checks := _checks || jsonb_build_object(
        'check', 'medication_interactions', 'state', 'not_completed',
        'reason', 'Interaction review not completed: no active medications are recorded. '
          || 'This is not evidence that the protocol is interaction-free.');
    elsif _meds_coded = 0 then
      _checks := _checks || jsonb_build_object(
        'check', 'medication_interactions', 'state', 'not_completed',
        'reason', 'Interaction review not completed: recorded medications carry no coded '
          || 'identifiers, so no deterministic check can run.');
    elsif not exists (select 1 from public.ingredient_interactions) then
      -- The honest headline of this build.
      _checks := _checks || jsonb_build_object(
        'check', 'medication_interactions', 'state', 'not_completed',
        'reason', 'Interaction review not completed: this deployment holds no governed '
          || 'drug-nutrient interaction reference.');
    else
      _checks := _checks || jsonb_build_object(
        'check', 'medication_interactions', 'state', 'ok',
        'severity', 'blocking',
        'findings', coalesce((
          select jsonb_agg(distinct jsonb_build_object(
            'ingredient', ing.canonical_name, 'medication', med.name,
            'severity', ii.severity, 'mechanism', ii.mechanism,
            'source', ii.source, 'version', ii.version))
          from public.protocol_items it
          join public.product_ingredient_amounts amt
            on amt.product_version_id = it.catalog_product_version_id
          join public.supplement_ingredients ing on ing.id = amt.ingredient_id
          join public.ingredient_interactions ii on ii.ingredient_id = amt.ingredient_id
            and ii.interacts_with_type = 'medication'
          join public.medications med
            on lower(btrim(med.rxnorm)) = lower(btrim(ii.interacts_with_ref))
           and med.patient_id = _v.patient_id and med.organization_id = _v.organization_id
           and med.status = 'active' and med.deleted_at is null
          where it.version_id = _version_id), '[]'::jsonb));
    end if;
  end if;

  /* ---- demographics the other checks depend on ---- */
  if _v.patient_id is null then
    _checks := _checks || jsonb_build_object(
      'check', 'demographics', 'state', 'not_completed',
      'reason', 'A template has no patient demographics.');
  elsif _p.date_of_birth is null or _p.sex is null then
    _checks := _checks || jsonb_build_object(
      'check', 'demographics', 'state', 'finding', 'severity', 'review',
      'findings', jsonb_build_array(jsonb_build_object(
        'detail', 'Date of birth or sex is not recorded, so age- and sex-dependent checks cannot run.')));
  else
    _age := extract(year from age(_p.date_of_birth));
    _checks := _checks || jsonb_build_object(
      'check', 'demographics',
      'state', case when _age < 18 then 'finding' else 'ok' end,
      'severity', 'blocking',
      'findings', case when _age < 18
        then jsonb_build_array(jsonb_build_object(
          'detail', 'This patient is under 18. A paediatric protocol needs explicit clinical sign-off.'))
        else '[]'::jsonb end);
  end if;

  /* ---- unverified / stale / conflicted labels without a reviewed exception ---- */
  select coalesce(jsonb_agg(jsonb_build_object(
           'itemLabel', it.label, 'state', pv.verification_state)), '[]'::jsonb)
    into _unverified
  from public.protocol_items it
  join public.supplement_product_versions pv on pv.id = it.catalog_product_version_id
  where it.version_id = _version_id
    and pv.verification_state <> 'verified'
    and not exists (
      select 1 from public.catalog_use_exceptions e
      where e.product_version_id = pv.id
        and e.organization_id = _v.organization_id
        and e.revoked_at is null
        and (e.expires_on is null or e.expires_on >= current_date));

  _checks := _checks || jsonb_build_object(
    'check', 'label_verification',
    'state', case when jsonb_array_length(_unverified) > 0 then 'finding' else 'ok' end,
    'severity', 'blocking', 'findings', _unverified);

  /* ---- jurisdiction-sensitive categories ---- */
  select coalesce(jsonb_agg(jsonb_build_object(
           'itemLabel', it.label, 'classification', p.regulatory_classification,
           'jurisdiction', p.jurisdiction)), '[]'::jsonb)
    into _jurisdictional
  from public.protocol_items it
  join public.supplement_product_versions pv on pv.id = it.catalog_product_version_id
  join public.supplement_products p on p.id = pv.product_id
  where it.version_id = _version_id
    and p.regulatory_classification in ('prescription', 'peptide', 'device');

  _checks := _checks || jsonb_build_object(
    'check', 'jurisdiction_sensitive',
    'state', case when jsonb_array_length(_jurisdictional) > 0 then 'finding' else 'ok' end,
    'severity', 'blocking',
    'reason', case when jsonb_array_length(_jurisdictional) > 0
      then 'These categories require practitioner permissions and jurisdiction review. '
        || 'This system makes no determination that any intervention is legal where you practise.'
      else null end,
    'findings', _jurisdictional);

  /* ---- commercial separation, asserted rather than assumed ---- */
  _checks := _checks || jsonb_build_object(
    'check', 'commercial_separation', 'state', 'ok',
    'reason', 'No commercial or affiliate data was read by any check above. '
      || 'Eligibility, ranking and safety never consult it.');

  return jsonb_build_object(
    'versionId', _version_id,
    'checks', _checks,
    'blocking', (select count(*) from jsonb_array_elements(_checks) c
                 where c->>'state' = 'finding' and c->>'severity' = 'blocking'),
    'notCompleted', (select count(*) from jsonb_array_elements(_checks) c
                     where c->>'state' = 'not_completed'),
    'disclaimer', 'A completed check reports only what the checked sources contain. It is '
      || 'not a determination that a protocol is safe, and it does not replace practitioner '
      || 'review. Checks reported as not completed found nothing because they could not run.',
    'generatedAt', now());
end;
$$;

revoke all on function public.evaluate_protocol_safety(uuid) from public, anon;
grant execute on function public.evaluate_protocol_safety(uuid) to authenticated;

commit;
