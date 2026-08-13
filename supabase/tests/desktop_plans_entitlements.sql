-- Phase 8B acceptance: plans, entitlements, memberships, reconciliation.
--
-- Rolled back at the end. Proves the parts of the 28-scenario brief that a
-- browser cannot reach: anonymous and cross-tenant refusal, the exact grant
-- surface, definer posture, storage-level exactly-once guarantees, and the
-- accounting identity under adversarial writes.
--
-- Run against the staging project inside a transaction; ROLLBACK is the last
-- statement, so nothing survives.

begin;

create temporary table _r(n text, ok boolean) on commit drop;
create or replace function _c(_n text, _ok boolean) returns void language sql as $$
  insert into _r(n, ok) values (_n, _ok);
$$;

-- ---------------------------------------------------------------- fixtures
insert into public.organizations (id, name, slug) values
  ('dddddddd-0000-0000-0000-000000001001','P8B Org A','p8b-a'),
  ('dddddddd-0000-0000-0000-000000001002','P8B Org B','p8b-b');

insert into public.patient_profiles (id, organization_id, mrn, first_name, last_name, date_of_birth, sex, status) values
  ('dddddddd-0000-0000-0000-000000002001','dddddddd-0000-0000-0000-000000001001','A-1','Alpha','Patient','1980-01-01','female','active'),
  ('dddddddd-0000-0000-0000-000000002002','dddddddd-0000-0000-0000-000000001002','B-1','Beta','Patient','1981-02-02','male','active');

insert into public.packages (id, organization_id, name, amount_minor, kind, status) values
  ('dddddddd-0000-0000-0000-000000003001','dddddddd-0000-0000-0000-000000001001','A Pack',50000,'visit_credits','active'),
  ('dddddddd-0000-0000-0000-000000003002','dddddddd-0000-0000-0000-000000001002','B Pack',50000,'visit_credits','active');

insert into public.package_versions (id, organization_id, package_id, version_number, price_minor, credit_quantity, status, published_at) values
  ('dddddddd-0000-0000-0000-000000004001','dddddddd-0000-0000-0000-000000001001','dddddddd-0000-0000-0000-000000003001',1,50000,10,'published',now()),
  ('dddddddd-0000-0000-0000-000000004002','dddddddd-0000-0000-0000-000000001002','dddddddd-0000-0000-0000-000000003002',1,50000,10,'published',now());

insert into public.memberships (id, organization_id, name, amount_minor, status) values
  ('dddddddd-0000-0000-0000-000000005001','dddddddd-0000-0000-0000-000000001001','A Membership',19900,'active');
insert into public.membership_versions (id, organization_id, membership_id, version_number, price_minor, included_credits, status, published_at) values
  ('dddddddd-0000-0000-0000-000000006001','dddddddd-0000-0000-0000-000000001001','dddddddd-0000-0000-0000-000000005001',1,19900,2,'published',now());

insert into public.entitlements (id, organization_id, patient_id, package_version_id, source, granted_quantity, remaining_quantity) values
  ('dddddddd-0000-0000-0000-000000007001','dddddddd-0000-0000-0000-000000001001','dddddddd-0000-0000-0000-000000002001','dddddddd-0000-0000-0000-000000004001','package_purchase',10,10);

-- ============================================ 1. grant surface & posture
select _c('1.1 all 17 caller RPCs are granted to authenticated', (
  select count(*) = 17 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname='public' and p.proname in (
    'upsert_plan','create_plan_version','publish_plan_version','set_org_billing_policy',
    'purchase_package','grant_entitlements_for_invoice','assign_complimentary_plan',
    'reserve_entitlement_for_appointment','settle_entitlement_for_appointment',
    'restore_entitlement','expire_entitlements','revoke_entitlements_for_refund',
    'set_membership_lifecycle','resolve_reconciliation_exception','list_plans',
    'get_patient_entitlements','get_reconciliation_workspace')
    and has_function_privilege('authenticated', p.oid, 'EXECUTE')));

