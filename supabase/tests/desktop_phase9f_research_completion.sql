-- Phase 9F acceptance: five-stream Research Handoff preview.
-- Runs in one transaction and rolls back with zero residue.

begin;

create temp table _r(n text, ok boolean) on commit drop;
create or replace function _c(_n text, _ok boolean) returns void language sql as $fn$
  insert into _r values (_n, coalesce(_ok, false));
$fn$;
create or replace function _raises(_sql text, _state text) returns boolean
language plpgsql as $fn$
begin execute _sql; return false; exception when others then return sqlstate = _state; end;
$fn$;

insert into auth.users(id,email) values
  ('9f000000-0000-4000-8000-000000000001','phase9f-editor-a@test.invalid'),
  ('9f000000-0000-4000-8000-000000000002','phase9f-editor-b@test.invalid'),
  ('9f000000-0000-4000-8000-000000000003','phase9f-member@test.invalid');
insert into public.organizations(id,name,slug) values
  ('9f000000-0000-4000-8000-000000000101','Phase 9F A','phase9f-a'),
  ('9f000000-0000-4000-8000-000000000102','Phase 9F B','phase9f-b');
insert into public.organization_memberships(organization_id,user_id,role,status) values
  ('9f000000-0000-4000-8000-000000000101','9f000000-0000-4000-8000-000000000001','owner','active'),
  ('9f000000-0000-4000-8000-000000000102','9f000000-0000-4000-8000-000000000002','owner','active'),
  ('9f000000-0000-4000-8000-000000000101','9f000000-0000-4000-8000-000000000003','member','active');

select set_config('_test.p9f.clinical',
  '[{"entityType":"product_label_research","externalKey":"PRH-0001","displayName":"Clinical","payload":{"product_research_id":"PRH-0001","clinically_approved":false,"practitioner_verified":false,"imported":false},"sourceRaw":{}}]', true);
select set_config('_test.p9f.evidence',
  '[{"entityType":"product_label_evidence","externalKey":"EV9F-00001","displayName":"Evidence","payload":{"source_id":"EV9F-00001","product_research_id":"PRH-0001","archived":true,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"sourceRaw":{}}]', true);
select set_config('_test.p9f.commercial',
  '[{"entityType":"product_label_commercial_link","externalKey":"PRH-0001","displayName":"Commercial","payload":{"product_research_id":"PRH-0001","clean_destination_url":"https://example.invalid/product"},"sourceRaw":{}}]', true);
select set_config('_test.p9f.artifacts',
  '[{"entityType":"product_label_evidence_artifact","externalKey":"ART-00001","displayName":"Artifact","payload":{"artifact_id":"ART-00001","product_research_id":"PRH-0001","relative_path":"evidence/PRH-0001/a.json","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","bytes":100},"sourceRaw":{}}]', true);
select set_config('_test.p9f.conflicts',
  '[{"entityType":"product_label_conflict_packet","externalKey":"CP-00001","displayName":"Conflict","payload":{"conflict_id":"CP-00001","product_research_id":"PRH-0001","field":"serving_size","practitioner_decision_required":true},"sourceRaw":{}}]', true);

-- 1-4: caller boundary.
select set_config('request.jwt.claims', null, true);
select _c('P9F.SQL.1 anonymous refused', _raises(format($q$
  select public.preview_research_handoff_v2(
    '9f000000-0000-4000-8000-000000000101',true,%L,
    'c','c-v2.jsonl',1,%L::jsonb,'e','e-v2.jsonl',1,%L::jsonb,
    'x','x-v2.jsonl',1,%L::jsonb,'a','a-v2.jsonl',1,%L::jsonb,
    'p','p-v2.jsonl',1,%L::jsonb)$q$, repeat('a',64),
    current_setting('_test.p9f.clinical'), current_setting('_test.p9f.evidence'),
    current_setting('_test.p9f.commercial'), current_setting('_test.p9f.artifacts'),
    current_setting('_test.p9f.conflicts')), '28000'));

