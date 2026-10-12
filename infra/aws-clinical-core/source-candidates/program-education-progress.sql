-- BLOCKED source candidate (successor): learner progress through a purchased course
-- (program-education-progress/1), for Codex's review. Not in migrations/manifest.json; not applied
-- anywhere; not registered; not to be applied until src/contracts/programEducationProgress.ts,
-- src/server/commerce/education-progress-service.ts and
-- docs/claude-program-commerce-reliability-learner-journeys-2026-10-11.md are reviewed. Disabled like
-- its parents: every function refuses until the commercial activation row is enabled by a separately
-- reviewed change, and the SQL ledger's progress methods enable only with evidence naming this digest.
--
-- Parent assumptions (written against exactly these artifacts, applied first, each unchanged; the
-- test refuses to run it if any digest has moved):
--   source-candidates/program-commerce-authority.sql (BLOCKED, unregistered; caller_consumer_subject)
--     sha256 11e53bc2e7ff13d1aa66c219fc9da1c4e768faef8ea42e1ebc44ed375a8c6c62
--   and through it program-education-delivery.sql 653965ff…, program-education-access.sql e4f11e29…
--   (program_entitlements, program_education_enrollments), the checkout and offer candidates, and
--   20260929120000_synthetic_program_assignments.sql (clinical_private.program_consumer_content).
-- No historical migration, shared identity function, ledger, binary, privilege outside the
-- commercial_education schema, IAM or custody file is changed by this file.
--
-- What progress is: a learner's own bookkeeping through the exact purchased version. It is not a
-- clinical check-in, a practitioner-controlled phase, a supplement start or protocol adoption, and
-- nothing here reads or writes a clinical table except the published content it validates lesson ids
-- against (the same read the curriculum function makes).
--
-- What it holds:
--   * one progress row per enrollment (revision, resume position); the revision rises by exactly one
--     per recorded write, so a write against an older revision is refused, never merged;
--   * completions, append-only, one per lesson per enrollment, only for released lesson, diet or habit
--     items of the pinned version (never a supplement step);
--   * receipts, append-only, one per request id per enrollment: the same request id answers with the
--     same receipt, so a retry after a lost reply converges on one result;
--   * the caller is the verified consumer request context (caller_consumer_subject), never an
--     argument; another owner, another enrollment, an inactive entitlement, an older version, an
--     unknown lesson and a supplement completion are refused before anything is written.
-- Only clinical_core_api may call the two functions, and only with a consumer context; no role reads
-- the tables directly.

create table commercial_education.program_education_progress(
 enrollment_id uuid primary key references commercial_education.program_education_enrollments(id),
 revision integer not null check(revision>=1),
 position_phase_id text check(position_phase_id is null or position_phase_id ~ '^[A-Za-z0-9_.:-]{1,160}$'),
 position_item_id text check(position_item_id is null or position_item_id ~ '^[A-Za-z0-9_.:-]{1,160}$'),
 updated_at timestamptz not null,
 constraint program_education_progress_position_whole check((position_phase_id is null)=(position_item_id is null))
);
create table commercial_education.program_education_completions(
 enrollment_id uuid not null references commercial_education.program_education_enrollments(id),
 phase_id text not null check(phase_id ~ '^[A-Za-z0-9_.:-]{1,160}$'),
 item_id text not null check(item_id ~ '^[A-Za-z0-9_.:-]{1,160}$'),
 completed_at timestamptz not null,
 request_id uuid not null,
 primary key(enrollment_id,phase_id,item_id)
);
create table commercial_education.program_education_progress_receipts(
 enrollment_id uuid not null references commercial_education.program_education_enrollments(id),
 request_id uuid not null,
 action text not null check(action in('complete','position')),
 phase_id text not null check(phase_id ~ '^[A-Za-z0-9_.:-]{1,160}$'),
 item_id text not null check(item_id ~ '^[A-Za-z0-9_.:-]{1,160}$'),
 recorded_at timestamptz not null,
 revision integer not null check(revision>=1),
 primary key(enrollment_id,request_id)
);
alter table commercial_education.program_education_progress enable row level security;
alter table commercial_education.program_education_progress force row level security;
alter table commercial_education.program_education_completions enable row level security;
alter table commercial_education.program_education_completions force row level security;
alter table commercial_education.program_education_progress_receipts enable row level security;
alter table commercial_education.program_education_progress_receipts force row level security;
revoke all on commercial_education.program_education_progress from public,clinical_core_api,commercial_education_worker,commercial_education_delivery,commercial_education_operator;
revoke all on commercial_education.program_education_completions from public,clinical_core_api,commercial_education_worker,commercial_education_delivery,commercial_education_operator;
revoke all on commercial_education.program_education_progress_receipts from public,clinical_core_api,commercial_education_worker,commercial_education_delivery,commercial_education_operator;
create trigger program_education_completions_append_only before update or delete on commercial_education.program_education_completions
 for each row execute function clinical_private.block_update_delete();
