-- Versioned protocol + template acceptance tests.
-- Rolled back: the project is unchanged after the final statement.
--
-- Covers: honest empty state · template create/approve/archive · start a
-- protocol from an approved template · exact product identity preservation ·
-- template isolation (customizing the copy never touches the source) ·
-- autosave optimistic concurrency (40001) · payload validation · approve is
-- NOT activate · activation side-effect freedom (no order/charge/message/note)
-- · immutability of approved+active versions (RPC and direct SQL) ·
-- revise-into-new-draft with the original unchanged · supersede without delete
-- · lifecycle pause/complete · role refusal (staff) · cross-tenant refusals ·
-- anonymous refusal.

begin;
create temp table _v(name text, passed boolean, detail text) on commit drop;
create temp table _ids(k text primary key, v uuid) on commit drop;

insert into auth.users(id,email) values
  ('11111111-0000-0000-0000-000000000501','pr-practitioner@verify.local'),
  ('11111111-0000-0000-0000-000000000502','pr-staff@verify.local'),
  ('11111111-0000-0000-0000-000000000503','pr-outsider@verify.local');
insert into public.organizations(id,name,slug) values
  ('bbbbbbbb-0000-0000-0000-000000000501','Protocol Org','protocol-0050'),
  ('bbbbbbbb-0000-0000-0000-000000000502','Protocol Other','protocol-other-0050');
insert into public.organization_memberships(organization_id,user_id,role,status) values
  ('bbbbbbbb-0000-0000-0000-000000000501','11111111-0000-0000-0000-000000000501','practitioner','active'),
  ('bbbbbbbb-0000-0000-0000-000000000501','11111111-0000-0000-0000-000000000502','staff','active'),
  ('bbbbbbbb-0000-0000-0000-000000000502','11111111-0000-0000-0000-000000000503','practitioner','active');
insert into public.patient_profiles(id,organization_id,first_name,last_name) values
  ('cccccccc-0000-0000-0000-000000000501','bbbbbbbb-0000-0000-0000-000000000501','Protocol','Patient'),
  ('cccccccc-0000-0000-0000-000000000502','bbbbbbbb-0000-0000-0000-000000000502','Other','Patient');
insert into public.practitioner_patient_relationships
  (organization_id,practitioner_user_id,patient_id,status) values
  ('bbbbbbbb-0000-0000-0000-000000000501','11111111-0000-0000-0000-000000000501','cccccccc-0000-0000-0000-000000000501','active'),
  ('bbbbbbbb-0000-0000-0000-000000000501','11111111-0000-0000-0000-000000000502','cccccccc-0000-0000-0000-000000000501','active'),
  ('bbbbbbbb-0000-0000-0000-000000000502','11111111-0000-0000-0000-000000000503','cccccccc-0000-0000-0000-000000000502','active');
insert into public.supplement_brands(id,name) values
  ('99999999-0000-0000-0000-000000000501','Verify Labs');
insert into public.supplement_products(id,brand_id,name,form) values
  ('88888888-0000-0000-0000-000000000501','99999999-0000-0000-0000-000000000501','Magnesium Glycinate','capsule');

insert into _v
select 'anon cannot execute any protocol RPC',
  not bool_or(has_function_privilege('anon', p.oid, 'execute'))
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in
    ('get_patient_protocol','create_protocol_draft','save_protocol_draft',
     'approve_protocol_version','activate_protocol_version','set_protocol_lifecycle',
     'revise_protocol_version','list_protocol_templates','create_protocol_template',
     'approve_protocol_template_version','archive_protocol_template');
insert into _v
select 'all protocol RPCs pin an empty search_path',
  bool_and(p.prosecdef and 'search_path=""' = any(p.proconfig))
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in
    ('get_patient_protocol','create_protocol_draft','save_protocol_draft',
     'approve_protocol_version','activate_protocol_version','set_protocol_lifecycle',
     'revise_protocol_version','list_protocol_templates','create_protocol_template',
     'approve_protocol_template_version','archive_protocol_template');
insert into _v
select 'protocol tables have RLS and no direct authenticated writes',
  bool_and(c.relrowsecurity)
  and not bool_or(has_table_privilege('authenticated', c.oid, 'insert'))
  and not bool_or(has_table_privilege('authenticated', c.oid, 'update'))
  and not bool_or(has_table_privilege('authenticated', c.oid, 'delete'))
  from pg_class c where c.oid in (
    'public.protocols'::regclass,'public.protocol_templates'::regclass,
    'public.protocol_versions'::regclass,'public.protocol_phases'::regclass,
    'public.protocol_items'::regclass);

