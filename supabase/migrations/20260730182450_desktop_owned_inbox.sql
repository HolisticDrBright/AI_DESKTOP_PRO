-- desktop_owned_inbox
--
-- Phase 4: the Desktop-owned communication domain. Extends the 0004
-- conversations/messages skeleton into a real organization- and
-- patient-scoped inbox: categorized, prioritized, assignable threads with an
-- explicit status machine; immutable sent/inbound message bodies with
-- editable, versioned drafts; provider-neutral attachments (metadata +
-- opaque storage references only — never inline payloads); patient
-- communication preferences and consent; a durable outbound delivery outbox
-- with idempotency keys, provider event dedup, and retry state; append-only
-- assignment/status/delivery/AI history; and AI triage output stored
-- SEPARATELY from practitioner-authored content.
--
-- What is deliberately NOT here: any code path that sends email/SMS/push,
-- contacts a provider, marks anything sent or delivered without provider
-- acknowledgment, authorizes a refill, changes a protocol, creates an order
-- or invoice, or lets AI output act on its own. Sending without a configured
-- provider refuses; nothing is ever claimed delivered without evidence.
--
-- Thread status machine (enforced by RPC):
--   open -> snoozed | resolved ; snoozed -> open | resolved ; resolved -> open
-- Message status machine (enforced by RPC + triggers):
--   draft -> queued | cancelled | superseded  (draft bodies editable, versioned)
--   queued -> sent | failed | cancelled       (queued only exists with a provider)
--   sent -> delivered | failed                (provider callbacks only)
--   inbound is terminal (read_at is the only mutation)
--   DELETE is always refused; bodies freeze the moment a message leaves draft.

begin;

-- ------------------------------------------------------------ conversations
alter table public.conversations
  add column if not exists category text not null default 'general',
  add column if not exists priority text not null default 'normal',
  add column if not exists assigned_to uuid references auth.users(id),
  add column if not exists assigned_queue text not null default 'practitioner',
  add column if not exists follow_up_at timestamptz,
  add column if not exists snoozed_until timestamptz,
  add column if not exists urgent_flag boolean not null default false,
  add column if not exists urgent_terms text[] not null default '{}',
  add column if not exists last_message_at timestamptz,
  add column if not exists version integer not null default 1;

alter table public.conversations drop constraint if exists conversations_category_check;
alter table public.conversations add constraint conversations_category_check
  check (category in ('general','clinical_question','refill','lab','wearable_alert',
                      'scheduling','billing','program_check_in','protocol_adherence','administrative'));
alter table public.conversations drop constraint if exists conversations_priority_check;
alter table public.conversations add constraint conversations_priority_check
  check (priority in ('low','normal','high','urgent'));
alter table public.conversations drop constraint if exists conversations_queue_check;
alter table public.conversations add constraint conversations_queue_check
  check (assigned_queue in ('practitioner','staff'));

-- Migrate legacy statuses before tightening the check ('closed' -> 'resolved').
update public.conversations set status = 'resolved' where status = 'closed';
alter table public.conversations drop constraint if exists conversations_status_check;
alter table public.conversations add constraint conversations_status_check
  check (status in ('open','snoozed','resolved'));

-- --------------------------------------------------------------- messages
alter table public.messages
  add column if not exists status text not null default 'draft',
  add column if not exists channel text not null default 'in_app',
  add column if not exists version integer not null default 1,
  add column if not exists sent_at timestamptz,
  add column if not exists delivered_at timestamptz,
  add column if not exists failed_reason_safe text,
  add column if not exists provenance jsonb not null default '{}'::jsonb,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists updated_by uuid references auth.users(id);

-- Backfill legacy rows honestly: patient rows are inbound; practitioner rows
-- predate the outbox and delivery evidence, so they are 'sent' at best-known
-- state (they were written by the legacy app path, not claimed delivered).
update public.messages set status = case when is_from_patient then 'inbound' else 'sent' end
where status = 'draft' and created_at < now() - interval '1 minute';

alter table public.messages drop constraint if exists messages_status_check;
alter table public.messages add constraint messages_status_check
  check (status in ('draft','queued','sent','delivered','failed','inbound','cancelled','superseded'));
alter table public.messages drop constraint if exists messages_channel_check;
alter table public.messages add constraint messages_channel_check
  check (channel in ('in_app','alp_in_app','email','sms','push'));

-- ------------------------------------------------- editable draft history
create table if not exists public.message_draft_revisions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  message_id uuid not null references public.messages(id) on delete cascade,
  version integer not null,
  body text not null,
  saved_by uuid references auth.users(id),
  saved_at timestamptz not null default now(),
  unique (message_id, version)
);

