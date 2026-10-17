-- UNREGISTERED, BLOCKED source candidate (care-connections-patient-withdrawal-clinic-status). Applied nowhere,
-- registered in no manifest; no route, role or Lambda depends on it. Nothing switches it on: the deployed care-connections
-- service binds every function body by digest (care-connections-database-binding.ts), so this successor serves only with
-- a reviewed care-connections deployment that carries its digest, and until then the deployed service refuses every
-- action as service_unavailable rather than run a body it was not built for. That release unit is Codex work after
-- review (docs/clinic-continuity-release-map-2026-10-17.md).
--
-- Parent: the deployed clinical_core.production_care_connection_request(jsonb) of 20261006020000_production_care_connections
-- (prosrc SHA-256 1a0712788bb5ad19b098bb288eb11df9fcfa9833ba4f1cda808b1585e92366ea), with clinical_private.care_connection_actor(text,text) unchanged
-- (prosrc SHA-256 9948892ba79f9848ef66cf9e1cc403a38f55b8735f58b3535c760dfb2c6aed93). Nothing else in the 106-migration schema or in the BLOCKED workforce chain
-- (emergency revocation, ordinary-suspension window, consent-decision, grant paths) redefines either function, so this
-- file sits on any of them in any order.
-- Rollback: care-connections-patient-withdrawal-clinic-status-rollback.sql (restores the parent's body byte for byte and
-- keeps every consent row).
--
-- The owner's rule for a suspended clinic: new practitioner consent grants are blocked, withdrawals remain possible, and
-- the patient's own withdrawal stays open (docs/suspended-clinic-custody-2026-10-16.md, D2(B), "the patient's own
-- withdrawal stays open" in both alternatives). The care-connections contract states the same for an archived chart:
-- "New grants refuse paused/revoked links, archived charts and account-deletion fences; status and withdrawal remain
-- available" (docs/care-connections-source-candidate.md). As deployed, care_connection_actor refuses every consumer
-- action when organizations.status is not 'active', so in a suspended or archived clinic the patient can neither read
-- their own consent status nor withdraw it through this route
-- (care-connections-patient-withdrawal.database.test.ts, failing before on the deployed schema and on the full chain).
--
-- The change, and nothing more: for the consumer actions 'consent' (the patient's own status) and 'withdraw', the actor
-- is resolved with care_connection_actor's own identity checks minus its clinic-status clause. 'grant', 'claim',
-- 'connection' and workforce 'issue' are unchanged, so a closed clinic still admits no new link, no new grant and no
-- connection lookup. care_connection_actor itself is unchanged, so the clinic-records dispatcher (patient copies, D5)
-- and invitation issuance keep refusing in a closed clinic: this file decides nothing about D3, D4 or D5, clinic
-- amendment, guardian access or reactivation. Signature, owner, SECURITY DEFINER, search_path, volatility and grants are
-- kept. No lock is added: a withdrawal locks the connection row as before and never reads the clinic row's status.

begin;

do $guard$
declare _request regprocedure := to_regprocedure('clinical_core.production_care_connection_request(jsonb)');
  _actor regprocedure := to_regprocedure('clinical_private.care_connection_actor(text,text)');
  _p record;
begin
  if _request is null or _actor is null then
    raise exception using errcode = '55000', message = 'care_connection_patient_withdrawal_parent_refused';
  end if;
  select p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) as owner, encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') as body
    into _p from pg_proc p where p.oid = _request;
  if not _p.prosecdef or _p.proconfig is distinct from array['search_path=""'] or _p.owner <> current_user
    or _p.body <> '1a0712788bb5ad19b098bb288eb11df9fcfa9833ba4f1cda808b1585e92366ea'
    or (select encode(sha256(convert_to(prosrc, 'UTF8')), 'hex') from pg_proc where oid = _actor) <> '9948892ba79f9848ef66cf9e1cc403a38f55b8735f58b3535c760dfb2c6aed93' then
    raise exception using errcode = '55000', message = 'care_connection_patient_withdrawal_parent_refused';
  end if;
end
$guard$;

