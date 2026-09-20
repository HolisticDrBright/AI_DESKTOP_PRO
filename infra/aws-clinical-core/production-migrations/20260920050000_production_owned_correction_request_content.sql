-- Production overlay: the owner's own privacy-request ledger returns the
-- requested value and reason of a correction, so the owner's device can write
-- the exact successor record through the ordinary authorized write path and the
-- operator's evidence-bound resolution can verify it. Operator identities are
-- still never returned. No other function, grant or table changes.
create or replace function clinical_private.owned_privacy_request_json(_owner uuid,_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('privacyRequestId',r.id,'requestId',r.request_id,'kind',r.kind,'status',r.status,
    'submittedAt',r.submitted_at,'updatedAt',r.updated_at,'completedAt',r.completed_at,
    'legalHold',exists(select 1 from clinical_private.owned_legal_holds h where h.owner_id=r.owner_id and h.released_at is null),
    'fulfillment',(select coalesce(jsonb_agg(jsonb_build_object('store',f.store,'outcome',f.outcome,'evidenceSha256',f.evidence_sha256,'recordedAt',f.recorded_at)
      order by f.recorded_at,f.id),'[]'::jsonb) from clinical_private.owned_privacy_fulfillment f where f.privacy_request_id=r.id))
    ||case when t.privacy_request_id is null then '{}'::jsonb else jsonb_build_object('correctionTarget',jsonb_build_object(
      'collection',t.collection,'recordId',t.record_id,'expectedRevision',t.expected_revision,'expectedPayloadSha256',t.expected_payload_sha256,
      'field',t.field,'requestSha256',t.request_sha256,'requestedValue',r.correction->'requestedValue','reason',r.correction->>'reason')) end
    ||case when s.privacy_request_id is null then '{}'::jsonb else jsonb_build_object('correctionResolution',jsonb_build_object(
      'outcome',s.outcome,'appliedRevision',s.applied_revision,'appliedPayloadSha256',s.applied_payload_sha256,
      'evidenceSha256',s.evidence_sha256,'explanation',s.explanation,'resolvedAt',s.resolved_at)) end
  from clinical_private.owned_privacy_requests r left join clinical_private.owned_correction_targets t on t.privacy_request_id=r.id
    left join clinical_private.owned_correction_resolutions s on s.privacy_request_id=r.id where r.owner_id=_owner and r.id=_id
$$;
