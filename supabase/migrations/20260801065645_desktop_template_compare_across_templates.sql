-- Let template comparison cross template boundaries.
--
-- The version in the preceding migration required both sides to belong to the
-- SAME template, which made the most common review impossible: comparing a
-- duplicate against the template it was duplicated from. That was caught by
-- the acceptance suite rather than by reading the code, which is the point of
-- having one.
--
-- Both sides must still be TEMPLATE versions in the same organization. Patient
-- protocol versions are reachable only through `can_access_patient`, and
-- routing them down this path would sidestep that check entirely — so a
-- patient version on either side is refused rather than quietly compared.
--
-- The response now reports `sameTemplate` so a caller can tell which kind of
-- comparison it is looking at instead of inferring it.

begin;

create or replace function public.compare_protocol_template_versions(
  _left_version_id uuid, _right_version_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $fn$
declare
  _l public.protocol_versions%rowtype;
  _r public.protocol_versions%rowtype;
  _added jsonb; _removed jsonb; _changed jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  select * into _l from public.protocol_versions where id = _left_version_id;
  if not found then
    raise exception 'left version not found' using errcode = 'P0002';
  end if;
  select * into _r from public.protocol_versions where id = _right_version_id;
  if not found then
    raise exception 'right version not found' using errcode = 'P0002';
  end if;
  if _l.template_id is null or _r.template_id is null then
    raise exception 'both versions must be template versions' using errcode = '22023';
  end if;
  if _l.organization_id <> _r.organization_id then
    raise exception 'both versions must belong to the same organization'
      using errcode = '22023';
  end if;
  if not private.is_org_member(_l.organization_id) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'label', ri.label, 'kind', ri.kind, 'dosageText', ri.dosage_text,
    'doseSourceKind', ri.dose_source_kind) order by ri.position), '[]'::jsonb)
  into _added
  from public.protocol_items ri
  where ri.version_id = _right_version_id
    and not exists (select 1 from public.protocol_items li
                    where li.version_id = _left_version_id and li.label = ri.label);

  select coalesce(jsonb_agg(jsonb_build_object(
    'label', li.label, 'kind', li.kind, 'dosageText', li.dosage_text,
    'doseSourceKind', li.dose_source_kind) order by li.position), '[]'::jsonb)
  into _removed
  from public.protocol_items li
  where li.version_id = _left_version_id
    and not exists (select 1 from public.protocol_items ri
                    where ri.version_id = _right_version_id and ri.label = li.label);

  select coalesce(jsonb_agg(jsonb_build_object(
    'label', li.label,
    'doseChanged', li.dosage_text is distinct from ri.dosage_text,
    'from', jsonb_build_object(
      'dosageText', li.dosage_text, 'timingText', li.timing_text,
      'route', li.route, 'doseSourceKind', li.dose_source_kind,
      'stoppingRules', to_jsonb(li.stopping_rules),
      'monitoringRequirements', to_jsonb(li.monitoring_requirements)),
    'to', jsonb_build_object(
      'dosageText', ri.dosage_text, 'timingText', ri.timing_text,
      'route', ri.route, 'doseSourceKind', ri.dose_source_kind,
      'stoppingRules', to_jsonb(ri.stopping_rules),
      'monitoringRequirements', to_jsonb(ri.monitoring_requirements)))
    order by li.position), '[]'::jsonb)
  into _changed
  from public.protocol_items li
  join public.protocol_items ri
    on ri.version_id = _right_version_id and ri.label = li.label
  where li.version_id = _left_version_id
    and (li.dosage_text is distinct from ri.dosage_text
      or li.timing_text is distinct from ri.timing_text
      or li.route is distinct from ri.route
      or li.dose_source_kind is distinct from ri.dose_source_kind
      or li.stopping_rules is distinct from ri.stopping_rules
      or li.monitoring_requirements is distinct from ri.monitoring_requirements
      or li.contraindications is distinct from ri.contraindications);

  return jsonb_build_object(
    'sameTemplate', _l.template_id = _r.template_id,
    'left', jsonb_build_object('versionId', _l.id, 'templateId', _l.template_id,
      'version', _l.version, 'status', _l.status, 'title', _l.title),
    'right', jsonb_build_object('versionId', _r.id, 'templateId', _r.template_id,
      'version', _r.version, 'status', _r.status, 'title', _r.title),
    'added', _added,
    'removed', _removed,
    'changed', _changed,
    'doseChangeCount', (
      select count(*) from jsonb_array_elements(_changed) c
      where (c->>'doseChanged')::boolean),
    'matchNote',
      'Items are matched by label. A renamed item therefore reads as one '
      || 'removal and one addition rather than as a change - check those pairs '
      || 'before assuming an item was replaced.');
end;
$fn$;

revoke all on function public.compare_protocol_template_versions(uuid, uuid)
  from public, anon;
grant execute on function public.compare_protocol_template_versions(uuid, uuid)
  to authenticated;

commit;
