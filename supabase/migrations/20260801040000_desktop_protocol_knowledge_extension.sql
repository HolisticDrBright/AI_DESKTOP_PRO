-- Phase 9B Part 9: the protocol knowledge extension.
--
-- A protocol version currently records WHAT to do. This adds WHERE IT CAME FROM
-- and WHEN IT STOPPED BEING TRUE.
--
-- THE PROBLEM THIS SOLVES. Governed knowledge moves: a reference is superseded,
-- a product label is reformulated, an intervention class gains a stopping rule.
-- Today an approved protocol built on any of those keeps rendering exactly as
-- it did the day it was approved, with no indication the ground moved. That is
-- the dangerous failure: not a wrong protocol, but a protocol that has quietly
-- stopped being the one the practitioner reviewed.
--
-- THE SHAPE OF THE FIX.
--
--   1. `protocol_version_sources` records every governed source a version
--      depends on. It is the dependency edge that makes staleness computable
--      at all — without it, "which protocols used this reference?" has no
--      answer short of scanning JSON.
--
--   2. When a source goes superseded / withdrawn / expired / stale /
--      discontinued / conflicted, dependent versions are MARKED STALE. The
--      protocol itself is not edited, not withdrawn, and not deleted. A
--      practitioner keeps reading exactly the words they approved, and
--      additionally learns the source underneath them changed. Editing it for
--      them would be worse: it would mean the record no longer says what was
--      actually prescribed.
--
--   3. Monitoring requirements and stopping rules are SNAPSHOTTED onto the item
--      at save time from the governed intervention class. A snapshot, not a
--      join — otherwise editing a class silently rewrites protocols that were
--      already approved, which is the same defect as (2) with the sign flipped.
--
--   4. A dose on an approved version must name its source. Draft is permissive
--      because a practitioner types the dose before they attach the label; at
--      APPROVAL the constraint bites.
--
-- NOTHING HERE INVENTS CLINICAL CONTENT. Every monitoring requirement, stopping
-- rule and dose is copied from a governed row or supplied by the practitioner.
-- Where nothing is recorded, the result is NULL and renders as "Unknown".

begin;

-- ---------------------------------------------------------- staleness state

alter table public.protocol_versions
  add column if not exists source_stale_at timestamptz,
  add column if not exists source_stale_reason text,
  /** How many distinct governed sources are currently flagged. */
  add column if not exists stale_source_count integer not null default 0,
  /** Cleared by a practitioner who has re-reviewed against the new source. */
  add column if not exists stale_reviewed_at timestamptz,
  add column if not exists stale_reviewed_by uuid references auth.users(id);

create index if not exists pv_stale_idx
  on public.protocol_versions (organization_id, source_stale_at)
  where source_stale_at is not null;
create index if not exists pv_stale_reviewed_by_idx
  on public.protocol_versions (stale_reviewed_by);

-- ------------------------------------------------------- dependency edges

/**
 * Every governed source a protocol version depends on.
 *
 * Append-only in practice: rows are rebuilt when a DRAFT is saved and frozen
 * once the version is approved, because the dependency set of an approved
 * protocol is a historical fact.
 */
create table public.protocol_version_sources (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  version_id uuid not null references public.protocol_versions(id) on delete cascade,

  source_kind text not null check (source_kind in (
    'knowledge_reference', 'product_label_version', 'catalog_product_version',
    'intervention_class', 'practitioner_protocol')),
  /** Null for `practitioner_protocol`, which has no governed row to point at. */
  source_id uuid,
  /** Human locator, so a stale notice can name the thing without a join. */
  source_label text,

  /** Set when the source moved. The protocol row itself is never edited. */
  stale_at timestamptz,
  stale_reason text,

  recorded_at timestamptz not null default now(),

  constraint pvs_governed_needs_id check (
    source_kind = 'practitioner_protocol' or source_id is not null),
  unique (version_id, source_kind, source_id)
);

create index pvs_org_idx on public.protocol_version_sources (organization_id);
create index pvs_version_idx on public.protocol_version_sources (version_id);
create index pvs_lookup_idx on public.protocol_version_sources (source_kind, source_id);
create index pvs_stale_idx on public.protocol_version_sources (stale_at)
  where stale_at is not null;

alter table public.protocol_version_sources enable row level security;

create policy protocol_version_sources_select on public.protocol_version_sources
  for select to authenticated using (private.is_org_member(organization_id));

revoke insert, update, delete on public.protocol_version_sources
  from anon, authenticated;

-- --------------------------------------------------- snapshotted governance

