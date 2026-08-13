-- Phase 9C: the label-identity gate, wired into both approval paths.
--
-- `20260801185637` defined `private.protocol_label_identity_gate` and nothing
-- called it. A gate nobody is routed through is a comment; the two approval
-- functions are the route.
--
-- BOTH, and in the same migration, because Part 9 already made this mistake
-- once in the other direction: it gated `approve_protocol_version` and left
-- `approve_protocol_template_version` open, which is the wrong way round if
-- only one can be gated — a template is what every future protocol is copied
-- from, so an imported product with no verified label propagates from there
-- into every protocol that starts from it.
--
-- The gate's scope is deliberately narrow and is stated where it is defined:
-- it fires for IMPORT-DERIVED products, identified by the presence of a
-- provenance row. A product a practitioner entered by hand was entered by
-- someone holding the bottle. A product that arrived in a spreadsheet was not.
--
-- Both bodies are restated in full. `create or replace` has no way to patch a
-- plpgsql body, and a mechanical edit against a function this consequential is
-- harder to review than the function.

begin;

create or replace function public.approve_protocol_version(
  _version_id uuid, _review_note text default null)
returns jsonb language plpgsql security definer set search_path = ''
as $fn$
declare
  _uid uuid := auth.uid();
  _v public.protocol_versions%rowtype;
begin
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  select * into _v from public.protocol_versions where id = _version_id for update;
  if not found then
    raise exception 'protocol version not found' using errcode = 'P0002';
  end if;
  if _v.protocol_id is null then
    raise exception 'use approve_protocol_template_version for templates'
      using errcode = '22023';
  end if;
  if not private.can_author_protocol(_v.organization_id, _v.patient_id) then
    raise exception 'not authorized to approve this protocol' using errcode = '42501';
  end if;
  if _v.status <> 'draft' then
    raise exception 'only draft versions can be approved' using errcode = '22023';
  end if;
  if not exists (select 1 from public.protocol_items where version_id = _version_id) then
    raise exception 'an empty protocol cannot be approved' using errcode = '22023';
  end if;

  -- Part 9: a dose reaching an approved protocol must name where it came from.
  -- Raises 55000 and names the offending items.
  perform private.protocol_dose_provenance_gate(_version_id);

  -- Phase 9C: an imported product reaching an approved protocol must have had
  -- its exact label identity verified against the manufacturer by a reviewer.
  -- Raises 55000 and names the offending items.
  perform private.protocol_label_identity_gate(_version_id);

  update public.protocol_versions
  set status = 'approved', approved_by = _uid, approved_at = now(),
      review_note = nullif(trim(coalesce(_review_note,'')), ''),
      updated_by = _uid
  where id = _version_id;

  insert into public.audit_events
    (organization_id, patient_id, actor_user_id, action, resource_type,
     resource_id, safe_message, metadata)
  values
    (_v.organization_id, _v.patient_id, _uid, 'protocol.approved',
     'protocol_version', _version_id::text,
     'Protocol version approved by practitioner',
     jsonb_build_object('version', _v.version, 'hadNote', _review_note is not null));

  return jsonb_build_object('ok', true, 'versionId', _version_id,
    'status', 'approved',
    'message', 'Version approved and now immutable. It is NOT active — activate it separately.');
end;
$fn$;

revoke all on function public.approve_protocol_version(uuid, text) from public, anon;
grant execute on function public.approve_protocol_version(uuid, text) to authenticated;

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
  perform private.protocol_label_identity_gate(_version_id);

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