select set_config('request.jwt.claims',
  '{"sub":"11111111-0000-0000-0000-000000000501","role":"authenticated"}', true);

do $$
declare _p jsonb;
begin
  _p := public.get_patient_protocol(
    'bbbbbbbb-0000-0000-0000-000000000501','cccccccc-0000-0000-0000-000000000501');
  insert into _v values('a patient with no protocol reports an honest empty state',
    (_p->>'exists')::boolean = false
      and (_p->>'canAuthor')::boolean = true
      and (_p->'draft') = 'null'::jsonb
      and jsonb_array_length(_p->'history') = 0,
    _p #>> '{}');
end $$;

do $$
declare _t jsonb; _d jsonb; _saved jsonb;
begin
  _t := public.create_protocol_template(
    'bbbbbbbb-0000-0000-0000-000000000501','Thyroid Reset','Baseline thyroid protocol',null);
  insert into _ids values ('tpl',(_t->>'templateId')::uuid);
  insert into _ids values ('tplv',(_t->>'versionId')::uuid);

  _saved := public.save_protocol_draft((_t->>'versionId')::uuid, jsonb_build_object(
    'title','Thyroid Reset',
    'dietInstructions','Whole-food, iodine-aware',
    'monitoringPlan','TSH + free T4 at 8 weeks',
    'phases', jsonb_build_array(
      jsonb_build_object('name','Phase 1 — Repletion','relativeStartDay',0,'relativeDurationDays',28)),
    'items', jsonb_build_array(
      jsonb_build_object('kind','product','label','Magnesium Glycinate',
        'phaseIndex',0,'catalogProductId','88888888-0000-0000-0000-000000000501',
        'manufacturer','Verify Labs','labelVersion','2026-01',
        'dosageText','200 mg','timingText','evening','route','oral',
        'affiliateUrl','https://example.test/aff/mag'),
      jsonb_build_object('kind','followup','label','Recheck in 8 weeks'))
  ), null);
  insert into _v values('a template draft saves phases and exact product identity',
    (_saved->>'ok')::boolean, _saved #>> '{}');

  -- Phase 9B. The payload above still carries `affiliateUrl`, and it is still
  -- accepted — but it no longer lands on the clinical item. It is recorded in
  -- the commercial model, which is what makes "commercial data cannot influence
  -- clinical ranking" a fact about the schema rather than a policy.
  insert into _v values('affiliate data from a draft lands in the commercial model',
    (select count(*)=1 from public.protocol_commercial_links
     where protocol_version_id=(_t->>'versionId')::uuid
       and url='https://example.test/aff/mag' and kind='affiliate'), null);

  begin
    perform public.create_protocol_draft(
      'bbbbbbbb-0000-0000-0000-000000000501','cccccccc-0000-0000-0000-000000000501',
      'From Draft Template',(_t->>'templateId')::uuid);
    insert into _v values('an unapproved template cannot start a protocol',false,'no error');
  exception when others then
    insert into _v values('an unapproved template cannot start a protocol',
      sqlstate='22023', sqlstate);
  end;

  perform public.approve_protocol_template_version((_t->>'versionId')::uuid);
  insert into _v values('approving a template freezes its version',
    (select status from public.protocol_versions where id=(_t->>'versionId')::uuid)='approved',
    null);

  _d := public.create_protocol_draft(
    'bbbbbbbb-0000-0000-0000-000000000501','cccccccc-0000-0000-0000-000000000501',
    'Thyroid Reset — Protocol Patient',(_t->>'templateId')::uuid);
  insert into _ids values ('pv1',(_d->>'versionId')::uuid);
  insert into _ids values ('protocol',(_d->>'protocolId')::uuid);

  insert into _v values('a protocol draft from a template copies phases and items',
    (select count(*) from public.protocol_phases where version_id=(_d->>'versionId')::uuid) = 1
    and (select count(*) from public.protocol_items where version_id=(_d->>'versionId')::uuid) = 2,
    null);
  insert into _v values('the copy preserves exact product identity and dosage text',
    exists (select 1 from public.protocol_items
            where version_id=(_d->>'versionId')::uuid
              and catalog_product_id='88888888-0000-0000-0000-000000000501'
              and manufacturer='Verify Labs' and label_version='2026-01'
              and dosage_text='200 mg' and timing_text='evening' and route='oral'),
    null);
  insert into _v values('copied product items require their own interaction review',
    (select bool_and(interaction_review_state='not_completed'
                     and verification_status='unverified')
     from public.protocol_items where version_id=(_d->>'versionId')::uuid
       and kind='product'), null);
  insert into _v values('the draft records its template lineage',
    (select source_template_id from public.protocol_versions
     where id=(_d->>'versionId')::uuid) = (_t->>'templateId')::uuid, null);

  -- Phase 9B. The clinical copy-forward path carries clinical content ONLY.
  -- Before this phase the affiliate URL rode along automatically into every new
  -- version; now a commercial relationship has to be recorded deliberately
  -- against the version it actually applies to.
  insert into _v values('commercial data is not copied into a new clinical version',
    (select count(*)=0 from public.protocol_commercial_links
     where protocol_version_id=(_d->>'versionId')::uuid), null);
end $$;

do $$
declare _saved jsonb; _before timestamptz;
begin
  select updated_at into _before from public.protocol_versions
  where id=(select v from _ids where k='tplv');

  _saved := public.save_protocol_draft((select v from _ids where k='pv1'), jsonb_build_object(
    'title','Thyroid Reset — customized',
    'dietInstructions','Customized for this patient',
    'phases', jsonb_build_array(
      jsonb_build_object('name','Phase 1 — Repletion','relativeStartDay',0,'relativeDurationDays',28),
      jsonb_build_object('name','Phase 2 — Maintenance','relativeStartDay',28,'relativeDurationDays',56)),
    'items', jsonb_build_array(
      jsonb_build_object('kind','product','label','Magnesium Glycinate','phaseIndex',0,
        'catalogProductId','88888888-0000-0000-0000-000000000501',
        'manufacturer','Verify Labs','labelVersion','2026-01','dosageText','400 mg'),
      jsonb_build_object('kind','diet','label','Remove ultra-processed foods'),
      jsonb_build_object('kind','followup','label','Recheck in 8 weeks'))
  ), null);

  insert into _v values('customizing the patient draft leaves the source template untouched',
    (select count(*) from public.protocol_phases
     where version_id=(select v from _ids where k='tplv')) = 1
    and (select count(*) from public.protocol_items
         where version_id=(select v from _ids where k='tplv')) = 2
    and (select updated_at from public.protocol_versions
         where id=(select v from _ids where k='tplv')) = _before,
    null);
  insert into _v values('the customized draft has its own phases and items',
    (select count(*) from public.protocol_phases
     where version_id=(select v from _ids where k='pv1')) = 2
    and (select count(*) from public.protocol_items
         where version_id=(select v from _ids where k='pv1')) = 3, null);
end $$;

do $$
begin
  perform public.save_protocol_draft((select v from _ids where k='pv1'),
    jsonb_build_object('title','Conflicting edit'), now() - interval '1 hour');
  insert into _v values('a stale autosave token is refused with a conflict',false,'no error');
exception when others then
  insert into _v values('a stale autosave token is refused with a conflict',
    sqlstate='40001', sqlstate);
end $$;

do $$
begin
  perform public.save_protocol_draft((select v from _ids where k='pv1'),
    jsonb_build_object('items', jsonb_build_array(
      jsonb_build_object('kind','product','label','Ghost',
        'catalogProductId','00000000-0000-0000-0000-0000000000ff'))), null);
  insert into _v values('an unknown catalog product is refused',false,'no error');
exception when others then
  insert into _v values('an unknown catalog product is refused', sqlstate='P0002', sqlstate);
end $$;

do $$
declare _a jsonb; _act jsonb;
begin
  _a := public.approve_protocol_version((select v from _ids where k='pv1'),'Reviewed against labs');
  insert into _v values('approval freezes the version but does NOT activate it',
    (select status from public.protocol_versions where id=(select v from _ids where k='pv1'))='approved'
    and (select status from public.protocols where id=(select v from _ids where k='protocol'))='draft'
    and (select active_version_id from public.protocols
         where id=(select v from _ids where k='protocol')) is null,
    _a #>> '{}');
  insert into _v values('the approval message states activation is separate',
    (_a->>'message') ilike '%NOT active%', _a->>'message');

  _act := public.activate_protocol_version((select v from _ids where k='pv1'));
  insert into _v values('activation is a separate explicit action',
    (select status from public.protocol_versions where id=(select v from _ids where k='pv1'))='active'
    and (select status from public.protocols where id=(select v from _ids where k='protocol'))='active',
    _act #>> '{}');
  -- The strongest safety assertion in this suite: activation touches nothing
  -- downstream. No note, no invoice, no message, no supplement-order row.
  insert into _v values('activation creates no order, charge, message, or note',
    not exists (select 1 from public.clinical_notes
                where patient_id='cccccccc-0000-0000-0000-000000000501')
    and not exists (select 1 from public.invoices
                    where patient_id='cccccccc-0000-0000-0000-000000000501')
    and not exists (select 1 from public.messages m
                    join public.conversations c on c.id = m.conversation_id
                    where c.patient_id='cccccccc-0000-0000-0000-000000000501')
    and not exists (select 1 from public.supplement_protocols
                    where patient_id='cccccccc-0000-0000-0000-000000000501'),
    null);
end $$;

do $$
begin
  perform public.save_protocol_draft((select v from _ids where k='pv1'),
    jsonb_build_object('title','Sneaky edit'), null);
  insert into _v values('an active version refuses autosave edits',false,'no error');
exception when others then
  insert into _v values('an active version refuses autosave edits', sqlstate='22023', sqlstate);
end $$;

do $$
begin
  update public.protocol_versions set title='Direct overwrite'
  where id=(select v from _ids where k='pv1');
  insert into _v values('a direct UPDATE to active clinical content is blocked by trigger',
    false,'no error');
exception when others then
  insert into _v values('a direct UPDATE to active clinical content is blocked by trigger',
    sqlstate='22023', sqlstate);
end $$;

do $$
begin
  insert into public.protocol_items
    (organization_id, version_id, kind, label)
  values ('bbbbbbbb-0000-0000-0000-000000000501',
          (select v from _ids where k='pv1'),'diet','Injected item');
  insert into _v values('inserting an item into an active version is blocked by trigger',
    false,'no error');
exception when others then
  insert into _v values('inserting an item into an active version is blocked by trigger',
    sqlstate='22023', sqlstate);
end $$;

do $$
declare _rev jsonb; _orig_title text; _orig_items int;
begin
  select title into _orig_title from public.protocol_versions
  where id=(select v from _ids where k='pv1');
  select count(*) into _orig_items from public.protocol_items
  where version_id=(select v from _ids where k='pv1');

  _rev := public.revise_protocol_version((select v from _ids where k='pv1'));
  insert into _ids values ('pv2',(_rev->>'versionId')::uuid);

  insert into _v values('revising an active version creates a NEW draft version 2',
    (_rev->>'version')::int = 2
    and (select status from public.protocol_versions where id=(_rev->>'versionId')::uuid)='draft'
    and (select supersedes_version_id from public.protocol_versions
         where id=(_rev->>'versionId')::uuid) = (select v from _ids where k='pv1'),
    _rev #>> '{}');

  insert into _v values('the original approved/active version is completely unchanged',
    (select title from public.protocol_versions where id=(select v from _ids where k='pv1')) = _orig_title
    and (select status from public.protocol_versions where id=(select v from _ids where k='pv1'))='active'
    and (select count(*) from public.protocol_items
         where version_id=(select v from _ids where k='pv1')) = _orig_items,
    null);

  insert into _v values('the new draft carries a copy of the phases and items',
    (select count(*) from public.protocol_items
     where version_id=(_rev->>'versionId')::uuid) = _orig_items, null);

  begin
    perform public.revise_protocol_version((select v from _ids where k='pv1'));
    insert into _v values('a second concurrent draft is refused',false,'no error');
  exception when others then
    insert into _v values('a second concurrent draft is refused', sqlstate='22023', sqlstate);
  end;
end $$;

do $$
begin
  perform public.save_protocol_draft((select v from _ids where k='pv2'), jsonb_build_object(
    'title','Thyroid Reset v2',
    'items', jsonb_build_array(jsonb_build_object('kind','diet','label','Updated diet'))), null);
  perform public.approve_protocol_version((select v from _ids where k='pv2'),null);
  perform public.activate_protocol_version((select v from _ids where k='pv2'));

  insert into _v values('activating v2 supersedes v1 and never deletes it',
    (select status from public.protocol_versions where id=(select v from _ids where k='pv1'))='superseded'
    and (select status from public.protocol_versions where id=(select v from _ids where k='pv2'))='active'
    and exists (select 1 from public.protocol_versions where id=(select v from _ids where k='pv1')),
    null);
end $$;

do $$
declare _r jsonb;
begin
  _r := public.set_protocol_lifecycle((select v from _ids where k='protocol'),'paused','travel');
  insert into _v values('an active protocol can be paused',
    (select status from public.protocols where id=(select v from _ids where k='protocol'))='paused',
    _r #>> '{}');
  _r := public.set_protocol_lifecycle((select v from _ids where k='protocol'),'completed',null);
  insert into _v values('a protocol can be completed',
    (select status from public.protocols where id=(select v from _ids where k='protocol'))='completed', null);
end $$;
do $$
begin
  perform public.set_protocol_lifecycle((select v from _ids where k='protocol'),'paused',null);
  insert into _v values('a closed protocol refuses further lifecycle changes',false,'no error');
exception when others then
  insert into _v values('a closed protocol refuses further lifecycle changes',
    sqlstate='22023', sqlstate);
end $$;

do $$
declare _r jsonb;
begin
  _r := public.archive_protocol_template((select v from _ids where k='tpl'), true);
  insert into _v values('archiving a template leaves protocols created from it intact',
    (select status from public.protocol_templates where id=(select v from _ids where k='tpl'))='archived'
    and (select count(*) from public.protocol_versions
         where protocol_id=(select v from _ids where k='protocol')) = 2
    and (select count(*) from public.protocol_items
         where version_id=(select v from _ids where k='pv1')) > 0,
    _r #>> '{}');
  insert into _v values('archived templates are hidden from the default list',
    jsonb_array_length(public.list_protocol_templates('bbbbbbbb-0000-0000-0000-000000000501', false)) = 0,
    public.list_protocol_templates('bbbbbbbb-0000-0000-0000-000000000501', false) #>> '{}');
end $$;

select set_config('request.jwt.claims',
  '{"sub":"11111111-0000-0000-0000-000000000502","role":"authenticated"}', true);
do $$
begin
  perform public.create_protocol_draft(
    'bbbbbbbb-0000-0000-0000-000000000501','cccccccc-0000-0000-0000-000000000501','Staff attempt',null);
  insert into _v values('staff cannot author a protocol',false,'no error');
exception when others then
  insert into _v values('staff cannot author a protocol', sqlstate='42501', sqlstate);
end $$;

select set_config('request.jwt.claims',
  '{"sub":"11111111-0000-0000-0000-000000000503","role":"authenticated"}', true);
do $$
begin
  perform public.get_patient_protocol(
    'bbbbbbbb-0000-0000-0000-000000000501','cccccccc-0000-0000-0000-000000000501');
  insert into _v values('cross-tenant protocol read is refused',false,'no error');
exception when others then
  insert into _v values('cross-tenant protocol read is refused', sqlstate='42501', sqlstate);
end $$;
do $$
begin
  perform public.create_protocol_draft(
    'bbbbbbbb-0000-0000-0000-000000000502','cccccccc-0000-0000-0000-000000000502',
    'Steal template',(select v from _ids where k='tpl'));
  insert into _v values('a template from another org cannot start a protocol',false,'no error');
exception when others then
  insert into _v values('a template from another org cannot start a protocol',
    sqlstate='42501', sqlstate);
end $$;
do $$
begin
  perform public.revise_protocol_version((select v from _ids where k='pv2'));
  insert into _v values('cross-tenant revise is refused',false,'no error');
exception when others then
  insert into _v values('cross-tenant revise is refused', sqlstate='42501', sqlstate);
end $$;

select set_config('request.jwt.claims','{"role":"anon"}',true);
do $$
begin
  perform public.get_patient_protocol(
    'bbbbbbbb-0000-0000-0000-000000000501','cccccccc-0000-0000-0000-000000000501');
  insert into _v values('anonymous protocol read is refused',false,'no error');
exception when others then
  insert into _v values('anonymous protocol read is refused', sqlstate='28000', sqlstate);
end $$;

select name, passed, detail from _v order by name;
rollback;
