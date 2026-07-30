-- Patient Sync Worker & Contract Verification acceptance tests (Phase 6A).
-- Rolled back: the project is unchanged after the final statement.
--
-- Covers: worker RPCs service_role-only (never anon/authenticated) · single
-- claim_sync_outbound overload (old signature dropped) · definer functions
-- with pinned empty search_path · telemetry tables RLS-on with no client
-- writes and unreadable nonces · fail-closed posture (disabled → fixture →
-- approved precedence) · cross-tenant claim refusal and isolation · lease
-- claiming (sending + attempt row + lease columns), no double-claim of a
-- live lease, safe reclaim of an expired lease as a fresh attempt · delivery-
-- time recheck (consent revoked between claim and delivery cancels durably;
-- disabled connection cancels durably; superseded resource marked superseded,
-- never delivered) · explicit re-share after cancellation mints a NEW
-- envelope generation (never a silent resend) · duplicate provider-callback
-- dedup · late acknowledgment cannot resurrect a superseded envelope · PHI-
-- free worker-cycle telemetry with observable circuit state · unknown circuit
-- state refused · callback nonce registration + replay refusal · cancel
-- authorization (staff refused), delivered-envelope cancel refused, reason
-- required, reasoned cancel applied and audited · zero residue.
--
-- Last full run against urcjiehlxoehievobezf: 29/29 green.
--
-- Note on the two in-suite adjustments (both explained inline): the consent-
-- revocation check accepts the revoke-cascade's own durable cancellation
-- (production behavior — the recheck refusal is the backstop), and the
-- supersession check restores real created_at ordering because now() is
-- frozen inside this single transaction.

begin;
create temp table _v(name text, passed boolean, detail text) on commit drop;
create temp table _ids(k text primary key, v text) on commit drop;

insert into auth.users(id,email) values
  ('11111111-0000-0000-0000-000000000901','p6-practitioner@verify.local'),
  ('11111111-0000-0000-0000-000000000902','p6-staff@verify.local');
insert into public.organizations(id,name,slug) values
  ('bbbbbbbb-0000-0000-0000-000000000901','Worker Org','worker-0090'),
  ('bbbbbbbb-0000-0000-0000-000000000902','Worker Other','worker-other-0090');
insert into public.organization_memberships(organization_id,user_id,role,status) values
  ('bbbbbbbb-0000-0000-0000-000000000901','11111111-0000-0000-0000-000000000901','practitioner','active'),
  ('bbbbbbbb-0000-0000-0000-000000000901','11111111-0000-0000-0000-000000000902','staff','active');
insert into public.patient_profiles(id,organization_id,first_name,last_name) values
  ('cccccccc-0000-0000-0000-000000000901','bbbbbbbb-0000-0000-0000-000000000901','Worker','Patient');
insert into public.practitioner_patient_relationships
  (organization_id,practitioner_user_id,patient_id,status) values
  ('bbbbbbbb-0000-0000-0000-000000000901','11111111-0000-0000-0000-000000000901','cccccccc-0000-0000-0000-000000000901','active'),
  ('bbbbbbbb-0000-0000-0000-000000000901','11111111-0000-0000-0000-000000000902','cccccccc-0000-0000-0000-000000000901','active');
insert into public.appointments(id,organization_id,patient_id,title,appointment_type,status,starts_at,ends_at,version) values
  ('dddddddd-0000-0000-0000-000000000901','bbbbbbbb-0000-0000-0000-000000000901','cccccccc-0000-0000-0000-000000000901','Worker visit','follow-up','scheduled',now()+interval '2 days',now()+interval '2 days 30 minutes',1);

insert into _v
select 'phase-6 worker RPCs are service_role only (not anon, not authenticated)',
  not bool_or(has_function_privilege('anon', p.oid, 'execute'))
  and not bool_or(has_function_privilege('authenticated', p.oid, 'execute'))
  and bool_and(has_function_privilege('service_role', p.oid, 'execute')), null
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in
    ('claim_sync_outbound','recheck_sync_export','record_sync_worker_cycle',
     'register_sync_callback_nonce','record_sync_delivery','record_sync_inbound',
     'verify_sync_invitation');
