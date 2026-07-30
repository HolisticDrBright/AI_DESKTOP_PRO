-- Patient Delivery & Synchronization Gateway acceptance tests (Phase 5).
-- Rolled back: the project is unchanged after the final statement.
--
-- Covers: anonymous/insufficient-role refusal · cross-tenant connection and
-- event attacks · token expiry, supersession, single-use replay · forged
-- external-subject refusal (unique binding) · independent versioned consent
-- scopes with artifact/jurisdiction/method/authority · research consent
-- separation · fail-closed queueing AND claiming without a provider · server-
-- built minimum-necessary payloads with hashes · event idempotency ·
-- duplicate-callback dedup · out-of-order delivery (late delivered, stale
-- failure) · evidence timestamp window · bounded backoff · dead-letter at the
-- attempt threshold with a REAL review task · manual retry authorization +
-- reason · unsupported contract version · payload-hash mismatch · ungranted-
-- scope inbound refusal without storage · stale-version conflict (explicit,
-- never silently merged) · original inbound immutability (trigger-level) ·
-- versioned correction overlays · conflict resolution (40001, note required,
-- originals preserved) · practitioner inbound review · receipts projecting
-- provider evidence · patient-app consent revocation applying immediately ·
-- single-scope revocation independence · resource withdrawal · pause/resume/
-- revoke lifecycle with optimistic concurrency · immediate revocation
-- blocking exports and inbound writes · re-linking via a NEW invitation ·
-- no unintended clinical/financial side effects · exact grants · direct-write
-- refusal · zero residue.
--
-- Last full run against urcjiehlxoehievobezf: 80/80 green.

begin;
create temp table _v(name text, passed boolean, detail text) on commit drop;
create temp table _ids(k text primary key, v text) on commit drop;
create temp table _base(k text primary key, v bigint) on commit drop;

insert into auth.users(id,email) values
  ('11111111-0000-0000-0000-000000000801','ps-practitioner@verify.local'),
  ('11111111-0000-0000-0000-000000000802','ps-staff@verify.local'),
  ('11111111-0000-0000-0000-000000000803','ps-outsider@verify.local');
insert into public.organizations(id,name,slug) values
  ('bbbbbbbb-0000-0000-0000-000000000801','Sync Org','sync-0080'),
  ('bbbbbbbb-0000-0000-0000-000000000802','Sync Other','sync-other-0080');
insert into public.organization_memberships(organization_id,user_id,role,status) values
  ('bbbbbbbb-0000-0000-0000-000000000801','11111111-0000-0000-0000-000000000801','practitioner','active'),
  ('bbbbbbbb-0000-0000-0000-000000000801','11111111-0000-0000-0000-000000000802','staff','active'),
  ('bbbbbbbb-0000-0000-0000-000000000802','11111111-0000-0000-0000-000000000803','practitioner','active');
insert into public.patient_profiles(id,organization_id,first_name,last_name) values
  ('cccccccc-0000-0000-0000-000000000801','bbbbbbbb-0000-0000-0000-000000000801','Sync','Patient'),
  ('cccccccc-0000-0000-0000-000000000802','bbbbbbbb-0000-0000-0000-000000000802','Foreign','Patient'),
  ('cccccccc-0000-0000-0000-000000000803','bbbbbbbb-0000-0000-0000-000000000801','Second','Patient');
insert into public.practitioner_patient_relationships
  (organization_id,practitioner_user_id,patient_id,status) values
  ('bbbbbbbb-0000-0000-0000-000000000801','11111111-0000-0000-0000-000000000801','cccccccc-0000-0000-0000-000000000801','active'),
  ('bbbbbbbb-0000-0000-0000-000000000801','11111111-0000-0000-0000-000000000802','cccccccc-0000-0000-0000-000000000801','active'),
  ('bbbbbbbb-0000-0000-0000-000000000801','11111111-0000-0000-0000-000000000801','cccccccc-0000-0000-0000-000000000803','active'),
  ('bbbbbbbb-0000-0000-0000-000000000802','11111111-0000-0000-0000-000000000803','cccccccc-0000-0000-0000-000000000802','active');
insert into public.appointments(id,organization_id,patient_id,title,appointment_type,status,starts_at,ends_at,version) values
  ('dddddddd-0000-0000-0000-000000000801','bbbbbbbb-0000-0000-0000-000000000801','cccccccc-0000-0000-0000-000000000801','Follow-up visit','follow-up','scheduled',now()+interval '3 days',now()+interval '3 days 30 minutes',1);
insert into public.protocols(id,organization_id,patient_id,title,status) values
  ('dddddddd-0000-0000-0000-000000000811','bbbbbbbb-0000-0000-0000-000000000801','cccccccc-0000-0000-0000-000000000801','Longevity protocol','active');
insert into public.protocol_versions(id,organization_id,protocol_id,patient_id,version,status,title) values
  ('dddddddd-0000-0000-0000-000000000812','bbbbbbbb-0000-0000-0000-000000000801','dddddddd-0000-0000-0000-000000000811','cccccccc-0000-0000-0000-000000000801',1,'approved','Longevity protocol v1');

insert into _base
select 'notes', count(*) from public.clinical_notes
union all select 'messages', count(*) from public.messages
union all select 'protocols', count(*) from public.protocols
union all select 'appointments', count(*) from public.appointments
union all select 'enrollments', count(*) from public.program_enrollments
union all select 'conversations', count(*) from public.conversations;

