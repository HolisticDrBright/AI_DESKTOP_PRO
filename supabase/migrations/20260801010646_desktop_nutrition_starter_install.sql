-- Phase 9A: installing a starter diet template into an organization.
--
-- The starter library is PRODUCT CONTENT, not seeded patient data, and it is
-- installed through the same governed path a practitioner uses: a template, a
-- version, its content, then publish. There is no side door that writes a
-- published template without going through the version machinery.
--
-- Installation is IDEMPOTENT on a content hash. Re-running it when nothing
-- changed returns the version that is already published instead of creating a
-- v2 that differs from v1 in nothing — template churn is not free, because a
-- practitioner reading a version history has to work out what changed.
--
-- Starter templates are also, unavoidably, EDUCATIONAL SCAFFOLDING. Every one
-- installs with `requires_practitioner_review = true`, and the RPC refuses to
-- install one with it turned off.

begin;

-- A stable per-org identity so re-installing updates the same template.
alter table public.nutrition_templates
  add column if not exists starter_slug text;

create unique index if not exists nutrition_templates_starter_slug_idx
  on public.nutrition_templates (organization_id, starter_slug)
  where starter_slug is not null;

-- What was installed, so an unchanged re-install is a no-op.
alter table public.nutrition_template_versions
  add column if not exists starter_content_hash text;

create or replace function public.install_nutrition_starter_template(
  _organization_id uuid,
  _slug text,
  _name text,
  _pattern text,
  _summary text,
  _meta jsonb,
  _content jsonb,
  _content_hash text
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  _template uuid;
  _existing uuid;
  _version uuid;
  _next integer;
begin
  perform private.require_nutrition_approver(_organization_id);
  if coalesce(trim(_slug), '') = '' or coalesce(trim(_content_hash), '') = '' then
    raise exception 'a starter template needs a slug and a content hash'
      using errcode = '22023';
  end if;
  -- A starter template that claimed not to need review would be exactly the
  -- thing this phase is built to prevent.
  if coalesce((_meta->>'requiresPractitionerReview')::boolean, true) is not true then
    raise exception 'a starter template must require practitioner review'
      using errcode = '22023';
  end if;

  select id into _template from public.nutrition_templates
   where organization_id = _organization_id and starter_slug = trim(_slug)
   for update;

  if _template is null then
    insert into public.nutrition_templates (
      organization_id, name, pattern, summary, starter_slug, is_starter,
      created_by, updated_by)
    values (_organization_id, trim(_name), _pattern, _summary, trim(_slug), true,
            auth.uid(), auth.uid())
    returning id into _template;

    insert into public.nutrition_template_events (
      organization_id, template_id, kind, to_status, detail, actor_user_id)
    values (_organization_id, _template, 'created', 'draft',
            'installed from the starter library', auth.uid());
  else
    -- Already installed and unchanged: hand back what is there.
    select id into _existing from public.nutrition_template_versions
     where template_id = _template and status = 'published'
       and starter_content_hash = trim(_content_hash);
    if _existing is not null then
      return jsonb_build_object(
        'templateId', _template, 'versionId', _existing, 'outcome', 'unchanged');
    end if;

    update public.nutrition_templates
       set name = trim(_name), pattern = _pattern, summary = _summary,
           version = version + 1, updated_at = now(), updated_by = auth.uid()
     where id = _template;
  end if;

  select coalesce(max(version_number), 0) + 1 into _next
    from public.nutrition_template_versions where template_id = _template;

  insert into public.nutrition_template_versions (
    organization_id, template_id, version_number, purpose, intended_use,
    patient_education, education_vs_advice_note, caution_populations,
    prerequisites, missing_information_required, evidence_grade,
    evidence_summary, requires_practitioner_review, source_note,
    starter_content_hash, created_by)
  values (
    _organization_id, _template, _next,
    _meta->>'purpose', _meta->>'intendedUse',
    _meta->>'patientEducation', _meta->>'educationVsAdviceNote',
    coalesce((select array_agg(value::text) from jsonb_array_elements_text(
      coalesce(_meta->'cautionPopulations', '[]'::jsonb)) as value), '{}'),
    coalesce((select array_agg(value::text) from jsonb_array_elements_text(
      coalesce(_meta->'prerequisites', '[]'::jsonb)) as value), '{}'),
    coalesce((select array_agg(value::text) from jsonb_array_elements_text(
      coalesce(_meta->'missingInformationRequired', '[]'::jsonb)) as value), '{}'),
    _meta->>'evidenceGrade', _meta->>'evidenceSummary',
    true,
    'Installed from the AI Desktop Pro starter library.',
    trim(_content_hash), auth.uid())
  returning id into _version;

  perform private.write_nutrition_content(
    _organization_id, 'template', _version, _content);

  perform public.publish_nutrition_template_version(_organization_id, _version);

  return jsonb_build_object(
    'templateId', _template, 'versionId', _version, 'outcome',
    case when _next = 1 then 'installed' else 'updated' end);
end;
$$;

revoke all on function public.install_nutrition_starter_template(
  uuid, text, text, text, text, jsonb, jsonb, text) from public, anon;
grant execute on function public.install_nutrition_starter_template(
  uuid, text, text, text, text, jsonb, jsonb, text) to authenticated;

commit;
