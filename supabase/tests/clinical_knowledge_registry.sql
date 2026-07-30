-- Rolled-back acceptance suite for the Clinical Knowledge Registry foundation.
-- Run after migration 20260728030307. Every returned row must pass.

begin;
create temp table _v(name text, passed boolean, detail text) on commit drop;
create temp table _ids(k text primary key, v uuid) on commit drop;
grant all on _v to authenticated;
grant all on _ids to authenticated;

insert into auth.users(id,email) values
  ('11111111-0000-0000-0000-000000000071','knowledge-admin@verify.local'),
  ('11111111-0000-0000-0000-000000000072','knowledge-outsider@verify.local');
insert into public.organizations(id,name,slug) values
  ('bbbbbbbb-0000-0000-0000-000000000071','Knowledge Verify A','knowledge-verify-a'),
  ('bbbbbbbb-0000-0000-0000-000000000072','Knowledge Verify B','knowledge-verify-b');
insert into public.organization_memberships(organization_id,user_id,role,status) values
  ('bbbbbbbb-0000-0000-0000-000000000071','11111111-0000-0000-0000-000000000071','admin','active'),
  ('bbbbbbbb-0000-0000-0000-000000000072','11111111-0000-0000-0000-000000000072','admin','active');
insert into public.patient_profiles(id,organization_id,first_name,last_name) values
  ('cccccccc-0000-0000-0000-000000000071','bbbbbbbb-0000-0000-0000-000000000071','Registry','Patient');
insert into public.practitioner_patient_relationships
  (organization_id,practitioner_user_id,patient_id,status) values
  ('bbbbbbbb-0000-0000-0000-000000000071','11111111-0000-0000-0000-000000000071',
   'cccccccc-0000-0000-0000-000000000071','active');

select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-0000-0000-0000-000000000071","role":"authenticated"}',
  true
);

do $$
declare r jsonb;
begin
  r := public.create_clinical_pathway(
    'bbbbbbbb-0000-0000-0000-000000000071',
    'thyroid','Thyroid pathway','endocrine','Classification before products',
    '{"differentiatingQuestions":["Antibodies documented?"],"labs":[{"panel":"Full thyroid"}],"products":[],"safetyStops":["Urgent symptoms"]}'::jsonb,
    '[{"code":"practice-thyroid-v1"}]'::jsonb
  );
  insert into _ids values ('pathway',(r->>'pathwayId')::uuid), ('version1',(r->>'versionId')::uuid);
  insert into _v select 'pathway starts as a hashed draft',
    (r->>'version')::int = 1
    and exists (
      select 1 from public.clinical_pathway_versions
      where id=(r->>'versionId')::uuid and status='draft' and length(content_sha256)=64
    ), r::text;
exception when others then
  insert into _v values ('pathway starts as a hashed draft',false,sqlstate||' '||sqlerrm);
end $$;

do $$
begin
  perform public.approve_clinical_pathway_version((select v from _ids where k='version1'));
  insert into _v select 'admin approval creates the sole approved version',
    (select count(*)=1 from public.clinical_pathway_versions
      where pathway_id=(select v from _ids where k='pathway') and status='approved')
    and exists (select 1 from public.audit_events where action='knowledge.pathway_approved'), '';
exception when others then
  insert into _v values ('admin approval creates the sole approved version',false,sqlstate||' '||sqlerrm);
end $$;

do $$
begin
  update public.clinical_pathway_versions set content='{"tampered":true}'::jsonb
  where id=(select v from _ids where k='version1');
  insert into _v values ('approved pathway content is immutable',false,'no error');
exception when others then
  insert into _v values ('approved pathway content is immutable',sqlstate='22023',sqlstate);
end $$;

do $$
declare r jsonb;
begin
  r := public.create_clinical_pathway_draft(
    (select v from _ids where k='pathway'),
    '{"differentiatingQuestions":["Antibodies documented?","Medication timing?"],"labs":[{"panel":"Full thyroid"}],"products":[],"safetyStops":["Urgent symptoms"]}'::jsonb,
    '[{"code":"practice-thyroid-v2"}]'::jsonb,
    'Add medication timing'
  );
  insert into _ids values ('version2',(r->>'versionId')::uuid);
  perform public.approve_clinical_pathway_version((r->>'versionId')::uuid);
  insert into _v select 'new approval supersedes the prior version',
    exists (select 1 from public.clinical_pathway_versions
      where id=(select v from _ids where k='version1') and status='superseded'
        and superseded_by=(select v from _ids where k='version2'))
    and exists (select 1 from public.clinical_pathway_versions
      where id=(select v from _ids where k='version2') and status='approved'), r::text;