insert into _v
select 'exactly one claim_sync_outbound overload exists (old signature dropped)',
  count(*) = 1, count(*)::text
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='claim_sync_outbound';
insert into _v
select 'phase-6 functions are definer with pinned empty search_path',
  bool_and(p.prosecdef and 'search_path=""' = any(p.proconfig)), null
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in
    ('claim_sync_outbound','recheck_sync_export','record_sync_worker_cycle',
     'register_sync_callback_nonce','cancel_sync_event');
insert into _v
select 'telemetry tables: RLS on, no client writes; nonces unreadable',
  bool_and(c.relrowsecurity)
  and not bool_or(has_table_privilege('authenticated', c.oid, 'insert'))
  and not has_table_privilege('authenticated','public.sync_callback_nonces','select'), null
  from pg_class c where c.oid in ('public.sync_worker_cycles'::regclass,
    'public.sync_circuit_states'::regclass,'public.sync_callback_nonces'::regclass);

select set_config('request.jwt.claims',
  '{"sub":"11111111-0000-0000-0000-000000000901","role":"authenticated"}', true);
do $$
declare _r jsonb;
begin
  _r := public.create_sync_invitation('bbbbbbbb-0000-0000-0000-000000000901','cccccccc-0000-0000-0000-000000000901');
  insert into _ids values('tok', _r->>'token'), ('conn', _r->>'connectionId');
  _r := public.verify_sync_invitation((select v from _ids where k='tok'), 'alp-worker-subject');
  _r := public.set_sync_consent_scope((select v from _ids where k='conn')::uuid,
    'appointments', true, 'ALP sync consent', 'v1', 'US-CA', 'in_person', 'self');
end $$;

do $$ begin
  perform public.claim_sync_outbound('bbbbbbbb-0000-0000-0000-000000000901', 10);
  insert into _v values('a disabled provider prevents claims entirely', false, 'no error');
exception when others then
  insert into _v values('a disabled provider prevents claims entirely', sqlstate='22023', sqlstate);
end $$;
do $$
declare _o jsonb;
begin
  _o := public.get_org_sync_operations('bbbbbbbb-0000-0000-0000-000000000901');
  insert into _v values('posture reports disabled with no connector', _o->>'posture'='disabled', _o->>'posture');
end $$;
insert into public.connectors(organization_id, provider, kind, scopes, sync_status)
values ('bbbbbbbb-0000-0000-0000-000000000901','sync_contract_fixture','patient_sync','{}'::jsonb,'connected');
do $$
declare _o jsonb;
begin
  _o := public.get_org_sync_operations('bbbbbbbb-0000-0000-0000-000000000901');
  insert into _v values('posture reports fixture for the contract-test connector',
    _o->>'posture'='fixture' and _o->>'provider'='sync_contract_fixture', _o->>'posture');
end $$;
insert into public.connectors(organization_id, provider, kind, scopes, sync_status)
values ('bbbbbbbb-0000-0000-0000-000000000901','alp_patient_sync','patient_sync','{}'::jsonb,'connected');
do $$
declare _o jsonb;
begin
  _o := public.get_org_sync_operations('bbbbbbbb-0000-0000-0000-000000000901');
  insert into _v values('an approved provider takes posture precedence over the fixture',
    _o->>'posture'='approved', _o->>'posture');
end $$;
delete from public.connectors where organization_id='bbbbbbbb-0000-0000-0000-000000000901' and provider='alp_patient_sync';

do $$
declare _r jsonb;
begin
  _r := public.queue_sync_export((select v from _ids where k='conn')::uuid,
    'appointment_summary', 'dddddddd-0000-0000-0000-000000000901');
  insert into _ids values('evt', _r->>'eventId'), ('euid', _r->>'eventUid');
end $$;
do $$ begin
  perform public.claim_sync_outbound('bbbbbbbb-0000-0000-0000-000000000902', 10);
  insert into _v values('cross-tenant claim is refused (no provider in that org)', false, 'no error');
exception when others then
  insert into _v values('cross-tenant claim is refused (no provider in that org)', sqlstate='22023', sqlstate);
