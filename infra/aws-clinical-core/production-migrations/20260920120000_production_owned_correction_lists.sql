-- Production overlay: corrections reach lists. A path segment may be an array
-- index, so a scalar leaf inside a list (a dose in the second medication) is
-- addressable, and a leaf that is a list of plain values (allergies, tags) may
-- be replaced as a whole by another list of plain values. The exact-delta rule
-- is unchanged: the successor must equal the reviewed payload with only that
-- leaf changed (jsonb_set follows the same path). Lists of objects, objects and
-- null leaves still need a domain-specific workflow; signed practitioner notes
-- are never touched here (they have their own addendum path in Desktop).
create or replace function clinical_private.owned_correction_path(_field text) returns text[]
language plpgsql immutable set search_path='' as $$
declare _path text[]; _segment text;
begin
  if _field is null or char_length(_field) not between 1 and 240 then raise exception using errcode='22023',message='privacy_correction_invalid'; end if;
  _path:=string_to_array(_field,'.');
  if cardinality(_path) not between 1 and 6 then raise exception using errcode='22023',message='privacy_correction_invalid'; end if;
  foreach _segment in array _path loop
    if _segment is null or char_length(_segment) not between 1 and 80 or _segment in ('__proto__','prototype','constructor')
      or (_segment ~ '^[0-9-]' and _segment !~ '^(0|[1-9][0-9]{0,3})$') then
      raise exception using errcode='22023',message='privacy_correction_invalid'; end if;
  end loop;
  return _path;
end $$;

-- True when every element of a JSON array is a string, number or boolean and the list is bounded.
create function clinical_private.owned_correction_scalar_list(_value jsonb) returns boolean
language sql immutable set search_path='' as $$
  select _value is not null and jsonb_typeof(_value)='array' and jsonb_array_length(_value)<=200
    and not exists(select 1 from jsonb_array_elements(_value) e where jsonb_typeof(e) not in ('string','number','boolean'))
$$;
revoke all on function clinical_private.owned_correction_scalar_list(jsonb) from public,clinical_core_api;

create or replace function clinical_core.submit_owned_privacy_request(_request_id uuid,_kind text,_correction jsonb default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor(); _saved clinical_private.owned_privacy_requests;
  _target clinical_core.owned_consumer_record_versions; _result jsonb; _expected integer; _record uuid; _path text[]; _leaf jsonb; _requested jsonb;
begin
  if _kind is distinct from 'correction' then
    return clinical_core.submit_owned_privacy_request_v1(_request_id,_kind,_correction);
  end if;
  if clinical_private.claim('purpose') is distinct from 'consent_management' or _request_id is null
    or _correction is null or jsonb_typeof(_correction)<>'object' or octet_length(_correction::text)>16384
    or (select count(*) from jsonb_object_keys(_correction))<>8
    or not (_correction ?& array['collection','recordId','expectedRevision','expectedPayloadSha256','field','requestedValue','reason','version'])
    or _correction->>'version' is distinct from 'personal-correction/1'
    or jsonb_typeof(_correction->'collection')<>'string' or jsonb_typeof(_correction->'field')<>'string'
    or jsonb_typeof(_correction->'reason')<>'string' or char_length(btrim(_correction->>'reason')) not between 1 and 2000
    or char_length(_correction->>'field') not between 1 and 240
    or (jsonb_typeof(_correction->'requestedValue') not in ('string','number','boolean') and not clinical_private.owned_correction_scalar_list(_correction->'requestedValue'))
    or jsonb_typeof(_correction->'expectedRevision')<>'number' or (_correction->>'expectedRevision') !~ '^[1-9][0-9]{0,8}$'
    or jsonb_typeof(_correction->'recordId')<>'string' or (_correction->>'recordId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or jsonb_typeof(_correction->'expectedPayloadSha256')<>'string' or (_correction->>'expectedPayloadSha256') !~ '^[a-f0-9]{64}$' then
    raise exception using errcode='22023',message='privacy_correction_invalid';
  end if;
  _expected:=(_correction->>'expectedRevision')::integer; _record:=(_correction->>'recordId')::uuid;
  perform pg_advisory_xact_lock(hashtextextended(_actor::text,0));
  select * into _saved from clinical_private.owned_privacy_requests where owner_id=_actor and request_id=_request_id;
  if found then
    if _saved.kind<>'correction' or _saved.correction is distinct from _correction then
      raise exception using errcode='40001',message='privacy_request_conflict';
    end if;
    return clinical_private.owned_privacy_request_json(_actor,_saved.id)||jsonb_build_object('duplicate',true);
  end if;
  select * into _target from clinical_core.owned_consumer_record_versions where owner_id=_actor
    and collection=_correction->>'collection' and record_id=_record order by revision desc limit 1;
  if not found or _target.deleted or _target.revision<>_expected
    or encode(public.digest(_target.payload::text,'sha256'),'hex')<>_correction->>'expectedPayloadSha256' then
    raise exception using errcode='40001',message='privacy_correction_target_changed';
  end if;
  _path:=clinical_private.owned_correction_path(_correction->>'field');
  _leaf:=_target.payload #> _path; _requested:=_correction->'requestedValue';
  -- The path must reach an existing leaf of the same shape as the request: a scalar for a scalar, a list of plain values for a list.
  if _leaf is null or _leaf=_requested
    or (jsonb_typeof(_requested) in ('string','number','boolean') and jsonb_typeof(_leaf) not in ('string','number','boolean'))
    or (jsonb_typeof(_requested)='array' and not clinical_private.owned_correction_scalar_list(_leaf)) then
    raise exception using errcode='22023',message='privacy_correction_invalid';
  end if;
  _result:=clinical_core.submit_owned_privacy_request_v1(_request_id,_kind,_correction);
  insert into clinical_private.owned_correction_targets(privacy_request_id,collection,record_id,expected_revision,expected_payload_sha256,field,request_sha256)
    values((_result->>'privacyRequestId')::uuid,_target.collection,_target.record_id,_target.revision,
      _correction->>'expectedPayloadSha256',_correction->>'field',encode(public.digest(_correction::text,'sha256'),'hex'));
  return clinical_private.owned_privacy_request_json(_actor,(_result->>'privacyRequestId')::uuid)||jsonb_build_object('duplicate',false);
end $$;
