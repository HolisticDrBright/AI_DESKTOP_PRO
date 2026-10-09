-- Pre-visit questionnaires and signed documents.
-- Synthetic-only. No real patient data, and nothing here is enabled for production.
--
-- The clinic could already read the consumer app's own onboarding questionnaire once a
-- patient linked, and it could record that a patient granted a consent scope. Neither is
-- the thing a clinic actually needs before a first visit: its own forms, answered by this
-- patient, for this visit, and a document the patient has read and agreed to, with the
-- agreement bound to the exact words that were shown.
--
-- Three things are load-bearing here, and each of them exists because the alternative is a
-- record that cannot be relied on afterwards.
--
-- A packet only ever delivers a published version. A draft is something a practitioner is
-- still writing; delivering one would ask a patient to answer text nobody has approved.
-- The same mistake in the program path shipped a bug, so the rule is enforced here in the
-- one place that can enforce it: the assignment itself refuses a version that is not
-- published, and the delivered content is compiled from that version's own row rather than
-- from anything a caller sends.
--
-- A response and a signature both record the content digest of the version they answered,
-- and the submitter must send back the digest of what it rendered. A mismatch is refused
-- rather than recorded. Without this, "the patient agreed" means only "the patient pressed
-- a button near some text", and which text is unknowable later.
--
-- A signature binds to the agreement statement, separately digested. The document body may
-- be long and a screen may abridge it, but the sentence the patient agreed to is the one
-- thing that must be provable, so it is hashed on its own and compared on its own.
--
-- The typed name is stored as typed, not sealed, and the comment on the column says why. The database stores an envelope and a digest and can read neither.

create table clinical_core.intake_form_versions(
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references clinical_core.organizations(id),
 form_key text not null check(form_key ~ '^[a-z][a-z0-9_-]{2,48}$'),
 version integer not null check(version>0),
 title text not null check(char_length(title) between 1 and 160),
 kind text not null check(kind in('questionnaire','consent_document')),
 content jsonb not null,
 content_sha256 text not null check(content_sha256 ~ '^[a-f0-9]{64}$'),
 -- Only a consent document has one, and it is digested on its own so a signature can be
 -- bound to the sentence rather than to the whole document.
 agreement_sha256 text check(agreement_sha256 is null or agreement_sha256 ~ '^[a-f0-9]{64}$'),
 status text not null default 'draft' check(status in('draft','published','retired')),
 created_at timestamptz not null default clock_timestamp(),
 created_by_person_id uuid not null references clinical_core.persons(id),
 published_at timestamptz,
 published_by_person_id uuid references clinical_core.persons(id),
 retired_at timestamptz,
 unique(organization_id,form_key,version),
 unique(id,organization_id),
 check((published_at is null)=(published_by_person_id is null)),
 check(status='draft' or published_at is not null),
 check(status<>'draft' or (published_at is null and retired_at is null)),
 check((status='retired')=(retired_at is not null)),
 check((kind='consent_document')=(agreement_sha256 is not null))
);
alter table clinical_core.intake_form_versions enable row level security;
revoke all on clinical_core.intake_form_versions from public,clinical_core_api;
create index intake_form_versions_org_idx
 on clinical_core.intake_form_versions(organization_id,form_key,version desc);
create index intake_form_versions_status_idx
 on clinical_core.intake_form_versions(organization_id,status);
create index intake_form_versions_created_by_idx
 on clinical_core.intake_form_versions(created_by_person_id);
create index intake_form_versions_published_by_idx
 on clinical_core.intake_form_versions(published_by_person_id);

-- Published text never changes. A correction is a new version, so every response and every
-- signature keeps pointing at the words it was given.
create or replace function clinical_private.protect_intake_form_version() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if tg_op='DELETE' then
  if old.status='draft' and not exists(select 1 from clinical_core.intake_packet_items
   where form_version_id=old.id) then return old; end if;
  raise exception using errcode='55000',message='intake_form_immutable';
 end if;
 if old.status<>'draft' and (new.content is distinct from old.content
 or new.content_sha256 is distinct from old.content_sha256
 or new.agreement_sha256 is distinct from old.agreement_sha256
 or new.kind is distinct from old.kind or new.form_key is distinct from old.form_key
 or new.version is distinct from old.version
 or new.organization_id is distinct from old.organization_id) then
  raise exception using errcode='55000',message='intake_form_immutable';
 end if;
 return new;
end $$;
revoke all on function clinical_private.protect_intake_form_version() from public;

create table clinical_core.intake_packets(
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references clinical_core.organizations(id),
 connection_id uuid not null references clinical_core.patient_connections(id),
 patient_record_id uuid not null references clinical_core.patient_records(id),
 -- Set when the packet follows a request that came in through a public consult link, so
 -- the front door and the paperwork are one trail rather than two.
 consult_request_id uuid references clinical_core.consult_requests(id),
 label text not null check(char_length(label) between 1 and 160),
 status text not null default 'open' check(status in('open','completed','cancelled')),
 due_before timestamptz,
 revision bigint not null default 1 check(revision>0),
 created_at timestamptz not null default clock_timestamp(),
 created_by_person_id uuid not null references clinical_core.persons(id),
 completed_at timestamptz,
 cancelled_at timestamptz,
 cancelled_by_person_id uuid references clinical_core.persons(id),
 unique(id,organization_id),
 foreign key (connection_id,organization_id,patient_record_id)
  references clinical_core.patient_connections(id,organization_id,patient_record_id),
 check((status='completed')=(completed_at is not null)),
 check((status='cancelled')=(cancelled_at is not null)),
 check((cancelled_at is null)=(cancelled_by_person_id is null))
);
alter table clinical_core.intake_packets enable row level security;
revoke all on clinical_core.intake_packets from public,clinical_core_api;
create index intake_packets_connection_idx
 on clinical_core.intake_packets(connection_id,created_at desc);
create index intake_packets_org_status_idx
 on clinical_core.intake_packets(organization_id,status,created_at desc);
create index intake_packets_patient_idx on clinical_core.intake_packets(patient_record_id);
create index intake_packets_consult_idx on clinical_core.intake_packets(consult_request_id);
create index intake_packets_created_by_idx on clinical_core.intake_packets(created_by_person_id);
create index intake_packets_cancelled_by_idx on clinical_core.intake_packets(cancelled_by_person_id);

