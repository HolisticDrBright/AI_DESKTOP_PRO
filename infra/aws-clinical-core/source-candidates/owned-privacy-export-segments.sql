-- UNREGISTERED, BLOCKED source candidate (owned-privacy-export-segments). Applied nowhere, registered in no manifest; no
-- route, role or Lambda depends on it. The personal-storage export keeps calling clinical_core.read_owned_privacy_export
-- exactly as deployed until the separate TypeScript release switch (PRIVACY_EXPORT_SEGMENTED_READ_RELEASE in
-- src/server/clinical-core/owned-privacy-export.ts) is moved, which is Codex work after review
-- (docs/privacy-export-oversized-records-2026-10-17.md). This is NOT a production migration: the V2 launch kit binds the
-- production-migration digests, and none of them moves.
--
-- Parent: the 106-migration production chain. The file refuses to apply unless the deployed records reader
-- clinical_core.read_owned_privacy_export(uuid,text,integer,jsonb) has prosrc SHA-256
-- 8b12c598486a6de88a98a8c8c877e3fd5163260e532a126974fae4bd6a9fa5a1 and the owner derivation
-- clinical_private.owned_consumer_actor() has prosrc SHA-256
-- d716d99f9ed0e710b4c34ee11af53613a090d63904487a20c2ff8ec24aa02fd9, both SECURITY DEFINER with an empty search_path,
-- and the server encoding is UTF8.
-- Rollback: owned-privacy-export-segments-rollback.sql (drops only this function; every audit row it wrote is kept).
--
-- The defect. A saved lab analysis may be up to 262,144 bytes (20260918010000_production_owned_lab_analyses.sql), but the
-- deployed reader bounds each page to 24,576 bytes of item JSON (the RDS Data API limits each result row to 64 KiB, and
-- the reader returns one JSON field) and raises privacy_export_request_invalid when one record alone does not fit. Every
-- such owner's personal-storage copy, in the app and as a server-packaged job, is then unobtainable: every record, not
-- only the large one.
--
-- The contract, and nothing more:
--   1. clinical_core.read_owned_privacy_export_segments(_export_id, _limit, _after) reads the records section of the
--      caller's own export snapshot under exactly the deployed reader's rules: the same owner derivation, the
--      consent_management purpose, the snapshot's own cut-off and expiry, the same keyset order. It returns no consents.
--   2. Each record version is returned as one or more segments. A segment is at most 15,360 bytes of the stored payload's
--      own text (payload::text, the same octets the store's size check measures), base64-encoded without line breaks
--      (20,480 characters), so no segment needs JSON escaping and every segment fits one page.
--   3. Every segment carries the record version's identity, its received time, its consent revision, the payload's total
--      octet length, the SHA-256 of those octets and the segment count, so a reader reassembles each record and verifies
--      its size and digest before returning it, and a record that changed between segments is refused, not mixed.
--   4. Pages hold at most _limit segments and 24,576 bytes of item JSON, the deployed bound. A page can therefore always
--      return at least one segment: no record is too large to read, and no size condition raises.
--   5. _after is the deployed reader's record cursor {key, recordId, revision} (resume after that whole record version)
--      or that cursor with "segment" (resume after that segment of it). `next` is the position of the last segment
--      returned, present only when something follows.
--   6. Each call appends one clinical_audit.owned_privacy_export_events row ('records.read', the number of segments
--      returned), as the deployed reader does per page.
-- Nothing else changes: read_owned_privacy_export, start_owned_privacy_export, the export and job tables and functions,
-- the audit vocabulary and every existing grant are untouched. The function writes no record, consent or job state.

begin;

do $guard$
declare _read regprocedure := to_regprocedure('clinical_core.read_owned_privacy_export(uuid,text,integer,jsonb)');
  _actor regprocedure := to_regprocedure('clinical_private.owned_consumer_actor()');
  _p record; _expected text;
begin
  if _read is null or _actor is null
    or to_regprocedure('clinical_core.read_owned_privacy_export_segments(uuid,integer,jsonb)') is not null
    or to_regclass('clinical_private.owned_privacy_exports') is null
    or to_regclass('clinical_core.owned_consumer_record_versions') is null
    or current_setting('server_encoding') <> 'UTF8' then
    raise exception using errcode = '55000', message = 'privacy_export_segments_parent_refused';
  end if;
  for _p in select p.oid, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) as owner,
      encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') as body
    from pg_proc p where p.oid in (_read, _actor) loop
    _expected := '8b12c598486a6de88a98a8c8c877e3fd5163260e532a126974fae4bd6a9fa5a1';
    if _p.oid = _actor then _expected := 'd716d99f9ed0e710b4c34ee11af53613a090d63904487a20c2ff8ec24aa02fd9'; end if;
    if not _p.prosecdef or _p.proconfig is distinct from array['search_path=""'] or _p.owner <> current_user
      or _p.body <> _expected then
      raise exception using errcode = '55000', message = 'privacy_export_segments_parent_refused';
    end if;
  end loop;
end
$guard$;

