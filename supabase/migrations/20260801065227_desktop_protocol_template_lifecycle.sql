-- Phase 9B: protocol template lifecycle — duplicate, supersede, compare,
-- safety review, and the patient-instruction preview.
--
-- Create / publish / archive already existed. What was missing is everything
-- that happens to a template AFTER it is in use, which is where the safety
-- questions actually live:
--
--   * SUPERSEDE, not replace. A template that is no longer the one to start
--     from still has to be readable, because protocols already running were
--     started from it. Superseding points forward without erasing.
--
--   * COMPARE two versions. "What changed between v2 and v3" is the question
--     a reviewer asks before publishing, and answering it by eye across two
--     screens is how a changed dose gets missed.
--
--   * SAFETY REVIEW as an append-only LOG, not a boolean. Who reviewed what,
--     when, and what they concluded is the record; a flag that can be flipped
--     back records nothing.
--
--   * PATIENT-INSTRUCTION PREVIEW derived from the version, never stored. A
--     stored copy drifts from the protocol it claims to describe, and the
--     drift is invisible.

begin;

alter table public.protocol_templates
  add column if not exists superseded_by_id uuid references public.protocol_templates(id),
  add column if not exists superseded_at timestamptz,
  add column if not exists superseded_reason text;

create index if not exists pt_superseded_by_idx
  on public.protocol_templates (superseded_by_id)
  where superseded_by_id is not null;

/**
 * Append-only safety review log for a template version.
 *
 * No UPDATE, no DELETE: a safety review that can be edited afterwards is not
 * evidence of anything. A changed conclusion is a NEW review.
 */
create table if not exists public.protocol_template_safety_reviews (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  template_id uuid not null references public.protocol_templates(id) on delete cascade,
  version_id uuid not null references public.protocol_versions(id) on delete cascade,
  outcome text not null check (outcome in ('passed','concerns','blocked')),
  note text not null,
  /** Snapshotted so the record still reads correctly if items change later. */
  items_reviewed integer not null default 0,
  unsourced_dose_count integer not null default 0,
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz not null default now()
);

create index if not exists ptsr_org_idx
  on public.protocol_template_safety_reviews (organization_id);
create index if not exists ptsr_template_idx
  on public.protocol_template_safety_reviews (template_id);
create index if not exists ptsr_version_idx
  on public.protocol_template_safety_reviews (version_id);
create index if not exists ptsr_reviewed_by_idx
  on public.protocol_template_safety_reviews (reviewed_by);

alter table public.protocol_template_safety_reviews enable row level security;

drop policy if exists ptsr_select on public.protocol_template_safety_reviews;
create policy ptsr_select on public.protocol_template_safety_reviews
  for select to authenticated using (private.is_org_member(organization_id));

revoke insert, update, delete on public.protocol_template_safety_reviews
  from anon, authenticated;

create or replace function private.ptsr_append_only()
returns trigger language plpgsql security definer set search_path = ''
as $fn$
begin
  raise exception 'a safety review is a permanent record; add a new review instead'
    using errcode = '42501';
end;
$fn$;

drop trigger if exists ptsr_append_only on public.protocol_template_safety_reviews;
create trigger ptsr_append_only
  before update or delete on public.protocol_template_safety_reviews
  for each row execute function private.ptsr_append_only();

revoke all on function private.ptsr_append_only() from public, anon, authenticated;

-- ==================================================== supersede a template

create or replace function public.supersede_protocol_template(
  _template_id uuid, _successor_template_id uuid, _reason text)
