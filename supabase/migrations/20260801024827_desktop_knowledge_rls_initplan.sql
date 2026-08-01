-- Wrap auth.uid() in a scalar subquery on the two policies this phase added.
--
-- A bare `auth.uid()` in a policy is re-evaluated per row; `(select auth.uid())`
-- is evaluated once and the result reused. The platform tables from earlier
-- phases already use the subquery form — these two were inconsistent with them,
-- which the performance advisor caught.

begin;

drop policy if exists knowledge_source_states_select
  on public.clinical_knowledge_source_states;
create policy knowledge_source_states_select
  on public.clinical_knowledge_source_states
  for select to authenticated using ((select auth.uid()) is not null);

drop policy if exists platform_curators_select on public.platform_curators;
create policy platform_curators_select on public.platform_curators
  for select to authenticated using ((select auth.uid()) is not null);

commit;