end $$;
insert into public.connectors(organization_id, provider, kind, scopes, sync_status)
values ('bbbbbbbb-0000-0000-0000-000000000902','sync_contract_fixture','patient_sync','{}'::jsonb,'connected');
do $$
declare _r jsonb;
begin
  _r := public.claim_sync_outbound('bbbbbbbb-0000-0000-0000-000000000902', 10);
  insert into _v values('a tenant claims ONLY its own work (org2 sees nothing of org1)',
    jsonb_array_length(_r->'events') = 0, null);
end $$;
do $$
declare _r jsonb; _e record;
begin
  _r := public.claim_sync_outbound('bbbbbbbb-0000-0000-0000-000000000901', 10, 60);
  select * into _e from public.sync_outbound_events where id=(select v from _ids where k='evt')::uuid;
  insert into _v values('claim leases the envelope: sending, attempt row, lease set',
    jsonb_array_length(_r->'events') = 1 and _e.state='sending' and _e.attempts=1
    and _e.lease_id is not null and _e.lease_expires_at > now()
    and (_r->'events'->0->>'contractVersion') = 'patient-sync/1', _e.state);
  _r := public.claim_sync_outbound('bbbbbbbb-0000-0000-0000-000000000901', 10, 60);
  insert into _v values('a live lease is not double-claimed',
    jsonb_array_length(_r->'events') = 0 and (_r->>'leaseReclaims')::int = 0, null);
end $$;
update public.sync_outbound_events set lease_expires_at = now() - interval '1 second'
where id = (select v from _ids where k='evt')::uuid;
do $$
declare _r jsonb; _e record;
begin
  _r := public.claim_sync_outbound('bbbbbbbb-0000-0000-0000-000000000901', 10, 60);
  select * into _e from public.sync_outbound_events where id=(select v from _ids where k='evt')::uuid;
  insert into _v values('an expired lease is reclaimed safely and re-claimed as a fresh attempt',
    (_r->>'leaseReclaims')::int = 1 and jsonb_array_length(_r->'events') = 1
    and _e.state='sending' and _e.attempts=2, _e.attempts::text);
end $$;

do $$
declare _r jsonb;
begin
  _r := public.recheck_sync_export((select v from _ids where k='euid')::uuid);
  insert into _v values('recheck passes while consent and connection hold',
    (_r->>'deliverable')::boolean, null);
  -- Withdrawal while work is in flight: the revoke cascade cancels the
  -- sending envelope immediately; the recheck then refuses it. Either path,
  -- the envelope is durably cancelled with a consent reason and never
  -- reaches the provider.
  _r := public.set_sync_consent_scope((select v from _ids where k='conn')::uuid,
    'appointments', false);
  _r := public.recheck_sync_export((select v from _ids where k='euid')::uuid);
  insert into _v values('consent revoked between claim and delivery cancels durably',
    (_r->>'deliverable')::boolean = false
    and (select state='cancelled' and last_error_safe like '%consent%'
         from public.sync_outbound_events
         where id=(select v from _ids where k='evt')::uuid), _r->>'reason');
end $$;

do $$
declare _r jsonb; _ver int;
begin
  _r := public.set_sync_consent_scope((select v from _ids where k='conn')::uuid,
    'appointments', true, 'ALP sync consent', 'v1', null, 'in_person', 'self');
  _r := public.queue_sync_export((select v from _ids where k='conn')::uuid,
    'appointment_summary', 'dddddddd-0000-0000-0000-000000000901');
  insert into _v values('an explicit re-share after cancellation mints a NEW envelope generation',
    (_r->>'ok')::boolean and (_r->>'state') = 'queued'
    and _r->>'eventId' <> (select v from _ids where k='evt'), _r->>'state');
  insert into _ids values('evt2', _r->>'eventId'), ('euid2', _r->>'eventUid');
  _r := public.claim_sync_outbound('bbbbbbbb-0000-0000-0000-000000000901', 10, 60);
  select version into _ver from public.patient_app_connections
  where id=(select v from _ids where k='conn')::uuid;
  _r := public.pause_sync_connection((select v from _ids where k='conn')::uuid, _ver);
  _r := public.recheck_sync_export((select v from _ids where k='euid2')::uuid);
  insert into _v values('a connection disabled between claim and delivery cancels durably',
    (_r->>'deliverable')::boolean = false and _r->>'reason'='refused_revoked'
    and (select state='cancelled' from public.sync_outbound_events
         where id=(select v from _ids where k='evt2')::uuid), _r->>'reason');
  select version into _ver from public.patient_app_connections
  where id=(select v from _ids where k='conn')::uuid;
  _r := public.resume_sync_connection((select v from _ids where k='conn')::uuid, _ver);
