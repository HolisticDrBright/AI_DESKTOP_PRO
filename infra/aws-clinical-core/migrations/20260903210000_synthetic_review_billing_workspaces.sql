-- Synthetic-only Review Queue and Billing read models for the hosted Desktop.
-- Review work is projected from persisted lab-import events. Billing totals are
-- computed only from persisted synthetic ledger rows. No processor, charge,
-- card, real-patient, or PHI path is enabled here.

create table clinical_core.synthetic_review_task_state (
  organization_id uuid not null references clinical_core.organizations(id),
  patient_record_id uuid not null references clinical_core.patient_records(id),
  source_kind text not null check (source_kind = 'lab_import'),
  source_id uuid not null references clinical_core.lab_import_events(id),
  status text not null default 'open' check (status in ('open','resolved','snoozed','dismissed')),
  resolved_by_person_id uuid references clinical_core.persons(id),
  resolved_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (source_kind, source_id),
  foreign key (patient_record_id, organization_id)
    references clinical_core.patient_records(id, organization_id),
  check ((status = 'resolved' and resolved_by_person_id is not null and resolved_at is not null)
    or status <> 'resolved')
);

create table clinical_audit.synthetic_review_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  actor_person_id uuid not null references clinical_core.persons(id),
  source_kind text not null check (source_kind = 'lab_import'),
  source_id uuid not null,
  action text not null check (action = 'review_task.resolved'),
  occurred_at timestamptz not null default clock_timestamp()
);

create table clinical_core.synthetic_billing_invoices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  patient_record_id uuid not null references clinical_core.patient_records(id),
  number text,
  status text not null default 'draft' check (status in (
    'draft','open','partially_paid','paid','void','refunded','partially_refunded','uncollectible')),
  total_minor bigint not null default 0 check (total_minor >= 0),
  paid_minor bigint not null default 0 check (paid_minor >= 0),
  credit_applied_minor bigint not null default 0 check (credit_applied_minor >= 0),
  refunded_minor bigint not null default 0 check (refunded_minor >= 0),
  discount_minor bigint not null default 0 check (discount_minor >= 0),
  tax_minor bigint not null default 0 check (tax_minor >= 0),
  currency text not null default 'usd' check (currency ~ '^[a-z]{3}$'),
  location_id uuid,
  practitioner_person_id uuid references clinical_core.persons(id),
  finalized_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  version integer not null default 1 check (version > 0),
  foreign key (patient_record_id, organization_id)
    references clinical_core.patient_records(id, organization_id),
  check (paid_minor + credit_applied_minor <= total_minor),
  check (refunded_minor <= paid_minor)
);

create table clinical_core.synthetic_billing_payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  invoice_id uuid references clinical_core.synthetic_billing_invoices(id),
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null default 'usd' check (currency ~ '^[a-z]{3}$'),
  status text not null check (status in ('pending','succeeded','failed','refunded','partially_refunded')),
  method text not null check (method in ('cash','check','bank_transfer','card','credit','other')),
  environment text check (environment is null or environment = 'synthetic-staging'),
  reference text check (reference is null or char_length(reference) <= 120),
  created_at timestamptz not null default clock_timestamp()
);

create table clinical_core.synthetic_billing_events (
  event_id text primary key check (char_length(event_id) between 8 and 160),
  organization_id uuid not null references clinical_core.organizations(id),
  event_type text not null check (char_length(event_type) between 1 and 120),
  outcome text not null check (outcome in ('processed','duplicate','ignored','refused','out_of_order')),
  detail text check (detail is null or char_length(detail) <= 300),
  signature_verified boolean not null default false,
  livemode boolean,
  received_at timestamptz not null default clock_timestamp(),
  check (livemode is distinct from true)
);

create index synthetic_review_task_org_idx
  on clinical_core.synthetic_review_task_state(organization_id, status, updated_at desc);
create index synthetic_billing_invoice_org_idx
  on clinical_core.synthetic_billing_invoices(organization_id, created_at desc);
create index synthetic_billing_payment_org_idx
  on clinical_core.synthetic_billing_payments(organization_id, created_at desc);
create index synthetic_billing_event_org_idx
  on clinical_core.synthetic_billing_events(organization_id, received_at desc);

alter table clinical_core.synthetic_review_task_state enable row level security;
alter table clinical_audit.synthetic_review_events enable row level security;
alter table clinical_core.synthetic_billing_invoices enable row level security;
alter table clinical_core.synthetic_billing_payments enable row level security;
alter table clinical_core.synthetic_billing_events enable row level security;
revoke all on clinical_core.synthetic_review_task_state,
  clinical_core.synthetic_billing_invoices,
  clinical_core.synthetic_billing_payments,
  clinical_core.synthetic_billing_events from public, clinical_core_api;
revoke all on clinical_audit.synthetic_review_events from public, clinical_core_api;

create trigger synthetic_review_events_append_only
  before update or delete on clinical_audit.synthetic_review_events
  for each row execute function clinical_private.block_update_delete();

