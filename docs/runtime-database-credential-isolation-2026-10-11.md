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