insert into _v
select 'anon cannot execute any sync RPC',
  not bool_or(has_function_privilege('anon', p.oid, 'execute')), null
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in
    ('get_patient_sync_overview','create_sync_invitation','pause_sync_connection',
     'resume_sync_connection','revoke_sync_connection','set_sync_consent_scope',
     'queue_sync_export','withdraw_sync_resource','retry_sync_event',
     'resolve_sync_conflict','review_sync_inbound','record_sync_inbound_correction',
     'get_org_sync_operations','verify_sync_invitation','claim_sync_outbound',
     'record_sync_delivery','record_sync_inbound');
insert into _v
select 'worker-boundary sync RPCs are service_role only',
  not bool_or(has_function_privilege('authenticated', p.oid, 'execute'))
  and bool_and(has_function_privilege('service_role', p.oid, 'execute')), null
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in
    ('verify_sync_invitation','claim_sync_outbound','record_sync_delivery','record_sync_inbound');
insert into _v
select 'all sync RPCs are definer with a pinned empty search_path',
  count(*) >= 17 and bool_and(p.prosecdef and 'search_path=""' = any(p.proconfig)), null
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in
    ('get_patient_sync_overview','create_sync_invitation','pause_sync_connection',
     'resume_sync_connection','revoke_sync_connection','set_sync_consent_scope',
     'queue_sync_export','withdraw_sync_resource','retry_sync_event',
     'resolve_sync_conflict','review_sync_inbound','record_sync_inbound_correction',
     'get_org_sync_operations','verify_sync_invitation','claim_sync_outbound',
     'record_sync_delivery','record_sync_inbound');
insert into _v
select 'sync tables have RLS and no direct authenticated writes',
  bool_and(c.relrowsecurity)
  and not bool_or(has_table_privilege('authenticated', c.oid, 'insert'))
  and not bool_or(has_table_privilege('authenticated', c.oid, 'update'))
  and not bool_or(has_table_privilege('authenticated', c.oid, 'delete')), null
  from pg_class c where c.oid in (
    'public.patient_app_connections'::regclass,'public.patient_sync_invitations'::regclass,
    'public.sync_consent_scopes'::regclass,'public.sync_outbound_events'::regclass,
    'public.sync_inbound_events'::regclass,'public.sync_inbound_corrections'::regclass,
    'public.sync_delivery_attempts'::regclass,'public.sync_delivery_events'::regclass,
    'public.sync_dead_letters'::regclass,'public.sync_cursors'::regclass,
    'public.sync_conflicts'::regclass,'public.sync_resource_acks'::regclass,
    'public.sync_connection_events'::regclass);
insert into _v
select 'invitation token hashes are not selectable by clients at all',
  not has_table_privilege('authenticated','public.patient_sync_invitations','select'), null;

select set_config('request.jwt.claims', '', true);
do $$ begin
  perform public.get_patient_sync_overview('cccccccc-0000-0000-0000-000000000801');
  insert into _v values('anonymous sync overview is refused', false, 'no error');
exception when others then
  insert into _v values('anonymous sync overview is refused', sqlstate='28000', sqlstate);
end $$;
select set_config('request.jwt.claims',
  '{"sub":"11111111-0000-0000-0000-000000000803","role":"authenticated"}', true);
do $$ begin
  perform public.get_patient_sync_overview('cccccccc-0000-0000-0000-000000000801');
  insert into _v values('cross-tenant overview is refused', false, 'no error');
exception when others then
  insert into _v values('cross-tenant overview is refused', sqlstate='42501', sqlstate);
end $$;
do $$ begin
  perform public.create_sync_invitation('bbbbbbbb-0000-0000-0000-000000000801','cccccccc-0000-0000-0000-000000000801');
  insert into _v values('cross-tenant invitation is refused', false, 'no error');
exception when others then
  insert into _v values('cross-tenant invitation is refused', sqlstate='42501', sqlstate);
end $$;
select set_config('request.jwt.claims',
  '{"sub":"11111111-0000-0000-0000-000000000802","role":"authenticated"}', true);
do $$ begin
  perform public.create_sync_invitation('bbbbbbbb-0000-0000-0000-000000000801','cccccccc-0000-0000-0000-000000000801');
  insert into _v values('staff cannot create connection invitations', false, 'no error');
exception when others then
  insert into _v values('staff cannot create connection invitations', sqlstate='42501', sqlstate);
end $$;
do $$
declare _o jsonb;
begin
  _o := public.get_patient_sync_overview('cccccccc-0000-0000-0000-000000000801');
  insert into _v values('staff can READ the sync overview (unlinked, provider off)',
    jsonb_typeof(_o->'connection') = 'null' and (_o->>'providerConfigured')::boolean = false, null);
end $$;

select set_config('request.jwt.claims',
  '{"sub":"11111111-0000-0000-0000-000000000801","role":"authenticated"}', true);
do $$
declare _r jsonb;
begin
  _r := public.create_sync_invitation('bbbbbbbb-0000-0000-0000-000000000801','cccccccc-0000-0000-0000-000000000801');
  insert into _ids values('tok1', _r->>'token'), ('conn', _r->>'connectionId');
  insert into _v values('invitation created: pending connection, one-time token, honest no-delivery',
    (_r->>'ok')::boolean and length(_r->>'token') = 64
    and (_r->>'deliveryConfigured')::boolean = false
    and (_r->>'message') like '%Delivery provider not configured%'
    and (select state from public.patient_app_connections where id=(_r->>'connectionId')::uuid) = 'invitation_pending',
    null);
  insert into _v values('only the token HASH is stored',
    not exists (select 1 from public.patient_sync_invitations where token_hash = _r->>'token')
    and exists (select 1 from public.patient_sync_invitations
                where token_hash = private.sha256_hex(_r->>'token')), null);
