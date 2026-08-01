-- Phase 8B: plans, entitlements, subscriptions & reconciliation — RPCs.
--
-- Every caller RPC: SECURITY DEFINER, search_path pinned empty, explicit
-- auth.uid() identity, active-membership check, a GRANULAR financial
-- permission check (private.has_financial_permission — not one blanket
-- billing role), tenant agreement on every referenced row, bounded DTOs, and
-- typed errors: 28000 anonymous, 42501 forbidden, P0002 not found,
-- 22023 invalid, 40001 conflict. No PHI in any error message.
--
-- ENTITLEMENT ACCOUNTING POLICY (the contract the UI and docs describe):
--   grant    purchase paid / renewal / complimentary  -> remaining += n
--   reserve  booking holds a credit                   -> remaining -n, reserved +n
--   release  permitted cancellation                   -> reserved -n, remaining +n
--   consume  arrival or completion (org policy)       -> reserved -n, consumed +n
--   expire   past expires_at                          -> remaining -n, expired +n
--   refund_revoke  purchase refunded                  -> remaining -n, refunded +n
--   manual_restore  reasoned correction               -> consumed/expired -n, remaining +n
-- Every one writes an entitlement_ledger row in the SAME statement, and the
-- table's identity check (granted = remaining+reserved+consumed+expired+
-- refunded) makes an unbalanced move impossible to commit.
--
-- The browser NEVER asserts availability or consumption: it calls these and
-- renders what comes back.

begin;

-- ------------------------------------------------------------- helpers

create or replace function private.require_financial(_org uuid, _permission text)
returns void language plpgsql stable security definer set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not private.is_org_member(_org) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
  if not private.has_financial_permission(_org, _permission) then
    raise exception 'this action requires the % permission', _permission
      using errcode = '42501';
  end if;
end;
$$;

/** Read gate: membership only. Front-desk staff may READ the workspace. */
create or replace function private.require_financial_read(_org uuid)
returns void language plpgsql stable security definer set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not private.is_org_member(_org) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
  if not private.has_financial_permission(_org, 'billing.view_summary') then
    raise exception 'this action requires the billing.view_summary permission'
      using errcode = '42501';
  end if;
end;
$$;

/** The org's explicit credit policy, with documented defaults when unset. */
create or replace function private.billing_policy(_org uuid)
returns public.org_billing_policies language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (select p from public.org_billing_policies p where p.organization_id = _org),
    row(_org, 'consume', 'release', 24, 'completed', now(), null)::public.org_billing_policies
  );
$$;

/** Move an entitlement and record the ledger row atomically. */
create or replace function private.entitlement_move(
  _entitlement_id uuid, _kind text, _quantity integer,
  _ref_type text, _ref_id uuid, _reason text, _source text default 'rpc'
) returns void language plpgsql security definer set search_path = ''
as $$
declare
  _e public.entitlements;
begin
  select * into _e from public.entitlements where id = _entitlement_id for update;
  if not found then
    raise exception 'entitlement not found' using errcode = 'P0002';
  end if;
  if _quantity <= 0 then
    raise exception 'a movement quantity must be positive' using errcode = '22023';
  end if;

  if _kind = 'grant' then
    update public.entitlements
       set remaining_quantity = remaining_quantity + _quantity,
           granted_quantity = granted_quantity + _quantity,
           updated_at = now()
     where id = _entitlement_id;

  elsif _kind = 'reserve' then
    if _e.status <> 'active' then
      raise exception 'this entitlement is not active' using errcode = '40001';
    end if;
    if _e.expires_at is not null and _e.expires_at <= now() then
      raise exception 'this entitlement has expired' using errcode = '40001';
    end if;
    if _e.remaining_quantity < _quantity then
      raise exception 'not enough remaining credit' using errcode = '40001';
    end if;
    update public.entitlements
       set remaining_quantity = remaining_quantity - _quantity,
           reserved_quantity = reserved_quantity + _quantity,
           updated_at = now()
     where id = _entitlement_id;

  elsif _kind = 'release' then
    if _e.reserved_quantity < _quantity then
      raise exception 'not that much is reserved' using errcode = '40001';
    end if;
    update public.entitlements
       set reserved_quantity = reserved_quantity - _quantity,
           remaining_quantity = remaining_quantity + _quantity,
           updated_at = now()
     where id = _entitlement_id;

  elsif _kind = 'consume' then
    if _e.reserved_quantity < _quantity then
      raise exception 'not that much is reserved' using errcode = '40001';
    end if;
    update public.entitlements
       set reserved_quantity = reserved_quantity - _quantity,
           consumed_quantity = consumed_quantity + _quantity,
           updated_at = now()
     where id = _entitlement_id;

  elsif _kind = 'expire' then
    if _e.remaining_quantity < _quantity then
      raise exception 'not that much remains to expire' using errcode = '40001';
    end if;
    update public.entitlements
       set remaining_quantity = remaining_quantity - _quantity,
           expired_quantity = expired_quantity + _quantity,
           updated_at = now()
     where id = _entitlement_id;

  elsif _kind = 'refund_revoke' then
    -- A refund revokes only what is STILL UNSPENT. It never claws back a
    -- visit the patient already received, and never recreates one either.
    if _e.remaining_quantity < _quantity then
      raise exception 'only unspent credit can be revoked' using errcode = '40001';
    end if;
    update public.entitlements
       set remaining_quantity = remaining_quantity - _quantity,
           refunded_quantity = refunded_quantity + _quantity,
           updated_at = now()
     where id = _entitlement_id;

  elsif _kind = 'manual_restore' then
    if _reason is null or btrim(_reason) = '' then
      raise exception 'a manual restoration requires a reason' using errcode = '22023';
    end if;
    if _e.consumed_quantity >= _quantity then
      update public.entitlements
         set consumed_quantity = consumed_quantity - _quantity,
             remaining_quantity = remaining_quantity + _quantity,
             updated_at = now()
       where id = _entitlement_id;
    elsif _e.expired_quantity >= _quantity then
      update public.entitlements
         set expired_quantity = expired_quantity - _quantity,
             remaining_quantity = remaining_quantity + _quantity,
             updated_at = now()
       where id = _entitlement_id;
    else
      raise exception 'there is not that much consumed or expired credit to restore'
        using errcode = '40001';
    end if;
  else
    raise exception 'unknown entitlement movement' using errcode = '22023';
  end if;

  insert into public.entitlement_ledger
    (organization_id, entitlement_id, kind, quantity, ref_type, ref_id, reason,
     actor_user_id, source)
  values (_e.organization_id, _entitlement_id, _kind, _quantity, _ref_type, _ref_id,
          _reason, auth.uid(), _source);

  -- keep the derived status honest
  update public.entitlements
     set status = case
       when expires_at is not null and expires_at <= now() and remaining_quantity = 0
            and reserved_quantity = 0 then 'expired'
       when remaining_quantity = 0 and reserved_quantity = 0
            and (consumed_quantity > 0 or refunded_quantity > 0 or expired_quantity > 0)
            then 'exhausted'
       else 'active' end
   where id = _entitlement_id and status <> 'revoked';
