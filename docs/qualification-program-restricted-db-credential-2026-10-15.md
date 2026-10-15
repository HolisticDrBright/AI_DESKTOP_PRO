# Restricted credential for the fictional program API — source-only review

Status: **BLOCKED candidate, not applied or deployed.** This is not a PHI, billing, production-program or paid-build approval.

## Observed hosted gap

On 2026-10-15, a read-only check in account `588966314750` showed that the isolated `6zt8e9qz04-qualification-bound-programs` Lambda uses the cluster's RDS-managed **master** secret. The Lambda remains `PHI_ALLOWED=false` and `PROGRAM_ACTIVATION=blocked`. The 112-migration qualification database has `clinical_core_api` and `clinical_core_migrator` as NOLOGIN roles and no dedicated program API login. The request adapter issues `SET LOCAL ROLE clinical_core_api` within its transaction, but possession of the master credential is broader authority than the transaction-scoped role switch. This is a least-privilege finding, not evidence of a breach or of real-data use.

AWS documents that RDS Data API uses the Secrets Manager credential named in each request. PostgreSQL 17 supports role memberships with separate `SET`, `INHERIT` and `ADMIN` options. Sources: [AWS Data API authorization](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/data-api.access.html), [PostgreSQL roles](https://www.postgresql.org/docs/17/role-attributes.html), [role membership catalog](https://www.postgresql.org/docs/17/catalog-pg-auth-members.html).

## Prepared, inactive source

- `infra/aws-clinical-core/source-candidates/qualification-program-api-login.sql`, LF SHA-256 `64987db6766b18adbe66e182bd1beb6d35999d940c1a62243da594e5bfae1b19`: refuses any database except `clinical_core_qualification`, refuses an existing role or missing safe `clinical_core_api`, creates a NOLOGIN/NOINHERIT role with no elevated attributes, and grants only `clinical_core_api` with `SET TRUE`, `INHERIT FALSE`, `ADMIN FALSE`. It contains no password and creates no usable credential.
- `infra/aws-clinical-core/qualification-program-api-restricted-credential.json`, LF SHA-256 `3c607052015d25b392d28e2e668eb0290e791b4d99a5e92cb0d99fa07cde8f51`: generated from the existing `/2` template with unchanged resources, routes, JWT authorizers, Lambda code and blocked environment. Its sole functional change is to require a dedicated `alp-qualification-program-api-db-` Secrets Manager ARN, excluding the current `rds!cluster-` master secret. The new template is `/3`, not an in-place edit to the deployed template.
- Generator and four tests prove drift refusal, exact-template change scope, role attributes and membership, wrong-database refusal, missing-parent refusal and replay refusal. A local PostgreSQL-compatible test confirms the login can `SET ROLE clinical_core_api` but cannot set the migrator role. CloudFormation validation and `cfn-lint` pass.

The PostgreSQL least-privilege skill guided the separation between a login role and the NOLOGIN API authority role. The candidate does not silently inherit clinical privileges and does not assign administrator or migrator membership.

## Required reviewed operator work before any execution

1. Review the exact SQL and template hashes above, the 112-row qualification ledger, account/region/database identity, row custody and rollback. A preserving schema upgrade needs its own authorization. Do not apply this to staging or production.
2. Decide and review a secure credential-provisioning mechanism. Generate the password outside source and logs, activate the dedicated role only after the separate Secrets Manager credential exists, and arrange rotation/revocation. Do **not** put a password, token, secret value or interpolation containing one into this repository, shell history, change-set parameters or test output. The current source intentionally leaves the role NOLOGIN.
3. Verify the dedicated secret's actual database username, cluster, KMS key, rotation and access policy; verify the role has no direct grants, no other memberships, no ability to become the migrator, and only the reviewed qualification database can be reached. A secret name alone is insufficient proof of its contents.
4. Build a clean exact-source Lambda ZIP and prepare a CloudFormation change set from `/3`. Inspect every parameter, physical resource, IAM action and replacement effect. Keep `PHI_ALLOWED=false`, `PROGRAM_ACTIVATION=blocked`, qualification-only issuers and subjects, Sandbox billing blocked and zero store products. Obtain separate approval before execution.
5. Hosted qualification must show that the program API works using the dedicated credential, then revoke its access to the master secret. Recheck workforce reads, consumer entitlement refusals, malformed inputs, unauthorized roles, no-store/qualification headers and zero assignments. Positive assignment/purchase/device acceptance still requires its own entitlements and reviews; do not substitute a fake entitlement and call it a store pass.

This finding may apply to other request Lambdas that still use the RDS-managed master secret. The candidate changes only this isolated program API; it does not certify the wider fleet's credential posture.