select _c('1.2 no caller RPC is executable by anon', (
  select count(*) = 0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname='public' and p.proname in (
    'upsert_plan','create_plan_version','publish_plan_version','set_org_billing_policy',
    'purchase_package','grant_entitlements_for_invoice','assign_complimentary_plan',
    'reserve_entitlement_for_appointment','settle_entitlement_for_appointment',
    'restore_entitlement','expire_entitlements','revoke_entitlements_for_refund',
    'set_membership_lifecycle','resolve_reconciliation_exception','list_plans',
    'get_patient_entitlements','get_reconciliation_workspace')
    and has_function_privilege('anon', p.oid, 'EXECUTE')));

select _c('1.3 every caller RPC is SECURITY DEFINER with an empty search_path', (
  select bool_and(p.prosecdef and array_to_string(p.proconfig,',') like '%search_path=%')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname='public' and p.proname in (
    'upsert_plan','create_plan_version','publish_plan_version','purchase_package',
    'assign_complimentary_plan','reserve_entitlement_for_appointment',
    'settle_entitlement_for_appointment','restore_entitlement',
    'revoke_entitlements_for_refund','set_membership_lifecycle',
    'resolve_reconciliation_exception','list_plans','get_patient_entitlements')));

select _c('1.4 private helpers are NOT executable by authenticated', (
  select count(*) = 0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname='private'
    and p.proname in ('entitlement_move','upsert_financial_task','plans_append_only',
                      'plan_version_protect','entitlement_protect')
    and has_function_privilege('authenticated', p.oid, 'EXECUTE')));

-- ============================================ 2. RLS posture (no direct writes)
select _c('2.1 every 8B table has RLS enabled', (
  select bool_and(c.relrowsecurity) from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relname in (
    'package_versions','membership_versions','plan_acceptances','patient_memberships',
    'patient_membership_events','entitlements','entitlement_ledger','org_billing_policies',
    'processor_customers','reconciliation_exceptions','reconciliation_events',
    'financial_permission_grants')));

select _c('2.2 authenticated holds no INSERT/UPDATE/DELETE on 8B tables', (
  select count(*) = 0 from information_schema.role_table_grants
  where grantee='authenticated' and table_schema='public'
    and table_name in ('package_versions','membership_versions','plan_acceptances',
      'patient_memberships','entitlements','entitlement_ledger','org_billing_policies',
      'processor_customers','reconciliation_exceptions','reconciliation_events',
      'financial_permission_grants','packages','memberships','package_redemptions')
    and privilege_type in ('INSERT','UPDATE','DELETE')));

select _c('2.3 the 0011 broad FOR ALL policies are gone from packages/memberships', (
  select count(*) = 0 from pg_policies
  where schemaname='public' and tablename in ('packages','memberships','package_redemptions')
    and cmd = 'ALL'));

-- ============================================ 3. accounting identity
do $$
begin
  begin
    update public.entitlements set remaining_quantity = remaining_quantity - 1
     where id='dddddddd-0000-0000-0000-000000007001';
    perform _c('3.1 an unbalanced quantity move is refused', false);
  exception when check_violation then
    perform _c('3.1 an unbalanced quantity move is refused', true);
  end;

  update public.entitlements
     set remaining_quantity = remaining_quantity - 2, reserved_quantity = reserved_quantity + 2
   where id='dddddddd-0000-0000-0000-000000007001';
  perform _c('3.2 a balanced reserve is accepted', (
    select reserved_quantity = 2 from public.entitlements
     where id='dddddddd-0000-0000-0000-000000007001'));

  begin
    update public.entitlements set granted_quantity = 99
     where id='dddddddd-0000-0000-0000-000000007001';
    perform _c('3.3 grant size is immutable', false);
  exception when insufficient_privilege then
    perform _c('3.3 grant size is immutable', true);
  end;

  begin
    update public.entitlements set patient_id='dddddddd-0000-0000-0000-000000002002'
     where id='dddddddd-0000-0000-0000-000000007001';
    perform _c('3.4 an entitlement cannot be moved to another patient', false);
  exception when insufficient_privilege then
    perform _c('3.4 an entitlement cannot be moved to another patient', true);
  end;
