-- Separate, opt-in collection context. No provider or consent approval seeded.
alter table clinical_core.consent_artifacts drop constraint consent_artifacts_scope_check;
alter table clinical_core.consent_artifacts add constraint consent_artifacts_scope_check check (scope in (
 'programs','protocols_supplements','nutrition','appointments','messaging','forms_checkins','symptoms_adherence',
 'wearables','reproductive_health','lab_summaries','lab_results_import','lab_specimen_context','billing_links','research_n_of_1'));
alter table clinical_core.consent_grants drop constraint consent_grants_scope_check;
alter table clinical_core.consent_grants add constraint consent_grants_scope_check check (scope in (
 'programs','protocols_supplements','nutrition','appointments','messaging','forms_checkins','symptoms_adherence',
 'wearables','reproductive_health','lab_summaries','lab_results_import','lab_specimen_context','billing_links','research_n_of_1'));

-- Independent reviewed capability; existing lab-result/1 approval does not imply this grant.
alter table clinical_core.sync_providers add column specimen_context_contract text,
 add column specimen_context_reviewed_by uuid references clinical_core.persons(id),
 add column specimen_context_reviewed_at timestamptz;
alter table clinical_core.sync_providers add constraint specimen_context_capability_check check (
 (specimen_context_contract is null and specimen_context_reviewed_by is null and specimen_context_reviewed_at is null)
 or (specimen_context_contract is not null and specimen_context_contract='lab-specimen-context/1' and specimen_context_reviewed_by is not null and specimen_context_reviewed_at is not null));

create table clinical_core.lab_specimen_context_versions (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references clinical_core.organizations(id),
 patient_record_id uuid not null references clinical_core.patient_records(id),
 connection_id uuid not null,
 lab_event_id uuid not null references clinical_core.lab_import_events(id),
 request_id uuid not null,
 revision integer not null check (revision>0),
 payload_sha256 text not null check(payload_sha256 ~ '^[0-9a-f]{64}$'),
 lab_payload_sha256 text not null check(lab_payload_sha256 ~ '^[0-9a-f]{64}$'),
 context jsonb not null check(jsonb_typeof(context)='object'),
 consent_id uuid not null references clinical_core.consent_grants(id),
 reproductive_consent_id uuid references clinical_core.consent_grants(id),
 recorded_by_person_id uuid not null references clinical_core.persons(id),
 received_at timestamptz not null default clock_timestamp(),
 foreign key(connection_id,organization_id,patient_record_id) references clinical_core.patient_connections(id,organization_id,patient_record_id),
 unique(connection_id,request_id), unique(lab_event_id,revision)
);
create index lab_specimen_context_patient_idx on clinical_core.lab_specimen_context_versions(organization_id,patient_record_id,received_at);
alter table clinical_core.lab_specimen_context_versions enable row level security;
create policy lab_specimen_context_read on clinical_core.lab_specimen_context_versions for select to clinical_core_api using (
 organization_id=clinical_private.organization_id() and (
 clinical_private.has_clinical_role(organization_id) or exists (
 select 1 from clinical_core.patient_connections c where c.id=connection_id
 and c.consumer_person_id=clinical_private.actor_person_id() and c.state in ('verified','paused'))));
create trigger lab_specimen_context_immutable before update or delete on clinical_core.lab_specimen_context_versions
 for each row execute function clinical_private.block_update_delete();

create function clinical_core.record_lab_specimen_context(_content text)
returns table(context_id uuid,lab_event_id uuid,request_id uuid,revision integer,payload_sha256 text,received_at timestamptz,duplicate boolean)
language plpgsql security definer set search_path='' as $$
declare
 _p jsonb; _ctx jsonb; _connection clinical_core.patient_connections%rowtype;
 _event clinical_core.lab_import_events%rowtype; _provider clinical_core.sync_providers%rowtype;
 _grant clinical_core.consent_grants%rowtype; _reproductive clinical_core.consent_grants%rowtype;
 _old clinical_core.lab_specimen_context_versions%rowtype; _row clinical_core.lab_specimen_context_versions%rowtype;
 _has_reproductive boolean; _latest integer; _digest text; _k text;