end $$;
do $$ begin
  perform public.set_sync_consent_scope((select v from _ids where k='conn')::uuid,
    'appointments', true, 'Sync consent', 'v1', 'US-CA', 'in_person', 'self');
  insert into _v values('consent cannot attach to an unverified connection', false, 'no error');
exception when others then
  insert into _v values('consent cannot attach to an unverified connection', sqlstate='22023', sqlstate);
end $$;
do $$
declare _r jsonb;
begin
  _r := public.create_sync_invitation('bbbbbbbb-0000-0000-0000-000000000801','cccccccc-0000-0000-0000-000000000801');
  insert into _ids values('tok2', _r->>'token');
  insert into _v values('a new invitation supersedes the previous one',
    (select superseded_at is not null from public.patient_sync_invitations
     where token_hash = private.sha256_hex((select v from _ids where k='tok1'))), null);
end $$;
do $$ begin
  perform public.verify_sync_invitation((select v from _ids where k='tok1'), 'alp-subject-1');
  insert into _v values('a superseded token is refused', false, 'no error');
exception when others then
  insert into _v values('a superseded token is refused', sqlstate='22023', sqlstate);
end $$;
do $$ begin
  perform public.verify_sync_invitation('deadbeef', 'alp-subject-1');
  insert into _v values('an unknown token is refused', false, 'no error');
exception when others then
  insert into _v values('an unknown token is refused', sqlstate='P0002', sqlstate);
end $$;
do $$
declare _r jsonb;
begin
  _r := public.verify_sync_invitation((select v from _ids where k='tok2'), 'alp-subject-1');
  insert into _v values('verification binds the external subject and moves to verified',
    (_r->>'ok')::boolean
    and (select state = 'verified' and external_subject_id = 'alp-subject-1'
         from public.patient_app_connections where id=(_r->>'connectionId')::uuid), null);
end $$;
do $$ begin
  perform public.verify_sync_invitation((select v from _ids where k='tok2'), 'alp-subject-9');
  insert into _v values('a token is single-use: replay is refused', false, 'no error');
exception when others then
  insert into _v values('a token is single-use: replay is refused', sqlstate='22023', sqlstate);
end $$;
do $$ begin
  perform public.create_sync_invitation('bbbbbbbb-0000-0000-0000-000000000801','cccccccc-0000-0000-0000-000000000801');
  insert into _v values('re-inviting a verified patient is refused (revoke first)', false, 'no error');
exception when others then
  insert into _v values('re-inviting a verified patient is refused (revoke first)', sqlstate='22023', sqlstate);
end $$;
do $$
declare _r jsonb;
begin
  _r := public.create_sync_invitation('bbbbbbbb-0000-0000-0000-000000000801','cccccccc-0000-0000-0000-000000000803');
  insert into _ids values('tok3', _r->>'token');
end $$;
update public.patient_sync_invitations set expires_at = now() - interval '1 minute'
where token_hash = private.sha256_hex((select v from _ids where k='tok3'));
do $$ begin
  perform public.verify_sync_invitation((select v from _ids where k='tok3'), 'alp-subject-2');
  insert into _v values('an expired token is refused', false, 'no error');
exception when others then
  insert into _v values('an expired token is refused', sqlstate='22023', sqlstate);
end $$;
do $$
declare _r jsonb;
begin
  _r := public.create_sync_invitation('bbbbbbbb-0000-0000-0000-000000000801','cccccccc-0000-0000-0000-000000000803');
  insert into _ids values('tok4', _r->>'token');
end $$;
do $$ begin
  perform public.verify_sync_invitation((select v from _ids where k='tok4'), 'alp-subject-1');
  insert into _v values('a forged/reused external subject is refused', false, 'no error');
exception when others then
  insert into _v values('a forged/reused external subject is refused', sqlstate='23505', sqlstate);
end $$;

do $$ begin
  perform public.set_sync_consent_scope((select v from _ids where k='conn')::uuid,
    'appointments', true, null, null, null, 'in_person', 'self');
  insert into _v values('a consent grant requires the presented artifact + version', false, 'no error');
exception when others then
  insert into _v values('a consent grant requires the presented artifact + version', sqlstate='22023', sqlstate);
end $$;
do $$
declare _r jsonb;
begin
  _r := public.set_sync_consent_scope((select v from _ids where k='conn')::uuid,
    'appointments', true, 'ALP sync consent', 'v1', 'US-CA', 'in_person', 'self');
  insert into _v values('appointments scope granted with artifact/jurisdiction/method/authority',
    (_r->>'ok')::boolean and (select count(*)=1 from public.sync_consent_scopes
      where connection_id=(select v from _ids where k='conn')::uuid
        and scope='appointments' and status='granted' and artifact_version='v1'
        and jurisdiction='US-CA' and method='in_person' and representative_authority='self'), null);
  _r := public.set_sync_consent_scope((select v from _ids where k='conn')::uuid,
    'protocols_supplements', true, 'ALP sync consent', 'v1', 'US-CA', 'in_person', 'self');
  _r := public.set_sync_consent_scope((select v from _ids where k='conn')::uuid,
    'symptoms_adherence', true, 'ALP sync consent', 'v1', 'US-CA', 'in_person', 'self');
  _r := public.set_sync_consent_scope((select v from _ids where k='conn')::uuid,
    'appointments', true, 'ALP sync consent', 'v1', null, 'in_person', 'self');
  insert into _v values('re-granting an active scope is an honest no-op',
    (_r->>'alreadyApplied')::boolean, null);
  insert into _v values('research consent is fully separate from care scopes',
    not exists (select 1 from public.sync_consent_scopes
      where connection_id=(select v from _ids where k='conn')::uuid
        and scope='research_n_of_1'), null);
