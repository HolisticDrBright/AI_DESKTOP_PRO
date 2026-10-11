# Fullscript native owner preservation repair

The preserving Fullscript operator must distinguish unchanged historical role
memberships from the authority of its newly created worker role. The original
operator included every membership in the historical digest while excluding
the new worker role itself. PostgreSQL 17 creates an ADMIN-only membership
automatically when a non-superuser with CREATEROLE creates that role, so a valid
upgrade failed its historical-schema comparison.

## Permission checks

The historical digest excludes only edges whose granted role is the new
`fullscript_draft_worker`. Existing role edges remain covered, including any
attempt to make the worker a member of an existing role. Separate extension
validation refuses every worker-related edge except zero memberships or one
exact bootstrap-superuser grant to the current owner: ADMIN true, INHERIT false,
SET false. The grantor must be bootstrap OID 10 and a superuser. Duplicate,
API-role, other-owner, other-grantor, inherited and settable grants are refused.
Validation never creates, repairs or revokes a grant.

This matches the [PostgreSQL 17 role creation rules](https://www.postgresql.org/docs/17/role-attributes.html).
The synthetic Aurora read-only inspection found OID 10 is `rdsadmin` with
SUPERUSER; the local PostgreSQL fixture uses bootstrap `postgres`. This
observation does not emulate Aurora's managed memberships or approve an upgrade.

## Native diagnostic scope

`scripts/qualify-fullscript-native-owner.mjs` creates its own disposable,
loopback-only, SCRAM-authenticated PostgreSQL 17.7 cluster. Compilation,
extension creation and metadata comparison use `clinical_admin` without
SUPERUSER, BYPASSRLS or replication. Only two fictional, unprotected rows are
inserted. The actual 107 source is followed by the actual 108 through 111 SQL
inside a transaction, with metadata comparison and explicit rollback. An
in-memory audit export exposes the private metadata function without adding a
production route or permission.

The diagnostic also tests widened API and owner grants, verifies restoration
of the original ledger, rows and schema, and confirms shutdown before writing
a report. It accepts only explicit local binary and driver directories, not
AWS profiles, existing database URLs, approvals or deployment inputs.

The failed original run `pg17-6hpAb3` reproduced the metadata mismatch. The first
repaired positive run `pg17-KjtFjj` preserved the historical digest and rolled
back all new objects. Run `pg17-eZGzhV` also passed four real PostgreSQL
permission negatives: an API recipient, inherited owner authority, settable
owner authority and a second owner edge. Shutdown and rollback were confirmed.

The embedded Fullscript and telehealth operator suites each passed 83 tests;
the native argument and scope suite passed 11. Typecheck, targeted lint,
compatibility, operation inventory and stub-reset checks passed. Full-suite and
hosted CI evidence for the repaired commit must be recorded separately.

These are source diagnostics only. Protected-row preservation, Aurora role
semantics, custody, production admission, provider approvals and hosted
acceptance are not certified. Stock PostgreSQL refused the earlier protected
row fixture under forced RLS; no bypass privilege or simulated `rds_superuser`
was added to make it pass.

## AWS upgrade status

The read-only synthetic inspection found 107 migrations, 209 historical tables
and 56 rows, and its transaction was rolled back. No schema upgrade was applied.
The `9d03cfc` review packet must not authorize this changed operator. Build from
the clean repaired commit, review its new exact operator hashes, pass source
CI and the real rollback rehearsal, and obtain the separate exact approval
before committing either preserving upgrade. PHI remains false and activation
blocked throughout.