returns jsonb language plpgsql security definer set search_path = ''
as $fn$
declare _t public.protocol_templates%rowtype; _s public.protocol_templates%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  select * into _t from public.protocol_templates
  where id = _template_id and deleted_at is null for update;
  if not found then
    raise exception 'template not found' using errcode = 'P0002';
  end if;
  if not private.can_author_protocol(_t.organization_id, null) then
    raise exception 'not authorized to manage organization templates'
      using errcode = '42501';
  end if;
  if coalesce(btrim(_reason), '') = '' then
    raise exception 'superseding a template needs a reason' using errcode = '22023';
  end if;
  if _t.superseded_by_id is not null then
    raise exception 'this template is already superseded' using errcode = '55000';
  end if;
  if _successor_template_id = _template_id then
    raise exception 'a template cannot supersede itself' using errcode = '22023';
  end if;

  select * into _s from public.protocol_templates
  where id = _successor_template_id and deleted_at is null;
  if not found then
    raise exception 'successor template not found' using errcode = 'P0002';
  end if;
  if _s.organization_id <> _t.organization_id then
    raise exception 'successor belongs to another organization' using errcode = '42501';
  end if;
  if _s.status <> 'approved' then
    raise exception 'only an approved template can supersede another'
      using errcode = '22023';
  end if;
  -- Walking the chain rather than checking one hop: A->B->A is still a cycle,
  -- and a cycle here means "what should I use instead?" never terminates.
  if exists (
    with recursive chain as (
      select _s.id as id, _s.superseded_by_id as next, 1 as depth
      union all
      select t.id, t.superseded_by_id, chain.depth + 1
      from chain join public.protocol_templates t on t.id = chain.next
      where chain.depth < 64)
    select 1 from chain where chain.id = _template_id or chain.next = _template_id)
  then
    raise exception 'that would create a supersession cycle' using errcode = '22023';
  end if;

  update public.protocol_templates
  set superseded_by_id = _successor_template_id,
      superseded_at = now(),
      superseded_reason = btrim(_reason),
      updated_by = auth.uid(),
      updated_at = now()
  where id = _template_id;

  insert into public.audit_events
    (organization_id, actor_user_id, action, resource_type, resource_id,
     safe_message, metadata)
  values
    (_t.organization_id, auth.uid(), 'protocol_template.superseded',
     'protocol_template', _template_id::text,
     'Protocol template superseded by a newer template',
     jsonb_build_object('successorTemplateId', _successor_template_id));

  return jsonb_build_object('ok', true, 'templateId', _template_id,
    'supersededBy', _successor_template_id,
    'message', 'Superseded. The template is still readable — protocols already '
      || 'started from it must keep resolving — but it is no longer offered '
      || 'as a starting point.');
end;
$fn$;

revoke all on function public.supersede_protocol_template(uuid, uuid, text)
  from public, anon;
grant execute on function public.supersede_protocol_template(uuid, uuid, text)
  to authenticated;

-- ================================================= record a safety review

create or replace function public.record_protocol_template_safety_review(
  _version_id uuid, _outcome text, _note text)
returns jsonb language plpgsql security definer set search_path = ''
as $fn$
declare
  _v public.protocol_versions%rowtype;
  _items integer; _unsourced integer; _id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if _outcome not in ('passed','concerns','blocked') then
    raise exception 'a safety review outcome must be passed, concerns or blocked'
      using errcode = '22023';
  end if;
  if coalesce(btrim(_note), '') = '' then
    raise exception 'a safety review needs a note saying what was checked'
      using errcode = '22023';
  end if;

  select * into _v from public.protocol_versions where id = _version_id;
  if not found then
    raise exception 'protocol version not found' using errcode = 'P0002';
  end if;
  if _v.template_id is null then
    raise exception 'this version is not a template version' using errcode = '22023';
  end if;
  if not private.can_author_protocol(_v.organization_id, null) then
    raise exception 'not authorized to review organization templates'
      using errcode = '42501';
  end if;

  select count(*),
         count(*) filter (
           where kind = 'product'
             and coalesce(btrim(dosage_text), '') <> ''
             and dose_source_kind is null)
  into _items, _unsourced
  from public.protocol_items where version_id = _version_id;

  insert into public.protocol_template_safety_reviews
    (organization_id, template_id, version_id, outcome, note,
     items_reviewed, unsourced_dose_count, reviewed_by)
  values
    (_v.organization_id, _v.template_id, _version_id, _outcome, btrim(_note),
     _items, _unsourced, auth.uid())
  returning id into _id;

  insert into public.audit_events
    (organization_id, actor_user_id, action, resource_type, resource_id,
     safe_message, metadata)
  values
    (_v.organization_id, auth.uid(), 'protocol_template.safety_reviewed',
     'protocol_version', _version_id::text,
     'Protocol template version reviewed for safety',
     jsonb_build_object('outcome', _outcome, 'unsourcedDoseCount', _unsourced));

  return jsonb_build_object('ok', true, 'reviewId', _id,
    'outcome', _outcome,
    'unsourcedDoseCount', _unsourced,
    'message', case
      when _unsourced > 0 then
        'Review recorded. ' || _unsourced || ' item(s) carry a dose with no '
        || 'recorded source and will block publication until a source is named.'
      else 'Review recorded.' end);
end;
$fn$;

revoke all on function public.record_protocol_template_safety_review(uuid, text, text)
  from public, anon;
grant execute on function public.record_protocol_template_safety_review(uuid, text, text)
  to authenticated;

-- ============================================== compare two template versions