create table clinical_core.intake_packet_items(
 id uuid primary key default gen_random_uuid(),
 packet_id uuid not null references clinical_core.intake_packets(id),
 organization_id uuid not null references clinical_core.organizations(id),
 form_version_id uuid not null references clinical_core.intake_form_versions(id),
 position integer not null check(position between 1 and 20),
 required boolean not null default true,
 unique(packet_id,position),
 unique(packet_id,form_version_id),
 unique(id,packet_id),
 foreign key (packet_id,organization_id) references clinical_core.intake_packets(id,organization_id),
 foreign key (form_version_id,organization_id)
  references clinical_core.intake_form_versions(id,organization_id)
);
alter table clinical_core.intake_packet_items enable row level security;
revoke all on clinical_core.intake_packet_items from public,clinical_core_api;
create index intake_packet_items_packet_idx on clinical_core.intake_packet_items(packet_id,position);
create index intake_packet_items_version_idx on clinical_core.intake_packet_items(form_version_id);
create index intake_packet_items_org_idx on clinical_core.intake_packet_items(organization_id);

create trigger intake_form_versions_protected
 before update or delete on clinical_core.intake_form_versions
 for each row execute function clinical_private.protect_intake_form_version();

create table clinical_core.intake_form_responses(
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references clinical_core.organizations(id),
 packet_item_id uuid not null references clinical_core.intake_packet_items(id),
 connection_id uuid not null references clinical_core.patient_connections(id),
 form_version_id uuid not null references clinical_core.intake_form_versions(id),
 -- The digest of the text this answer was given to.
 form_content_sha256 text not null check(form_content_sha256 ~ '^[a-f0-9]{64}$'),
 answers jsonb not null check(jsonb_typeof(answers)='object'),
 answers_sha256 text not null check(answers_sha256 ~ '^[a-f0-9]{64}$'),
 submitted_at timestamptz not null default clock_timestamp(),
 submitted_by_person_id uuid not null references clinical_core.persons(id),
 unique(packet_item_id),
 foreign key (form_version_id,organization_id)
  references clinical_core.intake_form_versions(id,organization_id)
);
alter table clinical_core.intake_form_responses enable row level security;
revoke all on clinical_core.intake_form_responses from public,clinical_core_api;
create index intake_form_responses_connection_idx
 on clinical_core.intake_form_responses(connection_id,submitted_at desc);
create index intake_form_responses_org_idx on clinical_core.intake_form_responses(organization_id);
create index intake_form_responses_version_idx on clinical_core.intake_form_responses(form_version_id);
create index intake_form_responses_submitter_idx
 on clinical_core.intake_form_responses(submitted_by_person_id);
create trigger intake_form_responses_append_only
 before update or delete on clinical_core.intake_form_responses
 for each row execute function clinical_private.block_update_delete();

create table clinical_core.document_signatures(
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references clinical_core.organizations(id),
 packet_item_id uuid not null references clinical_core.intake_packet_items(id),
 connection_id uuid not null references clinical_core.patient_connections(id),
 form_version_id uuid not null references clinical_core.intake_form_versions(id),
 form_content_sha256 text not null check(form_content_sha256 ~ '^[a-f0-9]{64}$'),
 -- The sentence agreed to, digested on its own.
 agreement_sha256 text not null check(agreement_sha256 ~ '^[a-f0-9]{64}$'),
 -- The typed name is stored as the patient typed it, normalised for whitespace, and not
 -- sealed. Sealing it was considered and rejected: the answers recorded next to it are far
 -- more sensitive and are stored as text under the same row-level boundary, the clinic has
 -- to display the name on every signed document, and the only way to seal it would be to
 -- give the patient's own API a decryption key it has no other use for. The digest is kept
 -- so a name can be compared without reading it.
 signer_name text not null check(char_length(btrim(signer_name)) between 2 and 120
  and signer_name=btrim(signer_name)),
 signer_name_digest text not null check(signer_name_digest ~ '^[a-f0-9]{64}$'),
 signer_authority text not null
  check(signer_authority in('self','guardian','healthcare_proxy','legal_representative')),
 signed_at timestamptz not null default clock_timestamp(),
 signed_by_person_id uuid not null references clinical_core.persons(id),
 unique(packet_item_id),
 foreign key (form_version_id,organization_id)
  references clinical_core.intake_form_versions(id,organization_id)
);
alter table clinical_core.document_signatures enable row level security;
revoke all on clinical_core.document_signatures from public,clinical_core_api;
create index document_signatures_connection_idx
 on clinical_core.document_signatures(connection_id,signed_at desc);
create index document_signatures_org_idx on clinical_core.document_signatures(organization_id);
create index document_signatures_version_idx on clinical_core.document_signatures(form_version_id);
create index document_signatures_signer_idx on clinical_core.document_signatures(signed_by_person_id);
create trigger document_signatures_append_only
 before update or delete on clinical_core.document_signatures
 for each row execute function clinical_private.block_update_delete();

/* Whether a questionnaire's structure is usable, as a refusal reason or null.
   Written as sequential statements rather than one boolean expression: the earlier
   program validator was a single expression and accepted a phase whose required fields
   were absent, because `x->>'k' is not null` is false for absent and for null alike and
   the shape of the expression hid which. Each field is checked for presence and for type,
   separately, so neither can pass by being missing. */
create or replace function clinical_private.intake_questionnaire_refusal(_content jsonb) returns text
language plpgsql immutable set search_path='' as $$
declare _section jsonb; _question jsonb; _option jsonb; _ids text[]:='{}'; _values text[];
 _type text; _questions integer:=0;