end $$;

do $$
declare _r jsonb;
begin
  _r := public.queue_sync_export((select v from _ids where k='conn')::uuid,
    'appointment_summary', 'dddddddd-0000-0000-0000-000000000801');
  insert into _v values('queueing fails closed without a provider (durable refusal)',
    (_r->>'ok')::boolean = false and _r->>'refusal' = 'provider_not_configured'
    and (_r->>'message') like '%AI Longevity Pro connection not configured%'
    and not exists (select 1 from public.sync_outbound_events
      where connection_id=(select v from _ids where k='conn')::uuid), null);
end $$;
do $$ begin
  perform public.claim_sync_outbound('bbbbbbbb-0000-0000-0000-000000000801', 10);
  insert into _v values('even the worker cannot claim without a provider', false, 'no error');
exception when others then
  insert into _v values('even the worker cannot claim without a provider', sqlstate='22023', sqlstate);
end $$;

-- The TEST provider connector: an operational database act, never an env flag.
insert into public.connectors(organization_id, provider, kind, scopes, sync_status)
values ('bbbbbbbb-0000-0000-0000-000000000801','alp_patient_sync','patient_sync','{}'::jsonb,'connected');

do $$
declare _r jsonb; _e record;
begin
  _r := public.queue_sync_export((select v from _ids where k='conn')::uuid,
    'appointment_summary', 'dddddddd-0000-0000-0000-000000000801');
  insert into _ids values('evt1', _r->>'eventId'), ('euid1', _r->>'eventUid');
  select * into _e from public.sync_outbound_events where id=(_r->>'eventId')::uuid;
  insert into _v values('queued envelope: server-built payload, hash, queued state, NO delivery claim',
    (_r->>'ok')::boolean and _e.state='queued' and _e.delivered_at is null
    and _e.acknowledged_at is null
    and _e.payload_hash = private.sha256_hex(_e.payload::text)
    and _e.payload->>'appointmentId' = 'dddddddd-0000-0000-0000-000000000801'
    and _e.scope = 'appointments' and _e.contract_version = 'patient-sync/1', _e.state);
  insert into _v values('resource ack projection starts pending',
    (select state='pending' from public.sync_resource_acks
     where connection_id=(select v from _ids where k='conn')::uuid
       and resource_type='appointment_summary'), null);
  insert into _v values('outbound cursor advanced',
    exists (select 1 from public.sync_cursors
     where connection_id=(select v from _ids where k='conn')::uuid
       and direction='outbound' and scope='appointments'), null);
  _r := public.queue_sync_export((select v from _ids where k='conn')::uuid,
    'appointment_summary', 'dddddddd-0000-0000-0000-000000000801');
  insert into _v values('re-queueing the same resource version is idempotent',
    (_r->>'alreadyQueued')::boolean, null);
end $$;
do $$ begin
  perform public.queue_sync_export((select v from _ids where k='conn')::uuid,
    'lab_summary', 'cccccccc-0000-0000-0000-000000000801');
  insert into _v values('an ungranted scope refuses the export', false, 'no error');
exception when others then
  insert into _v values('an ungranted scope refuses the export', sqlstate='42501', sqlstate);
end $$;
do $$ begin
  perform public.queue_sync_export((select v from _ids where k='conn')::uuid,
    'nutrition_plan', 'dddddddd-0000-0000-0000-000000000801');
  insert into _v values('nutrition has no live source: honest refusal', false, 'no error');
exception when others then
  insert into _v values('nutrition has no live source: honest refusal',
    sqlstate in ('42501','22023'), sqlstate);
end $$;
do $$ begin
  perform public.queue_sync_export((select v from _ids where k='conn')::uuid,
    'message', 'dddddddd-0000-0000-0000-000000000801');
  insert into _v values('only an outbox-accepted practitioner message can be exported', false, 'no error');
exception when others then
  insert into _v values('only an outbox-accepted practitioner message can be exported',
    sqlstate in ('42501','22023','P0002'), sqlstate);
end $$;
do $$ begin
  perform public.queue_sync_export((select v from _ids where k='conn')::uuid,
    'program_enrollment', 'dddddddd-0000-0000-0000-000000000899');
  insert into _v values('a nonexistent enrollment cannot be exported', false, 'no error');
exception when others then
  insert into _v values('a nonexistent enrollment cannot be exported',
    sqlstate in ('42501','P0002'), sqlstate);
end $$;
do $$
declare _r jsonb; _e record;
begin
  _r := public.claim_sync_outbound('bbbbbbbb-0000-0000-0000-000000000801', 10);
  select * into _e from public.sync_outbound_events where id=(select v from _ids where k='evt1')::uuid;
  insert into _v values('claim moves queued -> sending with an attempt row',
    jsonb_array_length(_r->'events') = 1 and _e.state='sending' and _e.attempts=1
    and exists (select 1 from public.sync_delivery_attempts
      where outbound_event_id=_e.id and attempt_no=1), _e.state);