end;
$$;

/** One open dunning/financial task per (type, ref) — never duplicated. */
create or replace function private.upsert_financial_task(
  _org uuid, _item_type text, _ref_id uuid, _title text, _patient_id uuid,
  _priority text default 'medium'
) returns uuid language plpgsql security definer set search_path = ''
as $$
declare _id uuid;
begin
  select id into _id from public.review_queue_items
   where organization_id = _org and item_type = _item_type
     and ref_id = _ref_id and status in ('open', 'in_review')
   limit 1;
  if found then
    return _id;
  end if;
  insert into public.review_queue_items
    (organization_id, item_type, priority, status, ref_id, title, patient_id)
  values (_org, _item_type, _priority, 'open', _ref_id, _title, _patient_id)
  returning id into _id;
  return _id;
end;
$$;

-- ------------------------------------------------------- plan management

create or replace function public.upsert_plan(
  _organization_id uuid,
  _plan_type text,               -- 'package' | 'membership'
  _id uuid default null,
  _expected_version integer default null,
  _name text default null,
  _description text default null,
  _kind text default null,       -- packages only
  _archive boolean default false
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _new_id uuid; _v integer;
begin
  perform private.require_financial(_organization_id, 'plans.manage');
  if _plan_type not in ('package', 'membership') then
    raise exception 'unknown plan type' using errcode = '22023';
  end if;

  if _id is null then
    if _name is null or btrim(_name) = '' then
      raise exception 'a plan needs a name' using errcode = '22023';
    end if;
    if _plan_type = 'package' then
      insert into public.packages (organization_id, name, description, kind, amount_minor, created_by)
      values (_organization_id, btrim(_name), _description,
              coalesce(_kind, 'visit_credits'), 0, auth.uid())
      returning id into _new_id;
    else
      insert into public.memberships (organization_id, name, description, amount_minor, created_by)
      values (_organization_id, btrim(_name), _description, 0, auth.uid())
      returning id into _new_id;
    end if;
    return jsonb_build_object('id', _new_id, 'version', 1);
  end if;

  if _plan_type = 'package' then
    select version into _v from public.packages
     where id = _id and organization_id = _organization_id for update;
    if not found then raise exception 'plan not found' using errcode = 'P0002'; end if;
    if _expected_version is distinct from _v then
      raise exception 'this plan changed since you loaded it' using errcode = '40001';
    end if;
    update public.packages
       set name = coalesce(btrim(_name), name),
           description = coalesce(_description, description),
           kind = coalesce(_kind, kind),
           status = case when _archive then 'archived' else status end,
           archived_at = case when _archive then now() else archived_at end,
           version = version + 1, updated_at = now(), updated_by = auth.uid()
     where id = _id;
  else
    select version into _v from public.memberships
     where id = _id and organization_id = _organization_id for update;
    if not found then raise exception 'plan not found' using errcode = 'P0002'; end if;
    if _expected_version is distinct from _v then
      raise exception 'this plan changed since you loaded it' using errcode = '40001';
    end if;
    update public.memberships
       set name = coalesce(btrim(_name), name),
           description = coalesce(_description, description),
           status = case when _archive then 'archived' else status end,
           archived_at = case when _archive then now() else archived_at end,
           version = version + 1, updated_at = now(), updated_by = auth.uid()
     where id = _id;
  end if;

  insert into public.audit_events (organization_id, actor_user_id, action, entity_type, entity_id, safe_message)
  values (_organization_id, auth.uid(),
          case when _archive then 'plan.archived' else 'plan.updated' end,
          _plan_type, _id, 'plan ' || case when _archive then 'archived' else 'updated' end);

  return jsonb_build_object('id', _id, 'version', _v + 1);
end;
$$;

/**
 * Create the next DRAFT version of a plan. Terms live here, not on the plan,
 * so publishing freezes them and an accepted version can never be rewritten.
 */
create or replace function public.create_plan_version(
  _organization_id uuid,
  _plan_type text,
  _plan_id uuid,
  _price_minor bigint,
  _currency text default 'USD',
  _credit_quantity integer default 0,
  _credit_mode text default 'single_use',
  _expires_after_days integer default null,
  _interval_unit text default 'month',
  _interval_count integer default 1,
  _trial_days integer default 0,
  _included_credits integer default 0,
  _minimum_commitment_periods integer default 0,
  _grace_period_days integer default 0,
  _eligible_product_ids uuid[] default '{}',
  _eligible_location_ids uuid[] default '{}',
  _eligible_practitioner_ids uuid[] default '{}',
  _transfer_policy text default 'non_transferable',
  _terms_summary text default null
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _n integer; _id uuid;
begin
  perform private.require_financial(_organization_id, 'plans.manage');
  if _price_minor < 0 then
    raise exception 'a price cannot be negative' using errcode = '22023';
  end if;

  -- every referenced restriction must belong to the same tenant
  if exists (select 1 from unnest(_eligible_product_ids) pid
             where not exists (select 1 from public.products_services p
                               where p.id = pid and p.organization_id = _organization_id)) then
    raise exception 'a restricted product belongs to another organization' using errcode = '42501';
  end if;
  if exists (select 1 from unnest(_eligible_location_ids) lid
             where not exists (select 1 from public.locations l
                               where l.id = lid and l.organization_id = _organization_id)) then
    raise exception 'a restricted location belongs to another organization' using errcode = '42501';
  end if;

  if _plan_type = 'package' then
    if not exists (select 1 from public.packages
                   where id = _plan_id and organization_id = _organization_id) then
      raise exception 'plan not found' using errcode = 'P0002';
    end if;
    select coalesce(max(version_number), 0) + 1 into _n
      from public.package_versions where package_id = _plan_id;
    insert into public.package_versions
      (organization_id, package_id, version_number, price_minor, currency,
       credit_quantity, credit_mode, expires_after_days, eligible_product_ids,
       eligible_location_ids, eligible_practitioner_ids, transfer_policy,
       terms_summary, created_by)
    values (_organization_id, _plan_id, _n, _price_minor, upper(_currency),
            _credit_quantity, _credit_mode, _expires_after_days, _eligible_product_ids,
            _eligible_location_ids, _eligible_practitioner_ids, _transfer_policy,
            _terms_summary, auth.uid())
    returning id into _id;
  elsif _plan_type = 'membership' then
    if not exists (select 1 from public.memberships
                   where id = _plan_id and organization_id = _organization_id) then
      raise exception 'plan not found' using errcode = 'P0002';
    end if;
    select coalesce(max(version_number), 0) + 1 into _n
      from public.membership_versions where membership_id = _plan_id;
    insert into public.membership_versions
      (organization_id, membership_id, version_number, price_minor, currency,
       interval_unit, interval_count, trial_days, included_credits,
       minimum_commitment_periods, grace_period_days, eligible_product_ids,
       eligible_location_ids, terms_summary, created_by)
    values (_organization_id, _plan_id, _n, _price_minor, upper(_currency),
            _interval_unit, _interval_count, _trial_days, _included_credits,
            _minimum_commitment_periods, _grace_period_days, _eligible_product_ids,
            _eligible_location_ids, _terms_summary, auth.uid())
    returning id into _id;
  else
    raise exception 'unknown plan type' using errcode = '22023';
  end if;

  insert into public.audit_events (organization_id, actor_user_id, action, entity_type, entity_id, safe_message)
  values (_organization_id, auth.uid(), 'plan.version_created', _plan_type, _plan_id,
          'plan version ' || _n || ' drafted');

  return jsonb_build_object('id', _id, 'versionNumber', _n);
end;
$$;

create or replace function public.publish_plan_version(
  _organization_id uuid, _plan_type text, _version_id uuid
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _plan_id uuid;
begin
  perform private.require_financial(_organization_id, 'plans.manage');

  if _plan_type = 'package' then
    select package_id into _plan_id from public.package_versions
     where id = _version_id and organization_id = _organization_id for update;
    if not found then raise exception 'plan version not found' using errcode = 'P0002'; end if;
    update public.package_versions set status = 'published', published_at = now()
     where id = _version_id and status = 'draft';
    if not found then
      raise exception 'only a draft version can be published' using errcode = '42501';
    end if;
    update public.packages
       set current_version_id = _version_id, status = 'active',
           amount_minor = (select price_minor from public.package_versions where id = _version_id),
           version = version + 1, updated_at = now(), updated_by = auth.uid()
     where id = _plan_id;
  elsif _plan_type = 'membership' then
    select membership_id into _plan_id from public.membership_versions
     where id = _version_id and organization_id = _organization_id for update;
    if not found then raise exception 'plan version not found' using errcode = 'P0002'; end if;
    update public.membership_versions set status = 'published', published_at = now()
     where id = _version_id and status = 'draft';
    if not found then
      raise exception 'only a draft version can be published' using errcode = '42501';
    end if;
    update public.memberships
       set current_version_id = _version_id, status = 'active',
           amount_minor = (select price_minor from public.membership_versions where id = _version_id),
           version = version + 1, updated_at = now(), updated_by = auth.uid()
     where id = _plan_id;
  else
    raise exception 'unknown plan type' using errcode = '22023';
  end if;

  insert into public.audit_events (organization_id, actor_user_id, action, entity_type, entity_id, safe_message)
  values (_organization_id, auth.uid(), 'plan.version_published', _plan_type, _plan_id,
          'plan version published');

  return jsonb_build_object('id', _version_id, 'planId', _plan_id, 'status', 'published');
end;
$$;

create or replace function public.set_org_billing_policy(
  _organization_id uuid, _no_show_policy text, _late_cancel_policy text,
  _late_cancel_window_hours integer, _consume_on text
) returns jsonb language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_financial(_organization_id, 'plans.manage');
  insert into public.org_billing_policies as p
    (organization_id, no_show_policy, late_cancel_policy, late_cancel_window_hours,
     consume_on, updated_by)
  values (_organization_id, _no_show_policy, _late_cancel_policy,
          coalesce(_late_cancel_window_hours, 24), _consume_on, auth.uid())
  on conflict (organization_id) do update
    set no_show_policy = excluded.no_show_policy,
        late_cancel_policy = excluded.late_cancel_policy,
        late_cancel_window_hours = excluded.late_cancel_window_hours,
        consume_on = excluded.consume_on,
        updated_at = now(), updated_by = auth.uid();
  insert into public.audit_events (organization_id, actor_user_id, action, entity_type, entity_id, safe_message)
  values (_organization_id, auth.uid(), 'billing.policy_set', 'organization',
          _organization_id, 'credit policy updated');
  return jsonb_build_object('ok', true);
end;
$$;

-- ------------------------------------------------------ purchase & comp

/**
 * Sell a package: creates a phase-8A DRAFT INVOICE for the plan price.
 * Entitlements are NOT granted here — they are granted when that invoice is
 * actually paid (grant_entitlements_for_invoice), so an unpaid purchase can
 * never confer benefits.
 */
create or replace function public.purchase_package(
  _organization_id uuid, _patient_id uuid, _package_version_id uuid,
  _acceptance_method text default 'in_person'
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _pv public.package_versions; _invoice_id uuid; _pkg_name text; _product_id uuid;
begin
  perform private.require_financial(_organization_id, 'billing.create_invoice');
  if not private.can_access_patient(_patient_id) then
    raise exception 'no access to this patient' using errcode = '42501';
  end if;

  select * into _pv from public.package_versions
   where id = _package_version_id and organization_id = _organization_id;
  if not found then raise exception 'plan version not found' using errcode = 'P0002'; end if;
  if _pv.status <> 'published' then
    raise exception 'only a published plan version can be sold' using errcode = '42501';
  end if;

  select name into _pkg_name from public.packages where id = _pv.package_id;

  insert into public.invoices (organization_id, patient_id, status, currency, created_by)
  values (_organization_id, _patient_id, 'draft', _pv.currency, auth.uid())
  returning id into _invoice_id;

  -- The plan itself is the sold item; the line snapshots its name and price.
  insert into public.invoice_line_items
    (organization_id, invoice_id, kind, name_snapshot, quantity,
     unit_amount_minor, amount_minor, tax_rate_bps, tax_minor)
  values (_organization_id, _invoice_id, 'package', _pkg_name || ' (v' || _pv.version_number || ')',
          1, _pv.price_minor, _pv.price_minor, 0, 0);

  update public.invoices
     set subtotal_minor = _pv.price_minor, total_minor = _pv.price_minor,
         version = version + 1
   where id = _invoice_id;

  -- acceptance evidence for the exact version
  insert into public.plan_acceptances
    (organization_id, patient_id, package_version_id, method, terms_snapshot, recorded_by)
  values (_organization_id, _patient_id, _package_version_id, _acceptance_method,
          to_jsonb(_pv), auth.uid());

  insert into public.audit_events (organization_id, actor_user_id, action, entity_type, entity_id, safe_message)
  values (_organization_id, auth.uid(), 'plan.package_purchase_started', 'invoice',
          _invoice_id, 'package purchase invoice drafted');

  return jsonb_build_object('invoiceId', _invoice_id, 'packageVersionId', _package_version_id);
end;
$$;

/**
 * Grant the entitlements a PAID invoice bought. Idempotent by construction:
 * the unique index on (source_invoice_id, package_version_id) means a second
 * call inserts nothing, so a duplicate webhook cannot double-grant.
 */
create or replace function public.grant_entitlements_for_invoice(
  _organization_id uuid, _invoice_id uuid
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _inv public.invoices; _pv public.package_versions; _ent_id uuid; _granted integer := 0;
begin
  perform private.require_financial(_organization_id, 'billing.create_invoice');

  select * into _inv from public.invoices
   where id = _invoice_id and organization_id = _organization_id;
  if not found then raise exception 'invoice not found' using errcode = 'P0002'; end if;
  if _inv.status <> 'paid' then
    raise exception 'entitlements are granted only for a paid invoice' using errcode = '42501';
  end if;

  for _pv in
    select pv.* from public.package_versions pv
    join public.plan_acceptances pa on pa.package_version_id = pv.id
    where pa.patient_id = _inv.patient_id and pa.organization_id = _organization_id
      and pv.organization_id = _organization_id
  loop
    -- one entitlement per (invoice, package version); the index enforces it
    insert into public.entitlements
      (organization_id, patient_id, package_version_id, source, credit_mode,
       granted_quantity, remaining_quantity, eligible_product_ids,
       eligible_location_ids, eligible_practitioner_ids, transfer_policy,
       expires_at, source_invoice_id, created_by)
    values (_organization_id, _inv.patient_id, _pv.id, 'package_purchase', _pv.credit_mode,
            _pv.credit_quantity, _pv.credit_quantity, _pv.eligible_product_ids,
            _pv.eligible_location_ids, _pv.eligible_practitioner_ids, _pv.transfer_policy,
            case when _pv.expires_after_days is null then null
                 else now() + make_interval(days => _pv.expires_after_days) end,
            _invoice_id, auth.uid())
    on conflict (source_invoice_id, package_version_id) do nothing
    returning id into _ent_id;

    if _ent_id is not null then
      insert into public.entitlement_ledger
        (organization_id, entitlement_id, kind, quantity, ref_type, ref_id,
         reason, actor_user_id)
      values (_organization_id, _ent_id, 'grant', _pv.credit_quantity, 'invoice',
              _invoice_id, 'package purchase paid', auth.uid());
      _granted := _granted + 1;
      _ent_id := null;
    end if;
  end loop;

  return jsonb_build_object('entitlementsCreated', _granted);
end;
$$;

/**
 * Complimentary assignment. Requires the SEPARATE comp.assign permission, a
 * reason, and an authorizer, and records a zero-amount invoice so the gift is
 * visible in the financial record rather than invisible.
 *
 * It confers a COMMERCIAL benefit only: no clinical order, note, protocol, or
 * eligibility follows from it.
 */
create or replace function public.assign_complimentary_plan(
  _organization_id uuid, _patient_id uuid, _plan_type text, _version_id uuid,
  _reason text, _expires_at timestamptz default null
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _pv public.package_versions; _mv public.membership_versions;
        _ent_id uuid; _sub_id uuid; _invoice_id uuid; _name text;
begin
  perform private.require_financial(_organization_id, 'comp.assign');
  if not private.can_access_patient(_patient_id) then
    raise exception 'no access to this patient' using errcode = '42501';
  end if;
  if _reason is null or btrim(_reason) = '' then
    raise exception 'a complimentary assignment requires a reason' using errcode = '22023';
  end if;

  -- a documented zero-dollar invoice keeps the gift on the financial record
  insert into public.invoices (organization_id, patient_id, status, currency,
                               total_minor, subtotal_minor, created_by)
  values (_organization_id, _patient_id, 'draft', 'USD', 0, 0, auth.uid())
  returning id into _invoice_id;

  if _plan_type = 'package' then
    select * into _pv from public.package_versions
     where id = _version_id and organization_id = _organization_id;
    if not found then raise exception 'plan version not found' using errcode = 'P0002'; end if;
    select name into _name from public.packages where id = _pv.package_id;

    insert into public.invoice_line_items
      (organization_id, invoice_id, kind, name_snapshot, quantity,
       unit_amount_minor, amount_minor, discount_minor, discount_reason,
       tax_rate_bps, tax_minor)
    values (_organization_id, _invoice_id, 'package',
            'Complimentary: ' || _name, 1, 0, 0, 0, _reason, 0, 0);

    insert into public.entitlements
      (organization_id, patient_id, package_version_id, source, credit_mode,
       granted_quantity, remaining_quantity, eligible_product_ids,
       eligible_location_ids, eligible_practitioner_ids, transfer_policy,
       expires_at, source_invoice_id, created_by)
    values (_organization_id, _patient_id, _version_id, 'complimentary', _pv.credit_mode,
            _pv.credit_quantity, _pv.credit_quantity, _pv.eligible_product_ids,
            _pv.eligible_location_ids, _pv.eligible_practitioner_ids, _pv.transfer_policy,
            coalesce(_expires_at,
                     case when _pv.expires_after_days is null then null
                          else now() + make_interval(days => _pv.expires_after_days) end),
            _invoice_id, auth.uid())
    returning id into _ent_id;

    insert into public.entitlement_ledger
      (organization_id, entitlement_id, kind, quantity, ref_type, ref_id, reason, actor_user_id)
    values (_organization_id, _ent_id, 'grant', _pv.credit_quantity, 'invoice',
            _invoice_id, 'complimentary: ' || _reason, auth.uid());

  elsif _plan_type = 'membership' then
    select * into _mv from public.membership_versions
     where id = _version_id and organization_id = _organization_id;
    if not found then raise exception 'plan version not found' using errcode = 'P0002'; end if;

    insert into public.patient_memberships
      (organization_id, patient_id, membership_id, membership_version_id, status,
       origin, complimentary_reason, complimentary_authorized_by, started_at,
       current_period_start, current_period_end, ends_at, created_by)
    values (_organization_id, _patient_id, _mv.membership_id, _version_id, 'active',
            'complimentary', _reason, auth.uid(), now(), now(),
            now() + make_interval(months => _mv.interval_count), _expires_at, auth.uid())
    returning id into _sub_id;

    insert into public.patient_membership_events
      (organization_id, patient_membership_id, kind, from_status, to_status, detail, actor_user_id)
    values (_organization_id, _sub_id, 'complimentary_assigned', null, 'active', _reason, auth.uid());

    if _mv.included_credits > 0 then
      insert into public.entitlements
        (organization_id, patient_id, patient_membership_id, source, granted_quantity,
         remaining_quantity, eligible_product_ids, eligible_location_ids,
         period_key, expires_at, source_invoice_id, created_by)
      values (_organization_id, _patient_id, _sub_id, 'complimentary', _mv.included_credits,
              _mv.included_credits, _mv.eligible_product_ids, _mv.eligible_location_ids,
              to_char(now(), 'YYYY-MM'), _expires_at, _invoice_id, auth.uid())
      returning id into _ent_id;

      insert into public.entitlement_ledger
        (organization_id, entitlement_id, kind, quantity, ref_type, ref_id, reason, actor_user_id)
      values (_organization_id, _ent_id, 'grant', _mv.included_credits, 'invoice',
              _invoice_id, 'complimentary: ' || _reason, auth.uid());
    end if;
  else
    raise exception 'unknown plan type' using errcode = '22023';
  end if;

  insert into public.plan_acceptances
    (organization_id, patient_id, package_version_id, membership_version_id,
     method, terms_snapshot, recorded_by, note)
  values (_organization_id, _patient_id,
          case when _plan_type = 'package' then _version_id end,
          case when _plan_type = 'membership' then _version_id end,
          'in_person', '{}'::jsonb, auth.uid(), 'complimentary: ' || _reason);

  insert into public.audit_events (organization_id, actor_user_id, action, entity_type, entity_id, safe_message)
  values (_organization_id, auth.uid(), 'plan.complimentary_assigned', _plan_type,
          _version_id, 'complimentary plan assigned with reason');

  return jsonb_build_object('invoiceId', _invoice_id, 'entitlementId', _ent_id,
                            'patientMembershipId', _sub_id, 'complimentary', true);
end;
$$;

-- --------------------------------------------------- redemption lifecycle

create or replace function public.reserve_entitlement_for_appointment(
  _organization_id uuid, _entitlement_id uuid, _appointment_id uuid,
  _quantity integer default 1
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _e public.entitlements; _appt public.appointments;
begin
  perform private.require_financial(_organization_id, 'billing.create_invoice');

  select * into _e from public.entitlements
   where id = _entitlement_id and organization_id = _organization_id;
  if not found then raise exception 'entitlement not found' using errcode = 'P0002'; end if;
  if not private.can_access_patient(_e.patient_id) then
    raise exception 'no access to this patient' using errcode = '42501';
  end if;

  select * into _appt from public.appointments
   where id = _appointment_id and organization_id = _organization_id;
  if not found then raise exception 'appointment not found' using errcode = 'P0002'; end if;
  if _appt.patient_id is distinct from _e.patient_id then
    raise exception 'that appointment belongs to a different patient' using errcode = '42501';
  end if;

  -- eligibility restrictions are commercial, not clinical
  if array_length(_e.eligible_practitioner_ids, 1) is not null
     and not (_appt.practitioner_user_id = any (_e.eligible_practitioner_ids)) then
    raise exception 'this credit is not valid for that practitioner' using errcode = '22023';
  end if;

  -- The partial unique index on (entitlement_id, ref_id) where kind='reserve'
  -- is what makes a concurrent second reservation impossible.
  perform private.entitlement_move(_entitlement_id, 'reserve', _quantity,
                                   'appointment', _appointment_id, null);

  insert into public.package_redemptions
    (organization_id, patient_id, package_id, entitlement_id, appointment_id,
     quantity, state, recorded_by)
  values (_organization_id, _e.patient_id,
          (select package_id from public.package_versions where id = _e.package_version_id),
          _entitlement_id, _appointment_id, _quantity, 'reserved', auth.uid());

  return jsonb_build_object('entitlementId', _entitlement_id, 'state', 'reserved');
exception
  when unique_violation then
    raise exception 'a credit is already reserved for this appointment' using errcode = '40001';
end;
$$;

create or replace function public.settle_entitlement_for_appointment(
  _organization_id uuid, _appointment_id uuid, _outcome text, _reason text default null
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _r public.package_redemptions; _policy public.org_billing_policies; _action text;
begin
  perform private.require_financial(_organization_id, 'billing.take_payment');
  _policy := private.billing_policy(_organization_id);

  select * into _r from public.package_redemptions
   where appointment_id = _appointment_id and organization_id = _organization_id
     and state = 'reserved'
   limit 1;
  if not found then
    raise exception 'no reserved credit for that appointment' using errcode = 'P0002';
  end if;

  _action := case _outcome
    when 'completed' then 'consume'
    when 'arrived'   then case when _policy.consume_on = 'arrived' then 'consume' else 'hold' end
    when 'no_show'   then case _policy.no_show_policy
                            when 'consume' then 'consume'
                            when 'release' then 'release'
                            else 'review' end
    when 'late_cancel' then case _policy.late_cancel_policy
                            when 'consume' then 'consume'
                            when 'release' then 'release'
                            else 'review' end
    when 'cancelled' then 'release'
    else null end;

  if _action is null then
    raise exception 'unknown appointment outcome' using errcode = '22023';
  end if;
  if _action = 'hold' then
    return jsonb_build_object('state', 'reserved', 'policy', _policy.consume_on);
  end if;

  if _action = 'review' then
    perform private.upsert_financial_task(
      _organization_id, 'refund_action_required', _r.entitlement_id,
      'Credit decision needed after a ' || _outcome, _r.patient_id, 'medium');
    return jsonb_build_object('state', 'reserved', 'reviewRequired', true);
  end if;

  perform private.entitlement_move(_r.entitlement_id, _action, _r.quantity,
                                   'appointment', _appointment_id, _reason);

  update public.package_redemptions
     set state = case when _action = 'consume' then 'consumed' else 'released' end,
         released_reason = case when _action = 'release' then coalesce(_reason, _outcome) end,
         redeemed_at = now()
   where id = _r.id;

  insert into public.audit_events (organization_id, actor_user_id, action, entity_type, entity_id, safe_message)
  values (_organization_id, auth.uid(), 'entitlement.' || _action, 'appointment',
          _appointment_id, 'credit ' || _action || ' after ' || _outcome);

  return jsonb_build_object('state', case when _action = 'consume' then 'consumed' else 'released' end);
end;
$$;

create or replace function public.restore_entitlement(
  _organization_id uuid, _entitlement_id uuid, _quantity integer, _reason text
) returns jsonb language plpgsql security definer set search_path = ''
as $$
begin
  -- restoring spent credit is a corrective act: it needs the refund authority
  perform private.require_financial(_organization_id, 'billing.issue_refund');
  if _reason is null or btrim(_reason) = '' then
    raise exception 'a manual restoration requires a reason' using errcode = '22023';
  end if;
  if not exists (select 1 from public.entitlements
                 where id = _entitlement_id and organization_id = _organization_id) then
    raise exception 'entitlement not found' using errcode = 'P0002';
  end if;

  perform private.entitlement_move(_entitlement_id, 'manual_restore', _quantity,
                                   'manual', null, _reason);

  insert into public.audit_events (organization_id, actor_user_id, action, entity_type, entity_id, safe_message)
  values (_organization_id, auth.uid(), 'entitlement.manual_restore', 'entitlement',
          _entitlement_id, 'credit restored with a recorded reason');

  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.expire_entitlements(_organization_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _e record; _n integer := 0;
begin
  perform private.require_financial(_organization_id, 'plans.manage');
  for _e in
    select id, remaining_quantity from public.entitlements
     where organization_id = _organization_id and status = 'active'
       and expires_at is not null and expires_at <= now() and remaining_quantity > 0
  loop
    perform private.entitlement_move(_e.id, 'expire', _e.remaining_quantity,
                                     'manual', null, 'past expiry', 'system');
    _n := _n + 1;
  end loop;
  return jsonb_build_object('expired', _n);
end;
$$;

/**
 * A refund revokes UNSPENT credit only. It never recreates a consumed benefit
 * and never silently restores one — that is what restore_entitlement is for,
 * and that requires a reason.
 */
create or replace function public.revoke_entitlements_for_refund(
  _organization_id uuid, _invoice_id uuid, _reason text
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _e record; _n integer := 0;
begin
  perform private.require_financial(_organization_id, 'billing.issue_refund');
  if _reason is null or btrim(_reason) = '' then
    raise exception 'a revocation requires a reason' using errcode = '22023';
  end if;
  for _e in
    select id, remaining_quantity from public.entitlements
     where organization_id = _organization_id and source_invoice_id = _invoice_id
       and remaining_quantity > 0
  loop
    perform private.entitlement_move(_e.id, 'refund_revoke', _e.remaining_quantity,
                                     'invoice', _invoice_id, _reason);
    _n := _n + 1;
  end loop;
  insert into public.audit_events (organization_id, actor_user_id, action, entity_type, entity_id, safe_message)
  values (_organization_id, auth.uid(), 'entitlement.refund_revoke', 'invoice',
          _invoice_id, 'unspent credit revoked after refund');
  return jsonb_build_object('revoked', _n);
end;
$$;

-- -------------------------------------------------- subscription lifecycle

create or replace function public.set_membership_lifecycle(
  _organization_id uuid, _patient_membership_id uuid, _action text,
  _expected_version integer, _reason text default null
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _s public.patient_memberships; _to text;
begin
  perform private.require_financial(_organization_id, 'plans.manage');

  select * into _s from public.patient_memberships
   where id = _patient_membership_id and organization_id = _organization_id for update;
  if not found then raise exception 'membership not found' using errcode = 'P0002'; end if;
  if not private.can_access_patient(_s.patient_id) then
    raise exception 'no access to this patient' using errcode = '42501';
  end if;
  if _expected_version is distinct from _s.version then
    raise exception 'this membership changed since you loaded it' using errcode = '40001';
  end if;

  _to := case _action
    when 'pause'  then 'paused'
    when 'resume' then 'active'
    when 'cancel_at_period_end' then _s.status
    when 'cancel_now' then 'canceled'
    when 'reactivate' then 'active'
    else null end;
  if _to is null then
    raise exception 'unknown membership action' using errcode = '22023';
  end if;

  if _action = 'pause' and _s.status not in ('active', 'trialing') then
    raise exception 'only an active membership can be paused' using errcode = '42501';
  end if;
  if _action = 'resume' and _s.status <> 'paused' then
    raise exception 'only a paused membership can be resumed' using errcode = '42501';
  end if;
  if _action = 'reactivate' and _s.status not in ('canceled', 'expired') then
    raise exception 'only a canceled or expired membership can be reactivated'
      using errcode = '42501';
  end if;
  if _action in ('cancel_now', 'cancel_at_period_end')
     and (_reason is null or btrim(_reason) = '') then
    raise exception 'cancelling a membership requires a reason' using errcode = '22023';
  end if;

  update public.patient_memberships
     set status = _to,
         cancel_at_period_end = case when _action = 'cancel_at_period_end' then true
                                     when _action = 'reactivate' then false
                                     else cancel_at_period_end end,
         paused_at = case when _action = 'pause' then now()
                          when _action = 'resume' then null else paused_at end,
         canceled_at = case when _action = 'cancel_now' then now() else canceled_at end,
         cancel_reason = coalesce(_reason, cancel_reason),
         version = version + 1, updated_at = now()
   where id = _patient_membership_id;

  insert into public.patient_membership_events
    (organization_id, patient_membership_id, kind, from_status, to_status, detail, actor_user_id)
  values (_organization_id, _patient_membership_id, _action, _s.status, _to, _reason, auth.uid());

  insert into public.audit_events (organization_id, actor_user_id, action, entity_type, entity_id, safe_message)
  values (_organization_id, auth.uid(), 'membership.' || _action, 'patient_membership',
          _patient_membership_id, 'membership ' || _action);

  return jsonb_build_object('id', _patient_membership_id, 'status', _to,
                            'version', _s.version + 1);
end;
$$;

-- ----------------------------------------------------------- reconciliation

create or replace function public.resolve_reconciliation_exception(
  _organization_id uuid, _exception_id uuid, _resolution text, _reason text,
  _expected_version integer
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _x public.reconciliation_exceptions;
begin
  perform private.require_financial(_organization_id, 'reconciliation.resolve');
  if _reason is null or btrim(_reason) = '' then
    raise exception 'resolving an exception requires a reason' using errcode = '22023';
  end if;
  if _resolution not in ('resolved', 'dismissed') then
    raise exception 'unknown resolution' using errcode = '22023';
  end if;

  select * into _x from public.reconciliation_exceptions
   where id = _exception_id and organization_id = _organization_id for update;
  if not found then raise exception 'exception not found' using errcode = 'P0002'; end if;
  if _x.status <> 'open' then
    raise exception 'this exception is already closed' using errcode = '42501';
  end if;
  if _expected_version is distinct from _x.version then
    raise exception 'this exception changed since you loaded it' using errcode = '40001';
  end if;

  update public.reconciliation_exceptions
     set status = _resolution, resolved_at = now(), resolved_by = auth.uid(),
         resolution_reason = _reason, version = version + 1
   where id = _exception_id;

  insert into public.reconciliation_events
    (organization_id, exception_id, kind, detail, actor_user_id)
  values (_organization_id, _exception_id, _resolution, _reason, auth.uid());

  insert into public.audit_events (organization_id, actor_user_id, action, entity_type, entity_id, safe_message)
  values (_organization_id, auth.uid(), 'reconciliation.' || _resolution, 'reconciliation_exception',
          _exception_id, 'exception ' || _resolution || ' with a reason');

  return jsonb_build_object('id', _exception_id, 'status', _resolution,
                            'version', _x.version + 1);
end;
$$;

-- ------------------------------------------------------------------ reads

create or replace function public.list_plans(
  _organization_id uuid, _include_archived boolean default false
) returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare _out jsonb;
begin
  perform private.require_financial_read(_organization_id);
  select jsonb_build_object(
    'packages', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'name', p.name, 'description', p.description, 'kind', p.kind,
        'status', p.status, 'version', p.version, 'archivedAt', p.archived_at,
        'currentVersionId', p.current_version_id,
        'versions', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', v.id, 'versionNumber', v.version_number, 'priceMinor', v.price_minor,
            'currency', v.currency, 'creditQuantity', v.credit_quantity,
            'creditMode', v.credit_mode, 'expiresAfterDays', v.expires_after_days,
            'transferPolicy', v.transfer_policy, 'status', v.status,
            'publishedAt', v.published_at, 'termsSummary', v.terms_summary)
            order by v.version_number desc)
          from public.package_versions v where v.package_id = p.id), '[]'::jsonb))
        order by p.name)
      from public.packages p
      where p.organization_id = _organization_id
        and (_include_archived or p.status <> 'archived')), '[]'::jsonb),
    'memberships', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id, 'name', m.name, 'description', m.description,
        'status', m.status, 'version', m.version, 'archivedAt', m.archived_at,
        'currentVersionId', m.current_version_id,
        'versions', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', v.id, 'versionNumber', v.version_number, 'priceMinor', v.price_minor,
            'currency', v.currency, 'intervalUnit', v.interval_unit,
            'intervalCount', v.interval_count, 'trialDays', v.trial_days,
            'includedCredits', v.included_credits,
            'minimumCommitmentPeriods', v.minimum_commitment_periods,
            'gracePeriodDays', v.grace_period_days, 'status', v.status,
            'publishedAt', v.published_at, 'termsSummary', v.terms_summary)
            order by v.version_number desc)
          from public.membership_versions v where v.membership_id = m.id), '[]'::jsonb))
        order by m.name)
      from public.memberships m
      where m.organization_id = _organization_id
        and (_include_archived or m.status <> 'archived')), '[]'::jsonb),
    'policy', (select to_jsonb(p) from public.org_billing_policies p
                where p.organization_id = _organization_id)
  ) into _out;
  return _out;
