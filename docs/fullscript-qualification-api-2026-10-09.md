# Fullscript qualification API

The canonical delivery service now has a strict HTTP source boundary and native
AWS observer. It remains an unreleased candidate: no HTTP stack installs it,
no reviewed target is manufactured, and the current cart route still reports
`not_implemented`. PHI is disabled and production activation is blocked. This
advances the provider phase, not commercial readiness or live-patient approval.

## Request authority

Two POST routes separate workforce and consumer actions. Workforce can prepare,
send, read, cancel, reconcile and export a draft intent. Consumers can only read,
cancel or export their own existing intent; their service has no workforce session
and those operations never load Fullscript credentials. SQL still decides record
access, current approvals, consent, catalog eligibility and original writer authority.

Bodies contain only an action and IDs, or the export cursor. Unknown fields,
review bodies, supplied actors, credentials, query overrides, malformed UTF-8,
noncanonical base64 and oversized bodies are refused. Identity comes from verified
Cognito ID tokens, never an email or organization supplied in the body. Sign-in
must be fresh within 15 minutes using `auth_time`, not a refreshed token's `iat`.
Only separately designated fictional subjects can reach qualification execution.

The native observer also verifies the bearer signature through AWS's
[Cognito JWT verifier](https://github.com/awslabs/aws-jwt-verify). Verified identity
and time claims must agree with API Gateway's authorizer claims. A fabricated
direct Lambda event does not substitute for a valid signature. Missing or changed
observations yield one opaque refusal; no provider or SQL text is returned.

## Live observations before service construction

Every request observes the STS account and assumed role; the published numeric
Lambda version and its actual code hash; its PHI, qualification, source and
database settings; the actual API route, JWT authorizer, exact issuer/audience and
qualified Lambda integration; and the current Cognito pool, client and user.
There is no successful-observation cache or environment boolean standing in for
these calls. `$LATEST`, aliases, unfinished updates and production accounts refuse.

Workforce qualification requires a local-password, required-MFA pool with TOTP,
no remembered-device configuration, no federation or custom/passwordless client
flow, and sign-in after the currently observed pool/client/user changes. This is
policy-bound authentication verification, not a claim that MFA registration alone
proves a challenge. AWS documents both
[required MFA](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-mfa.html)
and [remembered-device bypass](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-device-tracking.html).
Optional-MFA pools are refused rather than silently treated as equivalent. These
settings must be qualified with an actual fictional login, including recovery.
The supported server-password flow remains allowed: AWS's
[AdminInitiateAuth](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_AdminInitiateAuth.html)
returns authentication tokens only after its outstanding challenges are complete.
Custom authentication and remembered-device bypass remain refused.

The delivery database itself observes `current_database()` and `current_user`.
Only `clinical_core_qualification` and `fullscript_draft_worker` are accepted.
A worker-only, fixed-search-path function returns version/name/hash metadata from
the actual migration ledger. No direct clinical-schema read or administrative
fallback is granted. Missing, additional, renamed or altered ledger entries refuse.
The reviewed ledger must equal the distinct 111-migration candidate, including
the exact names and SQL hashes of every historical entry. Both the ledger hash
and the filename-bound artifact hash are checked. Matching only the last three
names is insufficient. The current 107-entry hosted target is insufficient.

## Candidate release work still required

The [111-migration candidate and SQL transition](fullscript-schema-release-2026-10-09.md)
now register the three Fullscript source candidates after the exact telehealth108
parent. The source engine supports a preserving 107/108-to-111 transition and an
atomic rollback rehearsal. The separate [native operator](fullscript-upgrade-operator-2026-10-09.md)
now implements qualification-only command/custody/reconciliation source. Exact
operator/target review and actual AWS qualification remain required. Never splice
SQL into the existing 107 ledger or invent approval rows.
Build the Lambda from exact source and record its zip hash and published
version before filling the reviewed target. The target must be loaded from a
separate reviewed server artifact; embedding the zip's own expected hash inside
that zip would be circular and is not a valid release procedure.

The future candidate needs narrowly scoped permissions for STS caller observation,
its own `lambda:GetFunctionConfiguration`, the selected API's route/authorizer/
integration reads, and the designated Cognito pools' describe-client/describe-pool/
admin-get-user operations. Delivery separately needs the existing reviewed RDS,
token-store and provider permissions. Do not grant new admin database access,
wildcard provider secrets or public direct Lambda invocation. Deployment must
verify route permissions and published source binding, not merely copy examples.

Hosted qualification must cover actual AWS response shapes, expired/stale and
revoked users, MFA and device-bypass refusals, wrong pools/accounts/versions,
same-database ledger changes, role denial, consumer credential isolation and the
native sandbox draft/recovery journey. Local mocked commands are not proof of
these calls or grants. `AdminGetUser` contributes to Cognito's monthly active user
count; monitor request load and throttling before any wider release.

Read-only inspection on October 9 confirmed the synthetic account and its
required-MFA workforce pool, with no device configuration. The pool omits its
deprecated `Status` field, so the observer permits its absence while still
requiring exact ID/account binding and a currently enabled, confirmed user.
The observed client supports server-password authentication as well as password,
SRP and refresh. These observations corrected fictional response assumptions;
they are not hosted acceptance of this new API or an authorization to deploy it.

Hold-aware account-wide privacy, Fullscript-copy retention/deletion, OAuth-start,
disconnect and late-callback settlement remain open. No local check authorizes
an order, patient send, charge or production data transfer.

## Source verification

The final extended group passed 593 tests in 15 files with no skips. Typecheck
and targeted lint passed, and the native observer bundled and loaded as a 3.7 MB
Node 22 server module. The increment adds 86 API/observer cases and one real-SQL
privilege case. The JWT tests use real RSA signatures and AWS's actual verifier
with fictional cached keys; AWS command responses are fictional. The SQL case
proves the metadata function works for the worker while direct clinical-schema
reads, ledger writes and API-role execution remain denied.

Earlier test-helper typing and ledger-fixture errors failed their runs. A real
permission failure exposed the need for the narrow metadata function; it was
repaired without granting the worker clinical-schema access. Those earlier runs
are not counted as passes. The final run began at 19:47:38 PDT on October 9 and
completed in 123.56 seconds. Dependencies were reused locally, so this is not a
clean-install CI or hosted integration result. No candidate was deployed.
