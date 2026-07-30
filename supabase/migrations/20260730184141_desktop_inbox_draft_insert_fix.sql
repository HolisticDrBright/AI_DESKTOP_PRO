-- desktop_inbox_draft_insert_fix
--
-- save_message_draft referenced messages.created_by, a column the legacy
-- messages table never had (authorship lives in sender_user_id). Drop it
-- from the insert; everything else is unchanged.

begin;

create or replace function public.save_message_draft(
  _conversation_id uuid, _body text,
  _message_id uuid default null, _expected_version integer default null
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _c public.conversations%rowtype; _uid uuid := auth.uid();
        _m public.messages%rowtype; _new_version integer;
begin
  _c := private.inbox_thread_guard(_conversation_id);
  if coalesce(btrim(_body),'') = '' then
    raise exception 'a draft needs a body' using errcode = '22023';
  end if;
  if length(_body) > 20000 then
    raise exception 'draft too long' using errcode = '22023';
  end if;

  if _message_id is null then
    select * into _m from public.messages
    where conversation_id = _conversation_id and sender_user_id = _uid
      and status = 'draft'
    order by created_at desc limit 1
    for update;
  else
    select * into _m from public.messages where id = _message_id for update;
    if not found then raise exception 'message not found' using errcode = 'P0002'; end if;
    if _m.conversation_id is distinct from _conversation_id then
      raise exception 'message does not belong to this conversation' using errcode = '42501';
    end if;
  end if;

  if _m.id is null then
    insert into public.messages
      (organization_id, conversation_id, patient_id, sender_user_id, body,
       is_from_patient, status, channel, version, updated_by, updated_at)
    values
      (_c.organization_id, _conversation_id, _c.patient_id, _uid, _body,
       false, 'draft', 'in_app', 1, _uid, now())
    returning * into _m;
    insert into public.message_draft_revisions
      (organization_id, message_id, version, body, saved_by)
    values (_c.organization_id, _m.id, 1, _body, _uid);
    return jsonb_build_object('ok', true, 'messageId', _m.id, 'version', 1,
      'message', 'Draft saved.');
  end if;

  if _m.sender_user_id is distinct from _uid then
    raise exception 'only the draft author can edit this draft' using errcode = '42501';
  end if;
  if _m.status <> 'draft' then
    raise exception 'only a draft can be edited; this message is %', _m.status
      using errcode = '22023';
  end if;
  if _expected_version is not null and _expected_version is distinct from _m.version then
    raise exception 'this draft changed elsewhere since it was loaded' using errcode = '40001';
  end if;
  _new_version := _m.version + 1;
  update public.messages set body = _body, version = _new_version,
    updated_by = _uid, updated_at = now()
  where id = _m.id;
  insert into public.message_draft_revisions
    (organization_id, message_id, version, body, saved_by)
  values (_c.organization_id, _m.id, _new_version, _body, _uid);
  return jsonb_build_object('ok', true, 'messageId', _m.id, 'version', _new_version,
    'message', 'Draft saved.');
end;
$$;
revoke all on function public.save_message_draft(uuid, text, uuid, integer) from public, anon;
grant execute on function public.save_message_draft(uuid, text, uuid, integer) to authenticated, service_role;

commit;
