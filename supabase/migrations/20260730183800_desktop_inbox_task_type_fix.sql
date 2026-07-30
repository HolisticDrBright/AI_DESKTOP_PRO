-- desktop_inbox_task_type_fix
--
-- create_task_from_message wrote item_type/status values outside the
-- review_queue_items check constraints ('message_follow_up'/'pending').
-- Use the registry's lawful values: item_type 'patient_message', status 'open'.

begin;

create or replace function public.create_task_from_message(
  _message_id uuid, _title text default null, _priority text default 'medium'
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _m public.messages%rowtype; _c public.conversations%rowtype;
        _uid uuid := auth.uid(); _existing uuid; _tid uuid;
begin
  if _uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into _m from public.messages where id = _message_id;
  if not found then raise exception 'message not found' using errcode = 'P0002'; end if;
  _c := private.inbox_thread_guard(_m.conversation_id);
  if _priority not in ('low','medium','high') then
    raise exception 'unknown task priority' using errcode = '22023';
  end if;

  select id into _existing from public.review_queue_items
  where ref_id = _m.id and deleted_at is null and status not in ('resolved','dismissed')
  limit 1;
  if _existing is not null then
    return jsonb_build_object('ok', true, 'taskId', _existing, 'alreadyCreated', true,
      'message', 'A task for this message already exists.');
  end if;

  insert into public.review_queue_items
    (organization_id, patient_id, item_type, ref_id, title, priority, status,
     created_by, updated_by)
  values (_c.organization_id, _c.patient_id, 'patient_message', _m.id,
     left(coalesce(nullif(btrim(coalesce(_title,'')),''),
       'Follow up on patient message'), 200),
     _priority, 'open', _uid, _uid)
  returning id into _tid;
  perform private.log_conversation_event(_c.organization_id, _c.id, 'task_created',
    null, _tid::text, null, _uid);
  insert into public.audit_events (organization_id, actor_user_id, action,
    resource_type, resource_id, safe_message, patient_id, metadata)
  values (_c.organization_id, _uid, 'inbox.task_created', 'review_queue_item',
    _tid::text, 'Task created from a message', _c.patient_id,
    jsonb_build_object('messageId', _m.id));
  return jsonb_build_object('ok', true, 'taskId', _tid, 'alreadyCreated', false,
    'message', 'Task created in the review queue.');
end;
$$;
revoke all on function public.create_task_from_message(uuid, text, text) from public, anon;
grant execute on function public.create_task_from_message(uuid, text, text) to authenticated, service_role;

commit;