end;
$$;

create or replace function public.get_patient_entitlements(
  _organization_id uuid, _patient_id uuid
) returns jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  perform private.require_financial_read(_organization_id);
  if not private.can_access_patient(_patient_id) then
    raise exception 'no access to this patient' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'entitlements', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id, 'source', e.source, 'status', e.status,
        'grantedQuantity', e.granted_quantity, 'remainingQuantity', e.remaining_quantity,
        'reservedQuantity', e.reserved_quantity, 'consumedQuantity', e.consumed_quantity,
        'expiredQuantity', e.expired_quantity, 'refundedQuantity', e.refunded_quantity,
        'creditMode', e.credit_mode, 'expiresAt', e.expires_at,
        'transferPolicy', e.transfer_policy,
        'planName', coalesce((select p.name from public.packages p
                              join public.package_versions pv on pv.package_id = p.id
                              where pv.id = e.package_version_id),
                             (select m.name from public.memberships m
                              join public.patient_memberships pm on pm.membership_id = m.id
                              where pm.id = e.patient_membership_id)),
        'ledger', coalesce((
          select jsonb_agg(jsonb_build_object(
            'kind', l.kind, 'quantity', l.quantity, 'refType', l.ref_type,
            'refId', l.ref_id, 'reason', l.reason, 'at', l.created_at)
            order by l.created_at desc)
          from public.entitlement_ledger l where l.entitlement_id = e.id), '[]'::jsonb))
        order by e.created_at desc)
      from public.entitlements e
      where e.organization_id = _organization_id and e.patient_id = _patient_id), '[]'::jsonb),
    'memberships', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id, 'status', s.status, 'origin', s.origin, 'version', s.version,
        'membershipName', (select m.name from public.memberships m where m.id = s.membership_id),
        'currentPeriodEnd', s.current_period_end, 'trialEnd', s.trial_end,
        'cancelAtPeriodEnd', s.cancel_at_period_end, 'canceledAt', s.canceled_at,
        'graceUntil', s.grace_until, 'complimentaryReason', s.complimentary_reason,
        'processorSubscriptionRef', s.processor_subscription_ref)
        order by s.created_at desc)
      from public.patient_memberships s
      where s.organization_id = _organization_id and s.patient_id = _patient_id), '[]'::jsonb)
  );