create function clinical_core.read_owned_privacy_export_segments(_export_id uuid,_limit integer,_after jsonb default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor(); _saved clinical_private.owned_privacy_exports;
  _segment_bytes constant integer:=15360; _page_bytes constant integer:=24576;
  _out jsonb:='[]'::jsonb; _bytes integer:=2; _more boolean:=false; _r record; _payload bytea; _length integer;
  _count integer; _digest text; _first integer; _segment integer; _item jsonb; _last jsonb; _next jsonb;
  _resume boolean:=false;
begin
  if clinical_private.claim('purpose') is distinct from 'consent_management' or _export_id is null
    or _limit is null or _limit<1 or _limit>100 then
    raise exception using errcode='22023',message='privacy_export_request_invalid';
  end if;
  select * into _saved from clinical_private.owned_privacy_exports where id=_export_id and owner_id=_actor and expires_at>clock_timestamp();
  if not found then raise exception using errcode='22023',message='privacy_export_request_invalid'; end if;
  if _after is not null then
    if jsonb_typeof(_after)<>'object' or not (_after ?& array['key','recordId','revision'])
      or jsonb_typeof(_after->'key')<>'string' or length(_after->>'key')>80
      or jsonb_typeof(_after->'recordId')<>'string' or (_after->>'recordId')!~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or jsonb_typeof(_after->'revision')<>'number' or (_after->>'revision')!~'^[1-9][0-9]{0,9}$'
      or (_after->>'revision')::numeric>=2147483647
      or (_after ? 'segment' and (jsonb_typeof(_after->'segment')<>'number' or (_after->>'segment')!~'^(0|[1-9][0-9]{0,4})$'
        or (_after->>'segment')::integer>65535))
      or (_after - array['key','recordId','revision','segment'])<>'{}'::jsonb then
      raise exception using errcode='22023',message='privacy_export_request_invalid';
    end if;
    _resume:=_after ? 'segment';
  end if;
  -- The resumed record version (when the cursor names a segment) plus one more row than a page can return: a row left
  -- unread proves that something follows.
  for _r in select v.collection,v.record_id,v.revision,v.payload,v.deleted,v.consent_revision,v.received_at
    from clinical_core.owned_consumer_record_versions v
    where v.owner_id=_actor and v.received_at<=_saved.as_of
      and (_after is null
        or (not _resume and (v.collection collate "C",v.record_id,v.revision)>((_after->>'key') collate "C",(_after->>'recordId')::uuid,(_after->>'revision')::integer))
        or (_resume and (v.collection collate "C",v.record_id,v.revision)>=((_after->>'key') collate "C",(_after->>'recordId')::uuid,(_after->>'revision')::integer)))
    order by v.collection collate "C",v.record_id,v.revision limit _limit+2 loop
    _payload:=convert_to(_r.payload::text,'UTF8');
    _length:=octet_length(_payload);
    _count:=greatest(1,(_length+_segment_bytes-1)/_segment_bytes);
    _digest:=encode(sha256(_payload),'hex');
    _first:=0;
    if _resume and _r.collection=(_after->>'key') and _r.record_id=(_after->>'recordId')::uuid and _r.revision=(_after->>'revision')::integer then
      -- A cursor past the record's last segment does not describe this record.
      if (_after->>'segment')::integer>=_count then raise exception using errcode='22023',message='privacy_export_request_invalid'; end if;
      _first:=(_after->>'segment')::integer+1;
    end if;
    for _segment in _first.._count-1 loop
      _item:=jsonb_build_object('collection',_r.collection,'recordId',_r.record_id,'revision',_r.revision,'deleted',_r.deleted,
        'consentRevision',_r.consent_revision,'receivedAt',_r.received_at,'payloadBytes',_length,'payloadSha256',_digest,
        'segment',_segment,'segmentCount',_count,
        'data',translate(encode(substring(_payload from _segment*_segment_bytes+1 for _segment_bytes),'base64'),E'\n',''));
      if jsonb_array_length(_out)>=_limit or _bytes+octet_length(_item::text)+2>_page_bytes then _more:=true; exit; end if;
      _out:=_out||jsonb_build_array(_item); _bytes:=_bytes+octet_length(_item::text)+2;
    end loop;
    exit when _more;
  end loop;
  -- Unreachable while a segment item is at most 20,480 base64 characters plus its fixed fields; never a size refusal.
  if _more and jsonb_array_length(_out)=0 then raise exception using errcode='XX000',message='privacy_export_segment_unbounded'; end if;
  if _more then
    _last:=_out->(jsonb_array_length(_out)-1);
    _next:=jsonb_build_object('key',_last->'collection','recordId',_last->'recordId','revision',_last->'revision','segment',_last->'segment');
  end if;
  insert into clinical_audit.owned_privacy_export_events(owner_id,export_id,action,row_count)
    values(_actor,_export_id,'records.read',jsonb_array_length(_out));
  return jsonb_build_object('exportId',_saved.id,'asOf',_saved.as_of,'section','records','segmentBytes',_segment_bytes,
    'items',_out,'next',_next);
end $$;
revoke all on function clinical_core.read_owned_privacy_export_segments(uuid,integer,jsonb) from public;
grant execute on function clinical_core.read_owned_privacy_export_segments(uuid,integer,jsonb) to clinical_core_api;

do $post$
declare _fn regprocedure := to_regprocedure('clinical_core.read_owned_privacy_export_segments(uuid,integer,jsonb)');
begin
  if _fn is null or not has_function_privilege('clinical_core_api', _fn, 'EXECUTE')
    or has_function_privilege('public', _fn, 'EXECUTE')
    or not exists (select 1 from pg_proc p where p.oid = _fn and p.prosecdef and p.proconfig = array['search_path=""']::text[]) then
    raise exception using errcode = '55000', message = 'privacy_export_segments_install_refused';
  end if;
end
$post$;
commit;