end $$;
do $$
declare _r jsonb; _e record;
begin
  _r := public.record_sync_delivery((select v from _ids where k='euid1')::uuid, 'pe-1', 'delivered', now());
  select * into _e from public.sync_outbound_events where id=(select v from _ids where k='evt1')::uuid;
  insert into _v values('delivered ONLY via provider evidence',
    (_r->>'ok')::boolean and _e.state='delivered' and _e.delivered_at is not null, _e.state);
  _r := public.record_sync_delivery((select v from _ids where k='euid1')::uuid, 'pe-1', 'delivered', now());
  insert into _v values('a duplicate callback dedupes on provider event id',
    (_r->>'duplicate')::boolean, null);
  _r := public.record_sync_delivery((select v from _ids where k='euid1')::uuid, 'pe-2', 'acknowledged', now());
  select * into _e from public.sync_outbound_events where id=(select v from _ids where k='evt1')::uuid;
  insert into _v values('acknowledgment recorded with ack evidence id',
    _e.state='acknowledged' and _e.ack_provider_event_id='pe-2'
    and (select state='acknowledged' from public.sync_resource_acks
         where last_outbound_event_id=_e.id), _e.state);
  _r := public.record_sync_delivery((select v from _ids where k='euid1')::uuid, 'pe-3', 'delivered', now());
  select * into _e from public.sync_outbound_events where id=(select v from _ids where k='evt1')::uuid;
  insert into _v values('out-of-order late delivered never demotes an acknowledgment',
    _e.state='acknowledged', _e.state);
  _r := public.record_sync_delivery((select v from _ids where k='euid1')::uuid, 'pe-4', 'failed', now(), 'stale failure');
  select * into _e from public.sync_outbound_events where id=(select v from _ids where k='evt1')::uuid;
  insert into _v values('a stale failure after success records evidence but keeps state',
    (_r->>'staleEvidence')::boolean and _e.state='acknowledged', _e.state);
end $$;
do $$ begin
  perform public.record_sync_delivery((select v from _ids where k='euid1')::uuid,
    'pe-5', 'delivered', now() + interval '1 hour');
  insert into _v values('delivery evidence outside the timestamp window is refused', false, 'no error');
exception when others then
  insert into _v values('delivery evidence outside the timestamp window is refused', sqlstate='22023', sqlstate);
end $$;

do $$
declare _r jsonb; _e record;
begin
  _r := public.queue_sync_export((select v from _ids where k='conn')::uuid,
    'protocol_version', 'dddddddd-0000-0000-0000-000000000812');
  insert into _ids values('evt2', _r->>'eventId'), ('euid2', _r->>'eventUid');
  _r := public.claim_sync_outbound('bbbbbbbb-0000-0000-0000-000000000801', 10);
  _r := public.record_sync_delivery((select v from _ids where k='euid2')::uuid,
    'pe-10', 'failed', now(), 'transient provider error');
  select * into _e from public.sync_outbound_events where id=(select v from _ids where k='evt2')::uuid;
  insert into _v values('a failure below the threshold backs off with a bounded retry',
    _e.state='failed' and _e.next_retry_at > now() and _e.next_retry_at <= now() + interval '24 hours'
    and _e.last_error_safe='transient provider error', _e.state);
end $$;
select set_config('request.jwt.claims',
  '{"sub":"11111111-0000-0000-0000-000000000802","role":"authenticated"}', true);
do $$ begin
  perform public.retry_sync_event((select v from _ids where k='evt2')::uuid, 'ops retry');
  insert into _v values('staff cannot manually retry', false, 'no error');
exception when others then
  insert into _v values('staff cannot manually retry', sqlstate='42501', sqlstate);
end $$;
select set_config('request.jwt.claims',
  '{"sub":"11111111-0000-0000-0000-000000000801","role":"authenticated"}', true);
do $$ begin
  perform public.retry_sync_event((select v from _ids where k='evt2')::uuid, '  ');
  insert into _v values('manual retry requires a reason', false, 'no error');
exception when others then
  insert into _v values('manual retry requires a reason', sqlstate='22023', sqlstate);
end $$;
do $$
declare _r jsonb;
begin
  _r := public.retry_sync_event((select v from _ids where k='evt2')::uuid, 'provider outage resolved');
  insert into _v values('manual retry with reason requeues',
    (_r->>'ok')::boolean and (select state='queued' from public.sync_outbound_events
      where id=(select v from _ids where k='evt2')::uuid), null);
end $$;
update public.sync_outbound_events set attempts = 8
where id = (select v from _ids where k='evt2')::uuid;
do $$
declare _r jsonb; _e record;
begin
  _r := public.claim_sync_outbound('bbbbbbbb-0000-0000-0000-000000000801', 10);
  _r := public.record_sync_delivery((select v from _ids where k='euid2')::uuid,
    'pe-11', 'failed', now(), 'persistent provider error');
  select * into _e from public.sync_outbound_events where id=(select v from _ids where k='evt2')::uuid;
  insert into _v values('the attempt threshold dead-letters with a REAL review task',
    _e.state='dead_letter'
    and exists (select 1 from public.sync_dead_letters where outbound_event_id=_e.id)
    and exists (select 1 from public.review_queue_items
      where item_type='sync_review' and ref_id=_e.id and status='open' and priority='high'), _e.state);
  _r := public.retry_sync_event(_e.id, 'reviewed and safe to retry');
  insert into _v values('a dead-letter manual retry is recorded with reason + audit',
    (select retried_at is not null and retry_reason='reviewed and safe to retry'
     from public.sync_dead_letters where outbound_event_id=_e.id), null);