end;
$$;

create or replace function public.get_reconciliation_workspace(
  _organization_id uuid, _status text default 'open'
) returns jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  perform private.require_financial_read(_organization_id);
  return jsonb_build_object(
    'exceptions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'kind', x.kind, 'status', x.status, 'version', x.version,
        'internalAmountMinor', x.internal_amount_minor,
        'providerAmountMinor', x.provider_amount_minor,
        'currency', x.currency, 'detail', x.detail,
        -- NULL means UNAVAILABLE (not fetched in this phase), never zero.
        'providerFeeMinor', x.provider_fee_minor,
        'providerNetMinor', x.provider_net_minor,
        'providerSettlementStatus', x.provider_settlement_status,
        'createdAt', x.created_at, 'resolvedAt', x.resolved_at,
        'resolutionReason', x.resolution_reason)
        order by x.created_at desc)
      from public.reconciliation_exceptions x
      where x.organization_id = _organization_id
        and (_status is null or x.status = _status)), '[]'::jsonb),
    'settlementFieldsAvailable', false,
    'webhookEvents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'eventId', w.event_id, 'type', w.event_type, 'outcome', w.outcome,
        'detail', w.detail, 'receivedAt', w.received_at,
        'signatureVerified', w.signature_verified, 'livemode', w.livemode)
        order by w.received_at desc)
      from public.billing_webhook_events w
      where w.organization_id = _organization_id
      limit 100), '[]'::jsonb)
  );