begin
 if _content is null or clinical_private.jsonb_kind(_content)<>'object' then return 'content_not_object'; end if;
 if _content-array['sections']<>'{}'::jsonb then return 'content_unknown_field'; end if;
 if clinical_private.jsonb_kind(_content->'sections')<>'array' then return 'sections_not_array'; end if;
 if jsonb_array_length(_content->'sections') not between 1 and 20 then return 'sections_out_of_range'; end if;
 for _section in select value from jsonb_array_elements(_content->'sections') loop
  if clinical_private.jsonb_kind(_section)<>'object' then return 'section_not_object'; end if;
  if _section-array['id','title','questions']<>'{}'::jsonb then return 'section_unknown_field'; end if;
  if clinical_private.jsonb_kind(_section->'id')<>'string' then return 'section_id_invalid'; end if;
  if (_section->>'id') !~ '^[a-z0-9][a-z0-9_-]{0,38}$' then return 'section_id_invalid'; end if;
  if clinical_private.jsonb_kind(_section->'title')<>'string' then return 'section_title_invalid'; end if;
  if char_length(_section->>'title') not between 1 and 160 then return 'section_title_invalid'; end if;
  if clinical_private.jsonb_kind(_section->'questions')<>'array' then return 'questions_not_array'; end if;
  if jsonb_array_length(_section->'questions') not between 1 and 40 then return 'questions_out_of_range'; end if;
  if _section->>'id'=any(_ids) then return 'duplicate_id'; end if;
  _ids:=_ids||(_section->>'id');
  for _question in select value from jsonb_array_elements(_section->'questions') loop
   _questions:=_questions+1;
   if _questions>200 then return 'too_many_questions'; end if;
   if clinical_private.jsonb_kind(_question)<>'object' then return 'question_not_object'; end if;
   if clinical_private.jsonb_kind(_question->'id')<>'string' then return 'question_id_invalid'; end if;
   if (_question->>'id') !~ '^[a-z0-9][a-z0-9_-]{0,38}$' then return 'question_id_invalid'; end if;
   if _question->>'id'=any(_ids) then return 'duplicate_id'; end if;
   _ids:=_ids||(_question->>'id');
   if clinical_private.jsonb_kind(_question->'prompt')<>'string' then return 'question_prompt_invalid'; end if;
   if char_length(_question->>'prompt') not between 1 and 500 then return 'question_prompt_invalid'; end if;
   if clinical_private.jsonb_kind(_question->'required')<>'boolean' then return 'question_required_invalid'; end if;
   if clinical_private.jsonb_kind(_question->'type')<>'string' then return 'question_type_invalid'; end if;
   _type:=_question->>'type';
   if _type not in('single_choice','multi_choice','scale','short_text','boolean') then
    return 'question_type_invalid'; end if;
   if _type in('single_choice','multi_choice') then
    if _question-array['id','prompt','required','type','options']<>'{}'::jsonb then
     return 'question_unknown_field'; end if;
    if clinical_private.jsonb_kind(_question->'options')<>'array' then return 'options_not_array'; end if;
    if jsonb_array_length(_question->'options') not between 2 and 20 then return 'options_out_of_range'; end if;
    _values:='{}';
    for _option in select value from jsonb_array_elements(_question->'options') loop
     if clinical_private.jsonb_kind(_option)<>'object' then return 'option_not_object'; end if;
     if _option-array['value','label']<>'{}'::jsonb then return 'option_unknown_field'; end if;
     if clinical_private.jsonb_kind(_option->'value')<>'string' then return 'option_value_invalid'; end if;
     if (_option->>'value') !~ '^[a-z0-9][a-z0-9_-]{0,38}$' then return 'option_value_invalid'; end if;
     if clinical_private.jsonb_kind(_option->'label')<>'string' then return 'option_label_invalid'; end if;
     if char_length(_option->>'label') not between 1 and 200 then return 'option_label_invalid'; end if;
     if _option->>'value'=any(_values) then return 'duplicate_option'; end if;
     _values:=_values||(_option->>'value');
    end loop;
   elsif _type='scale' then
    if _question-array['id','prompt','required','type','min','max']<>'{}'::jsonb then
     return 'question_unknown_field'; end if;
    if clinical_private.jsonb_kind(_question->'min')<>'number' or clinical_private.jsonb_kind(_question->'max')<>'number' then
     return 'scale_bounds_invalid'; end if;
    if (_question->>'min')::numeric<>floor((_question->>'min')::numeric)
    or (_question->>'max')::numeric<>floor((_question->>'max')::numeric) then
     return 'scale_bounds_invalid'; end if;
    if (_question->>'max')::integer<=(_question->>'min')::integer
    or (_question->>'max')::integer-(_question->>'min')::integer>10 then
     return 'scale_bounds_invalid'; end if;
   elsif _type='short_text' then
    if _question-array['id','prompt','required','type','maxLength']<>'{}'::jsonb then
     return 'question_unknown_field'; end if;
    if clinical_private.jsonb_kind(_question->'maxLength')<>'number' then return 'max_length_invalid'; end if;
    if (_question->>'maxLength')::numeric<>floor((_question->>'maxLength')::numeric)
    or (_question->>'maxLength')::integer not between 1 and 500 then return 'max_length_invalid'; end if;
   else
    if _question-array['id','prompt','required','type']<>'{}'::jsonb then
     return 'question_unknown_field'; end if;
   end if;
  end loop;
 end loop;
 return null;
end $$;
revoke all on function clinical_private.intake_questionnaire_refusal(jsonb) from public;

