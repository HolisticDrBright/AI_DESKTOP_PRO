# Synthetic care intent release

The intent-aware API artifact binds V2 request preparation and discovery to
the exact Desktop handler and preserving schema transition. It is a synthetic
candidate, not a deployed feature or permission to erase records. The hosted
API still runs the earlier request-ID handler until a separate code deployment
is observed and accepted.

## Build and read only preparation

```powershell
npm run build:synthetic-care-intent-release -- --v2-root "<V2 checkout>"
npm run prepare:synthetic-care-intent-release -- --v2-root "<V2 checkout>" --candidate "<exact build directory>" --prepare-fictional-intent-code-only
```

Both checkouts must be clean. The build compares the lifecycle and recovery
contracts byte-for-byte after LF normalization, includes the recovery list,
journal, transport and synthetic EAS destination, rebuilds the handler, and
packages only `index.js` and its embedded release. Its separate
`synthetic-care-intent-release/1` contract and `care-intent-release` object
prefix cannot overwrite the parent release or certify its historical evidence.

The preparation command independently reads the fixed synthetic account,
foundation, complete API inventory, JWT authorizers, Lambda configuration,
execution role and encrypted logs. It rebuilds its read-only database inspector
from the same source and verifies the existing deployed ZIP through an
exact-version S3 HEAD and bounded download. It inspects database and control
state before and after; changed source, data, schema or authority is refused.
It has no upload, code update, change-set execution, fixture or lasting DDL
operation. A successful report is preparation only, never hosted acceptance
or an authorization to apply the successor.

## Preserving transition

The canonical parent remains source46/live47 with 88 tables. The blocked
overlay `20261007010000` has SQL SHA-256
`4be2ca72b0486bec171f16c5299c898d70bfbdbfd3143c4bb216fccc329299ec`.
The separate mapping is source47/live48 with 89 tables, preserving the
historical alias and reference ledger. Its proposed source digest is
`02026932fff5a37db42a17a1c4f80bd38a759cf8e2ccb2f4d53b8299c66065e7`
and live digest is
`447cf4ea8c8da3decbaa7edea964f97d9e3bdb029c38723bf3a5767c38679a50`.
It is not registered in the canonical manifest and is not applied.

Schema inspection batches the same per-table catalog representation in a
single ordered query. A database test compares its digest to the original
per-table query. Inventory, ACL, constraints, RLS, defaults, indexes, policies
and triggers remain checked. The operator uses bounded fresh connections,
one attempt, explicit disposal and machine-only diagnostics; no SQL, payload
or credentials are logged. Failed preparations receive separate finding files
and cannot be presented as successful reports.

## Exact upload and unexecuted proposal

```powershell
npm run upload:synthetic-care-intent-release -- --v2-root "<V2 checkout>" --candidate "<exact build directory>" --upload-fictional-intent-code-only
npm run prepare:synthetic-care-intent-code-change -- --v2-root "<V2 checkout>" --candidate "<exact build directory>" --prepare-fictional-intent-code-change-only
```

The proposal command includes the upload, so it does not require a separate
upload run. It rebuilds the current source and makes fresh AWS and database
observations before admission. Storage uses a create-only PUT, exact version
HEAD, and bounded download with checksum and byte equality. An identical
collision is reused only after readback; an unknown response is not retried.

Before proposing a change, the command repeats the complete live preparation.
The live template must match the source with the four already absent routes
removed and the existing 51-route annotation preserved. Only the Lambda code
key and its exact object version may change. All other parameters use their
previous values. The created change set must contain exactly one modification
to the existing Lambda's Code property, with no resource replacement. The
command reads both the default and property-value projections without hidden
pagination. Both must meet that same resource limit. Complete before/after
contexts and detail paths must prove exactly the expected code key and object
version changed, with every other property preserved. An extra dependency in
either projection is refused, even when omitted from the other view. The
command has no execution, SQL, fixture, activation, or paid-build operation.

A shared operator lock and flushed journal cover both writes. Admissions are
recorded before remote calls. A lost write response or unresolved readback
keeps that run's lock and journal; diagnose it with read-only observations
before any further write. Do not delete the lock or repeat the command merely
because an observation timed out. The deterministic change-set name and client
token support reconciliation, not automatic replay. A settled unexecuted
proposal still does not prove deployed runtime compatibility or schema safety.

## October 7 projection finding

The exact artifact at Desktop `bad6ee1` and V2 `70e1196` was uploaded and
downloaded successfully. Its unexecuted change set's property-value view listed
only the Lambda, so that first runner issued a success report. Independent
default-view readback listed a second modification to `IdentityApiIntegration`,
with a dynamic `IntegrationUri` dependency on `IdentityApiFunction.Arn`.
The first proposal report is therefore **not qualified deployment evidence**.
The code and database remain unchanged; do not execute that proposal.