end $$;

do $$
declare _r jsonb;
begin
  update public.appointments set version = version + 1
  where id='dddddddd-0000-0000-0000-000000000901';
  _r := public.queue_sync_export((select v from _ids where k='conn')::uuid,
    'appointment_summary', 'dddddddd-0000-0000-0000-000000000901');
  insert into _ids values('evt3', _r->>'eventId'), ('euid3', _r->>'eventUid');
  _r := public.claim_sync_outbound('bbbbbbbb-0000-0000-0000-000000000901', 10, 60);
  update public.appointments set version = version + 1
  where id='dddddddd-0000-0000-0000-000000000901';
  _r := public.queue_sync_export((select v from _ids where k='conn')::uuid,
    'appointment_summary', 'dddddddd-0000-0000-0000-000000000901');
  insert into _ids values('evt4', _r->>'eventId'), ('euid4', _r->>'eventUid');
  -- In production these queues are separate transactions with distinct
  -- created_at values; inside this single-transaction suite now() is frozen,
  -- so restore the real ordering explicitly (created_at is not a frozen
  -- content column).
  update public.sync_outbound_events set created_at = created_at - interval '1 minute'
  where id = (select v from _ids where k='evt3')::uuid;
  _r := public.recheck_sync_export((select v from _ids where k='euid3')::uuid);
  insert into _v values('a resource superseded before delivery is marked superseded, not delivered',
    (_r->>'deliverable')::boolean = false and _r->>'reason'='superseded'
    and (select state='superseded' from public.sync_outbound_events
         where id=(select v from _ids where k='evt3')::uuid), _r->>'reason');
end $$;

do $$
declare _r jsonb;
begin
  _r := public.claim_sync_outbound('bbbbbbbb-0000-0000-0000-000000000901', 10, 60);
  _r := public.record_sync_delivery((select v from _ids where k='euid4')::uuid,
    'fx-del-1', 'delivered', now());
  _r := public.record_sync_delivery((select v from _ids where k='euid4')::uuid,
    'fx-del-1', 'delivered', now());
  insert into _v values('a duplicate provider callback dedupes at the worker boundary',
    (_r->>'duplicate')::boolean, null);
  _r := public.record_sync_delivery((select v from _ids where k='euid3')::uuid,
    'fx-late-ack', 'acknowledged', now());
  insert into _v values('a superseded envelope cannot become current through a late acknowledgment',
    (select state from public.sync_outbound_events
     where id=(select v from _ids where k='evt3')::uuid) = 'superseded', null);
end $$;

do $$
declare _r jsonb; _o jsonb;
begin
  _r := public.record_sync_worker_cycle('bbbbbbbb-0000-0000-0000-000000000901',
    'sync_contract_fixture', now() - interval '2 seconds', 3, 2, 1, 0, 0, 1, 'closed', null, 12, null);
  _o := public.get_org_sync_operations('bbbbbbbb-0000-0000-0000-000000000901');
  insert into _v values('worker cycles surface in org operations with circuit state',
    (_r->>'ok')::boolean and (_o->'lastWorkerCycle'->>'claimed')::int = 3
    and _o->'lastWorkerCycle'->>'circuitState' = 'closed'
    and _o->'circuit'->>'state' = 'closed', null);
  _r := public.record_sync_worker_cycle('bbbbbbbb-0000-0000-0000-000000000901',
    'sync_contract_fixture', now() - interval '1 second', 1, 0, 1, 0, 0, 0, 'open', 'retryable', 30, null);
  _o := public.get_org_sync_operations('bbbbbbbb-0000-0000-0000-000000000901');
  insert into _v values('an open circuit is observable and failure counts accumulate',
    _o->'circuit'->>'state' = 'open' and (_o->'circuit'->>'failureCount')::int >= 1
    and _o->'circuit'->>'openedAt' is not null, null);
