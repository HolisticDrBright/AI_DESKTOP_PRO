# Runtime database credential isolation

Request-processing credentials must not be the database owner or administrative
operator credential. On October 11 a read-only managed test of the actual
application adapter confirmed that the qualification credential logs in as
`clinical_admin`, switches to `clinical_core_api`, and can switch back to
`clinical_admin` with create-role and create-database privileges. The transaction
rolled back; no patient record, secret value, schema or grant was read or changed.
This proves a credential boundary defect, not a public exploit.

PostgreSQL checks `SET ROLE` against the session user. Changing the effective
role does not restrict the login's ability to return to its own privileges.
See [PostgreSQL 17 SET ROLE](https://www.postgresql.org/docs/17/sql-set-role.html).
The Data API authenticates using the selected database secret; IAM permission
to use that secret is not a substitute for restrictive database credentials.
See [AWS Data API authorization](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/data-api.access.html).

## Source admission boundary

Both request factories perform a fixed read-only system-metadata query before
assuming the API or Fullscript worker role and before invoking request work.
Only one named boolean `true` admits the transaction. Missing, malformed,
multiple, false or unavailable results refuse and attempt one rollback, without
an administrative fallback. The target role comes from the factory, not a
request parameter.

The check refuses elevated login or target flags; unrelated or administrative
role memberships, including non-inherited/non-SET memberships; database,
application-schema, relation or function ownership; persistent schema creation;
and login schema/table/column/sequence/function privileges beyond the target.
Column comparisons are per column: access to one column must not hide excess
access to another. The check accepts a separate NOINHERIT login with SET
permission for its bound role. Temporary PostgreSQL schemas are outside the
persistent-schema ownership check.

This is a point-in-time credential admission boundary, not a complete RLS,
security-definer, IAM or effective-permissions certificate. It does not prove
all grants on the target role are appropriate, freeze administrator changes,
or qualify the full clinical request context. Those require separate review and
hosted acceptance. Existing administrative operator purposes remain separate;
their purpose string alone does not supply an executable or schema approval.

## Verification

The new adapter suite had 18 failures against the previous source; the one
already-correct administrative-operator test passed. The repaired suite passes
19 cases; six subsequent malformed-response cases extend the suite to 25.
The seven affected adapter, retry, messaging, connection and consent
suites pass 301 tests. The metadata SQL passes 25 additional embedded PostgreSQL
cases. These are local tests, not deployed services or physical devices.

Run native source qualification from clean committed source:

```text
npm run qualify:runtime-credential-native -- --binary-directory <absolute PostgreSQL 17.7 bin> --driver-directory <absolute pg 8.16.3 package directory>
```

This Windows runner creates a new fictional loopback-only cluster and separately
authenticates its request logins. It uses the actual adapter, refuses the owner
and an administrative membership, checks restored safe access, and confirms
shutdown. Bootstrap administration is fixture setup only. It accepts no AWS
credential, managed database or clinical input. Its report separates native
source evidence from hosted acceptance. Keep unfinished or failed runs visible;
do not treat an absent report as success.

## Required AWS preparation

Do not deploy this repair against the existing administrative secret expecting
requests to continue: the corrected adapter deliberately refuses that credential.
Prepare a separately reviewed runtime login and secret with only the intended
role membership and grants. The API and Fullscript worker need independent
credentials; neither may reach the owner's role. Restrict each runtime IAM role
to its own secret and cluster, with no permission to select the administrative
secret. Register the exact resource and credential review before changing target
manifests, templates or installed candidates.

The currently inspected qualification foundation pins an RDS-managed master
secret. It cannot simply be given a different ARN under its existing reviewed
template identity. A reviewed successor configuration and updated same-target
bindings are required. Creating users, passwords, secrets or grants, rotating
credentials, changing IAM and redeploying require the appropriate exact review;
the read-only diagnostic supplies none of those approvals. Do not rebuild or
substitute previously approved migration/operator binaries as part of this
request-adapter repair.

Run the corrected adapter against the reviewed runtime credential and prove
admission plus private-table/admin-role denials. Repeat the managed authority,
owner isolation and application journeys with the exact installed candidate.
No skipped or unavailable path counts as a pass. Historical source and managed
diagnostic receipts remain tied to their original code and target.

The qualification ledger remains at its last inspected 107 checkpoint. No
historical SQL, candidate117 identity, clinical hold, provider approval, consent
release, PHI flag or paid-build authorization changes here. Source integration,
hosted/device/provider/store qualification and owner reviews remain open within
the original six readiness scopes.

## Managed administrative credential refusal

The exact `14b454fbaec20f6ecd521b5a1eba4985dded6295` adapter was exercised
against the qualification database on October 11 at 10:27:15 UTC. The driver
injected a read-only transaction, pinned the AWS account, source and bundle,
and allowed only the fixed credential metadata query and rollback. The
metadata result was false, the adapter returned `configuration_invalid`,
request work was not called, no role was assumed and rollback returned
`Rollback complete`. This is actual managed negative evidence, not a deployed
Lambda journey or positive acceptance of a replacement credential. No record,
secret value, schema or grant was read or changed.

The normal frozen-source whole suite completed with 454 files, 7,180 tests
passed and 11 skipped in 727.60 seconds. Exact
[CI38131468725](https://github.com/HolisticDrBright/AI_DESKTOP_PRO/actions/runs/38131468725)
completed successfully across 11 jobs at that head. The deployed-backend
setup/build/live tests were skipped for missing secrets, not hosted passes.
Seven native PostgreSQL 17.7 source scenarios passed with confirmed shutdown.
Those local/native results do not supply managed positive or provider evidence.

## Fullscript observer rollback response

The deployment observer expected `Transaction Rolled Back`, a value supplied
by its fictional transport. The actual managed Data API response above is
`Rollback complete`. Consequently the observer would refuse a valid rollback;
the tests also allowed the fictional status to certify settlement. Two new
regression cases failed against the old source: actual-response acceptance
and fictional-status refusal.

The observer now requires `Rollback complete` and SDK metadata reporting HTTP
200. It refuses missing or malformed metadata, a non-success response, an
unknown status, denied or lost rollback. It still attempts exactly one
rollback and cannot issue a successful report before that response. No retry,
commit, role permission or schema behavior changes. The seven deployment
suites pass 262 tests, including the 28-case database suite. These transport
tests are not a complete live Fullscript observer run against a reviewed worker
credential and schema.

AWS documents successful rollback responses as HTTP 200 with a
`transactionStatus` field; it does not enumerate the status strings. The exact
accepted value comes from the observed managed response, not a guessed
documentation example. [AWS RollbackTransaction API](https://docs.aws.amazon.com/rdsdataservice/latest/APIReference/API_RollbackTransaction.html).

## Native authority tests with authenticated request credentials

Historical native authority report contract `telehealth-authority-native-source/3`
used a separately compiled non-superuser schema owner, but its request sessions
also logged in as that owner before lowering the role. The 29 authority/lock
results remain evidence for the SQL cases tested; they are not independent
restricted-request credential evidence.

Report contract `/4` separates compilation and request authentication. Bootstrap
creates one fictional local NOINHERIT request login with only SET membership
in clinical_core_api. Two request connections authenticate as that login.
The real source adapter must admit both and refuse the schema-owner credential
before request work. A physical attempt to assume clinical_admin must fail.
Each authority transaction then runs the same source metadata admission SQL
and parser before role assumption. No application or historical SQL is changed.

The report binds the adapter and metadata bundles, records the four credential
observations, and identifies the 29 authority cases as native SQL transactions
with source credential admission. It does not claim all those transactions use
the Data API factory or simulate a deployed API. A pass requires all four
credential observations and the entire exact authority matrix, with confirmed
server shutdown. Bootstrap blockers/fixture changes remain local negative
controls. Prior reports and candidate117 identity remain unchanged. A complete
source assertion is not a physical run; qualification requires the actual
fresh report from the committed source.

## Versioned configuration for independent credentials

The successor foundation adds optional, all-or-none runtime bindings without
creating database logins, secrets, grants, IAM roles or handlers. All three new
values must be empty or supplied together; shared secrets and an all-zero review
digest are refused by template rules. PHI stays false and foundation execution
stays disabled because the foundation is infrastructure, not an active candidate.

| Credential | Foundation binding | Version-four use |
| --- | --- | --- |
| Administrative operator | Existing `DatabaseSecretArn`, also exposed as `OperatorDatabaseSecretArn` | `operatorDatabaseSecretArn`, only for named fixture/release commands and bounded private-audit observation |
| Restricted request API | `RuntimeApiDatabaseSecretArn` | `databaseSecretArn` in the target and every request candidate parameter |
| Restricted Fullscript worker | `FullscriptWorkerDatabaseSecretArn` | The separately reviewed Fullscript target; never the generic request API or operator binding |

`RuntimeCredentialReviewSha256` binds the reviewed resource/credential packet.
It is not an approval produced by the template. The API secret namespace is
`alp/qualification/runtime-api-…`; the worker namespace is
`alp/qualification/fullscript-worker-…`. A matching name does not prove that
the stored login has the correct role: the existing actual-source metadata
admission and managed positive/negative qualification remain required.

Target contract `aws-clinical-core-qualification-target/4` preserves historical
versions 1–3, requires the independent operator binding and review digest, and
retains all twelve candidate names. Both Node and PowerShell must observe the
finished foundation's exact cluster, API, database, export bucket, administrative
secret, API secret and review outputs before request or fixture work. Candidate
parameters continue to bind to the API secret. Recording fixture administration
and retention release/inspection select only the operator secret. The scheduled
cleanup observation verifies the service's actual API binding before using the
operator credential for its fixed private-audit read. No absent operator value
falls back to request authority.

All ten generated parameter examples now use the API secret slot. Ten tests
failed against the previous master-secret placeholders before this change.
The version-four target example stays unfilled and refused. CI checks all four
example versions, their drift, the source tests and the credential-free
PowerShell runner matrix. Recording CLI wiring coverage is a source assertion,
not a physical fixture write. Template rule evaluation and `cfn-lint` are local
configuration evidence, not CloudFormation deployment evidence.

The earlier nine failing-before configuration cases proved the missing new
contract and slots. Existing negative tests that passed merely because version
four was unsupported do not prove its implemented guards. The expanded tests
exercise supported version-four positives and missing, mixed and mismatched
bindings independently. A separate failing-before case exposed that the shared
foundation-output helper still accepted a version-four master-as-API binding;
the live observer now uses the same corrected helper instead of duplicating
credential comparisons. Whole-suite and exact-head CI results must be recorded
after their actual terminal observation; predecessor results do not count.

Before any provisioning, prepare the exact review of two non-administrative
logins, their allowed SET membership/grants, separate Secrets Manager resources,
KMS and per-candidate IAM, rotation/revocation and the source/artifact bindings.
Keep secrets out of review text, logs and source. Provisioning, schema upgrades
and deployment require their respective reviewed authority. None is authorized
by this source preparation, an old schema approval or a fictional test digest.
Then prove actual-source admission, owner isolation, private-table/admin-role
denials and rollback on the managed target before deploying guarded candidates.

## Foundation credential declaration observation

The normal full suite at source `7b6e4a5b303ac4a8bcf655ebbba293eb1f648181`
finished with three foundation-observer failures, 7,229 passes and 11 skips.
Exact CI38135961227 failed in the normal-unit and inventory-configuration jobs
for the same three cases. These are source regressions, not timing failures.

The fixture attempted to resolve new conditional outputs without supplying the
new parameters or excluding inactive outputs. After the fixture was corrected
to represent CloudFormation parameters and active outputs, the production
observer itself refused the complete parameter set: it still expected only the
old four parameters. Seven cases failed before the source repair, including
the old positive infrastructure checks and new credential-binding cases.

The observer now supplies all three declared runtime parameters explicitly.
An unbound foundation requires empty values and no conditional credential
outputs. A bound foundation requires an exact `runtimeCredentials` object
containing `apiSecretArn`, `fullscriptWorkerSecretArn` and `reviewSha256`.
Namespaces, account, region, independent secrets and a nonzero review digest
are checked before cloud reads. The unchanged foundation rules are also
evaluated. Actual parameter and output comparisons still reject missing,
extra, changed or inactive-output substitutions; repeated stack reads detect
ordinary drift. Missing references never receive a permissive fallback.

The report distinguishes observed declaration bindings from credential
qualification. It returns `runtimeCredentialsQualified: false`, with no
acceptance, review, delivery, mutation or PHI claim. Matching declarations do
not prove secret contents, database grants or IAM effectiveness. The fixture
uses fictional ARNs and a fictional review digest; it creates no AWS resource
and supplies no human review.

Malformed root bindings and explicitly malformed credential objects also
return `foundation_binding_refused` before cloud reads. One new test exposed
an early `Object.hasOwn` call on null; that failure was reproduced and fixed.
The four focused observer/stack/fleet-orchestration/credential files pass 99
tests, and typecheck/lint pass. Record the successor normal whole-suite and
exact-head CI only after their own terminal observations.

The existing thirteen-file inventory qualification target suite passes all 232
tests and its verifier build passes. Production-core, compatibility, operation
inventory, stub-reset and Core gates pass. These source checks do not install
the new foundation or establish the runtime login permissions.

The generic inventory-fleet coordinator still derives foundation and bounded
administrative-read bindings from the legacy generic database field. It does
not yet carry the separately reviewed Fullscript worker binding. Complete its
versioned credential mapping and operator-specific reads before using it for
a separated-credential fleet. The direct foundation observer repair does not
complete that integration or permit the administrative secret as a request
credential. Hosted credential provisioning, the exact reviewed foundation
successor, managed positive/negative acceptance and deployment remain open.