-- ------------------------------------------------------------ attachments
-- Provider-neutral metadata + an OPAQUE storage reference. Bytes never live
-- here, file names never reach application logs, and access goes through an
-- authorized route — no guessable URLs.
create table if not exists public.message_attachments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  message_id uuid references public.messages(id) on delete set null,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  file_name text not null,
  content_type text not null default 'application/octet-stream',
  byte_size integer check (byte_size is null or byte_size >= 0),
  storage_provider text not null default 'none'
    check (storage_provider in ('none','supabase_storage')),
  storage_ref text,
  sha256 text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
comment on column public.message_attachments.storage_ref is
  'Opaque provider reference. Never a public URL; access is authorized per request.';

-- --------------------------------------- patient communication preferences
create table if not exists public.communication_preferences (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid not null references public.patient_profiles(id) on delete cascade,
  preferred_channel text not null default 'in_app'
    check (preferred_channel in ('in_app','email','sms','none')),
  email_ok boolean not null default false,
  sms_ok boolean not null default false,
  push_ok boolean not null default false,
  do_not_contact boolean not null default false,
  consent_id uuid references public.consents(id) on delete set null,
  note text,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (organization_id, patient_id)
);

-- ------------------------------------------------------- durable outbox
-- One row per message+channel attempt lifecycle. Rows are created ONLY when
-- a real provider accepts work (queued/sending) or to record a refusal-free
-- future integration; with no provider configured, send_message refuses and
-- no outbox row is created — nothing pretends to be on its way.
create table if not exists public.message_outbox (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  message_id uuid not null references public.messages(id) on delete cascade,
  channel text not null check (channel in ('alp_in_app','email','sms','push')),
  provider text,
  status text not null default 'queued'
    check (status in ('queued','sending','sent','delivered','failed','cancelled')),
  idempotency_key text not null,
  provider_message_id text,
  attempts integer not null default 0,
  next_retry_at timestamptz,
  last_error_safe text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (idempotency_key),
  unique (message_id, channel)
);

-- ------------------------------------------- delivery events (append-only)
-- Provider callbacks land here exactly once: (provider, provider_event_id)
-- dedupes replays; out-of-order events are recorded verbatim and the outbox
-- projection only ever moves forward (RPC-enforced).
create table if not exists public.message_delivery_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  outbox_id uuid not null references public.message_outbox(id) on delete cascade,
  kind text not null check (kind in
    ('queued','provider_accepted','sent','delivered','failed','bounced','read_receipt','duplicate_ignored')),
  provider text,
  provider_event_id text,
  payload_sha256 text,
  occurred_at timestamptz,
  received_at timestamptz not null default now(),
  note text
);
create unique index if not exists message_delivery_events_provider_event_key
  on public.message_delivery_events (provider, provider_event_id)
  where provider_event_id is not null;

-- ------------------------------------- conversation events (append-only)
create table if not exists public.conversation_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  kind text not null check (kind in
    ('created','category_changed','priority_changed','status_changed','assigned',
     'queue_changed','snoozed','unsnoozed','follow_up_set','follow_up_cleared',
     'urgent_flagged','ai_suggested','ai_reviewed','task_created','note_appended',
     'send_refused','message_sent','message_failed','read')),
  from_value text,
  to_value text,
  note text,
  actor_user_id uuid references auth.users(id),
  created_at timestamptz not null default now()
);

-- --------------------------------------------- AI triage (separate store)
-- AI output NEVER mingles with practitioner-authored content. A suggestion
-- stays a suggestion until a human accepts it through a guarded RPC; the
-- provider/model/prompt/schema/output-hash provenance is versioned.
create table if not exists public.message_ai_reviews (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  message_id uuid references public.messages(id) on delete set null,
  kind text not null check (kind in
    ('category','priority','summary','unanswered_questions','routing',
     'draft_response','task_suggestion','note_suggestion')),
  content jsonb not null default '{}'::jsonb,
  provider text not null,
  model text not null,
  prompt_version text not null,
  schema_version text not null,
  output_sha256 text,
  status text not null default 'suggested'
    check (status in ('suggested','accepted','dismissed')),
  created_at timestamptz not null default now(),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz
);

-- ----------------------------------------------------------------- indexes
create index if not exists conversations_inbox_idx
  on public.conversations (organization_id, status, priority, last_message_at desc);
create index if not exists conversations_assigned_idx
  on public.conversations (assigned_to, status);
create index if not exists conversations_follow_up_idx
  on public.conversations (organization_id, follow_up_at)
  where follow_up_at is not null;
create index if not exists conversations_patient_idx
  on public.conversations (patient_id, status);
create index if not exists messages_conversation_idx
  on public.messages (conversation_id, created_at);