create or replace function clinical_core.list_review_queue(_organization_id uuid)
returns table(
  id uuid, item_type text, title text, priority text, status text,
  patient_id uuid, patient_name text, assignee_name text,
  due_at timestamptz, created_at timestamptz
)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform clinical_private.assert_synthetic_context(_organization_id, 'clinical_data', 'workforce');
  if _organization_id is distinct from clinical_private.organization_id()
    or not clinical_private.is_active_member(_organization_id) then
    raise exception using errcode = '42501', message = 'review_queue_access_refused';
  end if;
  return query
  select event.id, 'lab_extraction'::text,
    ('Review imported ' || event.marker_name || ' · ' || event.panel_name)::text,
    case when event.source_status = 'critical' then 'high'
      when event.source_status in ('low','high') then 'medium' else 'low' end::text,
    case when event.state in ('accepted','rejected') then 'resolved'
      else coalesce(task.status, 'open') end::text,
    event.patient_record_id, patient.synthetic_record_key::text,
    case when task.resolved_by_person_id = clinical_private.actor_person_id() then 'You' else null end::text,
    event.received_at + interval '3 days', event.received_at
  from clinical_core.lab_import_events event
  join clinical_core.patient_records patient
    on patient.id = event.patient_record_id and patient.organization_id = _organization_id
  left join clinical_core.synthetic_review_task_state task
    on task.source_kind = 'lab_import' and task.source_id = event.id
  where event.organization_id = _organization_id
    and patient.contains_phi = false
    and coalesce(task.status, 'open') <> 'dismissed'
  order by event.received_at desc, event.id
  limit 500;
end
$$;

