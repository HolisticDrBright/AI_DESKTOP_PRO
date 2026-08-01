-- Phase 9A: cover two foreign keys the performance advisor flagged.
--
-- `nutrition_plans` and `food_logs` both index (organization_id, patient_id,
-- …), which does NOT cover a lookup or a cascade on patient_id alone —
-- patient_id is the second column, so the index cannot be used for it. A
-- patient delete has to scan both tables without these.

begin;

create index if not exists nutrition_plans_patient_fk_idx
  on public.nutrition_plans (patient_id);

create index if not exists food_logs_patient_fk_idx
  on public.food_logs (patient_id);

commit;
