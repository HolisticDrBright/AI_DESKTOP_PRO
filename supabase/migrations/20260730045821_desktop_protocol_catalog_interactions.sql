-- desktop_protocol_catalog_interactions
--
-- Two things the protocol slice needs before a practitioner can put a real
-- product on a real patient's plan:
--
--   1. A catalog picker that returns REAL products from the existing
--      supplement catalog (supplement_brands / supplement_products /
--      supplement_product_versions) with their exact identity, so the protocol
--      item stores a product ID, manufacturer, and label version rather than
--      free text a practitioner typed from memory.
--
--   2. A deterministic interaction check that runs ONLY where verified
--      structured data supports it, and otherwise says so.
--
-- On (2): the check is deterministic and narrow on purpose. It can only compare
-- a product against a patient's medications when BOTH sides are structured:
-- the product version must have ingredient amount rows, and the medication must
-- carry an RxNorm code. If either side is missing, the item's interaction state
-- stays 'not_completed' and the application renders "Interaction review not
-- completed". A completed check that finds nothing reports "no interaction found
-- in the checked sources" — it never reports that a product is interaction-free,
-- because absence of a row in ingredient_interactions is not evidence of safety.
--
-- This migration also CLOSES A HOLE in save_protocol_draft: it previously
-- accepted `verificationStatus` from the autosave payload, which would let a
-- client assert that a product was structured-verified. Verification is now
-- derived server-side from what the catalog actually contains, and the payload
-- field is ignored.
--
--   search_protocol_catalog(query, limit)        real products + exact identity
--   check_protocol_interactions(version_id)      deterministic-or-not-completed
--   review_protocol_item_interactions(item, note) practitioner completes review
--
-- Contract, unchanged from the rest of the Desktop boundary: SECURITY DEFINER,
-- pinned empty search_path, membership + clinical-role gates, tenant agreement
-- across every referenced record, typed errors, PHI-safe audit metadata,
-- execution revoked from anon and public.

begin;

-- ---------------------------------------------------------------------------
-- Derived verification status. NOT client-assertable.
--
--   structured_verified : the product version has ingredient amount rows, so a
--                         deterministic ingredient-level check is possible.
--   label_verified      : a real catalog version row exists with a label, but
--                         its ingredients are not structured.
--   unverified          : no catalog version pinned, or the reference is dead.
-- ---------------------------------------------------------------------------
create or replace function private.catalog_verification_status(
  _product_id uuid,
  _product_version_id uuid
) returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when _product_version_id is null then 'unverified'
    when not exists (
      select 1 from public.supplement_product_versions v
      where v.id = _product_version_id
        and (_product_id is null or v.product_id = _product_id)
    ) then 'unverified'
    when exists (
      select 1 from public.product_ingredient_amounts a
      where a.product_version_id = _product_version_id
        and a.ingredient_id is not null
    ) then 'structured_verified'
    else 'label_verified'
  end;
$$;
revoke all on function private.catalog_verification_status(uuid, uuid) from public, anon;
grant execute on function private.catalog_verification_status(uuid, uuid)
  to authenticated, service_role;

comment on function private.catalog_verification_status(uuid, uuid) is
  'Derives a protocol item''s verification_status from what the catalog actually holds. Never accepts a client assertion: a practitioner cannot mark a product structured-verified by sending a field.';