begin
 if _content is null or octet_length(_content)>8192 then raise exception using errcode='22023',message='specimen_context_invalid'; end if;
 _p:=_content::jsonb; _ctx:=_p->'context';
 if jsonb_typeof(_p) is distinct from 'object' or jsonb_typeof(_ctx) is distinct from 'object' then
  raise exception using errcode='22023',message='specimen_context_invalid'; end if;
 if (select count(*) from jsonb_object_keys(_p))<>9 or not (_p ?& array['version','connectionId','labEventId','labPayloadSha256','requestId','expectedRevision','consentVersion','reproductiveConsentVersion','context'])
 or _p->>'version' is distinct from 'lab-specimen-context/1'
 or coalesce(_p->>'labPayloadSha256','') !~ '^[0-9a-f]{64}$'
 or jsonb_typeof(_p->'expectedRevision') is distinct from 'number' or coalesce(_p->>'expectedRevision','') !~ '^[0-9]{1,7}$'
 or (_p->>'expectedRevision')::integer>1000000
 or jsonb_typeof(_p->'consentVersion') is distinct from 'number' or coalesce(_p->>'consentVersion','') !~ '^[1-9][0-9]{0,8}$'
 or (select count(*) from jsonb_object_keys(_ctx))<>12
 or not (_ctx ?& array['source','verification','recordedAt','observedOn','ageAtDraw','sex','assayId','pregnancyStatus','cyclePhase','reproductiveStage','contraception','pregnancyTrimester'])
 or _ctx->>'source' is distinct from 'patient_reported' or _ctx->>'verification' is distinct from 'unverified'
 then raise exception using errcode='22023',message='specimen_context_invalid'; end if;
 if jsonb_typeof(_ctx->'ageAtDraw') is distinct from 'object' then raise exception using errcode='22023',message='specimen_context_invalid'; end if;
 if (select count(*) from jsonb_object_keys(_ctx->'ageAtDraw'))<>2
 or not ((_ctx->'ageAtDraw') ?& array['value','unit'])
 or jsonb_typeof(_ctx->'ageAtDraw'->'value') is distinct from 'number'
 or coalesce(_ctx->'ageAtDraw'->>'value','') !~ '^[0-9]{1,5}$'
 or coalesce(_ctx->'ageAtDraw'->>'unit','') not in ('days','months','years')
 or (_ctx->'ageAtDraw'->>'value')::integer > (case _ctx->'ageAtDraw'->>'unit' when 'days' then 46000 when 'months' then 1500 else 125 end)
 or jsonb_typeof(_ctx->'observedOn') is distinct from 'string' or coalesce(_ctx->>'observedOn','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
 or (_ctx->>'observedOn')::date::text is distinct from _ctx->>'observedOn'
 or jsonb_typeof(_ctx->'recordedAt') is distinct from 'string' or coalesce(_ctx->>'recordedAt','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
 or (_ctx->>'recordedAt')::timestamptz>clock_timestamp()+interval '5 minutes'
 then raise exception using errcode='22023',message='specimen_context_invalid'; end if;
 foreach _k in array array['sex','assayId','pregnancyStatus','cyclePhase','reproductiveStage','contraception'] loop
  if jsonb_typeof(_ctx->_k) not in ('null','string') then raise exception using errcode='22023',message='specimen_context_invalid'; end if;
 end loop;
 if (_ctx->>'sex' is not null and _ctx->>'sex' not in ('male','female','other'))
 or (_ctx->>'assayId' is not null and char_length(btrim(_ctx->>'assayId')) not between 1 and 160)
 or (_ctx->>'pregnancyStatus' is not null and _ctx->>'pregnancyStatus' not in ('not_pregnant','pregnant','unsure','not_applicable'))
 or (_ctx->>'cyclePhase' is not null and _ctx->>'cyclePhase' not in ('menstrual','follicular','ovulatory','luteal','not_applicable'))
 or (_ctx->>'reproductiveStage' is not null and _ctx->>'reproductiveStage' not in ('prepubertal','reproductive','irregular_cycles','perimenopause','menopause','pregnant','postpartum'))
 or (_ctx->>'contraception' is not null and _ctx->>'contraception' not in ('none','hormonal','non_hormonal'))
 or (_ctx->'pregnancyTrimester'<>'null'::jsonb and (jsonb_typeof(_ctx->'pregnancyTrimester')<>'number' or _ctx->>'pregnancyTrimester' not in ('1','2','3') or _ctx->>'pregnancyStatus' is distinct from 'pregnant'))
 then raise exception using errcode='22023',message='specimen_context_invalid'; end if;
 _has_reproductive:=exists(select 1 from unnest(array['pregnancyStatus','cyclePhase','reproductiveStage','contraception','pregnancyTrimester']) k where _ctx->k<>'null'::jsonb);
 if (_has_reproductive and (jsonb_typeof(_p->'reproductiveConsentVersion') is distinct from 'number' or coalesce(_p->>'reproductiveConsentVersion','') !~ '^[1-9][0-9]{0,8}$'))
 or (not _has_reproductive and _p->'reproductiveConsentVersion'<>'null'::jsonb)
 then raise exception using errcode='22023',message='specimen_context_invalid'; end if;

 -- Same connection lock used by grant/revoke: re-read consent only AFTER locking.
 select * into _connection from clinical_core.patient_connections c where c.id=(_p->>'connectionId')::uuid for update;
 if not found or _connection.state<>'verified' then raise exception using errcode='42501',message='specimen_context_refused'; end if;
 perform clinical_private.assert_production_context(_connection.organization_id,'clinical_data','consumer');
 if _connection.consumer_person_id is distinct from clinical_private.actor_person_id() then raise exception using errcode='42501',message='specimen_context_refused'; end if;
 select * into _event from clinical_core.lab_import_events e where e.id=(_p->>'labEventId')::uuid and e.connection_id=_connection.id and e.organization_id=_connection.organization_id and e.patient_record_id=_connection.patient_record_id for update;
 if not found or _event.state not in ('review_pending','accepted') or _event.payload_sha256<>_p->>'labPayloadSha256'
 or (_event.collected_at at time zone 'UTC')::date<>(_ctx->>'observedOn')::date then
 raise exception using errcode='42501',message='specimen_context_refused'; end if;
 select * into _provider from clinical_core.sync_providers p where p.id=_event.provider_id for share;
 if not found or _provider.state<>'active' or _provider.specimen_context_contract is distinct from 'lab-specimen-context/1'
 then raise exception using errcode='42501',message='specimen_provider_approval_required'; end if;
 if not exists(select 1 from clinical_core.current_consent c where c.connection_id=_connection.id and c.scope='lab_results_import' and c.status='granted')
 then raise exception using errcode='42501',message='specimen_consent_required'; end if;
 select g.* into _grant from clinical_core.current_consent g join clinical_core.consent_artifacts a on a.id=g.artifact_id
 where g.connection_id=_connection.id and g.scope='lab_specimen_context' and g.status='granted'
 and g.version=(_p->>'consentVersion')::integer and a.status='approved'
 and g.recorded_by_person_id=clinical_private.actor_person_id() and g.method='patient_app' and g.representative_authority='self'
 and a.organization_id=_connection.organization_id and a.scope='lab_specimen_context' and a.artifact_version='lab-specimen-context-consent/1';
 if not found then raise exception using errcode='42501',message='specimen_consent_required'; end if;
 if _has_reproductive then
  select g.* into _reproductive from clinical_core.current_consent g join clinical_core.consent_artifacts a on a.id=g.artifact_id
  where g.connection_id=_connection.id and g.scope='reproductive_health' and g.status='granted' and g.version=(_p->>'reproductiveConsentVersion')::integer
  and a.status='approved' and a.organization_id=_connection.organization_id and a.scope='reproductive_health'
  and g.recorded_by_person_id=clinical_private.actor_person_id() and g.method='patient_app' and g.representative_authority='self';
  if not found then raise exception using errcode='42501',message='specimen_consent_required'; end if;
 end if;
 _digest:=encode(public.digest(convert_to(_content,'UTF8'),'sha256'),'hex');
 select * into _old from clinical_core.lab_specimen_context_versions s where s.connection_id=_connection.id and s.request_id=(_p->>'requestId')::uuid;
 if found then
  if _old.payload_sha256<>_digest then raise exception using errcode='40001',message='specimen_context_conflict'; end if;
  return query select _old.id,_old.lab_event_id,_old.request_id,_old.revision,_old.payload_sha256,_old.received_at,true; return;
 end if;
 select coalesce(max(s.revision),0) into _latest from clinical_core.lab_specimen_context_versions s where s.lab_event_id=_event.id;
 if _latest<>(_p->>'expectedRevision')::integer then raise exception using errcode='40001',message='specimen_context_conflict'; end if;
 insert into clinical_core.lab_specimen_context_versions(organization_id,patient_record_id,connection_id,lab_event_id,request_id,revision,
 payload_sha256,lab_payload_sha256,context,consent_id,reproductive_consent_id,recorded_by_person_id)
 values(_connection.organization_id,_connection.patient_record_id,_connection.id,_event.id,(_p->>'requestId')::uuid,_latest+1,
 _digest,_event.payload_sha256,_ctx,_grant.id,_reproductive.id,clinical_private.actor_person_id()) returning * into _row;
 insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,purpose,safe_metadata)
 values(_connection.organization_id,clinical_private.actor_person_id(),'lab_import.received','lab_import',_event.id,'clinical_data',
 jsonb_build_object('contract','lab-specimen-context/1','revision',_row.revision));
 return query select _row.id,_row.lab_event_id,_row.request_id,_row.revision,_row.payload_sha256,_row.received_at,false;
end $$;
revoke all on clinical_core.lab_specimen_context_versions from public;
grant select on clinical_core.lab_specimen_context_versions to clinical_core_api;
revoke all on function clinical_core.record_lab_specimen_context(text) from public;
grant execute on function clinical_core.record_lab_specimen_context(text) to clinical_core_api;