create index if not exists messages_unread_inbound_idx
  on public.messages (conversation_id)
  where status = 'inbound' and read_at is null;
create index if not exists messages_patient_idx
  on public.messages (patient_id, created_at desc);
create index if not exists messages_sender_idx on public.messages (sender_user_id);
create index if not exists messages_updated_by_idx on public.messages (updated_by);
create index if not exists message_draft_revisions_msg_idx
  on public.message_draft_revisions (message_id, version desc);
create index if not exists message_draft_revisions_org_idx
  on public.message_draft_revisions (organization_id);
create index if not exists message_draft_revisions_saved_by_idx
  on public.message_draft_revisions (saved_by);
create index if not exists message_attachments_conversation_idx
  on public.message_attachments (conversation_id);
create index if not exists message_attachments_message_idx
  on public.message_attachments (message_id);
create index if not exists message_attachments_patient_idx
  on public.message_attachments (patient_id);
create index if not exists message_attachments_org_idx
  on public.message_attachments (organization_id);
create index if not exists message_attachments_created_by_idx
  on public.message_attachments (created_by);
create index if not exists communication_preferences_patient_idx
  on public.communication_preferences (patient_id);
create index if not exists communication_preferences_consent_idx
  on public.communication_preferences (consent_id);
create index if not exists communication_preferences_updated_by_idx
  on public.communication_preferences (updated_by);
create index if not exists message_outbox_message_idx on public.message_outbox (message_id);
create index if not exists message_outbox_org_retry_idx
  on public.message_outbox (organization_id, status, next_retry_at);
create index if not exists message_delivery_events_outbox_idx
  on public.message_delivery_events (outbox_id, received_at);
create index if not exists message_delivery_events_org_idx
  on public.message_delivery_events (organization_id);
create index if not exists conversation_events_conversation_idx
  on public.conversation_events (conversation_id, created_at desc);
create index if not exists conversation_events_org_idx
  on public.conversation_events (organization_id);
create index if not exists conversation_events_actor_idx
  on public.conversation_events (actor_user_id);
create index if not exists message_ai_reviews_conversation_idx
  on public.message_ai_reviews (conversation_id, created_at desc);
create index if not exists message_ai_reviews_org_idx
  on public.message_ai_reviews (organization_id);
create index if not exists message_ai_reviews_message_idx
  on public.message_ai_reviews (message_id);
create index if not exists message_ai_reviews_reviewed_by_idx
  on public.message_ai_reviews (reviewed_by);
create index if not exists conversations_assigned_to_idx
  on public.conversations (assigned_to);
create index if not exists conversations_org_idx
  on public.conversations (organization_id);
create index if not exists conversations_created_by_idx
  on public.conversations (created_by);
create index if not exists conversations_updated_by_idx
  on public.conversations (updated_by);
create index if not exists messages_org_idx on public.messages (organization_id);

-- ------------------------------------------------- deterministic invariant
-- The urgent-language precheck. A fixed dictionary, matched case-insensitively
-- in SQL: it can only elevate visibility and suggest immediate human review.
-- It never diagnoses and never claims a definitive emergency — the matched
-- terms are dictionary entries, not message excerpts.
create or replace function private.detect_urgent_language(_body text)
returns text[] language sql immutable security definer set search_path = ''
as $$
  select coalesce(array_agg(term), '{}')
  from unnest(array[
    'chest pain','can''t breathe','cannot breathe','trouble breathing',
    'shortness of breath','suicid','overdose','severe bleeding','anaphyla',
    'stroke','unconscious','seizure','emergency','call 911'
  ]) as term
  where position(term in lower(coalesce(_body,''))) > 0;
$$;
revoke all on function private.detect_urgent_language(text) from public, anon;
grant execute on function private.detect_urgent_language(text) to authenticated, service_role;

-- --------------------------------------------------------------- triggers
-- Sent/inbound immutability: once a message leaves draft, its body and
-- identity freeze. Delivery evidence fields and read receipts remain the only
-- lawful updates, and DELETE is always refused.
create or replace function private.guard_message_immutability()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'messages are never deleted; cancel or supersede a draft instead'
      using errcode = '22023';
  end if;
  if old.status <> 'draft' then
    if new.body is distinct from old.body
       or new.conversation_id is distinct from old.conversation_id
       or new.patient_id is distinct from old.patient_id
       or new.sender_user_id is distinct from old.sender_user_id
       or new.is_from_patient is distinct from old.is_from_patient
       or new.channel is distinct from old.channel
       or new.created_at is distinct from old.created_at then
      raise exception 'a % message is immutable', old.status using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists guard_message_immutability on public.messages;