select set_config('request.jwt.claims','{"sub":"9f000000-0000-4000-8000-000000000003","role":"authenticated"}',true);
select _c('P9F.SQL.2 non-editor refused', _raises(format($q$
  select public.preview_research_handoff_v2(
    '9f000000-0000-4000-8000-000000000101',true,%L,
    'c','c-v2.jsonl',1,%L::jsonb,'e','e-v2.jsonl',1,%L::jsonb,
    'x','x-v2.jsonl',1,%L::jsonb,'a','a-v2.jsonl',1,%L::jsonb,
    'p','p-v2.jsonl',1,%L::jsonb)$q$, repeat('a',64),
    current_setting('_test.p9f.clinical'), current_setting('_test.p9f.evidence'),
    current_setting('_test.p9f.commercial'), current_setting('_test.p9f.artifacts'),
    current_setting('_test.p9f.conflicts')), '42501'));

select set_config('request.jwt.claims','{"sub":"9f000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
select _c('P9F.SQL.3 cross-tenant editor refused', _raises(format($q$
  select public.preview_research_handoff_v2(
    '9f000000-0000-4000-8000-000000000101',true,%L,
    'c','c-v2.jsonl',1,%L::jsonb,'e','e-v2.jsonl',1,%L::jsonb,
    'x','x-v2.jsonl',1,%L::jsonb,'a','a-v2.jsonl',1,%L::jsonb,
    'p','p-v2.jsonl',1,%L::jsonb)$q$, repeat('a',64),
    current_setting('_test.p9f.clinical'), current_setting('_test.p9f.evidence'),
    current_setting('_test.p9f.commercial'), current_setting('_test.p9f.artifacts'),
    current_setting('_test.p9f.conflicts')), '42501'));

select set_config('request.jwt.claims','{"sub":"9f000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
select _c('P9F.SQL.4 false attestation refused', _raises(format($q$
  select public.preview_research_handoff_v2(
    '9f000000-0000-4000-8000-000000000101',false,%L,
    'c','c-v2.jsonl',1,%L::jsonb,'e','e-v2.jsonl',1,%L::jsonb,
    'x','x-v2.jsonl',1,%L::jsonb,'a','a-v2.jsonl',1,%L::jsonb,
    'p','p-v2.jsonl',1,%L::jsonb)$q$, repeat('a',64),
    current_setting('_test.p9f.clinical'), current_setting('_test.p9f.evidence'),
    current_setting('_test.p9f.commercial'), current_setting('_test.p9f.artifacts'),
    current_setting('_test.p9f.conflicts')), '55000'));

-- 5-7: malformed package invariants.
select _c('P9F.SQL.5 bad manifest hash refused', _raises(format($q$
  select public.preview_research_handoff_v2(
    '9f000000-0000-4000-8000-000000000101',true,'NOT-A-HASH',
    'c','c-v2.jsonl',1,%L::jsonb,'e','e-v2.jsonl',1,%L::jsonb,
    'x','x-v2.jsonl',1,%L::jsonb,'a','a-v2.jsonl',1,%L::jsonb,
    'p','p-v2.jsonl',1,%L::jsonb)$q$,
    current_setting('_test.p9f.clinical'), current_setting('_test.p9f.evidence'),
    current_setting('_test.p9f.commercial'), current_setting('_test.p9f.artifacts'),
    current_setting('_test.p9f.conflicts')), '22023'));

select _c('P9F.SQL.6 wrong artifact entity type refused', _raises(format($q$
  select public.preview_research_handoff_v2(
    '9f000000-0000-4000-8000-000000000101',true,%L,
    'c','c-v2.jsonl',1,%L::jsonb,'e','e-v2.jsonl',1,%L::jsonb,
    'x','x-v2.jsonl',1,%L::jsonb,'a','a-v2.jsonl',1,%L::jsonb,
    'p','p-v2.jsonl',1,%L::jsonb)$q$, repeat('b',64),
    current_setting('_test.p9f.clinical'), current_setting('_test.p9f.evidence'),
    current_setting('_test.p9f.commercial'), current_setting('_test.p9f.clinical'),
    current_setting('_test.p9f.conflicts')), '22023'));

select _c('P9F.SQL.7 conflict without practitioner gate refused', _raises(format($q$
  select public.preview_research_handoff_v2(
    '9f000000-0000-4000-8000-000000000101',true,%L,
    'c','c-v2.jsonl',1,%L::jsonb,'e','e-v2.jsonl',1,%L::jsonb,
    'x','x-v2.jsonl',1,%L::jsonb,'a','a-v2.jsonl',1,%L::jsonb,
    'p','p-v2.jsonl',1,'[{"entityType":"product_label_conflict_packet","externalKey":"CP-X","displayName":"bad","payload":{"practitioner_decision_required":false},"sourceRaw":{}}]'::jsonb)$q$,
    repeat('c',64), current_setting('_test.p9f.clinical'),
    current_setting('_test.p9f.evidence'), current_setting('_test.p9f.commercial'),
    current_setting('_test.p9f.artifacts')), '55000'));

-- 8-14: successful atomic preview and idempotence.
do $$ declare _x jsonb; begin
  _x := public.preview_research_handoff_v2(
    '9f000000-0000-4000-8000-000000000101',true,repeat('d',64),
    'clinical','product-label-enrichment-v2.jsonl',10,current_setting('_test.p9f.clinical')::jsonb,
    'evidence','evidence-sources-v2.jsonl',10,current_setting('_test.p9f.evidence')::jsonb,
    'commercial','commercial-links-v2.jsonl',10,current_setting('_test.p9f.commercial')::jsonb,
    'artifacts','evidence-artifact-index.jsonl',10,current_setting('_test.p9f.artifacts')::jsonb,
    'conflicts','conflict-resolution-packets.jsonl',10,current_setting('_test.p9f.conflicts')::jsonb);
  perform set_config('_test.p9f.cb',_x->'clinical'->>'batchId',true);
  perform set_config('_test.p9f.eb',_x->'evidence'->>'batchId',true);
  perform set_config('_test.p9f.xb',_x->'commercial'->>'batchId',true);
  perform set_config('_test.p9f.ab',_x->'artifacts'->>'batchId',true);
  perform set_config('_test.p9f.pb',_x->'conflicts'->>'batchId',true);
  perform _c('P9F.SQL.8 response carries five batch IDs',
    (_x->'clinical'->>'batchId') is not null and (_x->'evidence'->>'batchId') is not null
    and (_x->'commercial'->>'batchId') is not null and (_x->'artifacts'->>'batchId') is not null
    and (_x->'conflicts'->>'batchId') is not null);
end $$;

select _c('P9F.SQL.9 five preview batches created atomically',
  (select count(*) from public.clinical_knowledge_import_batches
   where id in (current_setting('_test.p9f.cb')::uuid,current_setting('_test.p9f.eb')::uuid,
                current_setting('_test.p9f.xb')::uuid,current_setting('_test.p9f.ab')::uuid,
                current_setting('_test.p9f.pb')::uuid)
     and status='preview' and manifest_sha256=repeat('d',64)) = 5);

select _c('P9F.SQL.10 supplemental entity types persisted only in staging',
  (select count(*) from public.clinical_knowledge_import_items
   where batch_id=current_setting('_test.p9f.ab')::uuid
     and entity_type='product_label_evidence_artifact' and status='needs_review') = 1
  and (select count(*) from public.clinical_knowledge_import_items
   where batch_id=current_setting('_test.p9f.pb')::uuid
     and entity_type='product_label_conflict_packet' and status='needs_review') = 1);

select _c('P9F.SQL.11 only commercial batch is commercial_only',
  (select commercial_only from public.clinical_knowledge_import_batches where id=current_setting('_test.p9f.xb')::uuid)
  and not (select commercial_only from public.clinical_knowledge_import_batches where id=current_setting('_test.p9f.cb')::uuid)
  and not (select commercial_only from public.clinical_knowledge_import_batches where id=current_setting('_test.p9f.ab')::uuid));

select _c('P9F.SQL.12 all conflict packets remain restricted',
  (select restricted_flags @> array['practitioner_decision_required','never_auto_resolve','preview_only']
   from public.clinical_knowledge_import_items where batch_id=current_setting('_test.p9f.pb')::uuid limit 1));

select _c('P9F.SQL.13 artifact index explicitly says bytes were not uploaded',
  (select restricted_flags @> array['metadata_only','artifact_bytes_not_uploaded','preview_only']
   from public.clinical_knowledge_import_items where batch_id=current_setting('_test.p9f.ab')::uuid limit 1));

do $$ declare _x jsonb; begin
  _x := public.preview_research_handoff_v2(
    '9f000000-0000-4000-8000-000000000101',true,repeat('d',64),
    'clinical','product-label-enrichment-v2.jsonl',10,current_setting('_test.p9f.clinical')::jsonb,
    'evidence','evidence-sources-v2.jsonl',10,current_setting('_test.p9f.evidence')::jsonb,
    'commercial','commercial-links-v2.jsonl',10,current_setting('_test.p9f.commercial')::jsonb,
    'artifacts','evidence-artifact-index.jsonl',10,current_setting('_test.p9f.artifacts')::jsonb,
    'conflicts','conflict-resolution-packets.jsonl',10,current_setting('_test.p9f.conflicts')::jsonb);
  perform _c('P9F.SQL.14 retry is idempotent across all five batches',
    (_x->'clinical'->>'batchId')=current_setting('_test.p9f.cb')
    and (_x->'evidence'->>'batchId')=current_setting('_test.p9f.eb')
    and (_x->'commercial'->>'batchId')=current_setting('_test.p9f.xb')
    and (_x->'artifacts'->>'batchId')=current_setting('_test.p9f.ab')
    and (_x->'conflicts'->>'batchId')=current_setting('_test.p9f.pb')
    and (_x->'artifacts'->>'idempotent')::boolean
    and (_x->'conflicts'->>'idempotent')::boolean);
end $$;

-- 15-19: structural non-application and audit/security proofs.
select _c('P9F.SQL.15 artifact batch cannot be marked committed', _raises(
  format('update public.clinical_knowledge_import_batches set status=''committed'' where id=%L::uuid',
    current_setting('_test.p9f.ab')), '55000'));
select _c('P9F.SQL.16 conflict batch cannot be marked committed', _raises(
  format('update public.clinical_knowledge_import_batches set status=''committed'' where id=%L::uuid',
    current_setting('_test.p9f.pb')), '55000'));
select _c('P9F.SQL.17 generic accept has no apply path for artifact metadata', _raises(
  format('select public.review_clinical_knowledge_import_item((select id from public.clinical_knowledge_import_items where batch_id=%L::uuid limit 1),''accept'',''test refusal'')',
    current_setting('_test.p9f.ab')), '55000'));

select _c('P9F.SQL.18 PHI-safe audit records all five IDs', exists(
  select 1 from public.audit_events where action='research_handoff.phase9f_previewed'
    and metadata->>'manifestSha256'=repeat('d',64)
    and metadata ?& array['clinicalBatchId','evidenceBatchId','commercialBatchId','artifactBatchId','conflictBatchId']
    and metadata::text not like '%serving_size%'));

select _c('P9F.SQL.19 no PUBLIC anon or service_role execute',
  not has_function_privilege('public','public.preview_research_handoff_v2(uuid,boolean,text,text,text,bigint,jsonb,text,text,bigint,jsonb,text,text,bigint,jsonb,text,text,bigint,jsonb,text,text,bigint,jsonb,text)','execute')
  and not has_function_privilege('anon','public.preview_research_handoff_v2(uuid,boolean,text,text,text,bigint,jsonb,text,text,bigint,jsonb,text,text,bigint,jsonb,text,text,bigint,jsonb,text,text,bigint,jsonb,text)','execute')
  and not has_function_privilege('service_role','public.preview_research_handoff_v2(uuid,boolean,text,text,text,bigint,jsonb,text,text,bigint,jsonb,text,text,bigint,jsonb,text,text,bigint,jsonb,text,text,bigint,jsonb,text)','execute'));

select _c('P9F.SQL.20 private guard is not callable by browser or worker roles',
  not has_function_privilege('public','private.phase9f_preview_only_guard()','execute')
  and not has_function_privilege('anon','private.phase9f_preview_only_guard()','execute')
  and not has_function_privilege('authenticated','private.phase9f_preview_only_guard()','execute')
  and not has_function_privilege('service_role','private.phase9f_preview_only_guard()','execute'));

select _c('P9F.SQL.21 no product label reference commercial or copilot side effect',
  not exists(select 1 from public.supplement_products where created_at > now()-interval '30 seconds')
  and not exists(select 1 from public.product_label_versions where created_at > now()-interval '30 seconds')
  and not exists(select 1 from public.governed_knowledge_references where created_at > now()-interval '30 seconds')
  and not exists(select 1 from public.product_label_commercial_links where recorded_at > now()-interval '30 seconds')
  and not exists(select 1 from public.clinical_copilot_runs where created_at > now()-interval '30 seconds'));

select count(*) filter(where ok) as passed,
       count(*) filter(where ok is false) as failed,
       count(*) as total,
       coalesce(string_agg(n,' | ') filter(where ok is not true),'(none)') as problems
from _r;

rollback;