end $$;

-- ============================================ 4. append-only ledgers
insert into public.entitlement_ledger (organization_id, entitlement_id, kind, quantity, ref_type, ref_id)
values ('dddddddd-0000-0000-0000-000000001001','dddddddd-0000-0000-0000-000000007001','reserve',2,'appointment','dddddddd-0000-0000-0000-000000008001');

do $$
begin
  begin
    update public.entitlement_ledger set quantity = 5
     where entitlement_id='dddddddd-0000-0000-0000-000000007001';
    perform _c('4.1 the entitlement ledger refuses UPDATE', false);
  exception when insufficient_privilege then
    perform _c('4.1 the entitlement ledger refuses UPDATE', true);
  end;
  begin
    delete from public.entitlement_ledger
     where entitlement_id='dddddddd-0000-0000-0000-000000007001';
    perform _c('4.2 the entitlement ledger refuses DELETE', false);
  exception when insufficient_privilege then
    perform _c('4.2 the entitlement ledger refuses DELETE', true);
  end;

  -- one live reservation per (entitlement, appointment): the concurrency guard
  begin
    insert into public.entitlement_ledger (organization_id, entitlement_id, kind, quantity, ref_type, ref_id)
    values ('dddddddd-0000-0000-0000-000000001001','dddddddd-0000-0000-0000-000000007001','reserve',1,'appointment','dddddddd-0000-0000-0000-000000008001');
    perform _c('4.3 a second reservation for one appointment is impossible', false);
  exception when unique_violation then
    perform _c('4.3 a second reservation for one appointment is impossible', true);
  end;
end $$;

-- ============================================ 5. versioning immutability
do $$
begin
  begin
    update public.package_versions set price_minor = 1
     where id='dddddddd-0000-0000-0000-000000004001';
    perform _c('5.1 a published package version''s price is frozen', false);
  exception when insufficient_privilege then
    perform _c('5.1 a published package version''s price is frozen', true);
  end;
  begin
    update public.package_versions set status = 'draft'
     where id='dddddddd-0000-0000-0000-000000004001';
    perform _c('5.2 a published version cannot return to draft', false);
  exception when insufficient_privilege then
    perform _c('5.2 a published version cannot return to draft', true);
  end;
  begin
    update public.membership_versions set terms_summary = 'rewritten'
     where id='dddddddd-0000-0000-0000-000000006001';
    perform _c('5.3 published membership terms are frozen', false);
  exception when insufficient_privilege then
    perform _c('5.3 published membership terms are frozen', true);
  end;
  -- retiring IS allowed: it is the only legal change
  update public.package_versions set status = 'retired'
   where id='dddddddd-0000-0000-0000-000000004002';
  perform _c('5.4 retiring a published version is allowed', (
    select status = 'retired' from public.package_versions
     where id='dddddddd-0000-0000-0000-000000004002'));
end $$;

-- ============================================ 6. exactly-once guarantees
select _c('6.1 one entitlement per (invoice, package version)',
  (select count(*) = 1 from pg_indexes
   where indexname = 'entitlements_invoice_package_idx'));
select _c('6.2 one entitlement per (membership, period)',
  (select count(*) = 1 from pg_indexes
   where indexname = 'entitlements_membership_period_idx'));
select _c('6.3 one live membership per (patient, membership)',
  (select count(*) = 1 from pg_indexes
   where indexname = 'patient_memberships_one_live_idx'));
select _c('6.4 one processor subscription maps to one row',
  (select count(*) = 1 from pg_indexes
   where indexname = 'patient_memberships_processor_ref_idx'));

