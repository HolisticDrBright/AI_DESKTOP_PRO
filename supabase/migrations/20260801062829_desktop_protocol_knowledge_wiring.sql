-- Phase 9B Part 9, wiring (1 of 2): make the dependency edges real.
--
-- The preceding migration built the machinery — the dependency table, the
-- snapshot columns, the dose-provenance gate, the staleness cascade. None of it
-- was connected to anything. `save_protocol_draft` never wrote a dependency
-- edge, never snapshotted a monitoring requirement, and `approve_protocol_version`
-- never called the gate. A feature in that state passes a schema test and
-- protects nobody, which is the more dangerous of the two failure modes: the
-- table exists, so a reviewer reasonably assumes it is populated.
--
-- This half makes `protocol_version_sources` DERIVED from `protocol_items` by
-- a trigger, so "which protocols depend on this reference?" is answerable by
-- query rather than by scanning JSON — and so EVERY path that writes items
-- gets correct edges, including the three that copy items forward and any
-- written later. The RPC changes are in the migration that follows this one.

begin;

-- =============================================== rebuild the dependency edges

/**
 * Recompute a DRAFT version's governed-source dependency set from its items.
 *
 * Rebuild rather than merge: the draft's items were just replaced wholesale, so
 * a merge would leave edges pointing at sources the practitioner has removed,
 * and those stale edges would later raise staleness warnings about content that
 * is no longer in the protocol. A warning that cites something the practitioner
 * cannot find is worse than no warning.
 *
 * Approved versions are never rebuilt: their dependency set is a historical
 * fact about what was reviewed.
 */
create or replace function private.protocol_rebuild_version_sources(_version_id uuid)
returns void language plpgsql security definer set search_path = ''
as $fn$
declare _v public.protocol_versions%rowtype;
begin
  select * into _v from public.protocol_versions where id = _version_id;
  if not found or _v.status <> 'draft' then
    return;
  end if;

  delete from public.protocol_version_sources where version_id = _version_id;

  -- Exact catalog product versions the protocol names.
  insert into public.protocol_version_sources
    (organization_id, version_id, source_kind, source_id, source_label)
  select distinct _v.organization_id, _version_id, 'catalog_product_version',
         it.catalog_product_version_id,
         coalesce(it.manufacturer || ' ' || it.label, it.label)
  from public.protocol_items it
  where it.version_id = _version_id and it.catalog_product_version_id is not null;

  -- Governed intervention classes whose governance was snapshotted onto items.
  insert into public.protocol_version_sources
    (organization_id, version_id, source_kind, source_id, source_label)
  select distinct _v.organization_id, _version_id, 'intervention_class',
         it.intervention_class_id, it.intervention_class_code
  from public.protocol_items it
  where it.version_id = _version_id and it.intervention_class_id is not null
  on conflict (version_id, source_kind, source_id) do nothing;

  -- Governed references cited as the source of a dose.
  insert into public.protocol_version_sources
    (organization_id, version_id, source_kind, source_id, source_label)
  select distinct _v.organization_id, _version_id, 'knowledge_reference',
         it.dose_source_reference_id, it.dose_source_ref
  from public.protocol_items it
  where it.version_id = _version_id and it.dose_source_reference_id is not null
  on conflict (version_id, source_kind, source_id) do nothing;

  -- A practitioner-supplied dose is a dependency too, even though it points at
  -- no governed row. Recording it keeps "where did this come from?" answerable
  -- for EVERY dose rather than only the governed ones.
  insert into public.protocol_version_sources
    (organization_id, version_id, source_kind, source_id, source_label)
  select _v.organization_id, _version_id, 'practitioner_protocol', null,
         'Practitioner-supplied dosing, not a governed source'
  where exists (
    select 1 from public.protocol_items it
    where it.version_id = _version_id
      and it.dose_source_kind = 'practitioner_protocol');
end;
$fn$;

revoke all on function private.protocol_rebuild_version_sources(uuid)
  from public, anon, authenticated;

-- `source_id` is NULL for practitioner_protocol, and two NULLs are never equal
-- in SQL, so the table's `unique (version_id, source_kind, source_id)` does not
-- constrain that row at all. Without this, every save would add another one.
create unique index if not exists pvs_practitioner_once_idx
  on public.protocol_version_sources (version_id, source_kind)
  where source_id is null;

/**
 * Keep the dependency edges in step with the items, from ONE place.
 *
 * The alternative was a `perform protocol_rebuild_version_sources(...)` at the
 * end of each of the four RPCs that write items. That is four places to
 * forget, and the failure mode of forgetting is silent: the protocol saves
 * fine and simply never reports that its source moved. Deriving the edges from
 * the rows they describe means a future RPC that writes items gets correct
 * edges without knowing this feature exists.
 */
create or replace function private.protocol_sources_sync()
returns trigger language plpgsql security definer set search_path = ''
as $fn$
begin
  if tg_op = 'DELETE' then
    perform private.protocol_rebuild_version_sources(v)
    from (select distinct version_id from removed) s(v);
  else
    perform private.protocol_rebuild_version_sources(v)
    from (select distinct version_id from added) s(v);
  end if;
  return null;
end;
$fn$;

revoke all on function private.protocol_sources_sync()
  from public, anon, authenticated;

drop trigger if exists protocol_items_sources_sync_ins on public.protocol_items;
drop trigger if exists protocol_items_sources_sync_del on public.protocol_items;

create trigger protocol_items_sources_sync_ins
  after insert on public.protocol_items
  referencing new table as added
  for each statement execute function private.protocol_sources_sync();

create trigger protocol_items_sources_sync_del
  after delete on public.protocol_items
  referencing old table as removed
  for each statement execute function private.protocol_sources_sync();

commit;
