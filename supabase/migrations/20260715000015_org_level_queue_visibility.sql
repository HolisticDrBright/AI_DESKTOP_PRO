-- ============================================================
-- 0015 Org-level review-queue visibility
--
-- review_queue_items.patient_id is nullable (org-level items such as QA
-- checklists), but the SELECT policy gated every row on
-- private.can_access_patient(patient_id), which is FALSE when patient_id is
-- NULL — so org-level items were invisible to every non-definer reader, even
-- though resolve_review_queue_item (0014) can resolve them. Found while
-- implementing the backend's clinical.tasks.getQueue read.
--
-- Fix: patient-scoped rows keep the patient-access gate; org-level rows are
-- visible to active members of the owning organization. Write policies are
-- unchanged (org-level writes go through the SECURITY DEFINER RPC, which
-- requires a practitioner/admin role).
-- ============================================================

drop policy review_queue_items_select on public.review_queue_items;

create policy review_queue_items_select on public.review_queue_items for select
  using (
    deleted_at is null
    and (
      (patient_id is not null and private.can_access_patient(patient_id))
      or (patient_id is null and private.is_org_member(organization_id))
    )
  );
