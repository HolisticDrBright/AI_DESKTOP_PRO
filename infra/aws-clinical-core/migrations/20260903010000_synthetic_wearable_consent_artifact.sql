-- Synthetic-staging consent text for V2 -> Desktop wearable sharing.
-- The content hash covers the exact patient-facing copy shipped by V2.
-- This migration is intentionally absent from production-migrations.
insert into clinical_core.consent_artifacts (
  id, organization_id, scope, artifact_version, content_sha256,
  jurisdiction, status, approved_at, approved_by_person_id
)
select
  public.gen_random_uuid(),
  organization.id,
  'wearables',
  'synthetic-wearables/1',
  '56f4e358f46e4ec64c84dbf10bf01e45bc44610549bfea7ef7153af5c63abc74',
  'US-SYNTHETIC',
  'approved',
  clock_timestamp(),
  reviewer.person_id
from clinical_core.organizations organization
cross join lateral (
  select membership.person_id
  from clinical_core.organization_memberships membership
  where membership.organization_id = organization.id
    and membership.status = 'active'
    and membership.role in ('owner', 'admin', 'practitioner')
  order by case membership.role when 'owner' then 0 when 'admin' then 1 else 2 end,
    membership.person_id
  limit 1
) reviewer
where organization.environment = 'synthetic-staging'
  and organization.data_classification = 'synthetic_only'
  and organization.contains_phi = false
on conflict (organization_id, scope, artifact_version) do nothing;
