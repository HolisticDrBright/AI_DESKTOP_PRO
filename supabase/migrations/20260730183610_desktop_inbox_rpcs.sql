-- desktop_inbox_rpcs
--
-- The read + mutation layer for the Phase 4 Inbox. Contract identical to the
-- protocol/program RPCs: SECURITY DEFINER, pinned empty search_path, explicit
-- auth + membership + patient-access gates, tenant agreement across every
-- referenced record, bounded outputs, typed errors (28000/42501/P0002/22023/
-- 40001), PHI-safe audit metadata, anon+public execution revoked.
--
-- Server-generated authority: identity (the sender is ALWAYS auth.uid() — a
-- caller cannot claim another sender), organization, thread workflow state,
-- message lifecycle, consent/preference enforcement, urgent flagging, and
-- delivery evidence all come from the database — never from client claims.
--
-- NOT PRESENT, deliberately: any code path that contacts a provider, marks a
-- message sent or delivered without provider acknowledgment, sends anything
-- from AI output, authorizes a refill, diagnoses, orders, prescribes,
-- schedules, charges, or signs. With no configured messaging provider,
-- send_message REFUSES and the draft is kept — nothing pretends to be sent.

begin;

-- ------------------------------------------------------------- helpers
-- Inbox handling: any ACTIVE member of the organization (practitioners and
-- staff both work the inbox; patient visibility still flows through
-- private.can_access_patient on every read and mutation).
create or replace function private.can_handle_inbox(_organization_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.organization_memberships m
    where m.organization_id = _organization_id
      and m.user_id = auth.uid()
      and m.status = 'active'
      and m.role in ('owner','admin','practitioner','staff')
  );
$$;
revoke all on function private.can_handle_inbox(uuid) from public, anon;
grant execute on function private.can_handle_inbox(uuid) to authenticated, service_role;

-- A messaging provider is configured only when a connected messaging
-- connector exists for the organization. This repository ships NO provider,
-- so in production this is false and sending refuses.
create or replace function private.messaging_provider_configured(_organization_id uuid, _channel text)
returns text language sql stable security definer set search_path = ''
as $$
  select c.provider from public.connectors c
  where c.organization_id = _organization_id
    and c.kind = 'messaging'
    and c.sync_status = 'connected'
    and (c.scopes ? _channel)
  limit 1;
$$;
revoke all on function private.messaging_provider_configured(uuid, text) from public, anon;
grant execute on function private.messaging_provider_configured(uuid, text) to authenticated, service_role;

-- Load + guard a conversation for the CALLER (auth + membership + access).
create or replace function private.inbox_thread_guard(_conversation_id uuid)
returns public.conversations language plpgsql stable security definer set search_path = ''
as $$
declare _c public.conversations%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  select * into _c from public.conversations
  where id = _conversation_id and deleted_at is null;
  if not found then raise exception 'conversation not found' using errcode = 'P0002'; end if;
  if not private.can_handle_inbox(_c.organization_id)
     or not private.can_access_patient(_c.patient_id) then
    raise exception 'not authorized for this conversation' using errcode = '42501';
  end if;
  return _c;
end;
$$;
revoke all on function private.inbox_thread_guard(uuid) from public, anon;
grant execute on function private.inbox_thread_guard(uuid) to authenticated, service_role;

create or replace function private.log_conversation_event(
  _organization_id uuid, _conversation_id uuid, _kind text,
  _from text, _to text, _note text, _actor uuid
) returns void language sql security definer set search_path = ''
as $$
  insert into public.conversation_events
    (organization_id, conversation_id, kind, from_value, to_value, note, actor_user_id)
  values (_organization_id, _conversation_id, _kind, _from, _to, left(_note, 500), _actor);
$$;
revoke all on function private.log_conversation_event(uuid, uuid, text, text, text, text, uuid) from public, anon;
grant execute on function private.log_conversation_event(uuid, uuid, text, text, text, text, uuid) to authenticated, service_role;

-- Apply the deterministic urgent-language invariant to a thread. It can only
-- ELEVATE (set the flag, record the matched dictionary terms, raise priority
-- to urgent); it never clears a flag, diagnoses, or claims an emergency.
create or replace function private.apply_urgent_invariant(
  _conversation_id uuid, _organization_id uuid, _body text, _actor uuid
) returns void language plpgsql security definer set search_path = ''
as $$
declare _terms text[];
begin
  _terms := private.detect_urgent_language(_body);
  if coalesce(array_length(_terms, 1), 0) > 0 then
    update public.conversations set
      urgent_flag = true,
      urgent_terms = (select array(select distinct t from unnest(urgent_terms || _terms) t)),
      priority = 'urgent',
      updated_at = now()
    where id = _conversation_id;
    perform private.log_conversation_event(_organization_id, _conversation_id,
      'urgent_flagged', null, array_to_string(_terms, ', '),
      'Deterministic urgent-language check matched; immediate human review suggested', _actor);
  end if;
end;
$$;
revoke all on function private.apply_urgent_invariant(uuid, uuid, text, uuid) from public, anon;
grant execute on function private.apply_urgent_invariant(uuid, uuid, text, uuid) to authenticated, service_role;