end $$;

do $$ begin
  perform public.record_sync_inbound((select v from _ids where k='conn')::uuid,
    'in-1', 'patient-sync/2', 'protocol_adherence',
    '{"took":true}'::jsonb, private.sha256_hex('{"took": true}'::jsonb::text), now());
  insert into _v values('an unsupported contract version is refused', false, 'no error');
exception when others then
  insert into _v values('an unsupported contract version is refused', sqlstate='22023', sqlstate);
end $$;
do $$ begin
  perform public.record_sync_inbound((select v from _ids where k='conn')::uuid,
    'in-1', 'patient-sync/1', 'protocol_adherence',
    '{"took":true}'::jsonb, 'not-the-hash', now());
  insert into _v values('a payload hash mismatch is refused', false, 'no error');
exception when others then
  insert into _v values('a payload hash mismatch is refused', sqlstate='22023', sqlstate);
end $$;
do $$
declare _p jsonb := '{"took": true, "itemRef": "supp-1"}'::jsonb;
begin
  perform public.record_sync_inbound((select v from _ids where k='conn')::uuid,
    'in-1', 'patient-sync/1', 'supplement_adherence',
    _p, private.sha256_hex(_p::text), now() + interval '1 hour');
  insert into _v values('an inbound timestamp outside the window is refused', false, 'no error');
exception when others then
  insert into _v values('an inbound timestamp outside the window is refused', sqlstate='22023', sqlstate);
end $$;
do $$
declare _p jsonb := '{"steps": 9000}'::jsonb;
begin
  perform public.record_sync_inbound((select v from _ids where k='conn')::uuid,
    'in-2', 'patient-sync/1', 'wearable_summary',
    _p, private.sha256_hex(_p::text), now());
  insert into _v values('inbound data for an ungranted scope is refused without storing it', false, 'no error');
exception when others then
  insert into _v values('inbound data for an ungranted scope is refused without storing it',
    sqlstate='42501' and not exists (select 1 from public.sync_inbound_events
      where connection_id=(select v from _ids where k='conn')::uuid
        and resource_type='wearable_summary'), sqlstate);
end $$;
do $$
declare _p jsonb := '{"adherence": "took all doses", "day": "2026-07-29"}'::jsonb; _r jsonb;
begin
  _r := public.record_sync_inbound((select v from _ids where k='conn')::uuid,
    'in-3', 'patient-sync/1', 'supplement_adherence',
    _p, private.sha256_hex(_p::text), now(), 'adh-day-1', '2');
  insert into _ids values('inb1', _r->>'eventId');
  insert into _v values('adherence ingests idempotently as the authoritative original',
    (_r->>'ok')::boolean and _r->>'state'='processed', _r->>'state');
  _r := public.record_sync_inbound((select v from _ids where k='conn')::uuid,
    'in-3', 'patient-sync/1', 'supplement_adherence',
    _p, private.sha256_hex(_p::text), now(), 'adh-day-1', '2');
  insert into _v values('an inbound replay is refused as a duplicate',
    (_r->>'duplicate')::boolean, null);
end $$;
do $$
declare _p jsonb := '{"adherence": "missed morning dose", "day": "2026-07-28"}'::jsonb; _r jsonb;
begin
  _r := public.record_sync_inbound((select v from _ids where k='conn')::uuid,
    'in-4', 'patient-sync/1', 'supplement_adherence',
    _p, private.sha256_hex(_p::text), now(), 'adh-day-1', '1');
  insert into _v values('a stale out-of-order version becomes an explicit conflict, never a silent merge',
    _r->>'state'='conflict'
    and exists (select 1 from public.sync_conflicts
      where inbound_event_id=(_r->>'eventId')::uuid and state='open'), _r->>'state');
  insert into _ids values('conf1', (select id::text from public.sync_conflicts
    where inbound_event_id=(_r->>'eventId')::uuid));
end $$;
do $$
declare _p jsonb := '{"symptom": "crushing chest pain since this morning"}'::jsonb; _r jsonb;
begin
  _r := public.record_sync_inbound((select v from _ids where k='conn')::uuid,
    'in-5', 'patient-sync/1', 'symptom_report',
    _p, private.sha256_hex(_p::text), now());
  insert into _ids values('inb2', _r->>'eventId');
  insert into _v values('urgent language in an inbound symptom escalates to high-priority human review',
    _r->>'state'='review_pending' and (_r->>'urgent')::boolean
    and exists (select 1 from public.review_queue_items
      where item_type='sync_review' and ref_id=(_r->>'eventId')::uuid and priority='high'), _r->>'state');
end $$;
do $$ begin
  update public.sync_inbound_events set payload='{"tampered":true}'::jsonb
  where id=(select v from _ids where k='inb1')::uuid;
  insert into _v values('an original inbound submission cannot be mutated', false, 'no error');
exception when others then
  insert into _v values('an original inbound submission cannot be mutated', sqlstate='42501', sqlstate);
end $$;
do $$ begin
  delete from public.sync_outbound_events where id=(select v from _ids where k='evt1')::uuid;
  insert into _v values('outbound sync events cannot be deleted', false, 'no error');
