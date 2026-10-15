-- Rollback for qualification-program-boundary.sql (BLOCKED; applied nowhere). Restores the three parent definitions
-- exactly as production-program-assignments.sql (SHA-256 78bd5b3805d96443829f6e7380deba0d66ad2f03073374bd6681f4f6bc25b4f3) and production-program-consumer-boundary.sql
-- (SHA-256 ca0ce5a62e68638c7c29bd114018344c2755da946d1785f849e11088f8e1122d) create them, then drops only what the successor created. create or replace keeps every grant.
-- No program, enrollment, review, completion or audit row is touched: the successor wrote none.

create or replace function clinical_core.production_program_assignment_request(_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 _actor uuid:=clinical_private.actor_person_id(); _org uuid:=clinical_private.organization_id();
 _pool text:=clinical_private.claim('identity_pool'); _action text:=_request->>'action';
 _connection clinical_core.patient_connections%rowtype; _row clinical_core.program_assignments%rowtype;
 _version clinical_core.program_versions%rowtype;
 _inventory jsonb; _review jsonb; _phase jsonb; _items jsonb; _digest text; _now timestamptz:=clock_timestamp();
 _expected bigint; _elapsed interval; _authorized boolean;
begin
 if not exists(select 1 from clinical_core.production_program_activation where singleton and enabled) then
  raise exception using errcode='42501',message='production_program_disabled'; end if;
 if _actor is null or _org is null or _pool is null or _pool not in('consumer','workforce')
 or clinical_private.claim('purpose') is distinct from 'clinical_data'
 or clinical_private.claim('environment') is distinct from 'production-clinical'
 or clinical_private.claim('data_classification') is distinct from 'clinical_phi'
 or not exists(select 1 from clinical_core.identities i join clinical_core.persons p on p.id=i.person_id
  where i.person_id=_actor and i.identity_pool=_pool and i.identity_subject=clinical_private.claim('identity_subject')
  and i.production_bound and i.status='active' and p.status='active')
 or not exists(select 1 from clinical_core.organizations where id=_org and status='active')
 or (_pool='workforce' and not clinical_private.has_clinical_role(_org)) then
  raise exception using errcode='42501',message='program_assignment_refused'; end if;
 if _request is null or jsonb_typeof(_request)<>'object' or octet_length(_request::text)>262144
 or _action is null or _action not in('list','read','accept','complete','check_in','advance','pause','resume','withdraw','assign','status','release','connections','programs','preview') then
  raise exception using errcode='22023',message='program_assignment_invalid'; end if;
 if (_action in('assign','status','release','connections','programs','preview')) <> (_pool='workforce') then
  raise exception using errcode='42501',message='program_assignment_refused'; end if;
 -- A consumer acting on a program is acting on their supplement plan; the storage consent that
 -- covers that scope must be granted now, not merely once.
 if _pool='consumer' and clinical_private.owned_consumer_consent(_actor,'protocols_supplements') is null then
  raise exception using errcode='42501',message='consumer_storage_consent_required'; end if;

 if _action in('assign','preview') then
  if _request-array['action','connectionId','programVersionId']<>'{}'::jsonb
  or (_request->>'programVersionId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  or (_action='assign') <> (_request ? 'connectionId')
  or (_request ? 'connectionId' and (_request->>'connectionId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
   raise exception using errcode='22023',message='program_assignment_invalid'; end if;
  select * into _version from clinical_core.program_versions
  where id=(_request->>'programVersionId')::uuid and organization_id=_org;
  if _version.id is null or _version.status<>'published' then
   raise exception using errcode='42501',message='program_assignment_unpublished'; end if;
  _items:=clinical_private.production_program_consumer_content(_version.content);
  if _items is null then raise exception using errcode='42501',message='program_assignment_unpublished'; end if;
  _digest:=encode(public.digest(convert_to(_items::text,'UTF8'),'sha256'),'hex');
  if _action='preview' then
   _inventory:=clinical_private.production_program_plan_inventory(null);
   _review:=clinical_private.production_program_review(_items->'phases',_inventory,null);
   insert into clinical_core.program_assignment_audit(actor_id,organization_id,action) values(_actor,_org,'status');
   return jsonb_build_object('action','preview','programVersionId',_version.id,
    'programVersion',_version.version::text,'title',_items->>'title','phases',_items->'phases',
    'sourceDigest',_digest,'review',_review);
  end if;
  select * into _connection from clinical_core.patient_connections where id=(_request->>'connectionId')::uuid for update;
  if _connection.id is null or _connection.organization_id<>_org or _connection.state<>'verified'
  or _connection.consumer_person_id is null
  or not exists(select 1 from clinical_core.patient_records where id=_connection.patient_record_id and organization_id=_org and status='active') then
   raise exception using errcode='42501',message='program_assignment_refused'; end if;
  select * into _row from clinical_core.program_assignments
  where connection_id=_connection.id and program_version_id=_version.id;
  if _row.id is null then
   insert into clinical_core.program_assignments(organization_id,connection_id,consumer_person_id,program_version_id,
    assigned_by,title,content,source_digest)
   values(_org,_connection.id,_connection.consumer_person_id,_version.id,_actor,_items->>'title',_items->'phases',_digest)
   returning * into _row;
  elsif _row.source_digest<>_digest then
   raise exception using errcode='40001',message='program_assignment_conflict';
  end if;
  insert into clinical_core.program_assignment_audit(actor_id,organization_id,assignment_id,action) values(_actor,_org,_row.id,'assign');
  return jsonb_build_object('action','assign','enrollmentId',_row.id,'sourceDigest',_row.source_digest,
   'state',_row.state,'revision',_row.revision::text,'duplicate',_row.created_at<_now);
 end if;

 if _action='programs' then
  if _request-array['action']<>'{}'::jsonb then raise exception using errcode='22023',message='program_assignment_invalid'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'programVersionId',v.id,'programId',v.program_id,'programVersion',v.version::text,
    'programName',p.name,
    'title',coalesce(clinical_private.production_program_consumer_content(v.content)->>'title',p.name),
    'phaseCount',coalesce(jsonb_array_length(clinical_private.production_program_consumer_content(v.content)->'phases'),0),
    'assignable',clinical_private.production_program_consumer_content(v.content) is not null,
    'publishedAt',v.published_at) order by v.published_at desc nulls last,v.version desc),'[]'::jsonb) into _items
  from (select v.* from clinical_core.program_versions v
   where v.organization_id=_org and v.status='published'
   order by v.published_at desc nulls last,v.version desc limit 50) v
  join clinical_core.programs p on p.id=v.program_id and p.organization_id=_org;
  insert into clinical_core.program_assignment_audit(actor_id,organization_id,action) values(_actor,_org,'status');
  return jsonb_build_object('action','programs','programs',_items);
 end if;

 if _action='connections' then
  if _request-array['action']<>'{}'::jsonb then raise exception using errcode='22023',message='program_assignment_invalid'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('connectionId',c.id,'patientRecordId',c.patient_record_id,
    'verifiedAt',c.verified_at) order by c.verified_at desc),'[]'::jsonb) into _items
  from (select c.* from clinical_core.patient_connections c join clinical_core.patient_records r on r.id=c.patient_record_id
   where c.organization_id=_org and c.state='verified' and c.consumer_person_id is not null and r.status='active'
   order by c.verified_at desc limit 50) c;
  insert into clinical_core.program_assignment_audit(actor_id,organization_id,action) values(_actor,_org,'status');
  return jsonb_build_object('action','connections','connections',_items);
 end if;

 if _action='status' then
  if _request-array['action','connectionId']<>'{}'::jsonb then
   raise exception using errcode='22023',message='program_assignment_invalid'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('enrollmentId',a.id,'title',a.title,'state',a.state,
    'revision',a.revision::text,'patientRecordId',c.patient_record_id,'connectionId',c.id,
    'phaseIndex',a.phase_index,'phaseCount',jsonb_array_length(a.content),
    'finished',a.finished,'completedCount',(select count(*) from clinical_core.program_assignment_completions x where x.assignment_id=a.id),
    'assignedAt',a.created_at,'updatedAt',a.updated_at) order by a.created_at desc),'[]'::jsonb) into _items
  from (select a.* from clinical_core.program_assignments a
   where a.organization_id=_org
   and (_request->>'connectionId' is null or a.connection_id=(_request->>'connectionId')::uuid)
   order by a.created_at desc limit 50) a
  join clinical_core.patient_connections c on c.id=a.connection_id and c.organization_id=_org;
  insert into clinical_core.program_assignment_audit(actor_id,organization_id,action) values(_actor,_org,'status');
  return jsonb_build_object('action','status','assignments',_items);
 end if;

 if _action='release' then
  if _request-array['action','enrollmentId','phaseId']<>'{}'::jsonb
  or coalesce(_request->>'phaseId','') !~ '^[A-Za-z0-9_.:-]{1,160}$' then
   raise exception using errcode='22023',message='program_assignment_invalid'; end if;
  select * into _row from clinical_core.program_assignments where id=(_request->>'enrollmentId')::uuid and organization_id=_org for update;
  if _row.id is null or not exists(select 1 from jsonb_array_elements(_row.content) p where p.value->>'id'=_request->>'phaseId') then
   raise exception using errcode='42501',message='program_assignment_refused'; end if;
  insert into clinical_core.program_phase_authorizations(assignment_id,phase_id,kind,recorded_by)
  values(_row.id,_request->>'phaseId','practitioner_release',_actor) on conflict do nothing;
  insert into clinical_core.program_assignment_audit(actor_id,organization_id,assignment_id,action) values(_actor,_org,_row.id,'release');
  return jsonb_build_object('action','release','enrollmentId',_row.id,'phaseId',_request->>'phaseId');
 end if;

 if _action='list' then
  if _request-array['action']<>'{}'::jsonb then raise exception using errcode='22023',message='program_assignment_invalid'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('enrollmentId',a.id,'title',a.title,'state',a.state,
    'revision',a.revision::text,'sourceDigest',a.source_digest,'programVersion',v.version::text,'phaseIndex',a.phase_index,
    'phaseCount',jsonb_array_length(a.content),'finished',a.finished,'assignedAt',a.created_at) order by a.created_at desc),'[]'::jsonb)
  into _items from clinical_core.program_assignments a join clinical_core.patient_connections c on c.id=a.connection_id
  join clinical_core.program_versions v on v.id=a.program_version_id
  join clinical_core.patient_records r on r.id=c.patient_record_id
  where a.organization_id=_org and c.organization_id=_org and c.state='verified' and r.status='active'
  and c.consumer_person_id=_actor and a.state<>'withdrawn';
  insert into clinical_core.program_assignment_audit(actor_id,organization_id,action) values(_actor,_org,'list');
  return jsonb_build_object('action','list','assignments',_items);
 end if;

 if _request->>'enrollmentId' is null
 or (_request->>'enrollmentId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
  raise exception using errcode='22023',message='program_assignment_invalid'; end if;
 select * into _row from clinical_core.program_assignments where id=(_request->>'enrollmentId')::uuid for update;
 if _row.id is null or _row.organization_id<>_org then
  raise exception using errcode='42501',message='program_assignment_refused'; end if;
 select * into _connection from clinical_core.patient_connections where id=_row.connection_id;
 if _connection.id is null or _connection.organization_id<>_org or _connection.state<>'verified'
 or _connection.consumer_person_id is distinct from _actor
 or not exists(select 1 from clinical_core.patient_records where id=_connection.patient_record_id and organization_id=_org and status='active') then
  raise exception using errcode='42501',message='program_assignment_refused'; end if;
 _inventory:=clinical_private.production_program_plan_inventory(_actor);
 _review:=clinical_private.production_program_review(_row.content,_inventory,
  clinical_private.production_program_lab_readings(_actor,_org,_connection.patient_record_id));

 if _action='read' then
  if _request-array['action','enrollmentId']<>'{}'::jsonb then raise exception using errcode='22023',message='program_assignment_invalid'; end if;
  insert into clinical_core.program_assignment_audit(actor_id,organization_id,assignment_id,action) values(_actor,_org,_row.id,'read');
  return jsonb_build_object('action','read','assignment',jsonb_build_object('enrollmentId',_row.id,'title',_row.title,
   'state',_row.state,'revision',_row.revision::text,'sourceDigest',_row.source_digest,
   'programVersion',(select v.version::text from clinical_core.program_versions v where v.id=_row.program_version_id),
   'phases',_row.content,
   'phaseIndex',_row.phase_index,'finished',_row.finished,'startedAt',_row.started_at,'phaseStartedAt',_row.phase_started_at),
   'completed',(select coalesce(jsonb_agg(c.item_id order by c.item_id),'[]'::jsonb) from clinical_core.program_assignment_completions c where c.assignment_id=_row.id),
   'authorizations',(select coalesce(jsonb_agg(jsonb_build_object('phaseId',a.phase_id,'kind',a.kind) order by a.phase_id,a.kind),'[]'::jsonb)
    from clinical_core.program_phase_authorizations a where a.assignment_id=_row.id),
   'review',_review);
 end if;

 if _request->>'sourceDigest' is distinct from _row.source_digest then
  raise exception using errcode='40001',message='program_assignment_version_changed'; end if;
 _expected:=nullif(_request->>'expectedRevision','')::bigint;
 if _expected is null then raise exception using errcode='22023',message='program_assignment_invalid'; end if;
 if _expected<>_row.revision then raise exception using errcode='40001',message='program_assignment_revision_stale'; end if;

 if _action='accept' then
  if _request-array['action','enrollmentId','sourceDigest','expectedRevision','planRevision']<>'{}'::jsonb then
   raise exception using errcode='22023',message='program_assignment_invalid'; end if;
  if _request->>'planRevision' is distinct from (_review->>'planRevision') then
   raise exception using errcode='40001',message='program_review_stale'; end if;
  if _row.state='active' then
   insert into clinical_core.program_assignment_audit(actor_id,organization_id,assignment_id,action) values(_actor,_org,_row.id,'accept');
   return jsonb_build_object('action','accept','enrollmentId',_row.id,'revision',_row.revision::text,'state',_row.state,'duplicate',true);
  end if;
  if _row.state<>'offered' then raise exception using errcode='40001',message='program_assignment_state_invalid'; end if;
  update clinical_core.program_assignments set state='active',started_at=_now,phase_started_at=_now,
   phase_index=0,revision=revision+1,updated_at=_now where id=_row.id returning * into _row;
  insert into clinical_core.program_assignment_audit(actor_id,organization_id,assignment_id,action) values(_actor,_org,_row.id,'accept');
  return jsonb_build_object('action','accept','enrollmentId',_row.id,'revision',_row.revision::text,'state',_row.state,'duplicate',false);
 end if;

 if _row.state='withdrawn' then raise exception using errcode='40001',message='program_assignment_state_invalid'; end if;

 if _action in('pause','resume') then
  if _request-array['action','enrollmentId','sourceDigest','expectedRevision']<>'{}'::jsonb then
   raise exception using errcode='22023',message='program_assignment_invalid'; end if;
  if (_action='pause' and _row.state<>'active') or (_action='resume' and _row.state<>'paused') then
   raise exception using errcode='40001',message='program_assignment_state_invalid'; end if;
  update clinical_core.program_assignments set state=case when _action='pause' then 'paused' else 'active' end,
   revision=revision+1,updated_at=_now where id=_row.id returning * into _row;
  insert into clinical_core.program_assignment_audit(actor_id,organization_id,assignment_id,action) values(_actor,_org,_row.id,_action);
  return jsonb_build_object('action',_action,'enrollmentId',_row.id,'revision',_row.revision::text,'state',_row.state);
 end if;

 if _action='withdraw' then
  if _request-array['action','enrollmentId','sourceDigest','expectedRevision']<>'{}'::jsonb then
   raise exception using errcode='22023',message='program_assignment_invalid'; end if;
  update clinical_core.program_assignments set state='withdrawn',finished=false,revision=revision+1,updated_at=_now
   where id=_row.id returning * into _row;
  insert into clinical_core.program_assignment_audit(actor_id,organization_id,assignment_id,action) values(_actor,_org,_row.id,'withdraw');
  return jsonb_build_object('action','withdraw','enrollmentId',_row.id,'revision',_row.revision::text,'state',_row.state);
 end if;

 if _row.state<>'active' or _row.finished then
  raise exception using errcode='40001',message='program_assignment_state_invalid'; end if;
 _phase:=_row.content->_row.phase_index;
 if _phase is null then raise exception using errcode='40001',message='program_assignment_state_invalid'; end if;

 if _action='complete' then
  if _request-array['action','enrollmentId','sourceDigest','expectedRevision','itemId']<>'{}'::jsonb then
   raise exception using errcode='22023',message='program_assignment_invalid'; end if;
  if not exists(select 1 from jsonb_array_elements(_phase->'items') i where i.value->>'id'=_request->>'itemId')
  or not exists(select 1 from jsonb_array_elements_text(_review->'add') a where a.value=_request->>'itemId') then
   raise exception using errcode='42501',message='program_item_held'; end if;
  insert into clinical_core.program_assignment_completions(assignment_id,item_id)
  values(_row.id,_request->>'itemId') on conflict do nothing;
  update clinical_core.program_assignments set revision=revision+1,updated_at=_now where id=_row.id returning * into _row;
  insert into clinical_core.program_assignment_audit(actor_id,organization_id,assignment_id,action) values(_actor,_org,_row.id,'complete');
  return jsonb_build_object('action','complete','enrollmentId',_row.id,'revision',_row.revision::text,'itemId',_request->>'itemId');
 end if;

 if _action='check_in' then
  if _request-array['action','enrollmentId','sourceDigest','expectedRevision']<>'{}'::jsonb then
   raise exception using errcode='22023',message='program_assignment_invalid'; end if;
  insert into clinical_core.program_phase_authorizations(assignment_id,phase_id,kind,recorded_by)
  values(_row.id,_phase->>'id','consumer_check_in',_actor) on conflict do nothing;
  update clinical_core.program_assignments set revision=revision+1,updated_at=_now where id=_row.id returning * into _row;
  insert into clinical_core.program_assignment_audit(actor_id,organization_id,assignment_id,action) values(_actor,_org,_row.id,'check_in');
  return jsonb_build_object('action','check_in','enrollmentId',_row.id,'revision',_row.revision::text,'phaseId',_phase->>'id');
 end if;

 if _request-array['action','enrollmentId','sourceDigest','expectedRevision']<>'{}'::jsonb then
  raise exception using errcode='22023',message='program_assignment_invalid'; end if;
 if exists(select 1 from jsonb_array_elements(_phase->'items') i
  where exists(select 1 from jsonb_array_elements_text(_review->'add') a where a.value=i.value->>'id')
  and not exists(select 1 from clinical_core.program_assignment_completions c where c.assignment_id=_row.id and c.item_id=i.value->>'id')) then
  raise exception using errcode='40001',message='program_tasks_remaining'; end if;
 _elapsed:=_now-_row.phase_started_at;
 if _elapsed < ((_phase->>'days')::int * interval '1 day') then
  raise exception using errcode='40001',message='program_phase_not_due'; end if;
 if _phase->>'transition'='check_in' then
  select exists(select 1 from clinical_core.program_phase_authorizations a
   where a.assignment_id=_row.id and a.phase_id=_phase->>'id' and a.kind='consumer_check_in') into _authorized;
  if not _authorized then raise exception using errcode='40001',message='program_check_in_required'; end if;
 elsif _phase->>'transition'='practitioner' then
  select exists(select 1 from clinical_core.program_phase_authorizations a
   where a.assignment_id=_row.id and a.phase_id=_phase->>'id' and a.kind='practitioner_release') into _authorized;
  if not _authorized then raise exception using errcode='40001',message='program_practitioner_review_required'; end if;
 end if;
 if exists(select 1 from jsonb_array_elements(_phase->'items') i
  where exists(select 1 from jsonb_array_elements_text(_review->'held') h where h.value=i.value->>'id')
  or exists(select 1 from jsonb_array_elements_text(_review->'conflicts') x where x.value=i.value->>'id')) then
  raise exception using errcode='40001',message='program_clinical_items_held'; end if;
 if _row.phase_index=jsonb_array_length(_row.content)-1 then
  update clinical_core.program_assignments set finished=true,revision=revision+1,updated_at=_now where id=_row.id returning * into _row;
 else
  update clinical_core.program_assignments set phase_index=phase_index+1,phase_started_at=_now,revision=revision+1,updated_at=_now
   where id=_row.id returning * into _row;
 end if;
 insert into clinical_core.program_assignment_audit(actor_id,organization_id,assignment_id,action) values(_actor,_org,_row.id,'advance');
 return jsonb_build_object('action','advance','enrollmentId',_row.id,'revision',_row.revision::text,
  'phaseIndex',_row.phase_index,'finished',_row.finished);
end $$;

create or replace function clinical_private.production_program_bounded_complete(_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 _actor uuid:=clinical_private.actor_person_id(); _org uuid:=clinical_private.organization_id();
 _pool text:=clinical_private.claim('identity_pool');
 _connection clinical_core.patient_connections%rowtype; _row clinical_core.program_assignments%rowtype;
 _review jsonb; _phase jsonb; _expected bigint; _now timestamptz:=clock_timestamp();
begin
 if not exists(select 1 from clinical_core.production_program_activation where singleton and enabled) then
  raise exception using errcode='42501',message='production_program_disabled'; end if;
 if _actor is null or _org is null or _pool is null or _pool not in('consumer','workforce')
 or clinical_private.claim('purpose') is distinct from 'clinical_data'
 or clinical_private.claim('environment') is distinct from 'production-clinical'
 or clinical_private.claim('data_classification') is distinct from 'clinical_phi'
 or not exists(select 1 from clinical_core.identities i join clinical_core.persons p on p.id=i.person_id
  where i.person_id=_actor and i.identity_pool=_pool and i.identity_subject=clinical_private.claim('identity_subject')
  and i.production_bound and i.status='active' and p.status='active')
 or not exists(select 1 from clinical_core.organizations where id=_org and status='active')
 or (_pool='workforce' and not clinical_private.has_clinical_role(_org)) then
  raise exception using errcode='42501',message='program_assignment_refused'; end if;
 -- The plan revision is part of the request, not an optional extra: a completion without one is not a completion.
 if _request is null or jsonb_typeof(_request)<>'object' or octet_length(_request::text)>262144
 or _request-array['action','enrollmentId','sourceDigest','expectedRevision','planRevision','itemId']<>'{}'::jsonb
 or not (_request ?& array['action','enrollmentId','sourceDigest','expectedRevision','planRevision','itemId'])
 or jsonb_typeof(_request->'planRevision')<>'string' or char_length(btrim(_request->>'planRevision')) not between 1 and 200
 or jsonb_typeof(_request->'itemId')<>'string' or (_request->>'itemId') !~ '^[A-Za-z0-9_.:-]{1,160}$'
 or jsonb_typeof(_request->'expectedRevision')<>'string' or (_request->>'expectedRevision') !~ '^[1-9][0-9]{0,18}$'
 or jsonb_typeof(_request->'enrollmentId')<>'string'
 or (_request->>'enrollmentId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
  raise exception using errcode='22023',message='program_assignment_invalid'; end if;
 if _pool<>'consumer' then raise exception using errcode='42501',message='program_assignment_refused'; end if;
 if clinical_private.owned_consumer_consent(_actor,'protocols_supplements') is null then
  raise exception using errcode='42501',message='consumer_storage_consent_required'; end if;
 select * into _row from clinical_core.program_assignments where id=(_request->>'enrollmentId')::uuid for update;
 if _row.id is null or _row.organization_id<>_org then
  raise exception using errcode='42501',message='program_assignment_refused'; end if;
 select * into _connection from clinical_core.patient_connections where id=_row.connection_id;
 if _connection.id is null or _connection.organization_id<>_org or _connection.state<>'verified'
 or _connection.consumer_person_id is distinct from _actor
 or not exists(select 1 from clinical_core.patient_records where id=_connection.patient_record_id and organization_id=_org and status='active') then
  raise exception using errcode='42501',message='program_assignment_refused'; end if;
 _review:=clinical_private.production_program_review(_row.content,clinical_private.production_program_plan_inventory(_actor),
  clinical_private.production_program_lab_readings(_actor,_org,_connection.patient_record_id));
 if _request->>'sourceDigest' is distinct from _row.source_digest then
  raise exception using errcode='40001',message='program_assignment_version_changed'; end if;
 _expected:=(_request->>'expectedRevision')::bigint;
 if _expected<>_row.revision then raise exception using errcode='40001',message='program_assignment_revision_stale'; end if;
 -- The review the person was shown is the one they act on. A new or corrected result, a changed plan or a consent
 -- change moves the plan revision, and the step is refused here even if it is still listed as available.
 if _request->>'planRevision' is distinct from (_review->>'planRevision') then
  raise exception using errcode='40001',message='program_review_stale'; end if;
 if _row.state<>'active' or _row.finished then
  raise exception using errcode='40001',message='program_assignment_state_invalid'; end if;
 _phase:=_row.content->_row.phase_index;
 if _phase is null then raise exception using errcode='40001',message='program_assignment_state_invalid'; end if;
 if not exists(select 1 from jsonb_array_elements(_phase->'items') i where i.value->>'id'=_request->>'itemId')
 or not exists(select 1 from jsonb_array_elements_text(_review->'add') a where a.value=_request->>'itemId') then
  raise exception using errcode='42501',message='program_item_held'; end if;
 insert into clinical_core.program_assignment_completions(assignment_id,item_id)
 values(_row.id,_request->>'itemId') on conflict do nothing;
 update clinical_core.program_assignments set revision=revision+1,updated_at=_now where id=_row.id returning * into _row;
 insert into clinical_core.program_assignment_audit(actor_id,organization_id,assignment_id,action) values(_actor,_org,_row.id,'complete');
 return jsonb_build_object('action','complete','enrollmentId',_row.id,'revision',_row.revision::text,'itemId',_request->>'itemId');
end $$;

create or replace function clinical_core.production_program_bounded_request(_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from clinical_core.program_consumer_boundary_activation where singleton and enabled) then
  raise exception using errcode='42501',message='program_boundary_disabled'; end if;
 if _request is not null and jsonb_typeof(_request)='object' and _request->>'action'='complete' then
  return clinical_private.production_program_bounded_complete(_request);
 end if;
 return clinical_private.production_program_without_destinations(clinical_core.production_program_assignment_request(_request));
end $$;

drop function clinical_private.program_qualification_open();
drop table clinical_core.program_qualification_subjects;
drop trigger program_qualification_boundary_append_only on clinical_core.program_qualification_boundary;
drop table clinical_core.program_qualification_boundary;
