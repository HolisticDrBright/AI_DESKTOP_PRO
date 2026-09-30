-- What happened in this practice: a treatment-outcome ledger that reports only in aggregate.
-- Synthetic-only. No real patient data, and nothing here is enabled for production.
--
-- The question this answers is "which of the things I do actually help, and which do not".
-- Nobody selling practice software answers it: Jane, Practice Better and Biocanic all store what
-- was done and none of them store what happened next in any form that can be counted.
--
-- What it is NOT is important enough to be said first, in the schema, where it cannot be lost.
--
-- This is not proof that anything works. One practice's records are observational, uncontrolled
-- and self-selected: the people who came back are not the people who did not, and the
-- practitioner who chose the treatment also recorded the outcome. It can show what happened here.
-- It cannot show what caused it, and the report says so in its own payload rather than leaving a
-- screen to remember.
--
-- It is also NOT a HIPAA Safe Harbor de-identified data set, and calling it one would be the
-- kind of claim that ends badly. Removing a name is not de-identification. Every observation
-- keeps a link to the person who contributed it, because a revocable consent is worth more than
-- the label, and a link is exactly what Safe Harbor forbids. So this is a limited data set held
-- inside the clinic, with these protections instead:
--
--   * Nothing free-text is ever stored. Conditions and treatments are codes the practice
--     declared in advance; outcome and follow-up are closed sets. There is no column a sentence
--     about a person could be written into.
--   * An exact age is never stored. The contribution takes age in years and the database bands
--     it, five years wide, with everyone over 89 collapsed into one band — so the column that
--     would identify the oldest patient in a small practice does not exist.
--   * No date is stored on an observation beyond when the row was written, and no report may
--     group or filter by time at all.
--   * The API role has no read access to the table. The only exposed read is an aggregate
--     function, and it suppresses any cell below eleven, drops a second cell when exactly one was
--     suppressed so the missing count cannot be recovered by subtraction, and returns no total
--     whenever anything was suppressed.
--   * Consent is its own scope, granted and revoked separately from treatment consent. Revoking
--     it deletes the contributions, and so does any erasure the owner asks for.

-- The consent to contribute. Separate from every clinical scope, because agreeing to be treated
-- is not agreeing to be counted.
-- The whole list, carried forward from migration 20260916080000 with one scope added. Writing
-- only the scopes this migration cares about would silently drop reproductive_health,
-- lab_results_import and lab_specimen_context, and the first thing anyone would notice is a
-- reproductive-health revocation failing.
alter table clinical_core.consent_artifacts drop constraint consent_artifacts_scope_check;
alter table clinical_core.consent_artifacts add constraint consent_artifacts_scope_check
 check (scope in(
 'programs','protocols_supplements','nutrition','appointments','messaging','forms_checkins','symptoms_adherence',
 'wearables','reproductive_health','lab_summaries','lab_results_import','lab_specimen_context','billing_links',
 'research_n_of_1','research_practice_outcomes'));
alter table clinical_core.consent_grants drop constraint consent_grants_scope_check;
alter table clinical_core.consent_grants add constraint consent_grants_scope_check
 check (scope in(
 'programs','protocols_supplements','nutrition','appointments','messaging','forms_checkins','symptoms_adherence',
 'wearables','reproductive_health','lab_summaries','lab_results_import','lab_specimen_context','billing_links',
 'research_n_of_1','research_practice_outcomes'));

-- Codes the practice declared. An observation may only cite one of these, which is what stops a
-- free-text description of a person arriving in a column called `condition_code`.
create table clinical_core.outcome_vocabulary(
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references clinical_core.organizations(id),
 kind text not null check(kind in('condition','treatment')),
 code text not null check(code ~ '^[a-z][a-z0-9_]{2,60}$'),
 -- Display only. Never contributed, never reported, never sent anywhere.
 label text not null check(char_length(btrim(label)) between 1 and 160),
 status text not null default 'active' check(status in('active','retired')),
 declared_at timestamptz not null default clock_timestamp(),
 declared_by_person_id uuid not null references clinical_core.persons(id),
 unique(organization_id,kind,code)
);