Both views are now required, with negative tests for hidden dependencies,
pagination, incomplete contexts and non-code changes. AWS documents property
values as additional detail, not permission to discard the default resource
inventory ([DescribeChangeSet](https://docs.aws.amazon.com/AWSCloudFormation/latest/APIReference/API_DescribeChangeSet.html)).
The source template's ARN reference is a possible explanation for the extra
dependency, not proof of a harmless runtime no-op. The deployment path must
resolve and qualify that dependency without silently relaxing the gate.
The full upload receipt, both live projections, repaired-verifier refusal and
scope correction are archived in
[Intent upload audit](evidence/2026-10-07-care-intent-upload-audit.json).

## Separate integration dependency qualification

The original single-resource command still refuses the two-resource change
above. A separate, nonexecuting command handles only the exact observed
dependency shape:

```powershell
npm run prepare:synthetic-care-intent-dependency-change -- --v2-root "<V2 checkout>" --candidate "<exact current build directory>" --prepare-fictional-intent-dependency-change-only
```

This command performs the same fresh source rebuild, independent database
inspection and versioned artifact upload. It preserves the full default view
with two affected resources and the full property-value view with one. The
only second resource allowed is the existing `IdentityApiIntegration`, without
replacement, whose single dynamic `IntegrationUri` dependency must be caused
by `IdentityApiFunction.Arn`. Any extra resource, detail, property or pagination
is refused. This is an explicit two-resource scope, not a single-resource pass.

The live stack template must differ from the proposed template only in the
Lambda object version; the code-key parameter is independently bound to the
verified upload. The integration resource must retain the exact `Fn::GetAtt`
reference, API parameter, AWS proxy configuration, timeout and payload format.
Actual stack resource IDs, the existing Lambda ARN, revision, code checksum,
full resolved Lambda property context and integration configuration are
checked before and after proposal creation. The two projections must have
identical metadata and parameters, standard deployment and rollback enabled.

A successful report classifies the preserved dependency but explicitly leaves
`integrationNoOpProven`, `executionAdmissible` and `deployed` false. AWS describes
dynamic evaluations as references whose target values depend on the update;
an unchanged template reference does not prove the update's runtime result
([ResourceChangeDetail](https://docs.aws.amazon.com/AWSCloudFormation/latest/APIReference/API_ResourceChangeDetail.html)).
Any subsequent execution needs its own admitted operator, exact post-execution
integration and control-plane readback, compatible retained-version recovery
and before/after database verification. Neither this command nor a saved
classification report can perform or authorize that continuation.

Targeted tests preserve the original refusal and cover extra resources,
dependency mutation, live binding changes, unread pagination, metadata drift,
disabled rollback, non-Code context changes and the absence of execution,
schema, report-authority and target-override commands.

The actual run at Desktop `8d5c8ad` and matched V2 `c7d76cc` completed on
October 7. ZIP `5c6b489e789b704a5936d2f52ff78dbffb9f9d4521ccbd347e072acfa2e0b25d`
was uploaded as encrypted S3 version `90cXIgm3VBS6lPJymSyY0fvWVZsiyWBJ` and
downloaded byte-for-byte. Fresh complete preparations preceded both writes.
Proposal `care-intent-b7f045bc93c35bd02e47dfd8afb755c6` passed the separate
dependency classification, with unchanged live bindings before and after.
An independent read-only recheck at `2026-10-07T22:02:48.240Z` classified the
same exact scope and confirmed that the original strict profile still refused
it. Both raw projections and their hashes are retained in
[Dependency audit](evidence/2026-10-07-care-intent-dependency-audit.json).

The proposal is unexecuted. The deployed Lambda remains `5b6f8aa`, and the
database remains live47/source46 with 88 tables and 23,985 rows. This closes
the explicit proposal-shape classification step, not deployment, functional
recovery, intent migration, erased-outcome acceptance or PHI readiness. The
subsequent test-only repair `a15b1d6` is not the uploaded candidate's source.
Any future candidate must bind its exact selected source pair; do not relabel
this historical upload as a newer source or execute from saved JSON authority.

Local verification at `a15b1d6` passed all 341 Desktop files: 4,307 tests passed
and 11 skipped. The preserved test deadline remained five seconds. The earlier
bundled rollback case timed out; it was split into three independently bounded
cases, retaining every mutation, refusal, preservation and predecessor check.
All 30 cases in that file passed in isolation. A full run concurrent with the
eight-worker AST refresh then had two timing failures, which remain archived;
the unchanged full suite passed once that job had finished. Do not run the
resource-heavy graph refresh concurrently with full embedded-database testing.
This is local verification, not hosted CI or device acceptance.

The unchanged V2 source at `c7d76cc` passed 216 files and 2,509 tests, with one
file/test skipped; typecheck and lint passed. Its store gate remains
`not_submittable` with eight blockers. Neither these source tests nor the
classification report activate any commercial or PHI capability.

## Connected live runner

`release:synthetic-care-intent` now connects upload custody, the separately
qualified two-resource proposal, actual stack execution and readback, compatible
retained-code recovery, and the embedded database continuation. Its source and
failure tests are implemented; this runner has not yet been hosted verified.

After selecting and building a clean exact source pair, run from Desktop:

```powershell
npm run release:synthetic-care-intent -- --v2-root <V2-checkout> --candidate <exact-candidate-directory> --release-fictional-intent-with-fresh-recovery
```

The command has no target, qualifier, saved-report, approval, skip or PHI override.
It pins account `588966314750`, the synthetic API and the unchanged parent
database. The public inspection command still refuses direct `upgrade`.
The embedded database port is hash-checked against the clean source before it
loads; external service calls occur outside the preserving database transaction.

The runner reads both fresh CloudFormation projections and actual predecessor
state before one execution request. If that response is lost, it observes the
same stack and change-set, not a second execution or a new proposal. A terminal
successful stack is insufficient alone: actual Lambda code is downloaded from
the pinned AWS-managed host and compared byte-for-byte, while the full template,
physical resources, execution configuration, JWT routes, IAM and logs are checked.
The original single-resource and historical-code verifiers remain unchanged.

Recovery publishes or independently finds an exact-source compatible version
other than historical version 1. Its immutable code and executable configuration
must match the deployed candidate. The actual five fictional owners exercise 75
existing consumer/terminal-receipt requests plus 20 pre-schema preparation and
discovery refusals. The runner requires distinct Gateway identities, stable
receipt contents, retained-version invocation metrics, three observed route
deployments and verified permission removal. Source or unrelated control drift
is a refusal, never a compensating overwrite of someone else's changes.

Only then can the same custody enter the rollback rehearsal, admit a lasting
schema transaction, and independently read back the successor. An unknown
COMMIT transport outcome is inspected once; it is not retried or replaced with
an invented commit receipt. Saved observation files omit downloaded code bytes
and presigned URLs and explicitly cannot serve as admission authority.

An observation deadline is not a declaration that AWS stopped. Any unresolved
admitted write keeps the original operator lock and journal. Inspect that exact
execution and reconcile its actual resources before further writes; never remove
the lock or restart solely because a process or observation budget ended.

Local verification of this connected implementation passed **77** expanded
release/recovery tests and **42** focused database/operator tests. The full
Desktop suite passed **341 files, 4,307 tests, 11 skips** in **278.64 seconds**;
typecheck and lint passed without warnings. These are local source checks, not
hosted release or physical-device acceptance.

The release report keeps canonical registration, prepared/erased and lost-reply
journeys, second-device acceptance, full commercial readiness, PHI and paid mobile
builds false. Those require their own subsequent work and evidence. Existing
unexecuted October 7 proposals and uploaded source pairs remain historical;
they are not this new runner's deployed artifacts.

## Remaining release work

1. Run and qualify exact-version upload and an explicitly scoped deployment proposal
   against freshly re-observed state. Preserve all 51 existing identity JWT
   routes, the four absent source routes, environment, execution role and logs.
2. Deploy and read back the exact intent-aware code while the parent schema
   still applies. Preparation/discovery must stay unavailable until the schema
   exists; existing terminal receipt recovery must remain intact.
3. Retain the compatible handler and run fresh actual recovery, including
   observed Gateway responses, retained-version invocation metrics, return
   deployment and removal of temporary invocation permission.
4. Hosted-verify the implemented source-bound, in-lock preserving continuation
   with real rollback rehearsal, lasting application and independent readback,
   then deliberately register the qualified migration canonically. Keep the
   public intent CLI's direct `upgrade` refusal. A saved report or owner
   confirmation cannot replace fresh recovery.
5. Execute isolated fictional prepared/erased/cancelled, lost-reply,
   second-session discovery, concurrency, replay and cross-owner journeys.
   Cancelled receipts alone do not prove erased outcomes or native recovery.

Never restore the ID-less API, down-migrate terminal history, delete immutable
receipts, invent a consent/provider review or enable PHI to make a test pass.
Paid mobile builds remain held. All six original commercial-readiness scopes
remain partial, including owned delivery, full privacy and retained-clinic
disposition, eligible clinical releases, Core $19.99 store/provider acceptance,
matched releases and physical devices. Security, retention and executed
agreement coverage require actual review before separate PHI activation.