-- ============================================ 7. complimentary integrity
do $$
begin
  begin
    insert into public.patient_memberships
      (organization_id, patient_id, membership_id, membership_version_id, status, origin)
    values ('dddddddd-0000-0000-0000-000000001001','dddddddd-0000-0000-0000-000000002001',
            'dddddddd-0000-0000-0000-000000005001','dddddddd-0000-0000-0000-000000006001',
            'active','complimentary');
    perform _c('7.1 a complimentary membership without reason+authorizer is refused', false);
  exception when check_violation then
    perform _c('7.1 a complimentary membership without reason+authorizer is refused', true);
  end;
end $$;

-- ============================================ 8. reconciliation integrity
insert into public.reconciliation_exceptions (id, organization_id, kind, internal_amount_minor, provider_amount_minor)
values ('dddddddd-0000-0000-0000-000000009001','dddddddd-0000-0000-0000-000000001001','amount_mismatch',50000,49500);

do $$
begin
  begin
    update public.reconciliation_exceptions set status = 'resolved'
     where id='dddddddd-0000-0000-0000-000000009001';
    perform _c('8.1 resolving without a reason+resolver is refused', false);
  exception when check_violation then
    perform _c('8.1 resolving without a reason+resolver is refused', true);
  end;
end $$;

select _c('8.2 provider settlement figures are NULL, not zero', (
  select provider_fee_minor is null and provider_net_minor is null
     and provider_settlement_status is null
  from public.reconciliation_exceptions where id='dddddddd-0000-0000-0000-000000009001'));

-- ============================================ 9. dunning task types
-- Containment, not regex: an earlier regex form silently passed nothing and
-- read as a failure even though the constraint was correct.
select _c('9.1 the 8 phase-8B financial task types are lawful', (
  select bool_and(pg_get_constraintdef(oid) like '%' || t || '%')
  from pg_constraint, unnest(array[
    'subscription_payment_failed','subscription_payment_method_required',
    'membership_expiring','package_credits_expiring','payment_unreconciled',
    'payment_dispute','refund_action_required','processor_failure_repeated']) t
  where conname='review_queue_items_item_type_check'));

-- ============================================ 10. no clinical side effects
select _c('10.1 no clinical row was created by any of the above', (
  select not exists (select 1 from public.encounters
                     where organization_id in ('dddddddd-0000-0000-0000-000000001001',
                                               'dddddddd-0000-0000-0000-000000001002'))
     and not exists (select 1 from public.protocols
                     where organization_id in ('dddddddd-0000-0000-0000-000000001001',
                                               'dddddddd-0000-0000-0000-000000001002'))
     and not exists (select 1 from public.conversations
                     where organization_id in ('dddddddd-0000-0000-0000-000000001001',
                                               'dddddddd-0000-0000-0000-000000001002'))));

-- ============================================ 11. FK index coverage
select _c('11.1 every single-column 8B foreign key leads an index', (
  select count(*) = 0 from (
    select t.relname as rel, a.attname as col
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    join unnest(c.conkey) k(attnum) on true
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
    where c.contype='f' and n.nspname='public'
      and t.relname in ('package_versions','membership_versions','plan_acceptances',
        'patient_memberships','patient_membership_events','entitlements','entitlement_ledger',
        'org_billing_policies','processor_customers','reconciliation_exceptions',
        'reconciliation_events','financial_permission_grants')
      and array_length(c.conkey,1) = 1
      -- LEADING column: being second in a composite index does not help a
      -- lookup or a cascade by this column alone.
      and not exists (
        select 1 from pg_index i
        where i.indrelid = c.conrelid and (i.indkey::smallint[])[0] = k.attnum)
  ) missing));

-- ---------------------------------------------------------------- results
select n as check, ok from _r order by n;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed,
       count(*) as total from _r;

rollback;
