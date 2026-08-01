-- Phase 9A: fix two defects the acceptance suite caught.
--
-- 1. THE EVIDENCE GUARD FIRED TOO EARLY. It refused any row claiming
--    `governed_reference` without a provenance row in the SAME transaction.
--    But the RPC path records references in a LATER call — draft the version,
--    then attach citations — so a practitioner who set that grade while
--    drafting could never commit, whatever they did next. The rule was right
--    and the moment was wrong: a DRAFT may hold the intent, a PUBLISHED or
--    APPROVED version must have the citation. The guard now fires only for
--    those, and `publish_nutrition_template_version` checks it up front so the
--    refusal is a sentence rather than a commit-time surprise.
--
-- 2. A NUTRIENT TARGET COULD BE STORED WITH NO UNIT. `write_nutrition_content`
--    refused one, but storage did not, so any other definer path could have
--    written a bare number. An unlabelled nutrition figure is the exact
--    ambiguity this phase exists to remove, so it is now NOT NULL. The table
--    is empty, so nothing is rewritten.

begin;

alter table public.nutrition_targets alter column unit set not null;

drop trigger if exists nutrition_template_evidence_guard
  on public.nutrition_template_versions;

create constraint trigger nutrition_template_evidence_guard
  after insert or update on public.nutrition_template_versions
  deferrable initially deferred
  for each row
  when (new.evidence_grade = 'governed_reference'
        and new.status in ('approved', 'published'))
  execute function private.nutrition_evidence_guard();

/**
 * Publish, with the evidence claim checked BEFORE the status moves.
 *
 * The deferred trigger above is the backstop for a direct writer; this is the
 * message a practitioner actually reads.
 */
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
  if not exists (
    select 1 from public.nutrition_food_rules where template_version_id = _v.id
    union all
    select 1 from public.nutrition_meal_days where template_version_id = _v.id
  ) then
    raise exception 'a template needs food guidance or a meal plan before publishing'
      using errcode = '22023';
  end if;
  -- Nothing is published as evidence-based on the strength of a typed string.
  if _v.evidence_grade = 'governed_reference' and not exists (
    select 1 from public.nutrition_provenance p
    where p.template_version_id = _v.id and p.kind = 'governed_reference'
  ) then
    raise exception 'record a governed reference before publishing this as evidence-based'
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

revoke all on function public.publish_nutrition_template_version(uuid, uuid)
  from public, anon;
grant execute on function public.publish_nutrition_template_version(uuid, uuid)
  to authenticated;

commit;