exception when others then
  insert into _v values('outbound sync events cannot be deleted', sqlstate='42501', sqlstate);
end $$;
do $$
declare _r jsonb;
begin
  _r := public.record_sync_inbound_correction((select v from _ids where k='inb1')::uuid,
    '{"adherence": "took all doses EXCEPT omega-3 (patient clarified by phone)"}'::jsonb,
    'patient phoned a correction');
  insert into _v values('a correction is a versioned overlay; the original is untouched',
    (_r->>'version')::int = 1
    and (select payload->>'adherence' from public.sync_inbound_events
         where id=(select v from _ids where k='inb1')::uuid) = 'took all doses', null);
  _r := public.record_sync_inbound_correction((select v from _ids where k='inb1')::uuid,
    '{"adherence": "final: all doses taken"}'::jsonb, 'second clarification');
  insert into _v values('correction overlays version forward', (_r->>'version')::int = 2, null);
end $$;
do $$ begin
  perform public.resolve_sync_conflict((select v from _ids where k='conf1')::uuid,
    'resolved_manual', 'checked with patient', 99);
  insert into _v values('conflict resolution enforces optimistic concurrency', false, 'no error');
exception when others then
  insert into _v values('conflict resolution enforces optimistic concurrency', sqlstate='40001', sqlstate);
end $$;
do $$ begin
  perform public.resolve_sync_conflict((select v from _ids where k='conf1')::uuid,
    'resolved_manual', '  ', 1);
  insert into _v values('conflict resolution requires a note', false, 'no error');
exception when others then
  insert into _v values('conflict resolution requires a note', sqlstate='22023', sqlstate);
end $$;
do $$
declare _r jsonb;
begin
  _r := public.resolve_sync_conflict((select v from _ids where k='conf1')::uuid,
    'resolved_keep_desktop', 'newer submission already recorded; stale one set aside', 1);
  insert into _v values('a conflict resolves without overwriting either original',
    (_r->>'ok')::boolean
    and (select state='resolved_keep_desktop' from public.sync_conflicts
         where id=(select v from _ids where k='conf1')::uuid)
    and (select payload->>'adherence' from public.sync_inbound_events
         where external_resource_id='adh-day-1' and resource_version='1') = 'missed morning dose'
    and (select status='resolved' from public.review_queue_items
         where item_type='sync_review' and ref_id=(select v from _ids where k='conf1')::uuid), null);
end $$;
do $$
declare _r jsonb;
begin
  _r := public.review_sync_inbound((select v from _ids where k='inb2')::uuid, 'accept', 'triaged by phone');
  insert into _v values('practitioner review settles a pending inbound item and its task',
    (_r->>'ok')::boolean
    and (select state='processed' from public.sync_inbound_events
         where id=(select v from _ids where k='inb2')::uuid)
    and (select status='resolved' from public.review_queue_items
         where item_type='sync_review' and ref_id=(select v from _ids where k='inb2')::uuid), null);
end $$;
do $$
declare _p jsonb; _r jsonb; _e record;
begin
  _p := jsonb_build_object('eventUid', (select v from _ids where k='euid2'));
  _r := public.record_sync_inbound((select v from _ids where k='conn')::uuid,
    'in-6', 'patient-sync/1', 'delivery_receipt',
    _p, private.sha256_hex(_p::text), now());
  select * into _e from public.sync_outbound_events where id=(select v from _ids where k='evt2')::uuid;
  insert into _v values('a delivery receipt projects provider evidence onto the outbound event',
    (_r->>'ok')::boolean and _e.state='delivered', _e.state);
end $$;
do $$
declare _p jsonb := '{"scope": "appointments", "action": "revoke"}'::jsonb; _r jsonb;
begin
  _r := public.record_sync_inbound((select v from _ids where k='conn')::uuid,
    'in-7', 'patient-sync/1', 'consent_change',
    _p, private.sha256_hex(_p::text), now());
  insert into _v values('a patient-app revocation applies immediately (newest revocation wins)',
    (select status='revoked' and revoke_source='patient_app'
     from public.sync_consent_scopes
     where connection_id=(select v from _ids where k='conn')::uuid
       and scope='appointments' order by version desc limit 1), null);
end $$;
do $$ begin
  perform public.queue_sync_export((select v from _ids where k='conn')::uuid,
    'appointment_summary', 'dddddddd-0000-0000-0000-000000000801');
  insert into _v values('the revoked scope stops syncing', false, 'no error');
exception when others then
  insert into _v values('the revoked scope stops syncing', sqlstate='42501', sqlstate);
end $$;
do $$
declare _r jsonb;
begin
  _r := public.queue_sync_export((select v from _ids where k='conn')::uuid,
    'protocol_version', 'dddddddd-0000-0000-0000-000000000812');
  insert into _v values('other scopes continue after a single-scope revocation',
    (_r->>'ok')::boolean, _r->>'message');
end $$;
do $$
declare _r jsonb;
begin
  _r := public.withdraw_sync_resource((select v from _ids where k='conn')::uuid,
    'protocol_version', 'dddddddd-0000-0000-0000-000000000812', 'superseded by an in-person plan');
  insert into _v values('withdrawal queues a withdrawal event and stops the resource',
    (_r->>'ok')::boolean
    and (select state='withdrawn' from public.sync_resource_acks
         where connection_id=(select v from _ids where k='conn')::uuid
           and resource_type='protocol_version')
    and exists (select 1 from public.sync_outbound_events
         where connection_id=(select v from _ids where k='conn')::uuid
           and resource_type='resource_withdrawal' and state='queued'), null);
  _r := public.withdraw_sync_resource((select v from _ids where k='conn')::uuid,
    'protocol_version', 'dddddddd-0000-0000-0000-000000000812', 'again');
  insert into _v values('withdrawal is idempotent', (_r->>'alreadyApplied')::boolean, null);