-- ------------------------------------------------------------- list_inbox
create or replace function public.list_inbox(
  _organization_id uuid,
  _query text default null,
  _category text default null,
  _priority text default null,
  _status text default null,
  _queue text default null,
  _assigned_to_me boolean default false,
  _unread_only boolean default false,
  _due_only boolean default false,
  _limit integer default 50
) returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare _uid uuid := auth.uid(); _q text; _n integer; _rows jsonb; _counts jsonb;
begin
  if _uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not private.can_handle_inbox(_organization_id) then
    raise exception 'not a member of this organization' using errcode = '42501';
  end if;
  _q := nullif(btrim(coalesce(_query,'')),'');
  _n := least(greatest(coalesce(_limit,50),1),100);

  select coalesce(jsonb_agg(r order by (r->>'urgent')::boolean desc, r->>'lastMessageAt' desc nulls last), '[]'::jsonb)
  into _rows
  from (
    select jsonb_build_object(
      'id', c.id,
      'subject', c.subject,
      'category', c.category,
      'priority', c.priority,
      'status', c.status,
      'assignedTo', c.assigned_to,
      'assignedQueue', c.assigned_queue,
      'followUpAt', c.follow_up_at,
      'snoozedUntil', c.snoozed_until,
      'urgent', c.urgent_flag,
      'urgentTerms', to_jsonb(c.urgent_terms),
      'version', c.version,
      'lastMessageAt', c.last_message_at,
      'patientId', c.patient_id,
      'patientName', btrim(coalesce(pp.first_name,'') || ' ' || coalesce(pp.last_name,'')),
      'unreadCount', (select count(*) from public.messages m
                      where m.conversation_id = c.id
                        and m.status = 'inbound' and m.read_at is null),
      'messageCount', (select count(*) from public.messages m
                       where m.conversation_id = c.id and m.status <> 'superseded')
    ) as r
    from public.conversations c
    join public.patient_profiles pp on pp.id = c.patient_id
    where c.organization_id = _organization_id
      and c.deleted_at is null
      and private.can_access_patient(c.patient_id)
      and (_status is null or c.status = _status)
      and (_category is null or c.category = _category)
      and (_priority is null or c.priority = _priority)
      and (_queue is null or c.assigned_queue = _queue)
      and (not _assigned_to_me or c.assigned_to = _uid)
      and (not _unread_only or exists (select 1 from public.messages m
             where m.conversation_id = c.id and m.status = 'inbound' and m.read_at is null))
      and (not _due_only or (c.follow_up_at is not null and c.follow_up_at <= now() + interval '1 day'))
      and (_q is null
           or coalesce(c.subject,'') ilike '%'||_q||'%'
           or btrim(coalesce(pp.first_name,'')||' '||coalesce(pp.last_name,'')) ilike '%'||_q||'%')
    limit _n
  ) s;

  -- Counts are counts of PERSISTED rows the caller can see. Nothing projected.
  select jsonb_build_object(
    'open',    count(*) filter (where c.status = 'open'),
    'snoozed', count(*) filter (where c.status = 'snoozed'),
    'resolved',count(*) filter (where c.status = 'resolved'),
    'urgent',  count(*) filter (where c.urgent_flag and c.status <> 'resolved'),
    'unread',  count(*) filter (where exists (select 1 from public.messages m
                 where m.conversation_id = c.id and m.status = 'inbound' and m.read_at is null)),
    'dueSoon', count(*) filter (where c.follow_up_at is not null
                 and c.follow_up_at <= now() + interval '1 day' and c.status <> 'resolved'),
    'mine',    count(*) filter (where c.assigned_to = _uid and c.status <> 'resolved')
  ) into _counts
  from public.conversations c
  where c.organization_id = _organization_id and c.deleted_at is null
    and private.can_access_patient(c.patient_id);

  return jsonb_build_object('threads', _rows, 'counts', _counts, 'generatedAt', now());
end;
$$;

-- -------------------------------------------------------- get_conversation
create or replace function public.get_conversation(_conversation_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare _c public.conversations%rowtype; _uid uuid := auth.uid();
begin
  _c := private.inbox_thread_guard(_conversation_id);
  return jsonb_build_object(
    'conversation', jsonb_build_object(
      'id', _c.id, 'subject', _c.subject, 'category', _c.category,
      'priority', _c.priority, 'status', _c.status,
      'assignedTo', _c.assigned_to, 'assignedQueue', _c.assigned_queue,
      'followUpAt', _c.follow_up_at, 'snoozedUntil', _c.snoozed_until,
      'urgent', _c.urgent_flag, 'urgentTerms', to_jsonb(_c.urgent_terms),
      'version', _c.version, 'lastMessageAt', _c.last_message_at,
      'createdAt', _c.created_at),
    'patient', (select jsonb_build_object('id', pp.id,
        'name', btrim(coalesce(pp.first_name,'')||' '||coalesce(pp.last_name,'')))
      from public.patient_profiles pp where pp.id = _c.patient_id),
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id, 'body', m.body, 'status', m.status, 'channel', m.channel,
        'isFromPatient', m.is_from_patient, 'senderUserId', m.sender_user_id,
        'isMine', m.sender_user_id = _uid,
        'version', m.version, 'readAt', m.read_at, 'sentAt', m.sent_at,
        'deliveredAt', m.delivered_at, 'failedReason', m.failed_reason_safe,
        'createdAt', m.created_at, 'updatedAt', m.updated_at
      ) order by m.created_at)
      from (select * from public.messages mm
            where mm.conversation_id = _c.id and mm.status <> 'superseded'
            order by mm.created_at limit 200) m), '[]'::jsonb),
    'attachments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'messageId', a.message_id, 'fileName', a.file_name,
        'contentType', a.content_type, 'byteSize', a.byte_size,
        'storageProvider', a.storage_provider,
        'accessible', a.storage_provider <> 'none',
        'createdAt', a.created_at) order by a.created_at)
      from public.message_attachments a
      where a.conversation_id = _c.id and a.deleted_at is null), '[]'::jsonb),
    'preferences', (select jsonb_build_object(
        'preferredChannel', p.preferred_channel, 'emailOk', p.email_ok,
        'smsOk', p.sms_ok, 'pushOk', p.push_ok, 'doNotContact', p.do_not_contact,
        'consentId', p.consent_id, 'note', p.note, 'updatedAt', p.updated_at)
      from public.communication_preferences p
      where p.patient_id = _c.patient_id and p.organization_id = _c.organization_id),
    'consents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', cs.id, 'type', cs.consent_type, 'status', cs.status,
        'grantedAt', cs.granted_at, 'revokedAt', cs.revoked_at) order by cs.created_at desc)
      from (select * from public.consents c2
            where c2.patient_id = _c.patient_id and c2.deleted_at is null
            order by c2.created_at desc limit 10) cs), '[]'::jsonb),
    'aiReviews', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id, 'kind', r.kind, 'content', r.content, 'status', r.status,
        'provider', r.provider, 'model', r.model, 'promptVersion', r.prompt_version,
        'schemaVersion', r.schema_version, 'createdAt', r.created_at,
        'reviewedAt', r.reviewed_at) order by r.created_at desc)
      from (select * from public.message_ai_reviews ar
            where ar.conversation_id = _c.id
            order by ar.created_at desc limit 30) r), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'kind', e.kind, 'fromValue', e.from_value, 'toValue', e.to_value,
        'note', e.note, 'createdAt', e.created_at) order by e.created_at desc)
      from (select * from public.conversation_events ce
            where ce.conversation_id = _c.id
            order by ce.created_at desc limit 50) e), '[]'::jsonb),
    'outbox', coalesce((
      select jsonb_agg(jsonb_build_object(
        'messageId', o.message_id, 'channel', o.channel, 'status', o.status,
        'attempts', o.attempts, 'nextRetryAt', o.next_retry_at,
        'lastError', o.last_error_safe) order by o.created_at desc)
      from public.message_outbox o
      join public.messages m2 on m2.id = o.message_id
      where m2.conversation_id = _c.id), '[]'::jsonb),
    'generatedAt', now());