create table clinical_core.outcome_observations(
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references clinical_core.organizations(id),
 -- The revocation link, and the reason this is a limited data set rather than a de-identified
 -- one. Deliberately named for what it is. No reporting path reads it.
 contributing_person_id uuid not null references clinical_core.persons(id),
 contributing_connection_id uuid not null references clinical_core.patient_connections(id),
 -- Banded here, never supplied. Five years wide, 90+ collapsed.
 age_band text not null check(age_band in('18_24','25_29','30_34','35_39','40_44','45_49',
  '50_54','55_59','60_64','65_69','70_74','75_79','80_84','85_89','90_plus')),
 sex text not null check(sex in('female','male','intersex','not_recorded')),
 condition_codes text[] not null check(array_length(condition_codes,1) between 1 and 5),
 treatment_code text not null,
 outcome_code text not null check(outcome_code in('resolved','much_improved','improved',
  'unchanged','worse','stopped_side_effects','stopped_cost','lost_to_follow_up')),
 followup_band text not null check(followup_band in('under_6_weeks','6_to_12_weeks',
  '3_to_6_months','6_to_12_months','over_12_months')),
 recorded_at timestamptz not null default clock_timestamp(),
 recorded_by_person_id uuid not null references clinical_core.persons(id)
);
create index outcome_observations_report_idx on clinical_core.outcome_observations(
 organization_id,treatment_code,outcome_code);
create index outcome_observations_owner_idx on clinical_core.outcome_observations(contributing_person_id);
/* The API role reads nothing here. Every read goes through the aggregate function, which runs as
   the owner. A caller that could select rows could re-identify a small practice by eye. */
revoke all on clinical_core.outcome_observations from clinical_core_api;
revoke all on clinical_core.outcome_vocabulary from clinical_core_api;

/* An age in years becomes a band, and never arrives as anything else. Under 18 is refused because
   this product is 18+ and a minor's row here would be a record nobody consented to. */
create or replace function clinical_private.outcome_age_band(_years integer)
returns text language plpgsql immutable set search_path='' as $$
begin
 if _years is null or _years<18 or _years>130 then return null; end if;
 if _years>=90 then return '90_plus'; end if;
 if _years<25 then return '18_24'; end if;
 return (_years/5*5)::text||'_'||(_years/5*5+4)::text;
end $$;
revoke all on function clinical_private.outcome_age_band(integer) from public;

/* Whether this account still agrees to be counted. The latest grant for the scope wins, and an
   absent grant is a no — never an assumption. */
create or replace function clinical_private.outcome_consent_current(_connection uuid)
returns boolean language plpgsql stable set search_path='' as $$
declare _status text;
begin
 select g.status into _status from clinical_core.consent_grants g
  where g.connection_id=_connection and g.scope='research_practice_outcomes'
  order by g.version desc limit 1;
 -- coalesce, not the bare comparison: an absent grant makes `_status` null, and `null='granted'`
 -- is null, which an `if not ...` would quietly treat as "no objection".
 return coalesce(_status='granted',false);
end $$;
revoke all on function clinical_private.outcome_consent_current(uuid) from public;

/* Revoking the consent removes what was contributed under it. Nothing has to remember to call
   this: it hangs off the consent row itself, so there is one revocation path and it is the one
   the patient already uses. */
create or replace function clinical_private.outcome_consent_withdrawn() returns trigger
language plpgsql set search_path='' as $$
begin
 if new.scope='research_practice_outcomes' and new.status='revoked' then
  delete from clinical_core.outcome_observations
   where contributing_connection_id=new.connection_id;
 end if;
 return new;
end $$;
create trigger consent_grants_outcome_withdrawal after insert on clinical_core.consent_grants
 for each row execute function clinical_private.outcome_consent_withdrawn();

