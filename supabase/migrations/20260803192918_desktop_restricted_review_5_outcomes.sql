-- Governed 5-outcome restricted-review decision surface.
--
-- The catalog already has two coarse actions on restricted rows —
-- `complete_catalog_product_review` (a reviewer says "I looked at it, it's
-- fine to leave restricted") and `clear_catalog_product_restriction`
-- (a reviewer downgrades the flag). That is not enough for the workspace
-- Phase 9E-A ships. The spec requires five discrete outcomes so the
-- practitioner records WHAT they decided, not just that they touched
-- the row:
--
--   * retain_restricted   — the reviewer looked and it stays restricted
--   * request_evidence    — the reviewer needs a citation before deciding
--   * defer               — the reviewer is not ready to decide
--   * reject              — the row will never be used
--   * clinician_reviewed_for_jurisdiction — a clinician reviewed for a stated
--                            jurisdiction; this is NOT approval, and it does
--                            NOT clear the restriction
--
-- Every decision requires a reason. The jurisdiction outcome additionally
-- requires a non-empty jurisdiction string. The decisions are append-only:
-- a later decision supersedes an earlier one but the earlier one is not
-- deleted. That preserves the audit trail the operator can point at.
--
-- Restrictions declared at import time (source_restricted_flags) are not
-- silently cleared by ANY of these outcomes. Clearing a restriction is a
-- separate action (`clear_catalog_product_restriction`) that is not part of
-- this migration.

create type public.catalog_restricted_review_outcome as enum (
  'retain_restricted',
  'request_evidence',
  'defer',
  'reject',
  'clinician_reviewed_for_jurisdiction'
);

create table public.catalog_restricted_review_decisions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  product_id uuid not null references public.supplement_products(id) on delete restrict,
  outcome public.catalog_restricted_review_outcome not null,
  reason text not null,
  jurisdiction text,
  decided_by uuid not null references auth.users(id),
  decided_at timestamptz not null default now(),
  constraint catalog_restricted_review_reason_non_empty check (btrim(reason) <> ''),
  constraint catalog_restricted_review_jurisdiction_when_clinician
    check (
      (outcome = 'clinician_reviewed_for_jurisdiction' and coalesce(btrim(jurisdiction), '') <> '')
      or (outcome <> 'clinician_reviewed_for_jurisdiction')
    )
);

create index catalog_restricted_review_decisions_product_idx
  on public.catalog_restricted_review_decisions(product_id, decided_at desc);
create index catalog_restricted_review_decisions_org_idx
  on public.catalog_restricted_review_decisions(organization_id, decided_at desc);

alter table public.catalog_restricted_review_decisions enable row level security;

-- Append-only: no update, no delete, no matter the role. If we ever need to
-- correct a decision, a NEW decision replaces the old one visibly.
create policy catalog_restricted_review_decisions_no_update
  on public.catalog_restricted_review_decisions for update
  using (false);
create policy catalog_restricted_review_decisions_no_delete
  on public.catalog_restricted_review_decisions for delete
  using (false);
create policy catalog_restricted_review_decisions_read_org
  on public.catalog_restricted_review_decisions for select
  using (organization_id in (
    select organization_id from public.organization_memberships
    where user_id = (select auth.uid()) and status = 'active'
  ));

-- Inserts go through the RPC (SECURITY DEFINER) — no direct-write policy is
-- offered here. A malformed request cannot reach this table without the RPC.

comment on table public.catalog_restricted_review_decisions is
  'Append-only log of restricted-review decisions per catalog product. Inserts only via record_restricted_review_outcome. Never deleted, never updated.';

create or replace function public.record_restricted_review_outcome(
  _organization_id uuid,
  _product_id uuid,
  _outcome public.catalog_restricted_review_outcome,
  _reason text,
  _jurisdiction text default null
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  _uid uuid;
  _product public.supplement_products%rowtype;
  _decision_id uuid;
begin
  select * into _product from public.supplement_products where id = _product_id;
  if not found then
    raise exception 'product not found' using errcode = 'P0002';
  end if;

  -- Products are global-ish; decisions are tenant-scoped. Require editor
  -- role in the tenant that is making the decision, and store the tenant
  -- on the decision row so the audit trail stays honest.
  _uid := private.require_knowledge_editor(_organization_id);

  if coalesce(btrim(_reason), '') = '' then
    raise exception 'a restricted-review decision requires a reason'
      using errcode = '22023';
  end if;

  if _outcome = 'clinician_reviewed_for_jurisdiction'
     and coalesce(btrim(_jurisdiction), '') = '' then
    raise exception 'clinician_reviewed_for_jurisdiction requires a jurisdiction'
      using errcode = '22023';
  end if;

  -- Reject-outcome is not the same as clearance. A rejected product stays
  -- restricted-flag-carrying and is not automatically deleted; a follow-on
  -- action (clear_catalog_product_restriction) is still required if the
  -- restriction is to leave.
  insert into public.catalog_restricted_review_decisions
    (organization_id, product_id, outcome, reason, jurisdiction, decided_by)
  values
    (_organization_id, _product_id, _outcome, btrim(_reason), nullif(btrim(_jurisdiction), ''), _uid)
  returning id into _decision_id;

  insert into public.audit_events
    (organization_id, actor_user_id, action, resource_type, resource_id,
     safe_message, metadata)
  values
    (_organization_id, _uid, 'catalog.restricted_review_recorded',
     'supplement_product', _product_id::text,
     'Restricted-review outcome recorded',
     jsonb_build_object('outcome', _outcome, 'has_jurisdiction', _jurisdiction is not null));

  return jsonb_build_object(
    'ok', true,
    'decisionId', _decision_id,
    'outcome', _outcome,
    'restrictionsPreserved', true);
end;
$function$;

comment on function public.record_restricted_review_outcome is
  'Record one of five governed restricted-review outcomes with a reason. Clinician-reviewed-for-jurisdiction additionally requires a jurisdiction. None of these clears the restriction — clearance is a separate governed action.';

revoke all on function public.record_restricted_review_outcome from public, anon;
grant execute on function public.record_restricted_review_outcome to authenticated;

-- Read-side helper: the CURRENT (latest) decision per product, plus counts.
create or replace function public.get_restricted_review_history(
  _organization_id uuid,
  _product_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  _uid uuid := auth.uid();
  _rows jsonb;
begin
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not exists (
    select 1 from public.organization_memberships
    where organization_id = _organization_id
      and user_id = _uid
      and status = 'active'
  ) then
    raise exception 'not a member of this organization'
      using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(x order by x->>'decidedAt' desc), '[]'::jsonb) into _rows
  from (
    select jsonb_build_object(
      'id', d.id,
      'outcome', d.outcome,
      'reason', d.reason,
      'jurisdiction', d.jurisdiction,
      'decidedBy', d.decided_by,
      'decidedAt', d.decided_at
    ) as x
    from public.catalog_restricted_review_decisions d
    where d.product_id = _product_id
      and d.organization_id = _organization_id
  ) t;

  return jsonb_build_object(
    'productId', _product_id,
    'organizationId', _organization_id,
    'currentOutcome', (
      select outcome
      from public.catalog_restricted_review_decisions
      where product_id = _product_id
        and organization_id = _organization_id
      order by decided_at desc limit 1),
    'history', _rows);
end;
$function$;

revoke all on function public.get_restricted_review_history from public, anon;
grant execute on function public.get_restricted_review_history to authenticated;