create or replace function clinical_core.resolve_review_queue_item(_item_id uuid, _note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  _organization_id uuid := clinical_private.organization_id();
  _event clinical_core.lab_import_events%rowtype;
  _existing clinical_core.synthetic_review_task_state%rowtype;
  _audit_id uuid;
begin
  perform clinical_private.assert_synthetic_context(_organization_id, 'clinical_data', 'workforce');
  if not clinical_private.has_clinical_role(_organization_id)
    or (_note is not null and char_length(_note) > 500) then
    raise exception using errcode = '42501', message = 'review_queue_access_refused';
  end if;
  select * into _event from clinical_core.lab_import_events
  where id = _item_id and organization_id = _organization_id;
  if not found then raise exception using errcode = 'P0002', message = 'review_task_not_found'; end if;
  select * into _existing from clinical_core.synthetic_review_task_state
  where source_kind = 'lab_import' and source_id = _event.id;
  if _event.state in ('accepted','rejected') or _existing.status = 'resolved' then
    return jsonb_build_object('id',_event.id,'status','resolved','previous_status','resolved','already_resolved',true);
  end if;
  insert into clinical_core.synthetic_review_task_state(
    organization_id,patient_record_id,source_kind,source_id,status,
    resolved_by_person_id,resolved_at,updated_at)
  values(_organization_id,_event.patient_record_id,'lab_import',_event.id,'resolved',
    clinical_private.actor_person_id(),clock_timestamp(),clock_timestamp())
  on conflict(source_kind,source_id) do update set
    status='resolved',resolved_by_person_id=excluded.resolved_by_person_id,
    resolved_at=excluded.resolved_at,updated_at=excluded.updated_at;
  insert into clinical_audit.synthetic_review_events(
    organization_id,actor_person_id,source_kind,source_id,action)
  values(_organization_id,clinical_private.actor_person_id(),'lab_import',_event.id,'review_task.resolved')
  returning id into _audit_id;
  return jsonb_build_object('id',_event.id,'status','resolved','previous_status',
    coalesce(_existing.status,'open'),'already_resolved',false,'audit_event_id',_audit_id);
end
$$;

create or replace function clinical_core.invoke_billing_operation(_operation text, _args jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  _organization_id uuid := clinical_private.organization_id();
  _from timestamptz;
  _to timestamptz;
begin
  perform clinical_private.assert_synthetic_context(_organization_id, 'clinical_data', 'workforce');
  if not clinical_private.has_clinical_role(_organization_id)
    or jsonb_typeof(_args) <> 'object'
    or _args->>'_organization_id' is distinct from _organization_id::text then
    raise exception using errcode = '42501', message = 'billing_access_refused';
  end if;
  if _operation <> 'get_billing_workspace' then
    raise exception using errcode = '0A000', message = 'synthetic_billing_write_disabled';
  end if;
  _from := nullif(_args->>'_from','')::timestamptz;
  _to := nullif(_args->>'_to','')::timestamptz;
  return jsonb_build_object(
    'summary', jsonb_build_object(
      'invoicedMinor', coalesce((select sum(invoice.total_minor) from clinical_core.synthetic_billing_invoices invoice
        where invoice.organization_id=_organization_id and (_from is null or invoice.created_at>=_from) and (_to is null or invoice.created_at<=_to)),0),
      'collectedMinor', coalesce((select sum(payment.amount_minor) from clinical_core.synthetic_billing_payments payment
        where payment.organization_id=_organization_id and payment.status='succeeded' and (_from is null or payment.created_at>=_from) and (_to is null or payment.created_at<=_to)),0),
      'outstandingMinor', coalesce((select sum(greatest(invoice.total_minor-invoice.paid_minor-invoice.credit_applied_minor,0)) from clinical_core.synthetic_billing_invoices invoice
        where invoice.organization_id=_organization_id and invoice.status in ('open','partially_paid')),0),
      'refundedMinor', coalesce((select sum(invoice.refunded_minor) from clinical_core.synthetic_billing_invoices invoice where invoice.organization_id=_organization_id),0),
      'discountMinor', coalesce((select sum(invoice.discount_minor) from clinical_core.synthetic_billing_invoices invoice where invoice.organization_id=_organization_id),0),
      'taxMinor', coalesce((select sum(invoice.tax_minor) from clinical_core.synthetic_billing_invoices invoice where invoice.organization_id=_organization_id),0)),
    'invoices', coalesce((select jsonb_agg(jsonb_build_object(
      'id',invoice.id,'number',invoice.number,'status',invoice.status,'patientId',invoice.patient_record_id,
      'patientName',patient.synthetic_record_key,'totalMinor',invoice.total_minor,
      'balanceMinor',greatest(invoice.total_minor-invoice.paid_minor-invoice.credit_applied_minor,0),
      'currency',invoice.currency,'locationId',invoice.location_id,
      'practitionerUserId',invoice.practitioner_person_id,'finalizedAt',invoice.finalized_at,
      'createdAt',invoice.created_at,'version',invoice.version) order by invoice.created_at desc)
      from clinical_core.synthetic_billing_invoices invoice
      join clinical_core.patient_records patient on patient.id=invoice.patient_record_id and patient.organization_id=_organization_id
      where invoice.organization_id=_organization_id and (_from is null or invoice.created_at>=_from) and (_to is null or invoice.created_at<=_to)
        and (nullif(_args->>'_status','') is null or invoice.status=_args->>'_status')),'[]'::jsonb),
    'payments', coalesce((select jsonb_agg(jsonb_build_object(
      'id',payment.id,'invoiceId',payment.invoice_id,'amountMinor',payment.amount_minor,
      'currency',payment.currency,'status',payment.status,'method',payment.method,
      'environment',payment.environment,'reference',payment.reference,'createdAt',payment.created_at)
      order by payment.created_at desc) from clinical_core.synthetic_billing_payments payment
      where payment.organization_id=_organization_id and (_from is null or payment.created_at>=_from) and (_to is null or payment.created_at<=_to)),'[]'::jsonb),
    'aging', jsonb_build_object(
      'current',coalesce((select sum(greatest(total_minor-paid_minor-credit_applied_minor,0)) from clinical_core.synthetic_billing_invoices where organization_id=_organization_id and status in ('open','partially_paid') and created_at>=clock_timestamp()-interval '30 days'),0),
      'days31to60',coalesce((select sum(greatest(total_minor-paid_minor-credit_applied_minor,0)) from clinical_core.synthetic_billing_invoices where organization_id=_organization_id and status in ('open','partially_paid') and created_at<clock_timestamp()-interval '30 days' and created_at>=clock_timestamp()-interval '60 days'),0),
      'days61to90',coalesce((select sum(greatest(total_minor-paid_minor-credit_applied_minor,0)) from clinical_core.synthetic_billing_invoices where organization_id=_organization_id and status in ('open','partially_paid') and created_at<clock_timestamp()-interval '60 days' and created_at>=clock_timestamp()-interval '90 days'),0),
      'over90',coalesce((select sum(greatest(total_minor-paid_minor-credit_applied_minor,0)) from clinical_core.synthetic_billing_invoices where organization_id=_organization_id and status in ('open','partially_paid') and created_at<clock_timestamp()-interval '90 days'),0)),
    'productSales','[]'::jsonb,
    'inventory',jsonb_build_object('valuationMinor',0,'lowStock','[]'::jsonb),
    'reconciliation',jsonb_build_object(
      'pendingCardPayments',(select count(*) from clinical_core.synthetic_billing_payments where organization_id=_organization_id and method='card' and status='pending'),
      'webhookEvents',coalesce((select jsonb_agg(jsonb_build_object(
        'eventId',event.event_id,'type',event.event_type,'outcome',event.outcome,
        'detail',event.detail,'receivedAt',event.received_at,'signatureVerified',event.signature_verified,
        'livemode',event.livemode) order by event.received_at desc)
        from clinical_core.synthetic_billing_events event where event.organization_id=_organization_id),'[]'::jsonb)));
end
$$;

revoke all on function clinical_core.list_review_queue(uuid),
  clinical_core.resolve_review_queue_item(uuid,text),
  clinical_core.invoke_billing_operation(text,jsonb) from public;
grant execute on function clinical_core.list_review_queue(uuid),
  clinical_core.resolve_review_queue_item(uuid,text),
  clinical_core.invoke_billing_operation(text,jsonb) to clinical_core_api;