/* Any erasure the owner asks for takes the contributions too, on either scope. A domain erase
   keeps the clinic's own records, and a practice's aggregate counts are arguably the clinic's —
   but the observation is about someone's body, so the strict reading wins. Hung off the erasure
   ledger row every erasure already writes, so there is nothing to remember here either. */
create or replace function clinical_private.outcome_erasure_followed() returns trigger
language plpgsql set search_path='' as $$
begin
 delete from clinical_core.outcome_observations where contributing_person_id=new.owner_id;
 return new;
end $$;
create trigger care_data_erasures_outcome_followup after insert on clinical_core.care_data_erasures
 for each row execute function clinical_private.outcome_erasure_followed();

/* Declaring the codes a practice counts by, and recording what happened.
   Contribution is workforce-only: an outcome is the practitioner's clinical judgement of what
   happened, and letting a patient write directly into the counted ledger would make the counts
   mean two different things at once. */
create or replace function clinical_core.outcome_ledger_workforce(_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 _org uuid:=clinical_private.organization_id(); _actor uuid; _action text;
 _connection clinical_core.patient_connections%rowtype;
 _band text; _codes text[]; _items jsonb; _id uuid; _kind text; _code text;
begin
 _actor:=clinical_private.assert_practice_workforce(_org,'outcome_ledger_forbidden');
 if _request is null or clinical_private.jsonb_kind(_request)<>'object' then
  raise exception using errcode='22023',message='outcome_ledger_invalid'; end if;
 _action:=_request->>'action';
 if _action is null or _action not in('declare_code','retire_code','vocabulary','contribute') then
  raise exception using errcode='22023',message='outcome_ledger_invalid'; end if;

 if _action='vocabulary' then
  if _request-array['action']<>'{}'::jsonb then
   raise exception using errcode='22023',message='outcome_ledger_invalid'; end if;
  return jsonb_build_object('action','vocabulary','codes',coalesce((
   select jsonb_agg(jsonb_build_object('kind',v.kind,'code',v.code,'label',v.label,
    'status',v.status) order by v.kind,v.code)
   from clinical_core.outcome_vocabulary v where v.organization_id=_org),'[]'::jsonb));
 end if;

 if _action in('declare_code','retire_code') then
  if _request-array['action','kind','code','label']<>'{}'::jsonb then
   raise exception using errcode='22023',message='outcome_ledger_invalid'; end if;
  _kind:=_request->>'kind'; _code:=_request->>'code';
  if _kind is null or _kind not in('condition','treatment')
  or _code is null or _code !~ '^[a-z][a-z0-9_]{2,60}$' then
   raise exception using errcode='22023',message='outcome_ledger_invalid'; end if;
  if _action='retire_code' then
   if _request ? 'label' then
    raise exception using errcode='22023',message='outcome_ledger_invalid'; end if;
   update clinical_core.outcome_vocabulary set status='retired'
    where organization_id=_org and kind=_kind and code=_code;
   if not found then raise exception using errcode='P0002',message='outcome_code_absent'; end if;
   -- Retiring stops new contributions citing it. Observations already counted keep their code,
   -- because deleting them would silently change every report that ever mentioned it.
   return jsonb_build_object('action','retire_code','kind',_kind,'code',_code,'status','retired');
  end if;
  if clinical_private.jsonb_kind(_request->'label')<>'string'
  or char_length(btrim(_request->>'label')) not between 1 and 160 then
   raise exception using errcode='22023',message='outcome_ledger_invalid'; end if;
  insert into clinical_core.outcome_vocabulary(organization_id,kind,code,label,
   declared_by_person_id)
  values(_org,_kind,_code,btrim(_request->>'label'),_actor)
  on conflict(organization_id,kind,code) do update
   set label=excluded.label,status='active';
  return jsonb_build_object('action','declare_code','kind',_kind,'code',_code,'status','active');
 end if;

 -- contribute
 if _request-array['action','connectionId','ageYears','sex','conditionCodes','treatmentCode',
  'outcomeCode','followupBand']<>'{}'::jsonb then
  raise exception using errcode='22023',message='outcome_ledger_invalid'; end if;
 begin
  select * into _connection from clinical_core.patient_connections
   where organization_id=_org and id=(_request->>'connectionId')::uuid;
 exception when invalid_text_representation then
  raise exception using errcode='22023',message='outcome_ledger_invalid'; end;
 if _connection.id is null or _connection.state<>'verified' then
  raise exception using errcode='P0002',message='outcome_connection_absent'; end if;
 -- Consent for this scope specifically. Treatment consent is not evidence of it.
 if not clinical_private.outcome_consent_current(_connection.id) then
  raise exception using errcode='42501',message='outcome_consent_absent'; end if;

 if clinical_private.jsonb_kind(_request->'ageYears')<>'number' then
  raise exception using errcode='22023',message='outcome_ledger_invalid'; end if;
 _band:=clinical_private.outcome_age_band((_request->>'ageYears')::numeric::integer);
 if _band is null then
  raise exception using errcode='22023',message='outcome_age_out_of_range'; end if;
 if (_request->>'sex') is null
 or (_request->>'sex') not in('female','male','intersex','not_recorded')
 or (_request->>'outcomeCode') is null
 or (_request->>'outcomeCode') not in('resolved','much_improved','improved','unchanged','worse',
  'stopped_side_effects','stopped_cost','lost_to_follow_up')
 or (_request->>'followupBand') is null
 or (_request->>'followupBand') not in('under_6_weeks','6_to_12_weeks','3_to_6_months',
  '6_to_12_months','over_12_months') then
  raise exception using errcode='22023',message='outcome_ledger_invalid'; end if;
 if clinical_private.jsonb_kind(_request->'conditionCodes')<>'array'
 or jsonb_array_length(_request->'conditionCodes') not between 1 and 5 then
  raise exception using errcode='22023',message='outcome_ledger_invalid'; end if;
 select array_agg(value) into _codes from jsonb_array_elements_text(_request->'conditionCodes');
 -- Every code must be one this practice declared and has not retired. An undeclared code is
 -- refused rather than stored, because a code nobody declared is free text wearing a code's name.
 if exists(select 1 from unnest(_codes) c where not exists(
  select 1 from clinical_core.outcome_vocabulary v where v.organization_id=_org
   and v.kind='condition' and v.code=c and v.status='active'))
 or not exists(select 1 from clinical_core.outcome_vocabulary v where v.organization_id=_org
  and v.kind='treatment' and v.code=(_request->>'treatmentCode') and v.status='active') then
  raise exception using errcode='P0002',message='outcome_code_absent'; end if;

 insert into clinical_core.outcome_observations(organization_id,contributing_person_id,
  contributing_connection_id,age_band,sex,condition_codes,treatment_code,outcome_code,
  followup_band,recorded_by_person_id)
 values(_org,_connection.consumer_person_id,_connection.id,_band,_request->>'sex',_codes,
  _request->>'treatmentCode',_request->>'outcomeCode',_request->>'followupBand',_actor)
 returning id into _id;
 -- The age band is echoed so the practitioner can see that the exact age was not kept.
 return jsonb_build_object('action','contribute','observationId',_id,'ageBand',_band,
  'stored',jsonb_build_object('exactAgeKept',false,'freeTextKept',false,'dateKept',false));
end $$;
revoke all on function clinical_core.outcome_ledger_workforce(jsonb) from public;
grant execute on function clinical_core.outcome_ledger_workforce(jsonb) to clinical_core_api;

/* The only read. Counts, never rows.
   Eleven is the threshold, the same one HHS's own guidance uses for small-cell suppression in
   public reporting. Below it a cell is dropped; when exactly one cell was dropped a second one
   goes with it, because a single hole next to a known total is not a hole. And no total is
   returned whenever anything was suppressed, for the same reason. */
create or replace function clinical_core.outcome_report(_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 _org uuid:=clinical_private.organization_id(); _actor uuid;
 _dims text[]; _condition text; _treatment text;
 _groups jsonb; _kept jsonb:='[]'::jsonb; _suppressed integer:=0; _total integer;
 _row record; _smallest_index integer; _smallest integer;
begin
 _actor:=clinical_private.assert_practice_workforce(_org,'outcome_ledger_forbidden');
 if _request is null or clinical_private.jsonb_kind(_request)<>'object'
 or _request-array['action','groupBy','conditionCode','treatmentCode']<>'{}'::jsonb
 or (_request->>'action') is distinct from 'report' then
  raise exception using errcode='22023',message='outcome_ledger_invalid'; end if;
 if clinical_private.jsonb_kind(_request->'groupBy')<>'array'
 or jsonb_array_length(_request->'groupBy')>2 then
  raise exception using errcode='22023',message='outcome_ledger_invalid'; end if;
 select coalesce(array_agg(value),'{}') into _dims from jsonb_array_elements_text(_request->'groupBy');
 if exists(select 1 from unnest(_dims) d where d not in('treatment','ageBand','sex','followupBand'))
 -- coalesce: an empty groupBy is legal and reports by outcome alone, but `array_length` of an
 -- empty array is null, and a bare comparison would reject it.
 or coalesce(array_length(_dims,1),0)
  is distinct from (select count(distinct d)::integer from unnest(_dims) d) then
  raise exception using errcode='22023',message='outcome_ledger_invalid'; end if;
 _condition:=_request->>'conditionCode'; _treatment:=_request->>'treatmentCode';

 -- Outcome is always a dimension: a count with no outcome in it does not answer the question.
 select coalesce(jsonb_agg(jsonb_build_object('outcome',g.outcome_code,
   'treatment',g.d_treatment,'ageBand',g.d_age,'sex',g.d_sex,'followupBand',g.d_followup,
   'count',g.n) order by g.n desc,g.outcome_code),'[]'::jsonb) into _groups
 from (
  select o.outcome_code,
   case when 'treatment'=any(_dims) then o.treatment_code end as d_treatment,
   case when 'ageBand'=any(_dims) then o.age_band end as d_age,
   case when 'sex'=any(_dims) then o.sex end as d_sex,
   case when 'followupBand'=any(_dims) then o.followup_band end as d_followup,
   count(*)::integer as n
  from clinical_core.outcome_observations o
  where o.organization_id=_org
   and (_condition is null or _condition=any(o.condition_codes))
   and (_treatment is null or o.treatment_code=_treatment)
  group by 1,2,3,4,5
 ) g;

 for _row in select (value->>'count')::integer as n,value from jsonb_array_elements(_groups) loop
  if _row.n>=11 then _kept:=_kept||_row.value; else _suppressed:=_suppressed+1; end if;
 end loop;
 -- One hole is not a hole. Take the smallest survivor with it.
 if _suppressed=1 and jsonb_array_length(_kept)>0 then
  _smallest_index:=null;
  for _row in select ordinality-1 as position,(value->>'count')::integer as n
   from jsonb_array_elements(_kept) with ordinality loop
   if _smallest is null or _row.n<_smallest then _smallest:=_row.n; _smallest_index:=_row.position; end if;
  end loop;
  _kept:=_kept-_smallest_index; _suppressed:=_suppressed+1;
 end if;
 -- A total next to a suppressed cell is the subtraction, so there is no total in that case.
 if _suppressed=0 then
  select coalesce(sum((value->>'count')::integer),0) into _total from jsonb_array_elements(_kept);
 else _total:=null; end if;

 return jsonb_build_object('action','report','groups',_kept,
  'suppressedGroups',_suppressed,'total',_total,'minimumCohort',11,
  -- Carried in the answer, not left to a screen: this is not evidence that anything works.
  'interpretation','what_happened_in_this_practice_not_evidence_of_efficacy');
end $$;
revoke all on function clinical_core.outcome_report(jsonb) from public;
grant execute on function clinical_core.outcome_report(jsonb) to clinical_core_api;
