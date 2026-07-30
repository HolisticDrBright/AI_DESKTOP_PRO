-- desktop_inbox_send_refusal_outcome
--
-- Two hardening fixes found by the acceptance suite:
--
-- 1. review_ai_suggestion was missing explicit revoke/grant lines, so the
--    schema's default privileges left it executable by anon. Revoke.
-- 2. send_message raised AFTER logging its send_refused event, which rolled
--    the event back — the durable refusal trail never persisted. The
--    provider-not-configured case is a lawful OUTCOME, not an error: it now
--    RETURNS {ok:false, sent:false, refusal:'provider_not_configured'} with
--    the draft kept and the send_refused event durable. Consent/preference
--    refusals remain typed errors (nothing about them needs an event trail).

begin;

revoke all on function public.review_ai_suggestion(uuid, text) from public, anon;
grant execute on function public.review_ai_suggestion(uuid, text) to authenticated, service_role;

create or replace function public.send_message(
  _message_id uuid, _channel text default 'alp_in_app',
  _idempotency_key text default null
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _m public.messages%rowtype; _c public.conversations%rowtype;
        _uid uuid := auth.uid(); _prefs public.communication_preferences%rowtype;
        _provider text; _key text; _existing public.message_outbox%rowtype;
begin
  if _uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into _m from public.messages where id = _message_id for update;
  if not found then raise exception 'message not found' using errcode = 'P0002'; end if;
  _c := private.inbox_thread_guard(_m.conversation_id);
  if _m.sender_user_id is distinct from _uid then
    raise exception 'only the draft author can send this draft' using errcode = '42501';
  end if;
  if _channel not in ('alp_in_app','email','sms','push') then
    raise exception 'unknown channel' using errcode = '22023';
  end if;

  _key := coalesce(nullif(btrim(coalesce(_idempotency_key,'')),''),
                   _m.id::text || ':' || _channel);
  select * into _existing from public.message_outbox where idempotency_key = _key;
  if found then
    return jsonb_build_object('ok', true, 'sent', true, 'messageId', _m.id,
      'status', _m.status, 'outboxStatus', _existing.status,
      'alreadyApplied', true, 'message', 'This send was already accepted.');
  end if;

  if _m.status <> 'draft' then
    raise exception 'only a draft can be sent; this message is %', _m.status
      using errcode = '22023';
  end if;

  select * into _prefs from public.communication_preferences
  where patient_id = _c.patient_id and organization_id = _c.organization_id;
  if _prefs.do_not_contact then
    raise exception 'this patient has do-not-contact set; sending is refused'
      using errcode = '22023';
  end if;
  if _prefs.preferred_channel = 'none' then
    raise exception 'this patient declined outbound messages; sending is refused'
      using errcode = '22023';
  end if;
  if _channel = 'email' and not coalesce(_prefs.email_ok, false) then
    raise exception 'this patient has not consented to email; sending is refused'
      using errcode = '22023';
  end if;
  if _channel = 'sms' and not coalesce(_prefs.sms_ok, false) then
    raise exception 'this patient has not consented to SMS; sending is refused'
      using errcode = '22023';
  end if;
  if _channel = 'push' and not coalesce(_prefs.push_ok, false) then
    raise exception 'this patient has not consented to push notifications; sending is refused'
      using errcode = '22023';
  end if;

  perform private.apply_urgent_invariant(_c.id, _c.organization_id, _m.body, _uid);

  _provider := private.messaging_provider_configured(_c.organization_id, _channel);
  if _provider is null then
    -- HONEST REFUSAL as a durable OUTCOME: the draft is kept, the refusal is
    -- recorded, and nothing is queued, sent, or claimed delivered.
    perform private.log_conversation_event(_c.organization_id, _c.id,
      'send_refused', 'draft', 'draft',
      'Messaging provider not configured for channel ' || _channel, _uid);
    return jsonb_build_object('ok', false, 'sent', false,
      'refusal', 'provider_not_configured', 'messageId', _m.id, 'status', 'draft',
      'message', 'Messaging provider not configured. The draft was kept; nothing was sent.');
  end if;

  insert into public.message_outbox
    (organization_id, message_id, channel, provider, status, idempotency_key)
  values (_c.organization_id, _m.id, _channel, _provider, 'queued', _key);
  update public.messages set status = 'queued', channel = _channel,
    updated_by = _uid, updated_at = now()
  where id = _m.id;
  update public.conversations set last_message_at = now(), updated_at = now()
  where id = _c.id;
  insert into public.audit_events (organization_id, actor_user_id, action,
    resource_type, resource_id, safe_message, patient_id, metadata)
  values (_c.organization_id, _uid, 'inbox.message_queued', 'message',
    _m.id::text, 'Message queued for delivery', _c.patient_id,
    jsonb_build_object('channel', _channel));
  return jsonb_build_object('ok', true, 'sent', false, 'messageId', _m.id, 'status', 'queued',
    'message', 'Message queued. It is NOT sent or delivered until the provider confirms.');
end;
$$;
revoke all on function public.send_message(uuid, text, text) from public, anon;
grant execute on function public.send_message(uuid, text, text) to authenticated, service_role;

commit;