end $$;
do $$ begin
  perform public.pause_sync_connection((select v from _ids where k='conn')::uuid, 999);
  insert into _v values('pause enforces optimistic concurrency', false, 'no error');
exception when others then
  insert into _v values('pause enforces optimistic concurrency', sqlstate='40001', sqlstate);
end $$;
do $$
declare _r jsonb; _ver int;
begin
  select version into _ver from public.patient_app_connections
  where id=(select v from _ids where k='conn')::uuid;
  _r := public.pause_sync_connection((select v from _ids where k='conn')::uuid, _ver);
  insert into _v values('a verified connection pauses', _r->>'state'='paused', null);
end $$;
do $$
declare _p jsonb := '{"steps": 100}'::jsonb;
begin
  perform public.record_sync_inbound((select v from _ids where k='conn')::uuid,
    'in-8', 'patient-sync/1', 'supplement_adherence',
    _p, private.sha256_hex(_p::text), now());
  insert into _v values('a paused connection holds inbound writes', false, 'no error');
exception when others then
  insert into _v values('a paused connection holds inbound writes', sqlstate='22023', sqlstate);
end $$;
do $$ begin
  perform public.queue_sync_export((select v from _ids where k='conn')::uuid,
    'protocol_version', 'dddddddd-0000-0000-0000-000000000812');
  insert into _v values('a paused connection refuses exports', false, 'no error');
exception when others then
  insert into _v values('a paused connection refuses exports', sqlstate='22023', sqlstate);
end $$;
do $$
declare _r jsonb; _ver int;
begin
  select version into _ver from public.patient_app_connections
  where id=(select v from _ids where k='conn')::uuid;
  _r := public.resume_sync_connection((select v from _ids where k='conn')::uuid, _ver);
  insert into _v values('a paused connection resumes', _r->>'state'='verified', null);
end $$;
do $$ begin
  perform public.revoke_sync_connection((select v from _ids where k='conn')::uuid,
    (select version from public.patient_app_connections where id=(select v from _ids where k='conn')::uuid), '  ');
  insert into _v values('revocation requires a reason', false, 'no error');
exception when others then
  insert into _v values('revocation requires a reason', sqlstate='22023', sqlstate);
end $$;
do $$
declare _r jsonb; _ver int;
begin
  select version into _ver from public.patient_app_connections
  where id=(select v from _ids where k='conn')::uuid;
  _r := public.revoke_sync_connection((select v from _ids where k='conn')::uuid, _ver,
    'patient asked to disconnect the app');
  insert into _v values('revocation cancels undelivered exports and blocks the connection',
    _r->>'state'='revoked'
    and not exists (select 1 from public.sync_outbound_events
      where connection_id=(select v from _ids where k='conn')::uuid
        and state in ('queued','sending','failed')), null);
end $$;
do $$
declare _p jsonb := '{"steps": 100}'::jsonb;
begin
  perform public.record_sync_inbound((select v from _ids where k='conn')::uuid,
    'in-9', 'patient-sync/1', 'supplement_adherence',
    _p, private.sha256_hex(_p::text), now());
  insert into _v values('a revoked connection blocks inbound writes immediately', false, 'no error');
exception when others then
  insert into _v values('a revoked connection blocks inbound writes immediately', sqlstate='42501', sqlstate);
end $$;
do $$
declare _r jsonb;
begin
  _r := public.create_sync_invitation('bbbbbbbb-0000-0000-0000-000000000801','cccccccc-0000-0000-0000-000000000801');
  insert into _v values('re-linking after revocation requires a NEW explicit invitation + connection',
    (_r->>'ok')::boolean and _r->>'connectionId' <> (select v from _ids where k='conn'), null);
end $$;
insert into _v
select 'the sync flow created no note, message, protocol, appointment, enrollment, or conversation',
  (select v from _base where k='notes') = (select count(*) from public.clinical_notes)
  and (select v from _base where k='messages') = (select count(*) from public.messages)
  and (select v from _base where k='protocols') = (select count(*) from public.protocols)
  and (select v from _base where k='appointments') = (select count(*) from public.appointments)
  and (select v from _base where k='enrollments') = (select count(*) from public.program_enrollments)
  and (select v from _base where k='conversations') = (select count(*) from public.conversations), null;

select name, passed, detail from _v order by name;
rollback;

-- Zero-residue check (runs OUTSIDE the rolled-back transaction above).
select 'zero rollback residue' as check, count(*) = 0 as clean from (
  select id from public.organizations
    where id in ('bbbbbbbb-0000-0000-0000-000000000801','bbbbbbbb-0000-0000-0000-000000000802')
  union all
  select id from public.patient_app_connections
    where organization_id in ('bbbbbbbb-0000-0000-0000-000000000801','bbbbbbbb-0000-0000-0000-000000000802')
  union all
  select id from public.connectors
    where organization_id = 'bbbbbbbb-0000-0000-0000-000000000801'
  union all
  select id from public.review_queue_items where item_type = 'sync_review'
) residue;
