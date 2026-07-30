-- Rolled-back acceptance suite for governed clinical-knowledge imports.
-- Run after migrations 20260728030307 and 20260728165840.

begin;
create temp table _v(name text, passed boolean, detail text) on commit drop;
create temp table _ids(k text primary key, v uuid) on commit drop;
grant all on _v to authenticated;
grant all on _ids to authenticated;

insert into auth.users(id,email) values
  ('11111111-0000-0000-0000-000000000081','knowledge-import-admin@verify.local'),
  ('11111111-0000-0000-0000-000000000082','knowledge-import-outsider@verify.local');
insert into public.organizations(id,name,slug) values
  ('bbbbbbbb-0000-0000-0000-000000000081','Knowledge Import A','knowledge-import-a'),
  ('bbbbbbbb-0000-0000-0000-000000000082','Knowledge Import B','knowledge-import-b');
insert into public.organization_memberships(organization_id,user_id,role,status) values
  ('bbbbbbbb-0000-0000-0000-000000000081','11111111-0000-0000-0000-000000000081','admin','active'),
  ('bbbbbbbb-0000-0000-0000-000000000082','11111111-0000-0000-0000-000000000082','admin','active');

select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-0000-0000-0000-000000000081","role":"authenticated"}',
  true
);

do $$
begin
  perform public.stage_clinical_knowledge_import(
    'bbbbbbbb-0000-0000-0000-000000000081',
    'Unsafe source', 'v1', 'clinical-knowledge-import-v1',
    '[{"entityType":"pathway","externalKey":"unsafe","displayName":"Unsafe","payload":{}}]'::jsonb,
    false
  );
  insert into _v values ('no-PHI attestation is mandatory',false,'no error');
exception when others then
  insert into _v values ('no-PHI attestation is mandatory',sqlstate='55000',sqlstate);
end $$;

do $$
declare r jsonb; _batch_id uuid;
begin
  r := public.stage_clinical_knowledge_import(
    'bbbbbbbb-0000-0000-0000-000000000081',
    'Clinical authoring pack', 'test-v1', 'clinical-knowledge-import-v1',
    '[
      {
        "entityType":"pathway",
        "externalKey":"thyroid-import",
        "displayName":"Thyroid import",
        "sourceSheet":"Conditions",
        "warnings":["Practitioner review required"],
        "payload":{
          "code":"thyroid-import",
          "name":"Thyroid import",
          "domainCode":"endocrine",
          "description":"Test pathway",
          "sourceRefs":[{"label":"Test authoring source"}],
          "content":{
            "differentiatingQuestions":["Antibodies documented?"],
            "labStrategy":[],
            "productCandidates":[],
            "nutrition":[],
            "lifestyle":[],
            "safetyStops":["Urgent symptoms"]
          }
        }
      },
      {
        "entityType":"product_label",
        "externalKey":"incomplete-product",
        "displayName":"Incomplete product",
        "sourceSheet":"Product Formulary",
        "warnings":["Affiliate link is not clinical eligibility"],
        "payload":{
          "productCode":"incomplete-product",
          "productName":"Incomplete product",
          "brand":"Test brand",
          "exactLabel":{},
          "affiliateUrl":"https://example.test/affiliate"
        }
      }
    ]'::jsonb,
    true
  );
  _batch_id := (r->>'batchId')::uuid;
  insert into _ids values ('batch',_batch_id);
  insert into _ids
    select 'pathway_item', id from public.clinical_knowledge_import_items
    where batch_id=_batch_id and entity_type='pathway';
  insert into _ids
    select 'product_item', id from public.clinical_knowledge_import_items
    where batch_id=_batch_id and entity_type='product_label';
  insert into _v select 'staging hashes source and every item',
    (r->>'itemCount')::int=2
    and exists (select 1 from public.clinical_knowledge_import_batches
      where id=_batch_id and length(source_sha256)=64 and status='in_review')
    and (select count(*)=2 from public.clinical_knowledge_import_items
      where clinical_knowledge_import_items.batch_id=_batch_id and length(payload_sha256)=64),
    r::text;
exception when others then
  insert into _v values ('staging hashes source and every item',false,sqlstate||' '||sqlerrm);