end;
$$;

-- ------------------------------------------------------------------ grants
revoke all on function private.require_financial(uuid, text) from public, anon;
revoke all on function private.require_financial_read(uuid) from public, anon;
revoke all on function private.entitlement_move(uuid, text, integer, text, uuid, text, text)
  from public, anon, authenticated;
revoke all on function private.upsert_financial_task(uuid, text, uuid, text, uuid, text)
  from public, anon, authenticated;
revoke all on function private.billing_policy(uuid) from public, anon;

do $$
declare fn text;
begin
  for fn in select unnest(array[
    'public.upsert_plan(uuid, text, uuid, integer, text, text, text, boolean)',
    'public.create_plan_version(uuid, text, uuid, bigint, text, integer, text, integer, text, integer, integer, integer, integer, integer, uuid[], uuid[], uuid[], text, text)',
    'public.publish_plan_version(uuid, text, uuid)',
    'public.set_org_billing_policy(uuid, text, text, integer, text)',
    'public.purchase_package(uuid, uuid, uuid, text)',
    'public.grant_entitlements_for_invoice(uuid, uuid)',
    'public.assign_complimentary_plan(uuid, uuid, text, uuid, text, timestamptz)',
    'public.reserve_entitlement_for_appointment(uuid, uuid, uuid, integer)',
    'public.settle_entitlement_for_appointment(uuid, uuid, text, text)',
    'public.restore_entitlement(uuid, uuid, integer, text)',
    'public.expire_entitlements(uuid)',
    'public.revoke_entitlements_for_refund(uuid, uuid, text)',
    'public.set_membership_lifecycle(uuid, uuid, text, integer, text)',
    'public.resolve_reconciliation_exception(uuid, uuid, text, text, integer)',
    'public.list_plans(uuid, boolean)',
    'public.get_patient_entitlements(uuid, uuid)',
    'public.get_reconciliation_workspace(uuid, text)'
  ]) loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end $$;

commit;
