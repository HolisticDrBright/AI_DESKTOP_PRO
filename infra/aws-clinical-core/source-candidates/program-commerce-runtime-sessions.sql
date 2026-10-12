-- BLOCKED source candidate (successor): the four reduced runtime identities the reviewed program-
-- commerce host connects as, for Codex's review. Not in migrations/manifest.json; not applied
-- anywhere; not registered; not to be applied until src/server/commerce/reviewed/*.ts and
-- docs/claude-purchase-to-course-closure-2026-10-12.md are reviewed. It creates NO login and NO
-- password: the reviewed operator provisions one dedicated login per role, each behind its own
-- secret, in the qualification account only.
--
-- Parent assumptions (written against exactly these artifacts, applied first, each unchanged):
--   source-candidates/program-education-progress.sql (BLOCKED)
--     sha256 7d4b3ee7027dca24e91423b409bc1cf5e387689e14d154ede448348f655a2eb5
--   and through it program-commerce-authority.sql 11e53bc2…, program-education-delivery.sql 653965ff…
--   (commercial_education_worker, commercial_education_delivery, commercial_education_operator) and
--   the shared clinical_core_api role from the installed migrations.
-- No historical migration, shared identity function, table, function grant, IAM or custody file is
-- changed by this file. It grants role membership and nothing else.
--
-- One runtime role per authority, NOLOGIN until the operator attaches a login, NOINHERIT so a
-- session holds nothing until it assumes its one role, and a member of exactly that role:
--   program_commerce_api_runtime       -> clinical_core_api (the consumer and staff request paths)
--   program_commerce_worker_runtime    -> commercial_education_worker (settlement, intake, expiry)
--   program_commerce_delivery_runtime  -> commercial_education_delivery (sealed code delivery)
--   program_commerce_operator_runtime  -> commercial_education_operator (policy, reissue)
-- None is a member of another, so no runtime session can assume a second authority. The API runtime
-- inherits the breadth of clinical_core_api, which every API service shares; narrowing that is a
-- separate review recorded in the return document.

do $$
begin
 if not exists(select 1 from pg_roles where rolname='program_commerce_api_runtime') then
  create role program_commerce_api_runtime nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
 end if;
 if not exists(select 1 from pg_roles where rolname='program_commerce_worker_runtime') then
  create role program_commerce_worker_runtime nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
 end if;
 if not exists(select 1 from pg_roles where rolname='program_commerce_delivery_runtime') then
  create role program_commerce_delivery_runtime nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
 end if;
 if not exists(select 1 from pg_roles where rolname='program_commerce_operator_runtime') then
  create role program_commerce_operator_runtime nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
 end if;
end $$;

grant clinical_core_api to program_commerce_api_runtime;
grant commercial_education_worker to program_commerce_worker_runtime;
grant commercial_education_delivery to program_commerce_delivery_runtime;
grant commercial_education_operator to program_commerce_operator_runtime;