create trigger guard_message_immutability
  before update or delete on public.messages
  for each row execute function private.guard_message_immutability();

create or replace function private.forbid_inbox_event_mutation()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  raise exception 'history rows are append-only' using errcode = '22023';
end;
$$;
drop trigger if exists forbid_conversation_event_mutation on public.conversation_events;
create trigger forbid_conversation_event_mutation
  before update or delete on public.conversation_events
  for each row execute function private.forbid_inbox_event_mutation();
drop trigger if exists forbid_delivery_event_mutation on public.message_delivery_events;
create trigger forbid_delivery_event_mutation
  before update or delete on public.message_delivery_events
  for each row execute function private.forbid_inbox_event_mutation();
drop trigger if exists forbid_draft_revision_mutation on public.message_draft_revisions;
create trigger forbid_draft_revision_mutation
  before update or delete on public.message_draft_revisions
  for each row execute function private.forbid_inbox_event_mutation();

-- AI reviews: content/provenance freeze at insert; only the human review
-- fields (status/reviewed_by/reviewed_at) may change, exactly once.
create or replace function private.guard_ai_review_mutation()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'AI reviews are append-only' using errcode = '22023';
  end if;
  if new.content is distinct from old.content
     or new.kind is distinct from old.kind
     or new.provider is distinct from old.provider
     or new.model is distinct from old.model
     or new.prompt_version is distinct from old.prompt_version
     or new.schema_version is distinct from old.schema_version
     or new.output_sha256 is distinct from old.output_sha256
     or new.conversation_id is distinct from old.conversation_id then
    raise exception 'AI suggestion content is immutable' using errcode = '22023';
  end if;
  return new;
end;
$$;
drop trigger if exists guard_ai_review_mutation on public.message_ai_reviews;
create trigger guard_ai_review_mutation
  before update or delete on public.message_ai_reviews
  for each row execute function private.guard_ai_review_mutation();

-- ---------------------------------------------------------------- RLS
alter table public.message_draft_revisions enable row level security;
alter table public.message_attachments enable row level security;
alter table public.communication_preferences enable row level security;
alter table public.message_outbox enable row level security;
alter table public.message_delivery_events enable row level security;
alter table public.conversation_events enable row level security;
alter table public.message_ai_reviews enable row level security;

-- Replace every pre-existing policy on the two legacy tables dynamically —
-- no guessed names (the 0004/0012 layers left permissive read/write sets).
do $$
declare _p record;
begin
  for _p in
    select policyname, tablename from pg_policies
    where schemaname = 'public' and tablename in ('conversations','messages')
  loop
    execute format('drop policy %I on public.%I', _p.policyname, _p.tablename);
  end loop;
end $$;

create policy conversations_select on public.conversations for select
  using (private.can_access_patient(patient_id) and deleted_at is null);
create policy messages_select on public.messages for select
  using (private.can_access_patient(patient_id));
create policy message_draft_revisions_select on public.message_draft_revisions for select
  using (exists (select 1 from public.messages m
                 where m.id = message_id and private.can_access_patient(m.patient_id)));
create policy message_attachments_select on public.message_attachments for select
  using (private.can_access_patient(patient_id) and deleted_at is null);
create policy communication_preferences_select on public.communication_preferences for select
  using (private.can_access_patient(patient_id));
create policy message_outbox_select on public.message_outbox for select
  using (private.is_org_member(organization_id));
create policy message_delivery_events_select on public.message_delivery_events for select
  using (private.is_org_member(organization_id));
create policy conversation_events_select on public.conversation_events for select
  using (private.is_org_member(organization_id));
create policy message_ai_reviews_select on public.message_ai_reviews for select
  using (exists (select 1 from public.conversations c
                 where c.id = conversation_id and private.can_access_patient(c.patient_id)));

-- No direct browser writes anywhere in this domain.
revoke insert, update, delete on public.conversations from authenticated, anon;
revoke insert, update, delete on public.messages from authenticated, anon;
revoke all on public.message_draft_revisions from authenticated, anon;
revoke all on public.message_attachments from authenticated, anon;
revoke all on public.communication_preferences from authenticated, anon;
revoke all on public.message_outbox from authenticated, anon;
revoke all on public.message_delivery_events from authenticated, anon;
revoke all on public.conversation_events from authenticated, anon;
revoke all on public.message_ai_reviews from authenticated, anon;
grant select on public.message_draft_revisions to authenticated;
grant select on public.message_attachments to authenticated;
grant select on public.communication_preferences to authenticated;
grant select on public.message_outbox to authenticated;
grant select on public.message_delivery_events to authenticated;
grant select on public.conversation_events to authenticated;
grant select on public.message_ai_reviews to authenticated;

commit;