create trigger program_education_progress_receipts_append_only before update or delete on commercial_education.program_education_progress_receipts
 for each row execute function clinical_private.block_update_delete();

create function commercial_education.protect_program_education_progress() returns trigger
language plpgsql set search_path='' as $$
begin
 if tg_op='DELETE' then raise exception using errcode='55000',message='program_progress_append_only'; end if;
 if new.enrollment_id<>old.enrollment_id then raise exception using errcode='55000',message='program_progress_identity_immutable'; end if;
 if new.revision<>old.revision+1 then raise exception using errcode='55000',message='program_progress_revision_must_increase'; end if;
 return new;
end $$;
revoke all on function commercial_education.protect_program_education_progress() from public;
create trigger program_education_progress_protect before update or delete on commercial_education.program_education_progress
 for each row execute function commercial_education.protect_program_education_progress();

-- The progress view of one enrollment of one entitlement.
create function commercial_education.progress_json(_entitlement uuid,_enrollment uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('contract','program-education-progress/1','entitlementId',e.id,'enrollmentId',n.id,
  'curriculum',jsonb_build_object('versionId',e.curriculum_version_id,'version',e.curriculum_version,'sourceDigest',e.curriculum_source_digest),
  'revision',coalesce(p.revision,0),
  'completed',coalesce((select jsonb_agg(jsonb_build_object('lesson',jsonb_build_object('phaseId',c.phase_id,'itemId',c.item_id),'completedAt',c.completed_at,'requestId',c.request_id) order by c.completed_at,c.phase_id,c.item_id)
   from commercial_education.program_education_completions c where c.enrollment_id=n.id),'[]'::jsonb),
  'position',case when p.position_phase_id is null then null else jsonb_build_object('phaseId',p.position_phase_id,'itemId',p.position_item_id) end,
  'updatedAt',p.updated_at)
 from commercial_education.program_entitlements e
 join commercial_education.program_education_enrollments n on n.id=_enrollment and n.entitlement_id=e.id
 left join commercial_education.program_education_progress p on p.enrollment_id=n.id
 where e.id=_entitlement
$$;
revoke all on function commercial_education.progress_json(uuid,uuid) from public;

-- The caller's own progress through one of their courses.
create function commercial_education.education_progress_for_caller(_entitlement uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare _subject text; _n commercial_education.program_education_enrollments%rowtype;
begin
 perform commercial_education.require_activation();
 _subject:=commercial_education.caller_consumer_subject();
 select n.* into _n from commercial_education.program_education_enrollments n
  join commercial_education.program_entitlements e on e.id=n.entitlement_id
  where e.id=_entitlement and e.subject_kind='claimed' and e.consumer_subject=_subject and n.consumer_subject=_subject;
 if not found then return jsonb_build_object('outcome','refused','reason','not_owner'); end if;
 return jsonb_build_object('outcome','read','progress',commercial_education.progress_json(_entitlement,_n.id));
end $$;
revoke all on function commercial_education.education_progress_for_caller(uuid) from public;
grant execute on function commercial_education.education_progress_for_caller(uuid) to clinical_core_api;

-- One explicit write by the caller: a completion or a resume position.
create function commercial_education.record_education_progress_for_caller(_command jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 _subject text; _action text; _entitlement uuid; _enrollment uuid; _pin jsonb; _phase text; _item text; _expected integer; _request uuid;
 _e commercial_education.program_entitlements%rowtype; _n commercial_education.program_education_enrollments%rowtype;
 _p commercial_education.program_education_progress%rowtype; _r commercial_education.program_education_progress_receipts%rowtype;
 _v clinical_core.synthetic_desktop_program_versions%rowtype; _items jsonb; _lesson jsonb; _now timestamptz:=clock_timestamp(); _revision integer;
 refuse constant text:='refused';
begin
 perform commercial_education.require_activation();
 _subject:=commercial_education.caller_consumer_subject();
 if _command is null or jsonb_typeof(_command)<>'object' or _command->>'action' not in('complete','position')
  or jsonb_typeof(_command->'curriculum')<>'object' or jsonb_typeof(_command->'lesson')<>'object' or jsonb_typeof(_command->'expectedRevision')<>'number' then
  raise exception using errcode='22023',message='program_progress_request_invalid';
 end if;
 _action:=_command->>'action'; _entitlement:=(_command->>'entitlementId')::uuid; _enrollment:=(_command->>'enrollmentId')::uuid; _pin:=_command->'curriculum';
 _phase:=_command->'lesson'->>'phaseId'; _item:=_command->'lesson'->>'itemId'; _expected:=(_command->>'expectedRevision')::integer; _request:=(_command->>'requestId')::uuid;
 if _phase !~ '^[A-Za-z0-9_.:-]{1,160}$' or _item !~ '^[A-Za-z0-9_.:-]{1,160}$' or _expected<0 or _request is null then raise exception using errcode='22023',message='program_progress_request_invalid'; end if;
 select * into _e from commercial_education.program_entitlements where id=_entitlement and subject_kind='claimed' and consumer_subject=_subject;
 if not found then return jsonb_build_object('outcome',refuse,'reason','not_owner','progress',null); end if;
 select * into _n from commercial_education.program_education_enrollments where entitlement_id=_e.id and consumer_subject=_subject for update;
 if not found then return jsonb_build_object('outcome',refuse,'reason','not_owner','progress',null); end if;
 if _n.id<>_enrollment then return jsonb_build_object('outcome',refuse,'reason','enrollment_mismatch','progress',null); end if;
 -- The same request id answers with the same receipt, whatever happened since.
 select * into _r from commercial_education.program_education_progress_receipts where enrollment_id=_n.id and request_id=_request;
 if found then
  if _r.action<>_action or _r.phase_id<>_phase or _r.item_id<>_item then return jsonb_build_object('outcome',refuse,'reason','request_conflict','progress',null); end if;
  return jsonb_build_object('outcome','recorded','receipt',jsonb_build_object('requestId',_r.request_id,'action',_r.action,'lesson',jsonb_build_object('phaseId',_r.phase_id,'itemId',_r.item_id),'recordedAt',_r.recorded_at,'revision',_r.revision),
   'progress',commercial_education.progress_json(_e.id,_n.id));
 end if;
 if _e.state<>'active' or _n.state<>'active' or _e.window_starts_at is null or _e.window_starts_at>_now or (_e.window_ends_at is not null and _e.window_ends_at<=_now) then
  return jsonb_build_object('outcome',refuse,'reason','not_active','progress',null);
 end if;
 if (_pin->>'versionId') is distinct from _e.curriculum_version_id::text or (_pin->>'version') is distinct from _e.curriculum_version::text or (_pin->>'sourceDigest') is distinct from _e.curriculum_source_digest then
  return jsonb_build_object('outcome',refuse,'reason','stale_version','progress',null);
 end if;
 select * into _v from clinical_core.synthetic_desktop_program_versions where id=_e.curriculum_version_id and version=_e.curriculum_version;
 if not found then return jsonb_build_object('outcome',refuse,'reason','service_unavailable','progress',null); end if;
 _items:=clinical_private.program_consumer_content(_v.content);
 if _items is null or encode(public.digest(convert_to((_items->'phases')::text,'UTF8'),'sha256'),'hex')<>_e.curriculum_source_digest then
  return jsonb_build_object('outcome',refuse,'reason','service_unavailable','progress',null);
 end if;
 select i.value into _lesson from jsonb_array_elements(_items->'phases') ph, jsonb_array_elements(ph.value->'items') i
  where ph.value->>'id'=_phase and i.value->>'id'=_item limit 1;
 if _lesson is null then return jsonb_build_object('outcome',refuse,'reason','unknown_lesson','progress',null); end if;
 if _action='complete' and (_lesson->>'kind' not in('lesson','diet','habit') or (_lesson->'released')<>'true'::jsonb) then
  return jsonb_build_object('outcome',refuse,'reason','not_completable','progress',null);
 end if;
 select * into _p from commercial_education.program_education_progress where enrollment_id=_n.id for update;
 if coalesce(_p.revision,0)<>_expected then
  return jsonb_build_object('outcome',refuse,'reason','revision_stale','progress',commercial_education.progress_json(_e.id,_n.id));
 end if;
 _revision:=coalesce(_p.revision,0)+1;
 if _p.enrollment_id is null then
  insert into commercial_education.program_education_progress(enrollment_id,revision,position_phase_id,position_item_id,updated_at)
   values(_n.id,_revision,case when _action='position' then _phase end,case when _action='position' then _item end,_now);
 else
  update commercial_education.program_education_progress set revision=_revision,updated_at=_now,
   position_phase_id=case when _action='position' then _phase else position_phase_id end,
   position_item_id=case when _action='position' then _item else position_item_id end
   where enrollment_id=_n.id;
 end if;
 if _action='complete' then
  insert into commercial_education.program_education_completions(enrollment_id,phase_id,item_id,completed_at,request_id) values(_n.id,_phase,_item,_now,_request)
   on conflict (enrollment_id,phase_id,item_id) do nothing;
 end if;
 insert into commercial_education.program_education_progress_receipts(enrollment_id,request_id,action,phase_id,item_id,recorded_at,revision)
  values(_n.id,_request,_action,_phase,_item,_now,_revision) returning * into _r;
 return jsonb_build_object('outcome','recorded','receipt',jsonb_build_object('requestId',_r.request_id,'action',_r.action,'lesson',jsonb_build_object('phaseId',_r.phase_id,'itemId',_r.item_id),'recordedAt',_r.recorded_at,'revision',_r.revision),
  'progress',commercial_education.progress_json(_e.id,_n.id));
end $$;
revoke all on function commercial_education.record_education_progress_for_caller(jsonb) from public;
grant execute on function commercial_education.record_education_progress_for_caller(jsonb) to clinical_core_api;