end $$;

insert into _v
select 'incomplete product label carries blocking validation errors',
  jsonb_array_length(validation_errors)>=3
  and validation_errors::text ilike '%Ingredient amounts%'
  and validation_errors::text ilike '%manufacturer label URL%',
  validation_errors::text
from public.clinical_knowledge_import_items
where id=(select v from _ids where k='product_item');

do $$
declare r jsonb;
begin
  r := public.review_clinical_knowledge_import_item(
    (select v from _ids where k='pathway_item'),'accept','Reviewed test pathway'
  );
  insert into _ids values ('draft',(r->>'appliedRefId')::uuid);
  insert into _v select 'accepted pathway is applied only as a draft',
    r->>'status'='applied'
    and exists (select 1 from public.clinical_pathway_versions
      where id=(r->>'appliedRefId')::uuid and status='draft' and approved_at is null)
    and not exists (select 1 from public.clinical_pathway_versions
      where id=(r->>'appliedRefId')::uuid and status='approved'),
    r::text;
exception when others then
  insert into _v values ('accepted pathway is applied only as a draft',false,sqlstate||' '||sqlerrm);
end $$;

do $$
begin
  perform public.update_clinical_pathway_draft(
    (select v from _ids where k='draft'),
    '{"differentiatingQuestions":["Updated question?"],"labStrategy":[],"productCandidates":[],"nutrition":[],"lifestyle":[],"safetyStops":["Urgent symptoms"]}'::jsonb,
    '[{"label":"Updated source"}]'::jsonb,
    'Practitioner edit'
  );
  insert into _v select 'draft update re-hashes content and audits',
    exists (select 1 from public.clinical_pathway_versions
      where id=(select v from _ids where k='draft')
        and content->'differentiatingQuestions' ? 'Updated question?'
        and length(content_sha256)=64)
    and exists (select 1 from public.audit_events
      where action='knowledge.pathway_draft_updated'
        and resource_id=(select v::text from _ids where k='draft')),
    '';
exception when others then
  insert into _v values ('draft update re-hashes content and audits',false,sqlstate||' '||sqlerrm);
end $$;

do $$
begin
  perform public.review_clinical_knowledge_import_item(
    (select v from _ids where k='product_item'),'accept','Should fail'
  );
  insert into _v values ('blocked product cannot be accepted',false,'no error');
exception when others then
  insert into _v values ('blocked product cannot be accepted',sqlstate='55000',sqlstate);
end $$;

do $$
begin
  perform public.review_clinical_knowledge_import_item(
    (select v from _ids where k='product_item'),'reject','Missing exact label'
  );
  insert into _v select 'rejection completes the reviewed batch',
    exists (select 1 from public.clinical_knowledge_import_items
      where id=(select v from _ids where k='product_item') and status='rejected')
    and exists (select 1 from public.clinical_knowledge_import_batches
      where id=(select v from _ids where k='batch') and status='completed' and completed_at is not null),
    '';
exception when others then
  insert into _v values ('rejection completes the reviewed batch',false,sqlstate||' '||sqlerrm);
end $$;

do $$
begin
  update public.clinical_knowledge_import_items
  set payload='{"tampered":true}'::jsonb
  where id=(select v from _ids where k='pathway_item');
  insert into _v values ('staged source payload is immutable',false,'no error');
exception when others then
  insert into _v values ('staged source payload is immutable',sqlstate='22023',sqlstate);
end $$;

select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-0000-0000-0000-000000000082","role":"authenticated"}',
  true
);

do $$
begin
  perform public.review_clinical_knowledge_import_item(
    (select v from _ids where k='pathway_item'),'reject','Cross-org'
  );
  insert into _v values ('cross-organization import review is refused',false,'no error');
exception when others then
  insert into _v values ('cross-organization import review is refused',sqlstate in ('42501','55000'),sqlstate);
end $$;

set local role authenticated;
insert into _v
select 'RLS hides another organization import history',
  (select count(*)=0 from public.clinical_knowledge_import_batches)
  and (select count(*)=0 from public.clinical_knowledge_import_items),
  '';
reset role;

select * from _v order by name;
rollback;