end $$;
do $$ begin
  perform public.record_sync_worker_cycle('bbbbbbbb-0000-0000-0000-000000000901',
    'sync_contract_fixture', now(), 0,0,0,0,0,0, 'bogus', null, null, null);
  insert into _v values('an unknown circuit state is refused', false, 'no error');
exception when others then
  insert into _v values('an unknown circuit state is refused', sqlstate='22023', sqlstate);
end $$;

do $$
declare _r jsonb;
begin
  _r := public.register_sync_callback_nonce('bbbbbbbb-0000-0000-0000-000000000901',
    'sync_contract_fixture', 'nonce-1');
  insert into _v values('a fresh callback nonce registers', (_r->>'replay')::boolean = false, null);
  _r := public.register_sync_callback_nonce('bbbbbbbb-0000-0000-0000-000000000901',
    'sync_contract_fixture', 'nonce-1');
  insert into _v values('a replayed callback nonce is refused', (_r->>'replay')::boolean = true, null);
end $$;

select set_config('request.jwt.claims',
  '{"sub":"11111111-0000-0000-0000-000000000902","role":"authenticated"}', true);
do $$ begin
  perform public.cancel_sync_event((select v from _ids where k='evt4')::uuid, 'staff try');
  insert into _v values('staff cannot cancel sync work', false, 'no error');
exception when others then
  insert into _v values('staff cannot cancel sync work', sqlstate='42501', sqlstate);
end $$;
select set_config('request.jwt.claims',
  '{"sub":"11111111-0000-0000-0000-000000000901","role":"authenticated"}', true);
do $$ begin
  perform public.cancel_sync_event((select v from _ids where k='evt4')::uuid, 'why not');
  insert into _v values('a delivered envelope cannot be cancelled', false, 'no error');
exception when others then
  insert into _v values('a delivered envelope cannot be cancelled', sqlstate='22023', sqlstate);
end $$;
do $$
declare _r jsonb;
begin
  update public.appointments set version = version + 1
  where id='dddddddd-0000-0000-0000-000000000901';
  _r := public.queue_sync_export((select v from _ids where k='conn')::uuid,
    'appointment_summary', 'dddddddd-0000-0000-0000-000000000901');
  insert into _ids values('evt5', _r->>'eventId');
end $$;
do $$ begin
  perform public.cancel_sync_event((select v from _ids where k='evt5')::uuid, '  ');
  insert into _v values('cancelling requires a reason', false, 'no error');
exception when others then
  insert into _v values('cancelling requires a reason', sqlstate='22023', sqlstate);
end $$;
do $$
declare _r jsonb;
begin
  _r := public.cancel_sync_event((select v from _ids where k='evt5')::uuid, 'plan changed in person');
  insert into _v values('a reasoned cancel is applied and audited',
    (_r->>'ok')::boolean
    and (select state='cancelled' from public.sync_outbound_events
         where id=(select v from _ids where k='evt5')::uuid)
    and exists (select 1 from public.audit_events
         where action='sync.event_cancelled'
           and resource_id=(select v from _ids where k='evt5')), null);
end $$;

select name || ' => ' || coalesce(detail,'-') as failure from _v where not passed
union all
select 'TOTALS ' || count(*) filter (where passed) || '/' || count(*) from _v;
rollback;
-- Zero-residue check (runs OUTSIDE the rolled-back transaction above).
select 'zero rollback residue' as check, count(*) = 0 as clean from (
  select id from public.organizations
    where id in ('bbbbbbbb-0000-0000-0000-000000000901','bbbbbbbb-0000-0000-0000-000000000902')
  union all
  select id from public.connectors
    where organization_id in ('bbbbbbbb-0000-0000-0000-000000000901','bbbbbbbb-0000-0000-0000-000000000902')
  union all
  select id from public.sync_outbound_events
    where organization_id in ('bbbbbbbb-0000-0000-0000-000000000901','bbbbbbbb-0000-0000-0000-000000000902')
  union all
  select id from public.sync_worker_cycles
    where organization_id in ('bbbbbbbb-0000-0000-0000-000000000901','bbbbbbbb-0000-0000-0000-000000000902')
  union all
  select id from public.sync_callback_nonces
    where organization_id in ('bbbbbbbb-0000-0000-0000-000000000901','bbbbbbbb-0000-0000-0000-000000000902')
) residue;