/* Whether a consent document's structure is usable, as a refusal reason or null. */
create or replace function clinical_private.intake_document_refusal(_content jsonb) returns text
language plpgsql immutable set search_path='' as $$
declare _block jsonb; _paragraph jsonb;
begin
 if _content is null or clinical_private.jsonb_kind(_content)<>'object' then return 'content_not_object'; end if;
 if _content-array['body','agreement']<>'{}'::jsonb then return 'content_unknown_field'; end if;
 if clinical_private.jsonb_kind(_content->'body')<>'array' then return 'body_not_array'; end if;
 if jsonb_array_length(_content->'body') not between 1 and 40 then return 'body_out_of_range'; end if;
 for _block in select value from jsonb_array_elements(_content->'body') loop
  if clinical_private.jsonb_kind(_block)<>'object' then return 'block_not_object'; end if;
  if _block-array['heading','paragraphs']<>'{}'::jsonb then return 'block_unknown_field'; end if;
  if clinical_private.jsonb_kind(_block->'heading')<>'string' then return 'block_heading_invalid'; end if;
  if char_length(_block->>'heading') not between 1 and 200 then return 'block_heading_invalid'; end if;
  if clinical_private.jsonb_kind(_block->'paragraphs')<>'array' then return 'paragraphs_not_array'; end if;
  if jsonb_array_length(_block->'paragraphs') not between 1 and 40 then return 'paragraphs_out_of_range'; end if;
  for _paragraph in select value from jsonb_array_elements(_block->'paragraphs') loop
   if clinical_private.jsonb_kind(_paragraph)<>'string' then return 'paragraph_invalid'; end if;
   if char_length(_paragraph #>> '{}') not between 1 and 4000 then return 'paragraph_invalid'; end if;
  end loop;
 end loop;
 if clinical_private.jsonb_kind(_content->'agreement')<>'object' then return 'agreement_not_object'; end if;
 if (_content->'agreement')-array['statement','requiresTypedName']<>'{}'::jsonb then
  return 'agreement_unknown_field'; end if;
 if clinical_private.jsonb_kind(_content->'agreement'->'statement')<>'string' then return 'agreement_statement_invalid'; end if;
 if char_length(_content->'agreement'->>'statement') not between 20 and 1000 then
  return 'agreement_statement_invalid'; end if;
 if clinical_private.jsonb_kind(_content->'agreement'->'requiresTypedName')<>'boolean' then
  return 'agreement_typed_name_invalid'; end if;
 -- A typed name is the only evidence this family collects that a person signed. A document
 -- that does not ask for one would record an agreement with nothing attached to it.
 if (_content->'agreement'->>'requiresTypedName')<>'true' then return 'agreement_typed_name_required'; end if;
 return null;
end $$;
revoke all on function clinical_private.intake_document_refusal(jsonb) from public;

/* Whether an answer set is acceptable for a questionnaire, as a refusal reason or null.
   Every required question must be answered, every answered question must exist, and every
   value must be of the kind its question declares. */
create or replace function clinical_private.intake_answers_refusal(_content jsonb,_answers jsonb)
returns text language plpgsql immutable set search_path='' as $$
declare _section jsonb; _question jsonb; _answer jsonb; _entry jsonb; _known text[]:='{}';
 _type text; _options text[];
begin
 if _answers is null or clinical_private.jsonb_kind(_answers)<>'object' then return 'answers_not_object'; end if;
 for _section in select value from jsonb_array_elements(_content->'sections') loop
  for _question in select value from jsonb_array_elements(_section->'questions') loop
   _known:=_known||(_question->>'id');
   _type:=_question->>'type';
   _answer:=_answers->(_question->>'id');
   if _answer is null or clinical_private.jsonb_kind(_answer)='null' then
    if (_question->>'required')='true' then return 'answer_missing'; end if;
    continue;
   end if;
   if _type='boolean' then
    if clinical_private.jsonb_kind(_answer)<>'boolean' then return 'answer_invalid'; end if;
   elsif _type='scale' then
    if clinical_private.jsonb_kind(_answer)<>'number' then return 'answer_invalid'; end if;
    if (_answer #>> '{}')::numeric<>floor((_answer #>> '{}')::numeric) then return 'answer_invalid'; end if;
    if (_answer #>> '{}')::integer<(_question->>'min')::integer
    or (_answer #>> '{}')::integer>(_question->>'max')::integer then return 'answer_out_of_range'; end if;
   elsif _type='short_text' then
    if clinical_private.jsonb_kind(_answer)<>'string' then return 'answer_invalid'; end if;
    if char_length(_answer #>> '{}')>(_question->>'maxLength')::integer then return 'answer_too_long'; end if;
    if (_question->>'required')='true' and char_length(btrim(_answer #>> '{}'))=0 then
     return 'answer_missing'; end if;
   else
    _options:=array(select jsonb_array_elements(_question->'options')->>'value');
    if _type='single_choice' then
     if clinical_private.jsonb_kind(_answer)<>'string' then return 'answer_invalid'; end if;
     if not (_answer #>> '{}')=any(_options) then return 'answer_not_offered'; end if;
    else
     if clinical_private.jsonb_kind(_answer)<>'array' then return 'answer_invalid'; end if;
     if jsonb_array_length(_answer)>cardinality(_options) then return 'answer_invalid'; end if;
     if (_question->>'required')='true' and jsonb_array_length(_answer)=0 then return 'answer_missing'; end if;
     for _entry in select value from jsonb_array_elements(_answer) loop
      if clinical_private.jsonb_kind(_entry)<>'string' then return 'answer_invalid'; end if;
      if not (_entry #>> '{}')=any(_options) then return 'answer_not_offered'; end if;
     end loop;
     if (select count(distinct value) from jsonb_array_elements_text(_answer))
        <>jsonb_array_length(_answer) then return 'answer_invalid'; end if;
    end if;
   end if;
  end loop;
 end loop;
 -- An answer to a question the form does not contain is a client the server does not
 -- understand, not extra information to keep.
 if exists(select 1 from jsonb_object_keys(_answers) key where not key=any(_known)) then
  return 'answer_unknown_question';
 end if;
 return null;
end $$;
revoke all on function clinical_private.intake_answers_refusal(jsonb,jsonb) from public;

/* A packet's completion, recomputed from what is actually recorded. Called after every
   submission and signature so 'completed' is never a state a client asked for. */
create or replace function clinical_private.settle_intake_packet(_packet uuid) returns text
language plpgsql set search_path='' as $$
declare _outstanding integer;
begin
 select count(*) into _outstanding
 from clinical_core.intake_packet_items item
 join clinical_core.intake_form_versions version on version.id=item.form_version_id
 where item.packet_id=_packet and item.required
  and case when version.kind='consent_document'
   then not exists(select 1 from clinical_core.document_signatures s where s.packet_item_id=item.id)
   else not exists(select 1 from clinical_core.intake_form_responses r where r.packet_item_id=item.id) end;
 if _outstanding=0 then
  update clinical_core.intake_packets set status='completed',completed_at=clock_timestamp(),
   revision=revision+1 where id=_packet and status='open';
  return 'completed';
 end if;
 return 'open';
end $$;
revoke all on function clinical_private.settle_intake_packet(uuid) from public;

/* What a patient is shown for one item: the published version's own content, never
   anything a caller supplied. */
create or replace function clinical_private.intake_item_view(_item uuid) returns jsonb
language plpgsql stable set search_path='' as $$
declare _row record;
begin
 select item.id as item_id,item.position,item.required,version.id as version_id,version.title,
  version.kind,version.content,version.content_sha256,version.agreement_sha256,
  version.form_key,version.version as version_number,
  (select jsonb_build_object('submittedAt',r.submitted_at,'answersSha256',r.answers_sha256)
   from clinical_core.intake_form_responses r where r.packet_item_id=item.id) as response,
  (select jsonb_build_object('signedAt',s.signed_at,'authority',s.signer_authority)
   from clinical_core.document_signatures s where s.packet_item_id=item.id) as signature
  into _row
 from clinical_core.intake_packet_items item
 join clinical_core.intake_form_versions version on version.id=item.form_version_id
 where item.id=_item;
 if _row.item_id is null then return null; end if;
 return jsonb_build_object('itemId',_row.item_id,'position',_row.position,'required',_row.required,
  'formVersionId',_row.version_id,'formKey',_row.form_key,'version',_row.version_number,
  'title',_row.title,'kind',_row.kind,'content',_row.content,
  'contentSha256',_row.content_sha256,'agreementSha256',_row.agreement_sha256,
  'response',_row.response,'signature',_row.signature);
end $$;
revoke all on function clinical_private.intake_item_view(uuid) from public;

/* The clinic authoring its own forms. Drafts are editable; published versions are not. */
create or replace function clinical_core.intake_form_admin(_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 _org uuid:=clinical_private.organization_id(); _actor uuid; _action text; _refusal text;
 _row clinical_core.intake_form_versions%rowtype; _next integer; _agreement text;
begin
 _actor:=clinical_private.assert_consult_workforce(_org);
 if _request is null or clinical_private.jsonb_kind(_request)<>'object' then
  raise exception using errcode='22023',message='intake_form_invalid'; end if;
 _action:=_request->>'action';
 if _action is null or _action not in('list','draft','update','publish','retire') then
  raise exception using errcode='22023',message='intake_form_invalid'; end if;

 if _action='list' then
  if _request-array['action','status']<>'{}'::jsonb then
   raise exception using errcode='22023',message='intake_form_invalid'; end if;
  if (_request->>'status') is not null and (_request->>'status') not in('draft','published','retired') then
   raise exception using errcode='22023',message='intake_form_invalid'; end if;
  return jsonb_build_object('action','list','forms',coalesce((
   select jsonb_agg(jsonb_build_object('formVersionId',v.id,'formKey',v.form_key,'version',v.version,
    'title',v.title,'kind',v.kind,'status',v.status,'contentSha256',v.content_sha256,
    'agreementSha256',v.agreement_sha256,'createdAt',v.created_at,'publishedAt',v.published_at,
    'assignable',v.status='published')
    order by v.form_key,v.version desc)
   from clinical_core.intake_form_versions v where v.organization_id=_org
    and ((_request->>'status') is null or v.status=_request->>'status')),'[]'::jsonb));
 end if;

 if _action='draft' then
  if _request-array['action','formKey','title','kind','content']<>'{}'::jsonb then
   raise exception using errcode='22023',message='intake_form_invalid'; end if;
  if (_request->>'formKey') is null or (_request->>'title') is null
  or (_request->>'kind') is null or (_request->>'kind') not in('questionnaire','consent_document')
  or clinical_private.jsonb_kind(_request->'content')<>'object' then
   raise exception using errcode='22023',message='intake_form_invalid'; end if;
  _refusal:=case when (_request->>'kind')='questionnaire'
   then clinical_private.intake_questionnaire_refusal(_request->'content')
   else clinical_private.intake_document_refusal(_request->'content') end;
  if _refusal is not null then
   raise exception using errcode='22023',message='intake_form_content_invalid: '||_refusal; end if;
  select coalesce(max(version),0)+1 into _next from clinical_core.intake_form_versions
   where organization_id=_org and form_key=_request->>'formKey';
  begin
   insert into clinical_core.intake_form_versions(organization_id,form_key,version,title,kind,
    content,content_sha256,agreement_sha256,created_by_person_id)
   values(_org,_request->>'formKey',_next,_request->>'title',_request->>'kind',_request->'content',
    encode(public.digest(convert_to((_request->'content')::text,'UTF8'),'sha256'),'hex'),
    case when (_request->>'kind')='consent_document'
     then encode(public.digest(convert_to(_request->'content'->'agreement'->>'statement','UTF8'),'sha256'),'hex')
     else null end,
    _actor)
   returning * into _row;
  exception when check_violation then raise exception using errcode='22023',message='intake_form_invalid';
  end;
  return jsonb_build_object('action','draft','formVersionId',_row.id,'formKey',_row.form_key,
   'version',_row.version,'status',_row.status,'contentSha256',_row.content_sha256);
 end if;

 if (_request->>'formVersionId') is null then
  raise exception using errcode='22023',message='intake_form_invalid'; end if;
 begin
  select * into _row from clinical_core.intake_form_versions
   where id=(_request->>'formVersionId')::uuid and organization_id=_org for update;
 exception when invalid_text_representation then
  raise exception using errcode='22023',message='intake_form_invalid'; end;
 if _row.id is null then raise exception using errcode='P0002',message='intake_form_absent'; end if;

 if _action='update' then
  if _request-array['action','formVersionId','title','content']<>'{}'::jsonb then
   raise exception using errcode='22023',message='intake_form_invalid'; end if;
  if _row.status<>'draft' then
   raise exception using errcode='40001',message='intake_form_not_draft'; end if;
  if clinical_private.jsonb_kind(_request->'content')<>'object' then
   raise exception using errcode='22023',message='intake_form_invalid'; end if;
  _refusal:=case when _row.kind='questionnaire'
   then clinical_private.intake_questionnaire_refusal(_request->'content')
   else clinical_private.intake_document_refusal(_request->'content') end;
  if _refusal is not null then
   raise exception using errcode='22023',message='intake_form_content_invalid: '||_refusal; end if;
  _agreement:=case when _row.kind='consent_document'
   then encode(public.digest(convert_to(_request->'content'->'agreement'->>'statement','UTF8'),'sha256'),'hex')
   else null end;
  update clinical_core.intake_form_versions set
   title=coalesce(nullif(_request->>'title',''),_row.title),content=_request->'content',
   content_sha256=encode(public.digest(convert_to((_request->'content')::text,'UTF8'),'sha256'),'hex'),
   agreement_sha256=_agreement where id=_row.id returning * into _row;
  return jsonb_build_object('action','update','formVersionId',_row.id,'version',_row.version,
   'status',_row.status,'contentSha256',_row.content_sha256);
 end if;

 if _request-array['action','formVersionId']<>'{}'::jsonb then
  raise exception using errcode='22023',message='intake_form_invalid'; end if;
 if _action='publish' then
  if _row.status<>'draft' then
   raise exception using errcode='40001',message='intake_form_not_draft'; end if;
  -- Revalidated at the moment of publication. A draft may have been written by an earlier
  -- version of this function, and publication is the point of no return.
  _refusal:=case when _row.kind='questionnaire'
   then clinical_private.intake_questionnaire_refusal(_row.content)
   else clinical_private.intake_document_refusal(_row.content) end;
  if _refusal is not null then
   raise exception using errcode='22023',message='intake_form_content_invalid: '||_refusal; end if;
  update clinical_core.intake_form_versions set status='published',published_at=clock_timestamp(),
   published_by_person_id=_actor where id=_row.id returning * into _row;
  return jsonb_build_object('action','publish','formVersionId',_row.id,'formKey',_row.form_key,
   'version',_row.version,'status',_row.status,'contentSha256',_row.content_sha256);
 end if;
 if _row.status<>'published' then
  raise exception using errcode='40001',message='intake_form_not_published'; end if;
 update clinical_core.intake_form_versions set status='retired',retired_at=clock_timestamp()
  where id=_row.id returning * into _row;
 return jsonb_build_object('action','retire','formVersionId',_row.id,'status',_row.status);
end $$;
revoke all on function clinical_core.intake_form_admin(jsonb) from public;
grant execute on function clinical_core.intake_form_admin(jsonb) to clinical_core_api;

/* The clinic assigning a packet and reading what came back. */
create or replace function clinical_core.intake_packet_workforce(_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 _org uuid:=clinical_private.organization_id(); _actor uuid; _action text;
 _connection clinical_core.patient_connections%rowtype; _packet clinical_core.intake_packets%rowtype;
 _entry jsonb; _position integer:=0; _version clinical_core.intake_form_versions%rowtype;
 _consult uuid; _due timestamptz; _items jsonb:='[]'::jsonb;
begin
 _actor:=clinical_private.assert_consult_workforce(_org);
 if _request is null or clinical_private.jsonb_kind(_request)<>'object' then
  raise exception using errcode='22023',message='intake_packet_invalid'; end if;
 _action:=_request->>'action';
 if _action is null or _action not in('assign','list','open','cancel') then
  raise exception using errcode='22023',message='intake_packet_invalid'; end if;

 if _action='assign' then
  if _request-array['action','connectionId','forms','label','dueBefore','consultRequestId']<>'{}'::jsonb
  or (_request->>'connectionId') is null or (_request->>'label') is null
  or clinical_private.jsonb_kind(_request->'forms')<>'array'
  or jsonb_array_length(_request->'forms') not between 1 and 20 then
   raise exception using errcode='22023',message='intake_packet_invalid'; end if;
  begin
   select * into _connection from clinical_core.patient_connections
    where id=(_request->>'connectionId')::uuid and organization_id=_org;
   _due:=nullif(_request->>'dueBefore','')::timestamptz;
   _consult:=nullif(_request->>'consultRequestId','')::uuid;
  exception when others then raise exception using errcode='22023',message='intake_packet_invalid'; end;
  if _connection.id is null then raise exception using errcode='P0002',message='intake_connection_absent'; end if;
  if _connection.state not in('invitation_pending','verified') then
   raise exception using errcode='40001',message='intake_connection_unavailable'; end if;
  -- Paperwork is a disclosure to and from the patient. A clinic that does not hold a
  -- granted forms consent for this connection does not get to send it.
  if not exists(select 1 from clinical_core.current_consent c
   where c.connection_id=_connection.id and c.scope='forms_checkins' and c.status='granted') then
   raise exception using errcode='42501',message='intake_consent_absent'; end if;
  if _consult is not null and not exists(select 1 from clinical_core.consult_requests r
   where r.id=_consult and r.organization_id=_org and r.connection_id=_connection.id) then
   raise exception using errcode='22023',message='intake_packet_invalid'; end if;
  insert into clinical_core.intake_packets(organization_id,connection_id,patient_record_id,
   consult_request_id,label,due_before,created_by_person_id)
  values(_org,_connection.id,_connection.patient_record_id,_consult,_request->>'label',_due,_actor)
  returning * into _packet;
  for _entry in select value from jsonb_array_elements(_request->'forms') loop
   _position:=_position+1;
   if clinical_private.jsonb_kind(_entry)<>'object' or _entry-array['formVersionId','required']<>'{}'::jsonb
   or (_entry->>'formVersionId') is null then
    raise exception using errcode='22023',message='intake_packet_invalid'; end if;
   begin
    select * into _version from clinical_core.intake_form_versions
     where id=(_entry->>'formVersionId')::uuid and organization_id=_org;
   exception when invalid_text_representation then
    raise exception using errcode='22023',message='intake_packet_invalid'; end;
   if _version.id is null then raise exception using errcode='P0002',message='intake_form_absent'; end if;
   -- The rule the program path got wrong: only a published version may be delivered.
   if _version.status<>'published' then
    raise exception using errcode='42501',message='intake_form_unpublished'; end if;
   insert into clinical_core.intake_packet_items(packet_id,organization_id,form_version_id,
    position,required)
   values(_packet.id,_org,_version.id,_position,
    coalesce((_entry->>'required')::boolean,true));
   _items:=_items||jsonb_build_array(jsonb_build_object('formVersionId',_version.id,
    'formKey',_version.form_key,'version',_version.version,'kind',_version.kind,
    'position',_position,'contentSha256',_version.content_sha256));
  end loop;
  return jsonb_build_object('action','assign','packetId',_packet.id,'status',_packet.status,
   'revision',_packet.revision::text,'items',_items);
 end if;

 if _action='list' then
  if _request-array['action','connectionId','status']<>'{}'::jsonb then
   raise exception using errcode='22023',message='intake_packet_invalid'; end if;
  if (_request->>'status') is not null and (_request->>'status') not in('open','completed','cancelled') then
   raise exception using errcode='22023',message='intake_packet_invalid'; end if;
  begin _connection.id:=nullif(_request->>'connectionId','')::uuid;
  exception when others then raise exception using errcode='22023',message='intake_packet_invalid'; end;
  return jsonb_build_object('action','list','packets',coalesce((
   select jsonb_agg(jsonb_build_object('packetId',p.id,'connectionId',p.connection_id,
    'label',p.label,'status',p.status,'dueBefore',p.due_before,'createdAt',p.created_at,
    'completedAt',p.completed_at,'revision',p.revision::text,
    'consultRequestId',p.consult_request_id,
    'required',(select count(*) from clinical_core.intake_packet_items i where i.packet_id=p.id and i.required),
    'outstanding',(select count(*) from clinical_core.intake_packet_items i
     join clinical_core.intake_form_versions v on v.id=i.form_version_id
     where i.packet_id=p.id and i.required
      and case when v.kind='consent_document'
       then not exists(select 1 from clinical_core.document_signatures s where s.packet_item_id=i.id)
       else not exists(select 1 from clinical_core.intake_form_responses r where r.packet_item_id=i.id) end))
    order by p.created_at desc)
   from clinical_core.intake_packets p where p.organization_id=_org
    and (_connection.id is null or p.connection_id=_connection.id)
    and ((_request->>'status') is null or p.status=_request->>'status')),'[]'::jsonb));
 end if;

 if (_request->>'packetId') is null then
  raise exception using errcode='22023',message='intake_packet_invalid'; end if;
 begin
  select * into _packet from clinical_core.intake_packets
   where id=(_request->>'packetId')::uuid and organization_id=_org for update;
 exception when invalid_text_representation then
  raise exception using errcode='22023',message='intake_packet_invalid'; end;
 if _packet.id is null then raise exception using errcode='P0002',message='intake_packet_absent'; end if;

 if _action='open' then
  if _request-array['action','packetId']<>'{}'::jsonb then
   raise exception using errcode='22023',message='intake_packet_invalid'; end if;
  return jsonb_build_object('action','open','packetId',_packet.id,'label',_packet.label,
   'status',_packet.status,'connectionId',_packet.connection_id,'dueBefore',_packet.due_before,
   'revision',_packet.revision::text,
   'items',coalesce((select jsonb_agg(entry order by entry->>'position') from (
    select jsonb_build_object('itemId',i.id,'position',i.position,'required',i.required,
     'formKey',v.form_key,'version',v.version,'title',v.title,'kind',v.kind,
     'contentSha256',v.content_sha256,
     'answers',(select r.answers from clinical_core.intake_form_responses r where r.packet_item_id=i.id),
     'submittedAt',(select r.submitted_at from clinical_core.intake_form_responses r where r.packet_item_id=i.id),
     'signature',(select jsonb_build_object('signedAt',s.signed_at,'authority',s.signer_authority,
       'agreementSha256',s.agreement_sha256,'signerName',s.signer_name,
       'signerNameDigest',s.signer_name_digest)
      from clinical_core.document_signatures s where s.packet_item_id=i.id)) as entry
    from clinical_core.intake_packet_items i
    join clinical_core.intake_form_versions v on v.id=i.form_version_id
    where i.packet_id=_packet.id) page),'[]'::jsonb));
 end if;

 if _request-array['action','packetId','expectedRevision']<>'{}'::jsonb
 or (_request->>'expectedRevision') !~ '^[0-9]{1,18}$' then
  raise exception using errcode='22023',message='intake_packet_invalid'; end if;
 if _packet.revision<>(_request->>'expectedRevision')::bigint then
  raise exception using errcode='40001',message='intake_packet_revision_stale'; end if;
 if _packet.status<>'open' then
  raise exception using errcode='40001',message='intake_packet_state_invalid'; end if;
 update clinical_core.intake_packets set status='cancelled',cancelled_at=clock_timestamp(),
  cancelled_by_person_id=_actor,revision=_packet.revision+1 where id=_packet.id returning * into _packet;
 return jsonb_build_object('action','cancel','packetId',_packet.id,'status',_packet.status,
  'revision',_packet.revision::text);
end $$;
revoke all on function clinical_core.intake_packet_workforce(jsonb) from public;
grant execute on function clinical_core.intake_packet_workforce(jsonb) to clinical_core_api;

/* The patient's side: see the packet, answer a questionnaire, sign a document. */
create or replace function clinical_core.intake_packet_consumer(_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 _actor uuid:=clinical_private.actor_person_id(); _org uuid:=clinical_private.organization_id();
 _pool text:=clinical_private.claim('identity_pool'); _action text; _refusal text;
 _packet clinical_core.intake_packets%rowtype; _item clinical_core.intake_packet_items%rowtype;
 _version clinical_core.intake_form_versions%rowtype; _state text; _digest text;
begin
 perform clinical_private.assert_synthetic_context(_org,'clinical_data');
 if _actor is null or _pool<>'consumer'
 or not exists(select 1 from clinical_core.identities i join clinical_core.persons p on p.id=i.person_id
  where i.person_id=_actor and i.identity_pool=_pool
   and i.identity_subject=clinical_private.claim('identity_subject')
   and i.status='active' and p.status='active' and i.synthetic_attested) then
  raise exception using errcode='42501',message='intake_packet_forbidden'; end if;
 if _request is null or clinical_private.jsonb_kind(_request)<>'object' then
  raise exception using errcode='22023',message='intake_packet_invalid'; end if;
 _action:=_request->>'action';
 if _action is null or _action not in('list','open','submit','sign') then
  raise exception using errcode='22023',message='intake_packet_invalid'; end if;

 if _action='list' then
  if _request-array['action']<>'{}'::jsonb then
   raise exception using errcode='22023',message='intake_packet_invalid'; end if;
  return jsonb_build_object('action','list','packets',coalesce((
   select jsonb_agg(jsonb_build_object('packetId',p.id,'label',p.label,'status',p.status,
    'dueBefore',p.due_before,'createdAt',p.created_at,'revision',p.revision::text,
    'outstanding',(select count(*) from clinical_core.intake_packet_items i
     join clinical_core.intake_form_versions v on v.id=i.form_version_id
     where i.packet_id=p.id and i.required
      and case when v.kind='consent_document'
       then not exists(select 1 from clinical_core.document_signatures s where s.packet_item_id=i.id)
       else not exists(select 1 from clinical_core.intake_form_responses r where r.packet_item_id=i.id) end))
    order by p.created_at desc)
   from clinical_core.intake_packets p
   join clinical_core.patient_connections c on c.id=p.connection_id
   where c.consumer_person_id=_actor and p.organization_id=_org
    and p.status in('open','completed')),'[]'::jsonb));
 end if;

 if (_request->>'packetId') is null then
  raise exception using errcode='22023',message='intake_packet_invalid'; end if;
 begin
  select p.* into _packet from clinical_core.intake_packets p
   join clinical_core.patient_connections c on c.id=p.connection_id
   where p.id=(_request->>'packetId')::uuid and p.organization_id=_org
    and c.consumer_person_id=_actor for update of p;
 exception when invalid_text_representation then
  raise exception using errcode='22023',message='intake_packet_invalid'; end;
 if _packet.id is null then raise exception using errcode='P0002',message='intake_packet_absent'; end if;

 if _action='open' then
  if _request-array['action','packetId']<>'{}'::jsonb then
   raise exception using errcode='22023',message='intake_packet_invalid'; end if;
  return jsonb_build_object('action','open','packetId',_packet.id,'label',_packet.label,
   'status',_packet.status,'dueBefore',_packet.due_before,'revision',_packet.revision::text,
   'items',coalesce((select jsonb_agg(clinical_private.intake_item_view(i.id) order by i.position)
    from clinical_core.intake_packet_items i where i.packet_id=_packet.id),'[]'::jsonb));
 end if;

 if _packet.status<>'open' then
  raise exception using errcode='40001',message='intake_packet_state_invalid'; end if;
 if _packet.due_before is not null and _packet.due_before<clock_timestamp() then
  raise exception using errcode='40001',message='intake_packet_past_due'; end if;
 if (_request->>'itemId') is null then
  raise exception using errcode='22023',message='intake_packet_invalid'; end if;
 begin
  select * into _item from clinical_core.intake_packet_items
   where id=(_request->>'itemId')::uuid and packet_id=_packet.id for update;
 exception when invalid_text_representation then
  raise exception using errcode='22023',message='intake_packet_invalid'; end;
 if _item.id is null then raise exception using errcode='P0002',message='intake_item_absent'; end if;
 select * into _version from clinical_core.intake_form_versions where id=_item.form_version_id;
 if (_request->>'contentSha256') is null
 or (_request->>'contentSha256') !~ '^[a-f0-9]{64}$' then
  raise exception using errcode='22023',message='intake_packet_invalid'; end if;
 -- The submitter proves which text it rendered. Recording an answer against text the
 -- patient did not see would make the record unusable as evidence of anything.
 if _request->>'contentSha256'<>_version.content_sha256 then
  raise exception using errcode='40001',message='intake_form_changed'; end if;

 if _action='submit' then
  if _request-array['action','packetId','itemId','contentSha256','answers']<>'{}'::jsonb
  or clinical_private.jsonb_kind(_request->'answers')<>'object' then
   raise exception using errcode='22023',message='intake_packet_invalid'; end if;
  if _version.kind<>'questionnaire' then
   raise exception using errcode='22023',message='intake_item_not_questionnaire'; end if;
  if exists(select 1 from clinical_core.intake_form_responses where packet_item_id=_item.id) then
   raise exception using errcode='40001',message='intake_response_recorded'; end if;
  _refusal:=clinical_private.intake_answers_refusal(_version.content,_request->'answers');
  if _refusal is not null then
   raise exception using errcode='22023',message='intake_answers_invalid: '||_refusal; end if;
  insert into clinical_core.intake_form_responses(organization_id,packet_item_id,connection_id,
   form_version_id,form_content_sha256,answers,answers_sha256,submitted_by_person_id)
  values(_org,_item.id,_packet.connection_id,_version.id,_version.content_sha256,
   _request->'answers',
   encode(public.digest(convert_to((_request->'answers')::text,'UTF8'),'sha256'),'hex'),_actor);
  _state:=clinical_private.settle_intake_packet(_packet.id);
  return jsonb_build_object('action','submit','packetId',_packet.id,'itemId',_item.id,
   'packetStatus',_state,'contentSha256',_version.content_sha256);
 end if;

 if _request-array['action','packetId','itemId','contentSha256','agreementSha256',
  'signerName','signerNameDigest','signerAuthority']<>'{}'::jsonb then
  raise exception using errcode='22023',message='intake_packet_invalid'; end if;
 if _version.kind<>'consent_document' then
  raise exception using errcode='22023',message='intake_item_not_document'; end if;
 if exists(select 1 from clinical_core.document_signatures where packet_item_id=_item.id) then
  raise exception using errcode='40001',message='intake_signature_recorded'; end if;
 if clinical_private.jsonb_kind(_request->'signerName')<>'string'
 or char_length(btrim(_request->>'signerName')) not between 2 and 120
 or (_request->>'signerNameDigest') !~ '^[a-f0-9]{64}$'
 -- The digest must be of the name that arrived. A client that sends one of something else is
 -- recording an agreement under a name nobody typed.
 or (_request->>'signerNameDigest')<>encode(public.digest(
  convert_to(regexp_replace(btrim(_request->>'signerName'),'\s+',' ','g'),'UTF8'),'sha256'),'hex')
 or (_request->>'signerAuthority') is null
 or (_request->>'signerAuthority') not in('self','guardian','healthcare_proxy','legal_representative') then
  raise exception using errcode='22023',message='intake_packet_invalid'; end if;
 _digest:=_request->>'agreementSha256';
 if _digest is null or _digest !~ '^[a-f0-9]{64}$' then
  raise exception using errcode='22023',message='intake_packet_invalid'; end if;
 -- The sentence agreed to, checked on its own. This is the claim a signature makes.
 if _digest<>_version.agreement_sha256 then
  raise exception using errcode='40001',message='intake_agreement_changed'; end if;
 insert into clinical_core.document_signatures(organization_id,packet_item_id,connection_id,
  form_version_id,form_content_sha256,agreement_sha256,signer_name,signer_name_digest,
  signer_authority,signed_by_person_id)
 values(_org,_item.id,_packet.connection_id,_version.id,_version.content_sha256,_version.agreement_sha256,
  regexp_replace(btrim(_request->>'signerName'),'\s+',' ','g'),
  _request->>'signerNameDigest',_request->>'signerAuthority',_actor);
 _state:=clinical_private.settle_intake_packet(_packet.id);
 return jsonb_build_object('action','sign','packetId',_packet.id,'itemId',_item.id,
  'packetStatus',_state,'agreementSha256',_version.agreement_sha256,
  'signerAuthority',_request->>'signerAuthority');
end $$;
revoke all on function clinical_core.intake_packet_consumer(jsonb) from public;
grant execute on function clinical_core.intake_packet_consumer(jsonb) to clinical_core_api;