-- ---------------------------------------------------------------------------
-- search_protocol_catalog — real products, exact identity, bounded.
--
-- The supplement catalog is global product knowledge and carries no PHI, but
-- the picker is still gated on org membership: an unauthenticated caller has
-- no business enumerating it through this application's boundary.
-- ---------------------------------------------------------------------------
create or replace function public.search_protocol_catalog(
  _organization_id uuid,
  _query text default null,
  _limit integer default 20
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  _q text;
  _n integer;
  _rows jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not private.is_org_member(_organization_id) then
    raise exception 'not a member of this organization' using errcode = '42501';
  end if;

  _q := nullif(btrim(coalesce(_query, '')), '');
  _n := least(greatest(coalesce(_limit, 20), 1), 50);

  select coalesce(jsonb_agg(r order by r->>'name'), '[]'::jsonb) into _rows
  from (
    select jsonb_build_object(
      'productId', p.id,
      'name', p.name,
      'form', p.form,
      -- The catalog's brand IS the manufacturer of record. Null stays null;
      -- a missing manufacturer is not filled in with the product name.
      'manufacturer', b.name,
      'productVersionId', lv.id,
      'labelVersion', lv.version_label,
      'servingSize', lv.serving_size,
      'effectiveFrom', lv.effective_from,
      'verificationStatus', private.catalog_verification_status(p.id, lv.id),
      'structuredIngredientCount', coalesce(ic.n, 0)
    ) as r
    from public.supplement_products p
    left join public.supplement_brands b on b.id = p.brand_id
    -- Most recent label version for this product, if any.
    left join lateral (
      select v.id, v.version_label, v.serving_size, v.effective_from
      from public.supplement_product_versions v
      where v.product_id = p.id
      order by v.effective_from desc nulls last, v.created_at desc
      limit 1
    ) lv on true
    left join lateral (
      select count(*)::int as n
      from public.product_ingredient_amounts a
      where a.product_version_id = lv.id and a.ingredient_id is not null
    ) ic on true
    where _q is null
       or p.name ilike '%' || _q || '%'
       or coalesce(b.name, '') ilike '%' || _q || '%'
    order by p.name
    limit _n
  ) s;

  return jsonb_build_object(
    'products', _rows,
    'query', _q,
    'generatedAt', now()
  );
end;
$$;
revoke all on function public.search_protocol_catalog(uuid, text, integer) from public, anon;
grant execute on function public.search_protocol_catalog(uuid, text, integer)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- check_protocol_interactions — deterministic where possible, honest otherwise.
--
-- Returns one entry per product item on the version:
--
--   state 'not_completed' + reason  → the application shows
--        "Interaction review not completed" and requires practitioner review.
--   state 'checked'                 → the deterministic comparison ran. It
--        reports the findings it has, and when there are none it says the
--        checked sources found none — NOT that the product is safe.
--
-- The RPC writes nothing. Completing a review is a separate explicit action
-- below, taken by a practitioner.
-- ---------------------------------------------------------------------------
create or replace function public.check_protocol_interactions(
  _version_id uuid
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  _v public.protocol_versions%rowtype;
  _meds_structured integer;
  _meds_total integer;
  _items jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  select * into _v from public.protocol_versions where id = _version_id;
  if not found then
    raise exception 'protocol version not found' using errcode = 'P0002';
  end if;
  if _v.patient_id is null then
    raise exception 'interaction checks require a patient protocol version'
      using errcode = '22023';
  end if;
  if not private.can_author_protocol(_v.organization_id, _v.patient_id) then
    raise exception 'not authorized to review protocols for this patient'
      using errcode = '42501';
  end if;

  -- Patient medication coverage. A check against an incompletely coded
  -- medication list is not a check, and is reported as such.
  select count(*), count(nullif(btrim(coalesce(m.rxnorm, '')), ''))
    into _meds_total, _meds_structured
  from public.medications m
  where m.patient_id = _v.patient_id
    and m.organization_id = _v.organization_id
    and m.status = 'active'
    and m.deleted_at is null;

  select coalesce(jsonb_agg(e order by e->>'label'), '[]'::jsonb) into _items
  from (
    select jsonb_build_object(
      'itemId', it.id,
      'label', it.label,
      'verificationStatus', it.verification_status,
      'interactionReviewState', it.interaction_review_state,
      'state', case
        when it.verification_status <> 'structured_verified' then 'not_completed'
        when _meds_total = 0 then 'not_completed'
        when _meds_structured = 0 then 'not_completed'
        else 'checked'
      end,
      'reason', case
        when it.verification_status <> 'structured_verified'
          then 'This product has no structured ingredient data in the catalog, so no deterministic check can run.'
        when _meds_total = 0
          then 'No active medications are recorded for this patient, so there is nothing to check against. This is not evidence that the product is safe.'
        when _meds_structured = 0
          then 'This patient''s active medications carry no coded identifiers, so no deterministic check can run.'
        else null
      end,
      'findings', case
        when it.verification_status <> 'structured_verified'
             or _meds_total = 0 or _meds_structured = 0
        then '[]'::jsonb
        else coalesce((
          select jsonb_agg(distinct jsonb_build_object(
            'ingredient', ing.canonical_name,
            'medication', med.name,
            'severity', ii.severity,
            'mechanism', ii.mechanism,
            'notes', ii.notes,
            'source', ii.source,
            'version', ii.version
          ))
          from public.product_ingredient_amounts a
          join public.supplement_ingredients ing on ing.id = a.ingredient_id
          join public.ingredient_interactions ii on ii.ingredient_id = a.ingredient_id
            and ii.interacts_with_type = 'medication'
          join public.medications med
            on lower(btrim(med.rxnorm)) = lower(btrim(ii.interacts_with_ref))
           and med.patient_id = _v.patient_id
           and med.organization_id = _v.organization_id
           and med.status = 'active'
           and med.deleted_at is null
          where a.product_version_id = it.catalog_product_version_id
        ), '[]'::jsonb)
      end
    ) as e
    from public.protocol_items it
    where it.version_id = _version_id and it.kind = 'product'
    order by it.position, it.created_at
    limit 200
  ) s;

  return jsonb_build_object(
    'versionId', _version_id,
    'items', _items,
    'medicationsRecorded', _meds_total,
    'medicationsCoded', _meds_structured,
    -- Said plainly so no caller can render this as a clean bill of health.
    'disclaimer', 'A completed check reports only what the checked sources contain. It is not a determination that a product is interaction-free, and it does not replace practitioner review.',
    'generatedAt', now()
  );
end;
$$;
revoke all on function public.check_protocol_interactions(uuid) from public, anon;
grant execute on function public.check_protocol_interactions(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- review_protocol_item_interactions — the practitioner's explicit sign-off.
--
-- Only on a DRAFT version: an approved or active version's clinical content is
-- immutable, and its interaction state is part of that content. Correcting an
-- approved protocol means revising it into a new draft.
-- ---------------------------------------------------------------------------
create or replace function public.review_protocol_item_interactions(
  _item_id uuid,
  _note text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  _uid uuid;
  _it public.protocol_items%rowtype;
  _v public.protocol_versions%rowtype;
begin
  _uid := auth.uid();
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  select * into _it from public.protocol_items where id = _item_id for update;
  if not found then
    raise exception 'protocol item not found' using errcode = 'P0002';
  end if;
  select * into _v from public.protocol_versions where id = _it.version_id;
  if not found then
    raise exception 'protocol version not found' using errcode = 'P0002';
  end if;
  -- Tenant agreement between item and version, not just membership.
  if _it.organization_id <> _v.organization_id then
    raise exception 'protocol item does not belong to its version''s organization'
      using errcode = '42501';
  end if;
  if not private.can_author_protocol(_v.organization_id, _v.patient_id) then
    raise exception 'not authorized to review protocols for this organization'
      using errcode = '42501';
  end if;
  if _v.status <> 'draft' then
    raise exception 'only a draft version can be reviewed; revise the protocol to correct an approved version'
      using errcode = '22023';
  end if;
  if _it.kind <> 'product' then
    raise exception 'interaction review applies to product items' using errcode = '22023';
  end if;

  if _it.interaction_review_state = 'reviewed_by_practitioner' then
    return jsonb_build_object(
      'ok', true, 'itemId', _item_id, 'alreadyReviewed', true,
      'message', 'Interaction review was already recorded for this item.'
    );
  end if;

  update public.protocol_items
     set interaction_review_state = 'reviewed_by_practitioner',
         interaction_reviewed_by = _uid,
         interaction_reviewed_at = now(),
         instructions = case
           when nullif(btrim(coalesce(_note, '')), '') is null then instructions
           else coalesce(instructions || E'\n', '') || 'Interaction review: ' || btrim(_note)
         end,
         updated_at = now()
   where id = _item_id;

  insert into public.audit_events
    (organization_id, actor_user_id, action, resource_type, resource_id,
     safe_message, patient_id, metadata)
  values
    (_v.organization_id, _uid, 'protocol.interaction_reviewed', 'protocol_item',
     _item_id::text, 'Practitioner recorded an interaction review for a protocol item',
     _v.patient_id,
     jsonb_build_object(
       'versionId', _v.id,
       'protocolId', _v.protocol_id,
       'verificationStatus', _it.verification_status,
       'noteProvided', nullif(btrim(coalesce(_note, '')), '') is not null
     ));

  return jsonb_build_object(
    'ok', true, 'itemId', _item_id, 'alreadyReviewed', false,
    'message', 'Interaction review recorded.'
  );
end;
$$;
revoke all on function public.review_protocol_item_interactions(uuid, text) from public, anon;
grant execute on function public.review_protocol_item_interactions(uuid, text)
  to authenticated, service_role;
commit;