/**
 * A structured diff of two versions of the same template.
 *
 * SUPERSEDED by 20260801065645, which drops the same-template restriction:
 * comparing a duplicate against the template it came from is the commonest
 * review and this version refused it. Kept as applied, for ledger fidelity.
 *
 *
 * Items are matched on LABEL, which is what a reviewer reads. Matching on row
 * id would report every item as removed-and-added after any save, since a save
 * replaces items wholesale — a diff that is always "everything changed" is a
 * diff nobody reads.
 */
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
  if not private.is_org_member(_l.organization_id)
     or not private.is_org_member(_r.organization_id) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
  if _l.template_id is null or _r.template_id is null
     or _l.template_id <> _r.template_id then
    raise exception 'both versions must belong to the same template'
      using errcode = '22023';
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

  -- A DOSE change is called out on its own. Everything else changing matters
  -- less than a number a patient will act on.
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
    'templateId', _l.template_id,
    'left', jsonb_build_object('versionId', _l.id, 'version', _l.version,
      'status', _l.status, 'title', _l.title),
    'right', jsonb_build_object('versionId', _r.id, 'version', _r.version,
      'status', _r.status, 'title', _r.title),
    'added', _added,
    'removed', _removed,
    'changed', _changed,
    'doseChangeCount', (
      select count(*) from jsonb_array_elements(_changed) c
      where (c->>'doseChanged')::boolean),
    'matchNote',
      'Items are matched by label. A renamed item therefore reads as one '
      || 'removal and one addition rather than as a change — check those pairs '
      || 'before assuming an item was replaced.');
end;
$fn$;

revoke all on function public.compare_protocol_template_versions(uuid, uuid)
  from public, anon;
grant execute on function public.compare_protocol_template_versions(uuid, uuid)
  to authenticated;

-- ============================================ template detail + patient preview

create or replace function public.get_protocol_template_detail(_template_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $fn$
declare
  _t public.protocol_templates%rowtype;
  _versions jsonb; _reviews jsonb; _current jsonb; _instructions jsonb;
  _current_id uuid; _unsourced integer;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  select * into _t from public.protocol_templates
  where id = _template_id and deleted_at is null;
  if not found then
    raise exception 'template not found' using errcode = 'P0002';
  end if;
  if not private.is_org_member(_t.organization_id) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;

  _current_id := coalesce(_t.approved_version_id, _t.current_version_id);

  select coalesce(jsonb_agg(jsonb_build_object(
    'versionId', v.id, 'version', v.version, 'status', v.status,
    'title', v.title, 'approvedAt', v.approved_at,
    'createdAt', v.created_at, 'itemCount', (
      select count(*) from public.protocol_items it where it.version_id = v.id))
    order by v.version desc), '[]'::jsonb)
  into _versions
  from public.protocol_versions v where v.template_id = _template_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'reviewId', s.id, 'versionId', s.version_id, 'outcome', s.outcome,
    'note', s.note, 'itemsReviewed', s.items_reviewed,
    'unsourcedDoseCount', s.unsourced_dose_count,
    'reviewedAt', s.reviewed_at)
    order by s.reviewed_at desc), '[]'::jsonb)
  into _reviews
  from public.protocol_template_safety_reviews s where s.template_id = _template_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'itemId', it.id, 'label', it.label, 'kind', it.kind,
    'position', it.position,
    'dosageText', it.dosage_text, 'timingText', it.timing_text,
    'route', it.route,
    'doseSourceKind', it.dose_source_kind, 'doseSourceRef', it.dose_source_ref,
    'manufacturer', it.manufacturer, 'labelVersion', it.label_version,
    'productSku', it.product_sku, 'productUpc', it.product_upc,
    'labelSha256', it.label_sha256,
    'verificationStatus', it.verification_status,
    'interventionClassCode', it.intervention_class_code,
    'monitoringRequirements', to_jsonb(it.monitoring_requirements),
    'stoppingRules', to_jsonb(it.stopping_rules),
    'contraindications', to_jsonb(it.contraindications),
    'followupIntervalDays', it.followup_interval_days,
    'jurisdictionSensitive', it.jurisdiction_sensitive)
    order by it.position), '[]'::jsonb)
  into _current
  from public.protocol_items it where it.version_id = _current_id;

  -- The patient-facing preview. DERIVED here, never stored: a saved copy
  -- silently drifts from the protocol it claims to describe. It carries only
  -- what was actually recorded — an item with no dose shows no dose rather
  -- than a plausible-looking default.
  select coalesce(jsonb_agg(jsonb_build_object(
    'label', it.label,
    'kind', it.kind,
    'instruction', it.instructions,
    'dose', it.dosage_text,
    'timing', it.timing_text,
    'stopIf', to_jsonb(it.stopping_rules),
    'doseIsSourced', it.dose_source_kind is not null)
    order by it.position), '[]'::jsonb)
  into _instructions
  from public.protocol_items it
  where it.version_id = _current_id and it.kind in ('product','diet','lifestyle');

  select count(*) into _unsourced
  from public.protocol_items
  where version_id = _current_id and kind = 'product'
    and coalesce(btrim(dosage_text), '') <> '' and dose_source_kind is null;

  return jsonb_build_object(
    'templateId', _t.id,
    'name', _t.name,
    'description', _t.description,
    'status', _t.status,
    'archivedAt', _t.archived_at,
    'supersededById', _t.superseded_by_id,
    'supersededAt', _t.superseded_at,
    'supersededReason', _t.superseded_reason,
    'currentVersionId', _current_id,
    'approvedVersionId', _t.approved_version_id,
    'versions', _versions,
    'items', _current,
    'safetyReviews', _reviews,
    'unsourcedDoseCount', _unsourced,
    'patientInstructionPreview', _instructions,
    'previewNotice',
      'This preview is generated from the template as it stands right now. It '
      || 'is not stored and not sent anywhere. An item with no recorded dose '
      || 'shows no dose — nothing is filled in to make the sheet look complete.',
    'safetyNotice', case
      when _unsourced > 0 then
        _unsourced || ' item(s) carry a dose with no recorded source. '
        || 'Publication is blocked until each names an exact product label, a '
        || 'supplied practitioner protocol, or a governed reference.'
      else 'Every recorded dose names its source.' end);