end;
$$;

-- ------------------------------------------------------ create_conversation
create or replace function public.create_conversation(
  _organization_id uuid, _patient_id uuid, _subject text,
  _category text default 'general', _priority text default 'normal'
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _uid uuid := auth.uid(); _cid uuid;
begin
  if _uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not private.can_handle_inbox(_organization_id) then
    raise exception 'not a member of this organization' using errcode = '42501';
  end if;
  if not private.can_access_patient(_patient_id) then
    raise exception 'not authorized for this patient' using errcode = '42501';
  end if;
  if not exists (select 1 from public.patient_profiles pp
                 where pp.id = _patient_id and pp.organization_id = _organization_id
                   and pp.deleted_at is null) then
    raise exception 'patient does not belong to this organization' using errcode = '42501';
  end if;
  if coalesce(btrim(_subject),'') = '' then
    raise exception 'a subject is required' using errcode = '22023';
  end if;
  if _category not in ('general','clinical_question','refill','lab','wearable_alert',
                       'scheduling','billing','program_check_in','protocol_adherence','administrative') then
    raise exception 'unknown category' using errcode = '22023';
  end if;
  if _priority not in ('low','normal','high','urgent') then
    raise exception 'unknown priority' using errcode = '22023';
  end if;

  insert into public.conversations
    (organization_id, patient_id, subject, status, category, priority,
     assigned_queue, created_by, updated_by)
  values (_organization_id, _patient_id, left(btrim(_subject), 300), 'open',
     _category, _priority,
     case when _category in ('scheduling','billing','administrative') then 'staff'
          else 'practitioner' end,
     _uid, _uid)
  returning id into _cid;
  perform private.log_conversation_event(_organization_id, _cid, 'created',
    null, _category, null, _uid);
  perform private.apply_urgent_invariant(_cid, _organization_id, _subject, _uid);
  insert into public.audit_events (organization_id, actor_user_id, action,
    resource_type, resource_id, safe_message, patient_id, metadata)
  values (_organization_id, _uid, 'inbox.thread_created', 'conversation',
    _cid::text, 'Conversation created', _patient_id,
    jsonb_build_object('category', _category));
  return jsonb_build_object('ok', true, 'conversationId', _cid,
    'message', 'Conversation created.');
end;
$$;

-- ------------------------------------------------------ save_message_draft
-- The sender is ALWAYS the authenticated caller: there is no sender
-- parameter, and editing another user's draft is refused. Draft edits are
-- versioned (append-only revisions) with optimistic concurrency.
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
    -- One open draft per author per thread.
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
       is_from_patient, status, channel, version, created_by, updated_by, updated_at)
    values
      (_c.organization_id, _conversation_id, _c.patient_id, _uid, _body,
       false, 'draft', 'in_app', 1, _uid, _uid, now())
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