alter table public.protocol_items
  /** Copied from the governed intervention class AT SAVE TIME, never joined. */
  add column if not exists monitoring_requirements text[] not null default '{}',
  add column if not exists stopping_rules text[] not null default '{}',
  add column if not exists contraindications text[] not null default '{}',
  add column if not exists followup_interval_days integer,
  add column if not exists jurisdiction_sensitive boolean not null default false,
  /** The class code as it was, so a renamed class does not orphan the record. */
  add column if not exists intervention_class_code text,
  /** Exact product identity, frozen with the item. */
  add column if not exists product_sku text,
  add column if not exists product_upc text,
  add column if not exists label_captured_at timestamptz,
  add column if not exists label_sha256 text;

-- ============================================ a dose must name its source
--
-- Draft is permissive; approval is not. A practitioner types a dose before
-- they attach the label, and refusing the keystroke would just teach them to
-- put the dose somewhere the system cannot see.

create or replace function private.protocol_dose_provenance_gate(_version_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare _missing text;
begin
  select string_agg(label, ', ' order by position) into _missing
  from public.protocol_items
  where version_id = _version_id
    and kind = 'product'
    and coalesce(btrim(dosage_text), '') <> ''
    and dose_source_kind is null;

  if _missing is not null then
    raise exception
      'these items carry a dose with no recorded source: %. A dose requires an '
      'exact product label, a supplied practitioner protocol, or a governed '
      'reference — record which one before approving.', _missing
      using errcode = '55000';
  end if;
end;
$$;

revoke all on function private.protocol_dose_provenance_gate(uuid)
  from public, anon, authenticated;

-- ==================================================== stale-source cascade

/**
 * Mark every protocol version that depends on a source as stale.
 *
 * Marks, never edits. The protocol keeps saying exactly what it said; the
 * practitioner additionally learns the source moved and can re-review.
 */
create or replace function private.protocol_mark_sources_stale(
  _source_kind text, _source_id uuid, _reason text)
returns integer language plpgsql security definer set search_path = ''
as $$
declare _n integer;
begin
  update public.protocol_version_sources
  set stale_at = now(), stale_reason = _reason
  where source_kind = _source_kind and source_id = _source_id and stale_at is null;
  get diagnostics _n = row_count;

  update public.protocol_versions v
  set source_stale_at = coalesce(v.source_stale_at, now()),
      source_stale_reason = _reason,
      stale_source_count = (
        select count(*) from public.protocol_version_sources s
        where s.version_id = v.id and s.stale_at is not null),
      -- A previous re-review does not survive a NEW source moving.
      stale_reviewed_at = null,
      stale_reviewed_by = null
  where exists (
    select 1 from public.protocol_version_sources s
    where s.version_id = v.id and s.source_kind = _source_kind
      and s.source_id = _source_id and s.stale_at is not null);

  return _n;
end;
$$;

revoke all on function private.protocol_mark_sources_stale(text, uuid, text)
  from public, anon, authenticated;

/** A governed reference reaching a terminal state stales its dependents. */
create or replace function private.protocol_stale_on_reference_state()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.status in ('superseded', 'withdrawn', 'expired') then
    perform private.protocol_mark_sources_stale(
      'knowledge_reference', new.reference_id,
      'The governed reference behind this protocol was marked ' || new.status
        || '. The protocol is unchanged; re-review it against the current source.');
  end if;
  return new;
end;
$$;

create trigger clinical_knowledge_source_states_protocol_stale
  after insert on public.clinical_knowledge_source_states
  for each row execute function private.protocol_stale_on_reference_state();

/** A product version leaving `verified` stales protocols that cite it. */
create or replace function private.protocol_stale_on_product_state()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and new.verification_state is distinct from old.verification_state
     and new.verification_state in ('stale', 'discontinued', 'conflicted') then
    perform private.protocol_mark_sources_stale(
      'catalog_product_version', new.id,
      'The exact product version in this protocol is now '
        || new.verification_state
        || '. The protocol is unchanged; confirm the product before continuing it.');
  end if;
  return new;
end;
$$;

create trigger supplement_product_versions_protocol_stale
  after update on public.supplement_product_versions
  for each row execute function private.protocol_stale_on_product_state();

revoke all on function private.protocol_stale_on_reference_state()
  from public, anon, authenticated;
revoke all on function private.protocol_stale_on_product_state()
  from public, anon, authenticated;

-- ------------------------------------------------- acknowledge a stale source

/**
 * Record that a practitioner re-reviewed a protocol against its moved source.
 *
 * Deliberately does NOT clear `source_stale_at`. The fact that the ground moved
 * is permanent history; what changes is that a named person has looked at it
 * since. Clearing the flag would erase the reason the review happened.
 */
create or replace function public.acknowledge_protocol_stale_sources(
  _version_id uuid, _note text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _v public.protocol_versions%rowtype; _uid uuid;
begin
  select * into _v from public.protocol_versions where id = _version_id for update;
  if not found then
    raise exception 'protocol version not found' using errcode = 'P0002';
  end if;
  if not private.can_author_protocol(_v.organization_id, _v.patient_id) then
    raise exception 'not authorized to review this protocol' using errcode = '42501';
  end if;
  if _v.source_stale_at is null then
    raise exception 'this protocol has no stale source to acknowledge'
      using errcode = '55000';
  end if;
  if coalesce(btrim(_note), '') = '' then
    raise exception 'a re-review needs a note saying what you checked'
      using errcode = '22023';
  end if;
  _uid := auth.uid();

  update public.protocol_versions
  set stale_reviewed_at = now(), stale_reviewed_by = _uid,
      review_note = _note
  where id = _version_id;

  insert into public.audit_events
    (organization_id, actor_user_id, action, resource_type, resource_id,
     safe_message, metadata)
  values
    (_v.organization_id, _uid, 'protocol.stale_sources_reviewed',
     'protocol_version', _version_id::text,
     'Practitioner re-reviewed a protocol whose governed source had moved',
     jsonb_build_object('staleSourceCount', _v.stale_source_count));

  return jsonb_build_object(
    'ok', true, 'versionId', _version_id,
    'staleSourceCount', _v.stale_source_count,
    'message', 'Re-review recorded. The staleness flag is kept deliberately: '
      || 'that the source moved is permanent history, and what changed is that '
      || 'someone has now looked at it.');
end;
$$;

revoke all on function public.acknowledge_protocol_stale_sources(uuid, text)
  from public, anon;
grant execute on function public.acknowledge_protocol_stale_sources(uuid, text)
  to authenticated;

-- ---------------------------------------------------- read the knowledge view

/**
 * The governed knowledge attached to a protocol version: exact product
 * identity, dose provenance, monitoring, stopping rules, and source staleness.
 *
 * Reads NO commercial table. The acceptance suite asserts it by name.
 */
create or replace function public.get_protocol_knowledge(_version_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare _v public.protocol_versions%rowtype; _items jsonb; _sources jsonb;
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

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', it.id, 'label', it.label, 'kind', it.kind, 'position', it.position,
    'phaseId', it.phase_id,
    'dosageText', it.dosage_text,
    'doseSourceKind', it.dose_source_kind,
    'doseSourceRef', it.dose_source_ref,
    'doseSourceReferenceId', it.dose_source_reference_id,
    'catalogProductVersionId', it.catalog_product_version_id,
    'manufacturer', it.manufacturer,
    'labelVersion', it.label_version,
    'productSku', it.product_sku,
    'productUpc', it.product_upc,
    'labelCapturedAt', it.label_captured_at,
    'labelSha256', it.label_sha256,
    'verificationStatus', it.verification_status,
    'interventionClassCode', it.intervention_class_code,
    'jurisdictionSensitive', it.jurisdiction_sensitive,
    'monitoringRequirements', to_jsonb(it.monitoring_requirements),
    'stoppingRules', to_jsonb(it.stopping_rules),
    'contraindications', to_jsonb(it.contraindications),
    'followupIntervalDays', it.followup_interval_days)
    order by it.position, it.created_at), '[]'::jsonb)
  into _items
  from public.protocol_items it where it.version_id = _version_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'sourceKind', s.source_kind, 'sourceId', s.source_id,
    'sourceLabel', s.source_label,
    'staleAt', s.stale_at, 'staleReason', s.stale_reason)
    order by s.recorded_at), '[]'::jsonb)
  into _sources
  from public.protocol_version_sources s where s.version_id = _version_id;

  return jsonb_build_object(
    'versionId', _version_id,
    'version', _v.version,
    'status', _v.status,
    'items', _items,
    'sources', _sources,
    'sourceStaleAt', _v.source_stale_at,
    'sourceStaleReason', _v.source_stale_reason,
    'staleSourceCount', _v.stale_source_count,
    'staleReviewedAt', _v.stale_reviewed_at,
    'dosePolicy', 'A dose is shown only where a source is recorded for it. An '
      || 'item with no recorded dose shows no dose — nothing is inferred from a '
      || 'product name.',
    'stalePolicy', 'A stale source never edits, withdraws or deletes a '
      || 'protocol. The protocol keeps saying exactly what was approved.');
end;
$$;

revoke all on function public.get_protocol_knowledge(uuid) from public, anon;
grant execute on function public.get_protocol_knowledge(uuid) to authenticated;

commit;