create or replace function clinical_core.production_care_connection_request(_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _action text:=_request->>'action'; _actor uuid; _org uuid:=clinical_private.organization_id();
  _c clinical_core.patient_connections; _i clinical_core.connection_invitations; _a clinical_core.consent_artifacts;
  _g clinical_core.consent_grants; _copy text; _token text; _scope text; _expected integer; _grant_id uuid;
  _keys text[]; _state text;
begin
  if jsonb_typeof(_request) is distinct from 'object' or _action is null or octet_length(_request::text)>22000 then
    raise exception using errcode='22023',message='care_connection_invalid'; end if;
  _keys:=case _action when 'issue' then array['action','patientRecordId'] when 'claim' then array['action','token']
    when 'connection' then array['action'] when 'consent' then array['action','connectionId','scope']
    when 'grant' then array['action','connectionId','scope','artifactId','contentSha256','expectedVersion']
    when 'withdraw' then array['action','connectionId','scope','expectedVersion'] else null end;
  if _keys is null or exists(select 1 from jsonb_object_keys(_request) k where not(k=any(_keys)))
    or exists(select 1 from unnest(_keys) k where not(_request ? k)) then
    raise exception using errcode='22023',message='care_connection_invalid'; end if;
  -- The SQL dispatcher is also a boundary: callers with execute privilege must
  -- not bypass the application schema using JSON nulls or coerced scalar types.
  if jsonb_typeof(_request->'action') is distinct from 'string'
    or exists(select 1 from unnest(array['patientRecordId','connectionId','artifactId']) k
      where _request ? k and (jsonb_typeof(_request->k) is distinct from 'string'
        or (_request->>k) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
    or (_request ? 'scope' and jsonb_typeof(_request->'scope') is distinct from 'string')
    or (_request ? 'contentSha256' and (jsonb_typeof(_request->'contentSha256') is distinct from 'string'
      or (_request->>'contentSha256') !~ '^[a-f0-9]{64}$')) then
    raise exception using errcode='22023',message='care_connection_invalid'; end if;
  if _action='issue' then
    return clinical_core.create_sync_invitation(_org,(_request->>'patientRecordId')::uuid);
  end if;
  -- care-connections-patient-withdrawal-clinic-status (BLOCKED): the patient's own consent status and withdrawal do
  -- not depend on the clinic's status. A suspended or archived clinic is treated as this contract already treats an
  -- archived chart: no new link, no new grant, no connection lookup, but status and withdrawal remain available. The
  -- identity checks are care_connection_actor's, every one, without its organizations.status clause; every other
  -- consumer action keeps care_connection_actor unchanged.
  if _action in ('consent','withdraw') then
    _actor:=clinical_private.actor_person_id();
    if _actor is null or _org is null
      or clinical_private.claim('identity_pool') is distinct from 'consumer'
      or clinical_private.claim('purpose') is distinct from 'consent_management'
      or clinical_private.claim('environment') is distinct from 'production-clinical'
      or clinical_private.claim('data_classification') is distinct from 'clinical_phi'
      or not exists(select 1 from clinical_core.identities i join clinical_core.persons p on p.id=i.person_id
        where i.person_id=_actor and i.identity_pool='consumer' and i.identity_subject=clinical_private.claim('identity_subject')
          and i.production_bound and i.status='active' and p.status='active')
      or not exists(select 1 from clinical_core.organizations where id=_org) then
      raise exception using errcode='42501',message='care_connection_refused';
    end if;
  else
    _actor:=clinical_private.care_connection_actor('consumer',case when _action='claim' then 'identity_link' else 'consent_management' end);
  end if;
  if _action='connection' then
    select c.* into _c from clinical_core.patient_connections c join clinical_core.patient_records p on p.id=c.patient_record_id
      where c.organization_id=_org and c.consumer_person_id=_actor and c.state in ('verified','paused') and p.status='active';
    if _c.id is null then return jsonb_build_object('connection',null); end if;
    return jsonb_build_object('connection',jsonb_build_object('connectionId',_c.id,'patientRecordId',_c.patient_record_id,
      'state',_c.state,'verifiedAt',_c.verified_at,'version',_c.version));
  end if;
  if _action='claim' then
    if jsonb_typeof(_request->'token') is distinct from 'string' then
      raise exception using errcode='22023',message='care_connection_invalid'; end if;
    _token:=upper(replace(btrim(_request->>'token'),'-',''));
    if _token !~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{13}$' then
      raise exception using errcode='22023',message='care_connection_invalid'; end if;
    select * into _i from clinical_core.connection_invitations where organization_id=_org
      and token_hash=encode(public.digest(_token,'sha256'),'hex');
    if _i.id is null then raise exception using errcode='42501',message='care_connection_refused'; end if;
    -- Admission locks the chart before the connection, matching issuance. A
    -- concurrently archived chart must not become a newly admitted link.
    perform 1 from clinical_core.patient_records where id=_i.patient_record_id
      and organization_id=_org and status='active' for share;
    if not found then raise exception using errcode='42501',message='care_connection_refused'; end if;
    select * into _c from clinical_core.patient_connections where id=_i.connection_id for update;
    -- Same connection-then-owner lock order as messaging and withdrawal.
    perform clinical_private.assert_owned_storage_writable(_actor);
    select * into _i from clinical_core.connection_invitations where id=_i.id for update;
    if _i.status<>'pending' or _i.expires_at<=clock_timestamp() or _c.state<>'invitation_pending'
      or _c.consumer_person_id is not null or not exists(select 1 from clinical_core.patient_records
        where id=_c.patient_record_id and organization_id=_org and status='active') then
      raise exception using errcode='42501',message='care_connection_refused'; end if;
    if exists(select 1 from clinical_core.patient_connections where consumer_person_id=_actor and state<>'revoked') then
      raise exception using errcode='40001',message='care_connection_conflict'; end if;
    update clinical_core.patient_connections set consumer_person_id=_actor,state='verified',verified_at=clock_timestamp(),
      updated_at=clock_timestamp(),version=version+1 where id=_c.id returning * into _c;
    update clinical_core.connection_invitations set status='accepted',used_at=clock_timestamp() where id=_i.id;
    update clinical_core.connection_invitations set status='superseded' where connection_id=_c.id and status='pending';
    insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,purpose,safe_metadata)
      values(_org,_actor,'connection.invitation_claimed','connection',_c.id,'identity_link',jsonb_build_object('invitation_id',_i.id));
    return jsonb_build_object('connectionId',_c.id,'patientRecordId',_c.patient_record_id,'state',_c.state,
      'verifiedAt',_c.verified_at,'version',_c.version);
  end if;
  _scope:=_request->>'scope';
  if _scope is null or _scope not in ('programs','protocols_supplements','nutrition','appointments','messaging',
    'forms_checkins','symptoms_adherence','wearables','reproductive_health','lab_summaries','lab_results_import',
    'lab_specimen_context','billing_links','research_n_of_1') then
    raise exception using errcode='22023',message='care_connection_invalid'; end if;
  if _action='grant' then
    perform 1 from clinical_core.patient_records p join clinical_core.patient_connections c on c.patient_record_id=p.id
      where c.id=(_request->>'connectionId')::uuid and c.organization_id=_org and c.consumer_person_id=_actor
        and p.organization_id=_org and p.status='active' for share of p;
    if not found then raise exception using errcode='42501',message='care_connection_refused'; end if;
  end if;
  select * into _c from clinical_core.patient_connections where id=(_request->>'connectionId')::uuid
    and organization_id=_org and consumer_person_id=_actor and state<>'invitation_pending' for update;
  if _c.id is null then raise exception using errcode='42501',message='care_connection_refused'; end if;
  select * into _g from clinical_core.consent_grants where connection_id=_c.id and scope=_scope order by version desc limit 1;
  if _action='consent' then
    _state:=coalesce(_g.status,'not_granted');
    -- Withdrawal/status remains available when a release is removed or the link revoked.
    begin
      _a:=clinical_private.care_connection_artifact(_scope);
      select content into _copy from clinical_core.care_consent_texts where artifact_id=_a.id;
    exception when sqlstate '42501' then _a:=null; _copy:=null; end;
    return jsonb_build_object('connectionId',_c.id,'connectionState',_c.state,'scope',_scope,'status',_state,
      'version',coalesce(_g.version,0),'currentArtifactId',_g.artifact_id,'artifact',case when _a.id is null then null else
      jsonb_build_object('artifactId',_a.id,'artifactVersion',_a.artifact_version,'contentSha256',_a.content_sha256,
        'jurisdiction',_a.jurisdiction,'approvedAt',_a.approved_at,'content',_copy) end);
  end if;
  if jsonb_typeof(_request->'expectedVersion') is distinct from 'number'
    or (_request->>'expectedVersion') !~ '^(0|[1-9][0-9]{0,8})$' then
    raise exception using errcode='22023',message='care_connection_invalid'; end if;
  _expected:=(_request->>'expectedVersion')::integer;
  if _action='grant' then
    if _c.state<>'verified' then raise exception using errcode='42501',message='care_connection_refused'; end if;
    perform clinical_private.assert_owned_storage_writable(_actor);
    _a:=clinical_private.care_connection_artifact(_scope);
    if _a.id is distinct from (_request->>'artifactId')::uuid or _a.content_sha256 is distinct from (_request->>'contentSha256') then
      raise exception using errcode='40001',message='care_connection_conflict'; end if;
    if _g.status='granted' and _g.artifact_id=_a.id and _g.recorded_by_person_id=_actor
      and _g.method='patient_app' and _g.representative_authority='self' and _g.version in (_expected,_expected+1) then
      return jsonb_build_object('connectionId',_c.id,'scope',_scope,'status','granted','version',_g.version,'alreadyApplied',true);
    end if;
    if _g.status='granted' or coalesce(_g.version,0)<>_expected then
      raise exception using errcode='40001',message='care_connection_conflict'; end if;
    insert into clinical_core.consent_grants(organization_id,patient_record_id,connection_id,artifact_id,scope,status,
      method,representative_authority,version,recorded_by_person_id)
      values(_org,_c.patient_record_id,_c.id,_a.id,_scope,'granted','patient_app','self',_expected+1,_actor) returning id into _grant_id;
  else
    -- No new sharing and no erasure claim: withdrawal is allowed even during deletion.
    if (_g.id is null and _expected=0) or (_g.status='revoked' and _g.version in (_expected,_expected+1)) then
      return jsonb_build_object('connectionId',_c.id,'scope',_scope,'status',coalesce(_g.status,'not_granted'),
        'version',coalesce(_g.version,0),'alreadyApplied',true);
    end if;
    if coalesce(_g.version,0)<>_expected then raise exception using errcode='40001',message='care_connection_conflict'; end if;
    insert into clinical_core.consent_grants(organization_id,patient_record_id,connection_id,scope,status,method,
      representative_authority,reason_code,version,recorded_by_person_id)
      values(_org,_c.patient_record_id,_c.id,_scope,'revoked','patient_app','self','patient_request',_expected+1,_actor) returning id into _grant_id;
  end if;
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,purpose,safe_metadata)
    values(_org,_actor,case when _action='grant' then 'consent.granted' else 'consent.revoked' end,'consent',_grant_id,
      'consent_management',jsonb_build_object('scope',_scope,'version',_expected+1));
  return jsonb_build_object('connectionId',_c.id,'scope',_scope,'status',case when _action='grant' then 'granted' else 'revoked' end,
    'version',_expected+1,'alreadyApplied',false);
end $$;

do $check$
declare _request regprocedure := to_regprocedure('clinical_core.production_care_connection_request(jsonb)');
  _actor regprocedure := to_regprocedure('clinical_private.care_connection_actor(text,text)');
  _p record;
begin
  select p.prosecdef, p.proconfig, p.provolatile, pg_get_userbyid(p.proowner) as owner,
      encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') as body
    into _p from pg_proc p where p.oid = _request;
  if _p.body is distinct from 'f1658585b2b3c66c4ba959c9aeff8242042be6159d30bf6202793c7b982a4b95' or not _p.prosecdef or _p.proconfig is distinct from array['search_path=""']
    or _p.provolatile <> 'v' or _p.owner <> current_user
    or (select encode(sha256(convert_to(prosrc, 'UTF8')), 'hex') from pg_proc where oid = _actor) is distinct from '9948892ba79f9848ef66cf9e1cc403a38f55b8735f58b3535c760dfb2c6aed93'
    or not has_function_privilege('clinical_core_api', _request, 'EXECUTE')
    or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where p.oid = _request and a.grantee = 0)
    or has_function_privilege('clinical_core_api', _actor, 'EXECUTE') then
    raise exception using errcode = '55000', message = 'care_connection_patient_withdrawal_successor_refused';
  end if;
end
$check$;

commit;
