# Clinical-private function grants: source review and blocked repair

This is a source-only security review, not production authorization. No SQL was registered or applied to AWS. The proposed repair is `infra/aws-clinical-core/source-candidates/clinical-private-public-execute-closure.sql`, SHA-256 `c11cae9fd13521840c7859c4ae47cba45fabc75db6bf7ad34bbc4f507d26b45f`. It is intentionally **BLOCKED**.

## Finding and evidence

The 106-migration production artifact grants the `clinical_core_api` role USAGE on `clinical_private`. Twenty functions in that schema retain PostgreSQL's default `PUBLIC EXECUTE`; nine are `SECURITY DEFINER`. The direct call to `clinical_private.move_entitlement(uuid,text,integer,text,uuid,text,uuid)` is the most consequential: its body changes entitlement quantities and appends a ledger row, but it does not resolve or check the caller's organization or actor. The public `clinical_core.invoke_plan_operation` entry point performs those checks before calling it. Any server-side SQL path able to invoke the private function under `clinical_core_api` could bypass that public entry point.

The disposable-database test `src/server/clinical-core/private-function-acl.database.test.ts` builds the real 106-migration artifact and confirms all twenty grants. Before the candidate, a call under `clinical_core_api` reaches `move_entitlement` and gets its own `entitlement_move_invalid` refusal for a nonexistent fictional ID, rather than a permission refusal. This proves callable authority, **not** that an HTTP route exposes arbitrary SQL or that any real entitlement was changed. The test then applies the candidate, confirms all twenty public grants are gone, confirms the API role cannot invoke `move_entitlement`, and confirms the checked public plan entry point still reaches its own argument validation. A fabricated twenty-first public grant makes the candidate refuse with `private_function_acl_parent_mismatch` before any revoke.

The candidate revokes `PUBLIC EXECUTE` on all functions in `clinical_private` only after verifying the exact observed set of twenty. It changes no table, row, role membership, schema USAGE, function body or activation flag. The expected removal of the twenty implicit grants is the intended effect; this is not a general schema lockdown. Future functions can receive default public grants again, so the source test and release review must keep checking this boundary.

## Required before any hosted application

1. Inspect the live target's `pg_proc` ACLs and schema USAGE under a read-only catalog query. A different set must stop the candidate, not be waived by changing the expected list blindly. Review any direct callers of these functions, particularly the sync worker and clinical knowledge paths, against their actual runtime roles.
2. Rehearse the exact candidate and its reversal on an isolated fictional copy of the matched production schema with role sessions. Exercise entitlement reserve/settle, sync delivery, knowledge import and clinical pathway operations, plus denials under `clinical_core_api` and cross-organization identities. PGlite's single-session test does not replace this.
3. Capture the pre-change per-function ACLs as the rollback artifact. An emergency reversal would restore **only** the captured grants and would reopen the documented exposure; it must be a reviewed security decision, not an automatic blanket `GRANT`.
4. Check the public API and RDS Data API command surfaces for any path that accepts caller-controlled SQL or function names. This determines actual reachability from a user; the present source review does not establish it.
5. Register, apply and activate only through a separately reviewed preserving change, with exact parent ledger/hash and a post-apply ACL and application-journey check. PHI and commercial activation remain independently blocked.

The related return packet is `docs/claude-source-closure-return-2026-10-17.md` §WP3 finding F5. This review narrows F5 from “unreviewed grants” to a demonstrated database-role call path and a blocked repair candidate; it does **not** claim a user-facing exploit, hosted validation, or PHI readiness.