create or replace function public.cancel_message_draft(_message_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _m public.messages%rowtype; _uid uuid := auth.uid();
begin
  if _uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into _m from public.messages where id = _message_id for update;
  if not found then raise exception 'message not found' using errcode = 'P0002'; end if;
  perform private.inbox_thread_guard(_m.conversation_id);
  if _m.sender_user_id is distinct from _uid then
    raise exception 'only the draft author can cancel this draft' using errcode = '42501';
  end if;
  if _m.status <> 'draft' then
    raise exception 'only a draft can be cancelled' using errcode = '22023';
  end if;
  update public.messages set status = 'cancelled', updated_by = _uid, updated_at = now()
  where id = _m.id;
  return jsonb_build_object('ok', true, 'messageId', _m.id, 'message', 'Draft cancelled.');
end;
$$;

-- ------------------------------------------------------------ send_message
-- FAIL-CLOSED SENDING. Consent and preferences are enforced here, the urgent
-- invariant runs here, and without a connected messaging provider this
-- REFUSES: the draft is kept, a send_refused event is recorded, and nothing
-- is marked queued, sent, or delivered. When a provider exists (none ships in
-- this repository), the message becomes 'queued' with a durable outbox row —
-- 'sent'/'delivered' remain reachable ONLY through provider callbacks.
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

  -- Idempotent replay: if this send already succeeded, return the stored
  -- outcome instead of acting twice.
  _key := coalesce(nullif(btrim(coalesce(_idempotency_key,'')),''),
                   _m.id::text || ':' || _channel);
  select * into _existing from public.message_outbox where idempotency_key = _key;
  if found then
    return jsonb_build_object('ok', true, 'messageId', _m.id,
      'status', _m.status, 'outboxStatus', _existing.status,
      'alreadyApplied', true, 'message', 'This send was already accepted.');
  end if;

  if _m.status <> 'draft' then
    raise exception 'only a draft can be sent; this message is %', _m.status
      using errcode = '22023';
  end if;

  -- Consent + preference enforcement (server-side, never a client claim).
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

  -- The deterministic urgent invariant runs on outbound content too.
  perform private.apply_urgent_invariant(_c.id, _c.organization_id, _m.body, _uid);

  _provider := private.messaging_provider_configured(_c.organization_id, _channel);
  if _provider is null then
    -- HONEST REFUSAL: the draft is kept; nothing is queued, sent, or claimed.
    perform private.log_conversation_event(_c.organization_id, _c.id,
      'send_refused', 'draft', 'draft',
      'Messaging provider not configured for channel ' || _channel, _uid);
    raise exception 'Messaging provider not configured; the draft was kept and nothing was sent'
      using errcode = '22023';
  end if;

  -- Provider path (unreachable in this repository until a provider is
  -- registered): durable outbox + queued message. Never 'sent' here.
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
  return jsonb_build_object('ok', true, 'messageId', _m.id, 'status', 'queued',
    'message', 'Message queued. It is NOT sent or delivered until the provider confirms.');
end;
$$;

-- ------------------------------------------------- mark_conversation_read
create or replace function public.mark_conversation_read(_conversation_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _c public.conversations%rowtype; _uid uuid := auth.uid(); _n integer;
begin
  _c := private.inbox_thread_guard(_conversation_id);
  update public.messages set read_at = now()
  where conversation_id = _conversation_id and status = 'inbound' and read_at is null;
  get diagnostics _n = row_count;
  if _n > 0 then
    perform private.log_conversation_event(_c.organization_id, _c.id, 'read',
      null, _n::text, null, _uid);
  end if;
  return jsonb_build_object('ok', true, 'markedRead', _n,
    'message', case when _n = 0 then 'Nothing unread.' else 'Marked read.' end);
end;
$$;

-- ------------------------------------------- update_conversation_workflow
-- Assignment / queue / priority / category / status / snooze / follow-up.
-- The status machine and optimistic concurrency live HERE, not in React.
create or replace function public.update_conversation_workflow(
  _conversation_id uuid, _action text, _expected_version integer,
  _value text default null, _at timestamptz default null, _note text default null
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _c public.conversations%rowtype; _uid uuid := auth.uid(); _from text; _ok boolean;
begin
  _c := private.inbox_thread_guard(_conversation_id);
  perform 1 from public.conversations where id = _conversation_id for update;
  select * into _c from public.conversations where id = _conversation_id;
  if _expected_version is distinct from _c.version then
    raise exception 'this conversation changed elsewhere since it was loaded'
      using errcode = '40001';
  end if;

  if _action = 'assign' then
    if _value is not null and not exists (
      select 1 from public.organization_memberships m
      where m.organization_id = _c.organization_id
        and m.user_id = _value::uuid and m.status = 'active') then
      raise exception 'assignee is not an active member of this organization'
        using errcode = '22023';
    end if;
    _from := _c.assigned_to::text;
    update public.conversations set assigned_to = _value::uuid,
      version = version + 1, updated_by = _uid, updated_at = now()
    where id = _c.id;
    perform private.log_conversation_event(_c.organization_id, _c.id, 'assigned',
      _from, _value, _note, _uid);

  elsif _action = 'queue' then
    if _value not in ('practitioner','staff') then
      raise exception 'unknown queue' using errcode = '22023';
    end if;
    _from := _c.assigned_queue;
    update public.conversations set assigned_queue = _value,
      version = version + 1, updated_by = _uid, updated_at = now()
    where id = _c.id;
    perform private.log_conversation_event(_c.organization_id, _c.id, 'queue_changed',
      _from, _value, _note, _uid);

  elsif _action = 'priority' then
    if _value not in ('low','normal','high','urgent') then
      raise exception 'unknown priority' using errcode = '22023';
    end if;
    _from := _c.priority;
    update public.conversations set priority = _value,
      version = version + 1, updated_by = _uid, updated_at = now()
    where id = _c.id;
    perform private.log_conversation_event(_c.organization_id, _c.id, 'priority_changed',
      _from, _value, _note, _uid);

  elsif _action = 'category' then
    if _value not in ('general','clinical_question','refill','lab','wearable_alert',
                      'scheduling','billing','program_check_in','protocol_adherence','administrative') then
      raise exception 'unknown category' using errcode = '22023';
    end if;
    _from := _c.category;
    update public.conversations set category = _value,
      version = version + 1, updated_by = _uid, updated_at = now()
    where id = _c.id;
    perform private.log_conversation_event(_c.organization_id, _c.id, 'category_changed',
      _from, _value, _note, _uid);

  elsif _action = 'status' then
    _ok := (_c.status = 'open' and _value in ('snoozed','resolved'))
        or (_c.status = 'snoozed' and _value in ('open','resolved'))
        or (_c.status = 'resolved' and _value = 'open');
    if not _ok then
      raise exception 'a % conversation cannot move to %', _c.status, _value
        using errcode = '22023';
    end if;
    if _value = 'snoozed' and _at is null then
      raise exception 'snoozing needs a wake time' using errcode = '22023';
    end if;
    _from := _c.status;
    update public.conversations set status = _value,
      snoozed_until = case when _value = 'snoozed' then _at else null end,
      version = version + 1, updated_by = _uid, updated_at = now()
    where id = _c.id;
    perform private.log_conversation_event(_c.organization_id, _c.id,
      case when _value = 'snoozed' then 'snoozed'
           when _from = 'snoozed' and _value = 'open' then 'unsnoozed'
           else 'status_changed' end,
      _from, _value, _note, _uid);
    insert into public.audit_events (organization_id, actor_user_id, action,
      resource_type, resource_id, safe_message, patient_id, metadata)
    values (_c.organization_id, _uid, 'inbox.thread_' || _value, 'conversation',
      _c.id::text, 'Conversation ' || _value, _c.patient_id,
      jsonb_build_object('from', _from));

  elsif _action = 'follow_up' then
    _from := _c.follow_up_at::text;
    update public.conversations set follow_up_at = _at,
      version = version + 1, updated_by = _uid, updated_at = now()
    where id = _c.id;
    perform private.log_conversation_event(_c.organization_id, _c.id,
      case when _at is null then 'follow_up_cleared' else 'follow_up_set' end,
      _from, _at::text, _note, _uid);

  else
    raise exception 'unknown workflow action' using errcode = '22023';
  end if;

  select * into _c from public.conversations where id = _conversation_id;
  return jsonb_build_object('ok', true, 'conversationId', _c.id,
    'version', _c.version, 'status', _c.status, 'message', 'Updated.');
end;
$$;

-- --------------------------------------------------- create_task_from_message
-- Converts a message into a REAL review-queue task, idempotently: the same
-- message never creates two open tasks.
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
  values (_c.organization_id, _c.patient_id, 'message_follow_up', _m.id,
     left(coalesce(nullif(btrim(coalesce(_title,'')),''),
       'Follow up on patient message'), 200),
     _priority, 'pending', _uid, _uid)
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

-- --------------------------------------------------- append_message_to_note
-- Adds quoted message content to an UNSIGNED draft note on an open encounter,
-- through the existing versioned note path — an explicit practitioner action
-- that NEVER signs anything. Idempotent per (message, encounter).
create or replace function public.append_message_to_note(
  _message_id uuid, _encounter_id uuid, _section text default 'subjective'
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _m public.messages%rowtype; _c public.conversations%rowtype;
        _e public.encounters%rowtype; _uid uuid;
        _n public.clinical_notes%rowtype; _content jsonb; _quoted text;
        _prov jsonb; _res jsonb;
begin
  select * into _m from public.messages where id = _message_id;
  if not found then raise exception 'message not found' using errcode = 'P0002'; end if;
  _c := private.inbox_thread_guard(_m.conversation_id);
  if _m.status not in ('inbound','sent','delivered') then
    raise exception 'only a real (inbound or sent) message can be added to a note'
      using errcode = '22023';
  end if;
  select * into _e from public.encounters
  where id = _encounter_id and deleted_at is null;
  if not found then raise exception 'encounter not found' using errcode = 'P0002'; end if;
  -- Clinical actor gate: staff cannot write into clinical documentation.
  _uid := private.require_clinical_actor(_e.organization_id, _e.patient_id);
  if _e.patient_id is distinct from _c.patient_id
     or _e.organization_id is distinct from _c.organization_id then
    raise exception 'encounter and message belong to different records' using errcode = '42501';
  end if;
  if _section not in ('subjective','objective','assessment','plan','narrative') then
    raise exception 'unknown note section' using errcode = '22023';
  end if;

  -- Idempotency: appending the same message to the same encounter twice is a
  -- no-op with an honest response.
  if exists (select 1 from public.conversation_events e
             where e.conversation_id = _c.id and e.kind = 'note_appended'
               and e.from_value = _m.id::text and e.to_value = _encounter_id::text) then
    return jsonb_build_object('ok', true, 'alreadyAppended', true,
      'message', 'This message is already in the encounter note.');
  end if;

  select * into _n from public.clinical_notes
  where encounter_id = _encounter_id and deleted_at is null
    and status in ('draft','ready_for_review')
  order by created_at desc limit 1;

  _quoted := case when _m.is_from_patient then 'Patient message' else 'Practitioner message' end
    || ' (' || to_char(_m.created_at, 'Mon DD, YYYY') || '): "' || _m.body || '"';
  -- The provenance label is PHI-safe (a date, never message content). Existing
  -- refs are carried forward because save_note_draft replaces them wholesale.
  _prov := jsonb_build_array(jsonb_build_object(
    'sectionKey', _section, 'refType', 'message', 'refId', _m.id::text,
    'label', 'Patient message ' || to_char(_m.created_at, 'Mon DD, YYYY')));

  if _n.id is null then
    _content := jsonb_build_object(_section, _quoted);
    _res := public.save_note_draft(_e.organization_id, _encounter_id, 'soap',
      _content, 0, null, 'manual', _prov);
  else
    select coalesce(v.content, '{}'::jsonb) into _content
    from public.clinical_note_versions v
    where v.note_id = _n.id and v.version = _n.current_version;
    _content := jsonb_set(_content, array[_section],
      to_jsonb(coalesce(nullif(_content->>_section,'') || E'\n\n', '') || _quoted));
    _prov := coalesce((
      select jsonb_agg(jsonb_build_object(
        'sectionKey', pr.section_key, 'refType', pr.ref_type,
        'refId', pr.ref_id::text, 'label', pr.label))
      from public.note_provenance_refs pr where pr.note_id = _n.id
    ), '[]'::jsonb) || _prov;
    _res := public.save_note_draft(_e.organization_id, _encounter_id, _n.note_type,
      _content, _n.current_version, _n.id, 'manual', _prov);
  end if;
  perform 1 where _res is not null;

  perform private.log_conversation_event(_c.organization_id, _c.id, 'note_appended',
    _m.id::text, _encounter_id::text, _section, _uid);
  insert into public.audit_events (organization_id, actor_user_id, action,
    resource_type, resource_id, safe_message, patient_id, metadata)
  values (_c.organization_id, _uid, 'inbox.note_appended', 'message',
    _m.id::text, 'Message content added to an unsigned draft note', _c.patient_id,
    jsonb_build_object('encounterId', _encounter_id, 'section', _section));
  return jsonb_build_object('ok', true, 'alreadyAppended', false,
    'message', 'Added to the unsigned draft note. Nothing was signed.');
end;
$$;

-- ----------------------------------------- set_communication_preferences
create or replace function public.set_communication_preferences(
  _patient_id uuid, _preferred_channel text default 'in_app',
  _email_ok boolean default false, _sms_ok boolean default false,
  _push_ok boolean default false, _do_not_contact boolean default false,
  _consent_id uuid default null, _note text default null
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _uid uuid := auth.uid(); _org uuid;
begin
  if _uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select organization_id into _org from public.patient_profiles
  where id = _patient_id and deleted_at is null;
  if _org is null then raise exception 'patient not found' using errcode = 'P0002'; end if;
  if not private.can_handle_inbox(_org) or not private.can_access_patient(_patient_id) then
    raise exception 'not authorized for this patient' using errcode = '42501';
  end if;
  if _preferred_channel not in ('in_app','email','sms','none') then
    raise exception 'unknown preferred channel' using errcode = '22023';
  end if;
  if _consent_id is not null and not exists (
    select 1 from public.consents cs
    where cs.id = _consent_id and cs.patient_id = _patient_id
      and cs.organization_id = _org and cs.deleted_at is null) then
    raise exception 'consent does not belong to this patient' using errcode = '42501';
  end if;
  insert into public.communication_preferences
    (organization_id, patient_id, preferred_channel, email_ok, sms_ok, push_ok,
     do_not_contact, consent_id, note, updated_by)
  values (_org, _patient_id, _preferred_channel, _email_ok, _sms_ok, _push_ok,
     _do_not_contact, _consent_id, left(_note, 500), _uid)
  on conflict (organization_id, patient_id) do update set
    preferred_channel = excluded.preferred_channel,
    email_ok = excluded.email_ok, sms_ok = excluded.sms_ok,
    push_ok = excluded.push_ok, do_not_contact = excluded.do_not_contact,
    consent_id = excluded.consent_id, note = excluded.note,
    updated_by = excluded.updated_by, updated_at = now();
  insert into public.audit_events (organization_id, actor_user_id, action,
    resource_type, resource_id, safe_message, patient_id, metadata)
  values (_org, _uid, 'inbox.preferences_updated', 'communication_preferences',
    _patient_id::text, 'Communication preferences updated', _patient_id,
    jsonb_build_object('doNotContact', _do_not_contact));
  return jsonb_build_object('ok', true, 'message', 'Preferences saved.');
end;
$$;

-- --------------------------------------------- register_message_attachment
-- Metadata + opaque reference ONLY. No bytes, no public URL, and the file
-- name never reaches application logs (the audit row carries the id only).
create or replace function public.register_message_attachment(
  _conversation_id uuid, _file_name text, _content_type text,
  _byte_size integer default null, _sha256 text default null,
  _message_id uuid default null
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _c public.conversations%rowtype; _uid uuid := auth.uid(); _aid uuid;
begin
  _c := private.inbox_thread_guard(_conversation_id);
  if coalesce(btrim(_file_name),'') = '' then
    raise exception 'a file name is required' using errcode = '22023';
  end if;
  if _message_id is not null and not exists (
    select 1 from public.messages m
    where m.id = _message_id and m.conversation_id = _conversation_id) then
    raise exception 'message does not belong to this conversation' using errcode = '42501';
  end if;
  insert into public.message_attachments
    (organization_id, conversation_id, message_id, patient_id, file_name,
     content_type, byte_size, storage_provider, created_by)
  values (_c.organization_id, _conversation_id, _message_id, _c.patient_id,
     left(btrim(_file_name), 300), left(coalesce(_content_type,'application/octet-stream'), 120),
     _byte_size, 'none', _uid)
  returning id into _aid;
  insert into public.audit_events (organization_id, actor_user_id, action,
    resource_type, resource_id, safe_message, patient_id, metadata)
  values (_c.organization_id, _uid, 'inbox.attachment_registered', 'message_attachment',
    _aid::text, 'Attachment metadata registered', _c.patient_id, '{}'::jsonb);
  return jsonb_build_object('ok', true, 'attachmentId', _aid,
    'message', 'Attachment metadata registered. No storage provider is configured; bytes were not uploaded.');
end;
$$;

-- --------------------------------------------------------- patient + today
create or replace function public.get_patient_messages(_patient_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not private.can_access_patient(_patient_id) then
    raise exception 'not authorized for this patient' using errcode = '42501';
  end if;
  return jsonb_build_object('threads', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', c.id, 'subject', c.subject, 'category', c.category,
      'priority', c.priority, 'status', c.status, 'urgent', c.urgent_flag,
      'lastMessageAt', c.last_message_at, 'createdAt', c.created_at,
      'unreadCount', (select count(*) from public.messages m
                      where m.conversation_id = c.id
                        and m.status = 'inbound' and m.read_at is null),
      'messageCount', (select count(*) from public.messages m
                       where m.conversation_id = c.id and m.status <> 'superseded')
    ) order by c.last_message_at desc nulls last)
    from (select * from public.conversations cc
          where cc.patient_id = _patient_id and cc.deleted_at is null
          order by cc.last_message_at desc nulls last limit 50) c
  ), '[]'::jsonb), 'generatedAt', now());
end;
$$;

create or replace function public.get_inbox_today_summary(_organization_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare _uid uuid := auth.uid();
begin
  if _uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not private.can_handle_inbox(_organization_id) then
    raise exception 'not a member of this organization' using errcode = '42501';
  end if;
  -- Counts of PERSISTED rows the caller can see; nothing is projected.
  return (select jsonb_build_object(
    'openThreads', count(*) filter (where c.status = 'open'),
    'urgentOpen', count(*) filter (where c.urgent_flag and c.status <> 'resolved'),
    'unreadInbound', coalesce(sum((select count(*) from public.messages m
        where m.conversation_id = c.id and m.status = 'inbound' and m.read_at is null)), 0),
    'dueFollowUps', count(*) filter (where c.follow_up_at is not null
        and c.follow_up_at <= now() + interval '1 day' and c.status <> 'resolved'),
    'myAssigned', count(*) filter (where c.assigned_to = _uid and c.status <> 'resolved'),
    'generatedAt', now())
  from public.conversations c
  where c.organization_id = _organization_id and c.deleted_at is null
    and private.can_access_patient(c.patient_id));
end;
$$;

-- ------------------------------------------------ worker-boundary RPCs
-- Inbound messages and delivery callbacks arrive through trusted server
-- integrations (the future AI Longevity Pro bridge / delivery workers), never
-- from the browser: EXECUTE is granted to service_role ONLY.
create or replace function public.record_inbound_message(
  _organization_id uuid, _patient_id uuid, _body text,
  _conversation_id uuid default null, _subject text default null,
  _category text default 'general', _provenance jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _cid uuid; _mid uuid;
begin
  if not exists (select 1 from public.patient_profiles pp
                 where pp.id = _patient_id and pp.organization_id = _organization_id
                   and pp.deleted_at is null) then
    raise exception 'patient does not belong to this organization' using errcode = '42501';
  end if;
  if coalesce(btrim(_body),'') = '' then
    raise exception 'an inbound message needs a body' using errcode = '22023';
  end if;

  if _conversation_id is not null then
    select id into _cid from public.conversations
    where id = _conversation_id and organization_id = _organization_id
      and patient_id = _patient_id and deleted_at is null;
    if _cid is null then
      raise exception 'conversation does not belong to this patient' using errcode = '42501';
    end if;
  else
    select id into _cid from public.conversations
    where organization_id = _organization_id and patient_id = _patient_id
      and status = 'open' and deleted_at is null
    order by last_message_at desc nulls last limit 1;
  end if;
  if _cid is null then
    insert into public.conversations
      (organization_id, patient_id, subject, status, category)
    values (_organization_id, _patient_id,
      left(coalesce(nullif(btrim(coalesce(_subject,'')),''),'Patient message'), 300),
      'open', case when _category in ('general','clinical_question','refill','lab',
        'wearable_alert','scheduling','billing','program_check_in',
        'protocol_adherence','administrative') then _category else 'general' end)
    returning id into _cid;
    perform private.log_conversation_event(_organization_id, _cid, 'created',
      null, _category, 'inbound', null);
  end if;

  insert into public.messages
    (organization_id, conversation_id, patient_id, sender_user_id, body,
     is_from_patient, status, channel, provenance, updated_at)
  values (_organization_id, _cid, _patient_id, null, _body,
     true, 'inbound', 'alp_in_app', coalesce(_provenance, '{}'::jsonb), now())
  returning id into _mid;
  -- Reopen resolved threads on new inbound content; never lose a message.
  update public.conversations set
    status = case when status = 'resolved' then 'open' else status end,
    snoozed_until = null,
    last_message_at = now(), updated_at = now()
  where id = _cid;
  perform private.apply_urgent_invariant(_cid, _organization_id, _body, null);
  insert into public.audit_events (organization_id, actor_user_id, action,
    resource_type, resource_id, safe_message, patient_id, metadata)
  values (_organization_id, null, 'inbox.inbound_recorded', 'message',
    _mid::text, 'Inbound patient message recorded', _patient_id, '{}'::jsonb);
  return jsonb_build_object('ok', true, 'conversationId', _cid, 'messageId', _mid);
end;
$$;

-- Delivery callbacks: deduplicated on (provider, provider_event_id), safe
-- against replays and out-of-order arrival. The outbox projection only moves
-- FORWARD (queued -> sending -> sent -> delivered); a late 'sent' after
-- 'delivered' is recorded but changes nothing.
create or replace function public.record_delivery_callback(
  _provider text, _provider_event_id text, _kind text,
  _outbox_id uuid default null, _provider_message_id text default null,
  _payload_sha256 text default null, _occurred_at timestamptz default null,
  _error_safe text default null, _retryable boolean default false
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _o public.message_outbox%rowtype; _rank_from integer; _rank_to integer;
  _new_status text;
begin
  if _kind not in ('provider_accepted','sent','delivered','failed','bounced','read_receipt') then
    raise exception 'unknown callback kind' using errcode = '22023';
  end if;
  if _outbox_id is not null then
    select * into _o from public.message_outbox where id = _outbox_id for update;
  else
    select * into _o from public.message_outbox
    where provider = _provider and provider_message_id = _provider_message_id
    for update;
  end if;
  if _o.id is null then raise exception 'outbox row not found' using errcode = 'P0002'; end if;

  -- Exactly-once: a replayed provider event is recorded as ignored.
  if exists (select 1 from public.message_delivery_events e
             where e.provider = _provider and e.provider_event_id = _provider_event_id) then
    insert into public.message_delivery_events
      (organization_id, outbox_id, kind, provider, payload_sha256, occurred_at, note)
    values (_o.organization_id, _o.id, 'duplicate_ignored', _provider,
      _payload_sha256, _occurred_at, 'Replay of ' || _provider_event_id);
    return jsonb_build_object('ok', true, 'duplicate', true, 'outboxStatus', _o.status);
  end if;

  insert into public.message_delivery_events
    (organization_id, outbox_id, kind, provider, provider_event_id,
     payload_sha256, occurred_at, note)
  values (_o.organization_id, _o.id, _kind, _provider, _provider_event_id,
    _payload_sha256, _occurred_at, _error_safe);

  if _kind = 'failed' or _kind = 'bounced' then
    if _retryable then
      update public.message_outbox set attempts = attempts + 1,
        next_retry_at = now() + make_interval(mins => least(60, 2 ^ least(attempts, 6))::int),
        last_error_safe = left(_error_safe, 300), status = 'queued', updated_at = now()
      where id = _o.id;
      _new_status := 'queued';
    else
      update public.message_outbox set status = 'failed', attempts = attempts + 1,
        next_retry_at = null, last_error_safe = left(_error_safe, 300), updated_at = now()
      where id = _o.id;
      update public.messages set status = 'failed',
        failed_reason_safe = left(_error_safe, 300), updated_at = now()
      where id = _o.message_id;
      _new_status := 'failed';
    end if;
  elsif _kind = 'read_receipt' then
    _new_status := _o.status;
  else
    _rank_from := case _o.status when 'queued' then 1 when 'sending' then 2
      when 'sent' then 3 when 'delivered' then 4 else 0 end;
    _rank_to := case _kind when 'provider_accepted' then 2 when 'sent' then 3
      when 'delivered' then 4 end;
    if _rank_to > _rank_from then
      _new_status := case _rank_to when 2 then 'sending' when 3 then 'sent' else 'delivered' end;
      update public.message_outbox set status = _new_status,
        provider_message_id = coalesce(_provider_message_id, provider_message_id),
        updated_at = now()
      where id = _o.id;
      if _new_status = 'sent' then
        update public.messages set status = 'sent', sent_at = coalesce(_occurred_at, now()),
          updated_at = now()
        where id = _o.message_id and status in ('queued','draft');
      elsif _new_status = 'delivered' then
        update public.messages set status = 'delivered',
          sent_at = coalesce(sent_at, _occurred_at, now()),
          delivered_at = coalesce(_occurred_at, now()), updated_at = now()
        where id = _o.message_id and status in ('queued','sent');
      end if;
    else
      _new_status := _o.status; -- out-of-order: recorded, projection unchanged
    end if;
  end if;

  return jsonb_build_object('ok', true, 'duplicate', false, 'outboxStatus', _new_status);
end;
$$;

-- AI triage output lands here from the (future) provider worker. Content is
-- stored SEPARATELY from practitioner-authored rows and is immutable.
create or replace function public.record_ai_suggestion(
  _conversation_id uuid, _kind text, _content jsonb,
  _provider text, _model text, _prompt_version text, _schema_version text,
  _output_sha256 text default null, _message_id uuid default null
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _c public.conversations%rowtype; _rid uuid;
begin
  select * into _c from public.conversations
  where id = _conversation_id and deleted_at is null;
  if not found then raise exception 'conversation not found' using errcode = 'P0002'; end if;
  if _kind not in ('category','priority','summary','unanswered_questions','routing',
                   'draft_response','task_suggestion','note_suggestion') then
    raise exception 'unknown suggestion kind' using errcode = '22023';
  end if;
  if _content is null or jsonb_typeof(_content) <> 'object'
     or length(_content::text) > 20000 then
    raise exception 'invalid suggestion content' using errcode = '22023';
  end if;
  if _message_id is not null and not exists (
    select 1 from public.messages m
    where m.id = _message_id and m.conversation_id = _conversation_id) then
    raise exception 'message does not belong to this conversation' using errcode = '42501';
  end if;
  insert into public.message_ai_reviews
    (organization_id, conversation_id, message_id, kind, content,
     provider, model, prompt_version, schema_version, output_sha256)
  values (_c.organization_id, _conversation_id, _message_id, _kind, _content,
     _provider, _model, _prompt_version, _schema_version, _output_sha256)
  returning id into _rid;
  perform private.log_conversation_event(_c.organization_id, _c.id, 'ai_suggested',
    null, _kind, null, null);
  return jsonb_build_object('ok', true, 'reviewId', _rid);
end;
$$;

-- ---------------------------------------------------- review_ai_suggestion
-- The ONLY path from AI output to action, and it requires a human. Accepting
-- a category/priority/routing suggestion applies it through the same guarded
-- workflow transitions; accepting a draft_response copies the text into the
-- CALLER'S editable draft; accepting a task_suggestion creates the task
-- idempotently. Nothing here can send a message, resolve a thread, refill,
-- diagnose, order, schedule, charge, or sign.
create or replace function public.review_ai_suggestion(
  _review_id uuid, _decision text
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare _r public.message_ai_reviews%rowtype; _c public.conversations%rowtype;
        _uid uuid := auth.uid(); _applied jsonb := 'null'::jsonb; _v text;
begin
  if _uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into _r from public.message_ai_reviews where id = _review_id for update;
  if not found then raise exception 'suggestion not found' using errcode = 'P0002'; end if;
  _c := private.inbox_thread_guard(_r.conversation_id);
  if _decision not in ('accept','dismiss') then
    raise exception 'unknown decision' using errcode = '22023';
  end if;
  if _r.status <> 'suggested' then
    return jsonb_build_object('ok', true, 'reviewId', _r.id,
      'alreadyReviewed', true, 'status', _r.status,
      'message', 'This suggestion was already reviewed.');
  end if;

  if _decision = 'accept' then
    if _r.kind = 'category' then
      _v := _r.content->>'category';
      _applied := public.update_conversation_workflow(_c.id, 'category', _c.version, _v,
        null, 'Accepted AI suggestion');
    elsif _r.kind = 'priority' then
      _v := _r.content->>'priority';
      _applied := public.update_conversation_workflow(_c.id, 'priority', _c.version, _v,
        null, 'Accepted AI suggestion');
    elsif _r.kind = 'routing' then
      _v := _r.content->>'queue';
      _applied := public.update_conversation_workflow(_c.id, 'queue', _c.version, _v,
        null, 'Accepted AI suggestion');
    elsif _r.kind = 'draft_response' then
      -- Into the CALLER'S draft only — never sent, never attributed to AI as
      -- a sender. The practitioner edits and sends (or doesn't) explicitly.
      _applied := public.save_message_draft(_c.id, coalesce(_r.content->>'body',''), null, null);
    elsif _r.kind = 'task_suggestion' then
      _applied := (select public.create_task_from_message(
        coalesce(_r.message_id,
          (select m.id from public.messages m where m.conversation_id = _c.id
           and m.status = 'inbound' order by m.created_at desc limit 1)),
        _r.content->>'title', coalesce(_r.content->>'priority','medium')));
    end if; -- summary / unanswered_questions / note_suggestion: no side effects
  end if;

  update public.message_ai_reviews set
    status = case when _decision = 'accept' then 'accepted' else 'dismissed' end,
    reviewed_by = _uid, reviewed_at = now()
  where id = _r.id;
  perform private.log_conversation_event(_c.organization_id, _c.id, 'ai_reviewed',
    _r.kind, _decision, null, _uid);
  insert into public.audit_events (organization_id, actor_user_id, action,
    resource_type, resource_id, safe_message, patient_id, metadata)
  values (_c.organization_id, _uid, 'inbox.ai_' || _decision || 'ed', 'message_ai_review',
    _r.id::text, 'AI suggestion ' || _decision || 'ed', _c.patient_id,
    jsonb_build_object('kind', _r.kind));
  return jsonb_build_object('ok', true, 'reviewId', _r.id, 'alreadyReviewed', false,
    'decision', _decision, 'applied', _applied,
    'message', case when _decision = 'accept'
      then 'Suggestion accepted and applied through the guarded workflow.'
      else 'Suggestion dismissed.' end);
end;
$$;

-- ----------------------------------------------------------------- grants
revoke all on function public.list_inbox(uuid, text, text, text, text, text, boolean, boolean, boolean, integer) from public, anon;
revoke all on function public.get_conversation(uuid) from public, anon;
revoke all on function public.create_conversation(uuid, uuid, text, text, text) from public, anon;
revoke all on function public.save_message_draft(uuid, text, uuid, integer) from public, anon;
revoke all on function public.cancel_message_draft(uuid) from public, anon;
revoke all on function public.send_message(uuid, text, text) from public, anon;
revoke all on function public.mark_conversation_read(uuid) from public, anon;
revoke all on function public.update_conversation_workflow(uuid, text, integer, text, timestamptz, text) from public, anon;
revoke all on function public.create_task_from_message(uuid, text, text) from public, anon;
revoke all on function public.append_message_to_note(uuid, uuid, text) from public, anon;
revoke all on function public.set_communication_preferences(uuid, text, boolean, boolean, boolean, boolean, uuid, text) from public, anon;
revoke all on function public.register_message_attachment(uuid, text, text, integer, text, uuid) from public, anon;
revoke all on function public.get_patient_messages(uuid) from public, anon;
revoke all on function public.get_inbox_today_summary(uuid) from public, anon;
grant execute on function public.list_inbox(uuid, text, text, text, text, text, boolean, boolean, boolean, integer) to authenticated, service_role;
grant execute on function public.get_conversation(uuid) to authenticated, service_role;
grant execute on function public.create_conversation(uuid, uuid, text, text, text) to authenticated, service_role;
grant execute on function public.save_message_draft(uuid, text, uuid, integer) to authenticated, service_role;
grant execute on function public.cancel_message_draft(uuid) to authenticated, service_role;
grant execute on function public.send_message(uuid, text, text) to authenticated, service_role;
grant execute on function public.mark_conversation_read(uuid) to authenticated, service_role;
grant execute on function public.update_conversation_workflow(uuid, text, integer, text, timestamptz, text) to authenticated, service_role;
grant execute on function public.create_task_from_message(uuid, text, text) to authenticated, service_role;
grant execute on function public.append_message_to_note(uuid, uuid, text) to authenticated, service_role;
grant execute on function public.set_communication_preferences(uuid, text, boolean, boolean, boolean, boolean, uuid, text) to authenticated, service_role;
grant execute on function public.register_message_attachment(uuid, text, text, integer, text, uuid) to authenticated, service_role;
grant execute on function public.get_patient_messages(uuid) to authenticated, service_role;
grant execute on function public.get_inbox_today_summary(uuid) to authenticated, service_role;

-- Worker-boundary functions: service_role ONLY (not even authenticated).
revoke all on function public.record_inbound_message(uuid, uuid, text, uuid, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.record_delivery_callback(text, text, text, uuid, text, text, timestamptz, text, boolean) from public, anon, authenticated;
revoke all on function public.record_ai_suggestion(uuid, text, jsonb, text, text, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.record_inbound_message(uuid, uuid, text, uuid, text, text, jsonb) to service_role;
grant execute on function public.record_delivery_callback(text, text, text, uuid, text, text, timestamptz, text, boolean) to service_role;
grant execute on function public.record_ai_suggestion(uuid, text, jsonb, text, text, text, text, text, uuid) to service_role;

commit;