end;
$fn$;

revoke all on function public.get_protocol_template_detail(uuid) from public, anon;
grant execute on function public.get_protocol_template_detail(uuid) to authenticated;

-- ====================================== publication enforces dose provenance
--
-- Part 9 gated `approve_protocol_version` and left the TEMPLATE path ungated,
-- which is the wrong way round if only one of them could be: a template is
-- what every future protocol is started from, so an unsourced dose there
-- propagates into every patient protocol that copies it. Gating the copies but
-- not the original catches the mistake one step too late, every time.
--
-- Restated in full rather than rewritten mechanically: this body is short, and
-- a `replace()` against a five-line function is harder to check than the
-- function.

create or replace function public.approve_protocol_template_version(_version_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $fn$
declare
  _uid uuid := auth.uid();
  _v public.protocol_versions%rowtype;
  _t public.protocol_templates%rowtype;
begin
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  select * into _v from public.protocol_versions where id = _version_id for update;
  if not found then
    raise exception 'template version not found' using errcode = 'P0002';
  end if;
  if _v.template_id is null then
    raise exception 'not a template version' using errcode = '22023';
  end if;
  if not private.can_author_protocol(_v.organization_id, null) then
    raise exception 'not authorized to approve organization templates' using errcode = '42501';
  end if;
  if _v.status <> 'draft' then
    raise exception 'only draft template versions can be approved' using errcode = '22023';
  end if;

  -- Raises 55000 and names the offending items.
  perform private.protocol_dose_provenance_gate(_version_id);

  select * into _t from public.protocol_templates where id = _v.template_id for update;
  if _t.superseded_by_id is not null then
    raise exception 'this template is superseded; publish on its successor instead'
      using errcode = '55000';
  end if;
  if _t.approved_version_id is not null then
    update public.protocol_versions set status = 'superseded', updated_by = _uid
    where id = _t.approved_version_id;
  end if;

  update public.protocol_versions
  set status = 'approved', approved_by = _uid, approved_at = now(), updated_by = _uid
  where id = _version_id;

  update public.protocol_templates
  set status = 'approved', approved_version_id = _version_id,
      current_version_id = _version_id, updated_by = _uid
  where id = _v.template_id;

  insert into public.audit_events
    (organization_id, patient_id, actor_user_id, action, resource_type,
     resource_id, safe_message, metadata)
  values
    (_v.organization_id, null, _uid, 'protocol_template.approved',
     'protocol_version', _version_id::text, 'Protocol template version approved',
     jsonb_build_object('version', _v.version));

  return jsonb_build_object('ok', true, 'versionId', _version_id, 'status', 'approved',
    'message', 'Template version approved and immutable.');
end;
$fn$;

revoke all on function public.approve_protocol_template_version(uuid) from public, anon;
grant execute on function public.approve_protocol_template_version(uuid) to authenticated;

commit;