exception when others then
  insert into _v values ('new approval supersedes the prior version',false,sqlstate||' '||sqlerrm);
end $$;

do $$
declare r jsonb;
begin
  r := public.save_product_label_version(
    'bbbbbbbb-0000-0000-0000-000000000071',
    'pro-omega-2000','ProOmega 2000','Nordic Naturals',
    '{"servingSize":"2 soft gels","ingredients":[{"name":"EPA/DHA","amount":"verified from current label"}]}'::jsonb,
    'https://example.test/current-label', 'https://example.test/affiliate'
  );
  insert into _ids values ('label1',(r->>'labelVersionId')::uuid);
  perform public.verify_product_label_version((r->>'labelVersionId')::uuid,'Compared with current manufacturer label');
  insert into _v select 'exact product label requires explicit verification',
    exists (select 1 from public.product_label_versions
      where id=(select v from _ids where k='label1') and status='verified'
        and verified_by='11111111-0000-0000-0000-000000000071' and length(label_sha256)=64), r::text;
exception when others then
  insert into _v values ('exact product label requires explicit verification',false,sqlstate||' '||sqlerrm);
end $$;

do $$
begin
  update public.product_label_versions set exact_label='{"tampered":true}'::jsonb
  where id=(select v from _ids where k='label1');
  insert into _v values ('verified product label is immutable',false,'no error');
exception when others then
  insert into _v values ('verified product label is immutable',sqlstate='22023',sqlstate);
end $$;

do $$
declare run_id uuid;
begin
  run_id := public.record_clinical_copilot_run(
    'cccccccc-0000-0000-0000-000000000071',null,
    (select v from _ids where k='version2'),
    '{"counts":{"labs":2},"safetyFieldsPresent":{"medications":true,"allergies":true}}'::jsonb,
    '{"questions":["Medication timing?"],"labCandidates":["Full thyroid"],"products":[]}'::jsonb,
    'incomplete',null,null,null,'clinical-copilot-v1'
  );
  insert into _ids values ('run1',run_id);
  insert into _v select 'copilot run snapshots approved pathway and hashes',
    exists (select 1 from public.clinical_copilot_runs
      where id=run_id and pathway_version_id=(select v from _ids where k='version2')
        and status='draft' and length(input_sha256)=64 and length(output_sha256)=64)
    and exists (select 1 from public.audit_events
      where action='knowledge.copilot_run_recorded' and resource_id=run_id::text
        and metadata::text not ilike '%medication timing%'), run_id::text;
exception when others then
  insert into _v values ('copilot run snapshots approved pathway and hashes',false,sqlstate||' '||sqlerrm);
end $$;

do $$
begin
  perform public.review_clinical_copilot_run((select v from _ids where k='run1'),'Reviewed against chart');
  insert into _v select 'copilot review is explicit and audited',
    exists (select 1 from public.clinical_copilot_runs
      where id=(select v from _ids where k='run1') and status='reviewed' and reviewed_at is not null)
    and exists (select 1 from public.audit_events where action='knowledge.copilot_run_reviewed'), '';
exception when others then
  insert into _v values ('copilot review is explicit and audited',false,sqlstate||' '||sqlerrm);
end $$;

select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-0000-0000-0000-000000000072","role":"authenticated"}',
  true
);

do $$
begin
  perform public.create_clinical_pathway_draft(
    (select v from _ids where k='pathway'),'{}'::jsonb,'[]'::jsonb,'cross-org'
  );
  insert into _v values ('cross-organization pathway mutation is refused',false,'no error');
exception when others then
  insert into _v values ('cross-organization pathway mutation is refused',sqlstate='42501',sqlstate);
end $$;

set local role authenticated;
insert into _v
select 'RLS hides another organization knowledge and patient runs',
  (select count(*)=0 from public.clinical_pathways)
  and (select count(*)=0 from public.clinical_pathway_versions)
  and (select count(*)=0 from public.product_label_versions)
  and (select count(*)=0 from public.clinical_copilot_runs),
  '';
reset role;

select * from _v order by name;
rollback;
