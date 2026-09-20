-- Production overlay: keyset-paged owner listing of privacy requests so a
-- long history is complete, not truncated at the 50 most recent. Newest first
-- by (submitted_at, id); the caller passes the last row's pair to continue. The
-- zero-argument listing is unchanged. Same owner, purpose and JSON as before.
create function clinical_core.list_owned_privacy_requests(_limit integer,_after_submitted timestamptz,_after_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor();
begin
  if clinical_private.claim('purpose') is distinct from 'consent_management' or _limit is null or _limit not between 1 and 50
    or (_after_submitted is null)<>(_after_id is null) then
    raise exception using errcode='22023',message='privacy_request_invalid';
  end if;
  return (select coalesce(jsonb_agg(clinical_private.owned_privacy_request_json(_actor,r.id) order by r.submitted_at desc,r.id desc),'[]'::jsonb)
    from (select id,submitted_at from clinical_private.owned_privacy_requests where owner_id=_actor
      and (_after_submitted is null or (submitted_at,id)<(_after_submitted,_after_id))
      order by submitted_at desc,id desc limit _limit) r);
end $$;
revoke all on function clinical_core.list_owned_privacy_requests(integer,timestamptz,uuid) from public;
grant execute on function clinical_core.list_owned_privacy_requests(integer,timestamptz,uuid) to clinical_core_api;
