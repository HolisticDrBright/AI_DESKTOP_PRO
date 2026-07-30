-- desktop_hypothesis_review_indexes
--
-- Close the three performance-advisor findings introduced by the
-- desktop_owned_reasoning_review slice: covering indexes for
-- hypothesis_reviews' foreign keys. (hypothesis_id already has one from the
-- slice itself.)

begin;

create index if not exists hypothesis_reviews_org_idx
  on public.hypothesis_reviews (organization_id);
create index if not exists hypothesis_reviews_patient_idx
  on public.hypothesis_reviews (patient_id, created_at desc);
create index if not exists hypothesis_reviews_reviewer_idx
  on public.hypothesis_reviews (reviewer_user_id);

commit;
