# Current synthetic care registered release

The current artifact binds the registered source47/live48 synthetic history to
one clean Desktop and V2 source pair. It replaces the build format for future
care releases; it does not revive the retired parent-schema release or change
the classification of its failed run. Build and local inspection are implemented.
The fixed-target live read-only preflight, encrypted exact-version upload and
unexecuted code-change proposal are implemented. Execution, compatible recovery
and the full-fictional-acceptance runner are still engineering work.
Neither app is commercial or PHI ready. PHI remains off and paid mobile builds
remain held.

## Registered history and known predecessor

`scripts/care-canonical-migrations.mjs` checks every ordered source/reference
SQL identity and the exact unchanged terminal SQL. Its expected descriptor
does not establish a live observation. Actual read-only registration passed
under clean Desktop3904899 on October8 UTC; its receipt is
`docs/evidence/2026-10-08-care-intent-canonical-registration.json`.
Source47/live48, the historical alias,89 tables and23,985 original rows were
verified without replay or ledger rewriting. That receipt cannot authorize a
future run or replace a fresh live inspection.

The new artifact names the known intent-aware predecessor Desktop0e38c130 /
V2 1488a3bf, ZIP SHA256
`f8f995e09879eb7b45d17ffc5f18d5ecb9867f21c0a0795eacb3fd31ccaa0216`,
version `lagGFfNd0kIrsydunYd2WvicsWEX9tLC`,1,826,076 bytes. These are expected
identities, not a claim that the service was observed by the build. The target
remains account588966314750/us-east-2/clinical_core and the existing identity
API. The four known absent source routes remain absent; this artifact does not
authorize adding routes, privileges, PHI, providers or consent releases.

## Build and independent local inspection

Run from a clean committed Desktop checkout, with the paired clean V2 root:

```powershell
npm run build:synthetic-care-registered-release -- --v2-root "<V2 checkout>"
npm run inspect:synthetic-care-registered-artifact -- --v2-root "<V2 checkout>" --artifact "<directory returned by build>"
```

The build checks both lifecycle/recovery contracts, owner-erasure journal and
transport/UI hashes, and both synthetic iOS/Android build destinations. It
refuses production-verification flags, dirty sources, old parent history and
cross-app contract drift. It builds the actual Lambda source independently of
supplied artifact bytes and rechecks both source snapshots afterward. No AWS
client, credential access, SQL execution or mobile-build call exists here.

The immutable directory is
`dist/synthetic-care-registered-release/<Desktop commit>/<V2 commit>/<ZIP hash>/`.
It contains exactly `index.js`, `candidate.zip`, `release.json` and
`artifact-manifest.json`. The ZIP is deterministic with the two admitted entries.
Writes are exclusive, fsynced and reread. An identical repeat is allowed; a
different existing file is left unchanged and refused. Parent symlinks/junctions,
extra files and oversized/changing reads are refused. Operational journals and
receipts must live separately, not inside this four-file artifact directory.

Every artifact file is compared as bytes. Reformatted metadata and duplicate
JSON flags cannot be normalized into acceptance. Self-consistent checksums do
not prove source equivalence: `verifyCareRegisteredCandidate` explicitly reports
`sourceRebuilt:false`. `inspectCareRegisteredArtifact` rebuilds the actual current
clean sources, compares actual code bytes, and rechecks their snapshots; only
that local inspection reports `sourceRebuilt:true`. It still reports no live
target observation, deployment, release acceptance or device acceptance.

## Current live read only preflight

After the current clean pair is built, run:

```powershell
npm run prepare:synthetic-care-registered-release -- --v2-root "<V2 checkout>" --artifact "<directory returned by build>" --inspect-fictional-current-release-only
```

This command independently rebuilds the actual candidate, compiles a clean
current canonical database inspector, and observes AWS itself. It has no
report-loading, target, profile, approval, upload or deployment argument. It
uses the synthetic member role, not the root-resolving staging profile.

The predecessor is pinned to the exact deployed0e38c130/1488a3bf ZIP and its
stored object version. Managed Lambda, retained version2 and S3 bytes are
downloaded and compared with that immutable ZIP; presigned URLs stay in memory.
The complete current template,11 parameters, resource IDs/status, seven-variable
environment, encrypted30-day logs, scoped IAM,51 owned JWT routes within the
112-route API, authorizers, integration/stage and invocation permission are
checked directly. Unknown differences are not normalized to the older5b6f8aa
generation. The retained intent-aware version must have no invoke permission.

Two new compiled database observations must show the registered source47/live48
history,89 tables,23,985 preserved rows and zero new intents. Full and original
digests are checked separately; the historical witness remains historical.
Source, principal, controls, database and retained configuration are rechecked.
A missing page, wrong owner/environment, stale or changed observation refuses.

Inspector child failures distinguish build from inspection and retain only a
finite static error category and transport phase/reason. Arbitrary stderr,
stdout on failure, credentials, SQL and stacks are never printed. Timeouts and
output limits take precedence over partial output, stop the run and do not
trigger an automatic retry. A later successful inspection cannot turn an
earlier failed preflight into a pass.

A preflight observation still reports `deployAuthorized:false`, no AWS or SQL
mutation, no recovery rehearsal, no hosted journey acceptance and no PHI/device
approval. It does not verify a new candidate's CloudFormation execution. The
future release runner must repeat current observations in-process, qualify its
executed projections and bind a compatible recovery and all mandatory journeys;
it cannot load this printed report as authority.

The new preflight tests use fictional transports. Record a later actual command
receipt separately with its exact source pair and terminal result; a local test
or old registration receipt is not a hosted preflight pass.

## Registered artifact upload

After building the clean current source pair, run:

```powershell
npm run upload:synthetic-care-registered-release -- --v2-root "<V2 checkout>" --artifact "<directory returned by build>" --upload-fictional-registered-code-only
```

The command performs its own complete live preflight and observes source,
principal and predecessor controls again immediately before admitting a write.
It does not load printed or saved preflight reports. Freshness and source are
checked again after the potentially slow control observation. Bucket location,
versioning and exact KMS encryption are verified. The create-only upload binds
both source commits and the ZIP digest; only an exact precondition collision
can reuse an existing object. The returned object version is checked with HEAD
and a bounded actual download. Unknown outcomes are never retried as writes.

Operational receipts and fsynced admission journals are stored separately under
`dist/synthetic-care-registered-operations/<Desktop>/<V2>/<ZIP>/`, preserving the
four-file artifact. Each parent and the shared-lock directory refuse junctions.
The existing shared operator lock records the registered-upload purpose and
excludes competing operators. A write admission is durable before S3 is called.
Any uncertain write or later failed verification retains its lock and journal
for reconciliation; process termination or a saved receipt does not settle it.
Successful receipts are fsynced and read back before custody is released.

The uploader exposes no execution, database replay, target/profile override,
PHI activation or paid-build option. An uploaded candidate is not a deployment
or acceptance pass. Proposal/execution, compatible recovery and the complete
fictional matrix below remain engineering. Credential-free tests cover upload
ordering, preflight/source/principal/control drift, slow-observation expiry,
lost write replies, custody and path isolation; actual AWS receipts must be
recorded separately for the exact committed pair.

## Reconcile a stopped failed upload

A failed admitted upload retains custody even when an initial lookup finds no
object. Do not delete its lock or repeat its PUT. After the writer has stopped,
use the reconciliation command against the original immutable artifact:

```powershell
npm run reconcile:synthetic-care-registered-upload -- --v2-root "<paired V2 checkout>" --artifact "<original artifact directory>" --reconcile-fictional-registered-upload-only
```

The command requires the exact compact lock and admission journal, one admitted
PUT, a terminal failure, a missing writer process and a 60-second settlement
interval. Active or reused process IDs, unknown process state, changed custody
and unrelated source pairs refuse. A later clean operator may inspect the
original application artifact only while its mobile contracts, template and
registered migration mapping remain unchanged. This is not a rebuild or
approval of that old application.

AWS reconciliation is read-only. It verifies the complete predecessor control
plane and repeats complete version listings and HEAD observations. A stored
outcome requires one exact encrypted version and a bounded download matching
the original bytes. An absent outcome requires an exact HEAD NotFound/404 and
a complete listing with no exact versions or delete markers. Denial, pagination,
multiple versions, wrong metadata, changed controls or disagreement refuses.

An absent result says `absent_at_observation`, not that the original PUT failed,
that a remote deletion occurred or that future late completion is impossible.
The original outcome remains `unknown` in either result. Subsequent operators
still require their own current-source preflight and create-only upload; this
receipt cannot authorize a retry, proposal or deployment. No remote deletion,
schema operation, provider activation or paid-build surface exists.

After repeated observations and final custody/source checks, the exact local
lock is copied into a recoverable archive and its receipt is fsynced and reread
before removing the active lock. The original journal, artifact and remote
storage are left untouched. Failed archive/readback keeps custody. The uploader
now journals only finite command-bound transport categories and disables idle
socket reuse for requests separated by long control observations, still with
one SDK attempt and bounded requests. This does not establish the cause of an
earlier error whose category was not recorded.

## Remaining live runner engineering

### Prepare an unexecuted current history proposal

From the clean committed source pair, build a new registered candidate and run:

```powershell
npm run prepare:synthetic-care-registered-code-change -- --v2-root "<V2 checkout>" --artifact "<new candidate directory>" --prepare-fictional-registered-code-change-only
```

This command performs its own upload and a new complete live preflight under
one durable custody lock. It cannot load an old upload or preflight report as
authority. The template changes the existing Lambda's exact immutable code key
and object version. All other parameters use their previous values, the four
known absent routes remain absent, and the registered database is inspected,
not replayed. The command has no stack-execution or mobile-build option.

Both raw CloudFormation views are qualified. The summary must identify exactly
the Lambda Code modification and its Gateway integration ARN dependency. The
property-value view must explain exactly the code key and object-version changes
against the complete actual predecessor configuration. Duplicate JSON fields,
unknown resources, pagination, new permissions, non-code properties and changed
controls refuse. Classifying the integration dependency does not prove it is a
no-op; post-execution readback and compatible traffic recovery are still needed.
See [AWS DescribeChangeSet](https://docs.aws.amazon.com/AWSCloudFormation/latest/APIReference/API_DescribeChangeSet.html)
for the two projection modes and execution statuses.

A complete listing is observed before creation. An exact existing proposal is
verified without another create. A new creation is journaled before its request,
uses a fixed source/version-bound token and one CLI attempt, and is never replayed
after an uncertain response. Source, assumed identity, controls and freshness
are checked before creation and after observation. Proposal input and report
files are exclusive, fsynced and read back outside the immutable artifact.

Successful proposal custody settles only after both views and final readback.
Any admitted upload or proposal with an unknown outcome retains custody. The
upload-only reconciliation command intentionally refuses the combined proposal
purpose: do not delete that lock, retry creation or substitute a saved report.
A separate read-only combined-proposal reconciliation operator is described
below. Registered execution and compatible recovery are still required.
An unexecuted proposal reports `executionAdmissible:false`, not release approval.

The fourteen proposal tests use fictional transports, including lost create
responses, both projection inventories, post-create drift, stale preparation,
idempotent existing-proposal inspection and false-positive context parsing.
Tests alone imply no actual CloudFormation proposal or execution.

### October 8 actual proposal finding and source repair

Actual Desktop4a29/V2 38ea run `57f235c2062e501cf676997ea36942cc` uploaded
the exact encrypted1,827,487-byte artifact `e5d8b5a42b9d38e4150e1d09c4dd61cd43e3e54275096d447a2cdfc531145068`
at version `Rnf4tZvXuCB_vNbrz_NcM3jiKURx252d`. It created the unexecuted
`care-registered-e5580f11742e2c0096ed873858f7d0b5` proposal, then exited1
at05:46:34.982Z with `proposal_property_delta`. The failure is preserved.
Its combined-operation custody remains held; the upload-only reconciler cannot
retire it. Do not delete the lock, retry creation or execute the proposal.

A later read-only AWS observation showed three detail records: dynamic direct
evaluation of S3Key, static direct S3ObjectVersion, and static LambdaCodeKey
parameter evaluation of the same S3Key. The former two-detail-only verifier
incorrectly refused that shape. A regression failed before the source repair.
It now compares the entire unordered detail inventory with this exact triple
(or the two previously supported fully evaluated shapes). Full before/after
contexts still permit only key/version changes; arbitrary duplicate paths,
extra fields, wrong values and non-code changes remain refused. Six orderings
and eleven invalid mutations are tested. This source repair does not qualify
the historical live run or settle its custody, and no execution occurred.

### Reconcile a stopped combined proposal

The new operator supports a completed exact upload followed by a failed,
observed, unexecuted proposal. It does not generalize an unknown upload or
unobserved creation into a pass; those unsupported shapes retain custody.
Use a clean checkout of the candidate's exact frozen Desktop commit as the
application root, separately from the current clean operator checkout:

```powershell
npm run reconcile:synthetic-care-registered-proposal -- --v2-root "<matched V2 checkout>" --artifact "<frozen candidate directory>" --application-root "<clean frozen Desktop checkout>" --reconcile-fictional-registered-proposal-only
```

The command independently rebuilds that application, compares its exact source
pair and candidate bytes, inspects the live canonical database twice with the
current compiled operator, and observes the complete current predecessor
controls, exact S3 version and both CloudFormation projections repeatedly.
It requires the original writer to be stopped, a settled bounded journal, a
matching assumed principal and unchanged sources, storage, proposal and data.
It accepts no saved report, target/profile override, skip, upload, execution,
schema or paid-build option. It preserves the original failed outcome.

Only after a durable receipt and recoverable archive are read back does it
retire that exact local lock under the shared reconciliation guard. The original
journal, artifact, remote object and unexecuted proposal remain untouched.
The receipt is not execution authority. A fresh matched candidate, deployment
qualification, compatible traffic recovery and all hosted journeys are still
required. Eight credential-free tests cover boundaries, late drift, both raw
views, database preservation and failed archival; they are not a hosted result.

The independent frozen-source rebuild also exposed a directory-dependent
bundle: esbuild used the operator's launch directory when writing source-path
comments. A separate regression failed before setting `absWorkingDir` to the
application root. Launching from either the frozen checkout or the operator
checkout now yields identical bytes. An actual local rebuild of Desktop4a29/
V2 38ea matched the already-uploaded e5d8 artifact exactly. This is local source
evidence, not AWS deployment or device acceptance.

The actual fresh combined-operation reconciliation completed at
`2026-10-08T06:16:13.320Z`, using clean6db operator source and independently
rebuilt frozen4a29/38ea application source. Repeated exact storage/proposal and
predecessor observations, plus two unchanged canonical inventory inspections,
passed. The original57f235 operation remains failed. Its exact journal is
unchanged; the local lock was retired only after a recoverable lock archive
and fsynced reconciliation receipt were read back. The remote artifact and
unexecuted proposal were not changed. Both active local locks were checked
absent. The first reconciliation attempt failed before settlement with an
unknown Begin diagnostic; neither later success rewrites that failure.
This historical reconciliation receipt does not authorize execution of the
old proposal or a current candidate. Fresh current-source observations remain
mandatory. The running API and installed mobile71 remain unchanged.

The next operator must use its own observations, never supplied report flags:

1. Independently rebuild the frozen candidate and qualify its exact application
   source pair separately from any later operator source. Observe the current
   synthetic assumed role, foundation, full registered ledger and preserved
   inventory afresh. Refuse root/long-lived credentials and unrelated targets.
2. Download and verify the actual predecessor ZIP/object version and actual
   managed Lambda bytes. Verify full CloudFormation parameters/resources and
   execution, IAM, encrypted logs, environment,51 JWT routes, authorizers,
   integration, stage and invoke policies. Refuse drift or partial inventories.
3. Admit one narrow immutable upload/change execution under durable exclusive
   custody. Bind exact current code and object version; preserve authority and
   route scope. Unknown responses are observed, never blindly retried. The
   already-registered schema is inspected, not replayed or down-migrated.
4. Rehearse compatible traffic recovery with actual Gateway requests and actual
   metrics, returning to the exact intended handler and removing temporary
   permissions. The ID-less/parent-only API is never a recovery substitute.
5. Run all declared fictional journeys: prepared/erased and prepared/cancelled,
   lost preparation and terminal replies, second-session discovery, both
   cancellation/erasure race orders, replay, cross-owner refusal and withdrawal
   refusal. Restrict mutations to approved fictional owners/fixtures and verify
   unrelated data preservation. A refusal, skipped step, mocked response or
   saved report cannot be a positive acceptance pass.

The old release, resumer, archived locks and historical inspection receipts
cannot authorize these new operations. Record unknown outcomes and retain
custody until independently reconciled; do not recreate retired locks.

## Verification and whole goal

### Registered execution and post-execution readback source

`care-registered-deployment.mjs` now provides the current-history execution
and readback primitives. They are not a public deployment command: no AWS
transport, saved-report loader, profile/target override, standalone schema
operation or activation port is present. A fixed live runner and compatible
traffic-recovery orchestration remain required before deployment.

Execution requires the independent source/predecessor preflight, two complete
fresh predecessor/database/proposal observations, repeated exact stored-version
readback, stable source/principal and durable custody. The journal admission must
finish before the one execute call. A lost response is followed by observations
of the same stack and change set, never another execute call or replacement
proposal. An exhausted observation budget is unconfirmed, not a terminal AWS
failure, and cannot retire admitted custody.

Post-execution verification keeps `EXECUTE_COMPLETE` separate from `AVAILABLE`.
It exhausts both raw projections and actual controls, compares the exact
downloaded candidate ZIP, immutable code pointer, stack parameters and physical
resource identities, and permits no IAM, JWT-route, logging, environment or
stage-configuration expansion. Function metadata may change only code checksum,
size, revision and its valid modification timestamp. Both canonical database
inspections must preserve the recorded inventory and source-bound ledger.
The predecessor and successor use distinct expected-code profiles against the
same raw inventory; successor responses are never rewritten to pass an old-code
check. Neither an executed proposal nor a deployment proof substitutes for
compatible recovery, patient journeys, a matched mobile release or PHI review.

The credential-free suite covers successful and lost-reply execution, failed
admission, unknown target, source/principal/custody drift, stale preflight,
changed exact storage, all incomplete/failing execution states, hidden control
mutations and exact-byte/database refusals. These are fictional transports,
not AWS execution or hosted acceptance. The initial positive stage fixture used
an invalid hyphenated deployment id and was corrected to the existing AWS-shaped
id constraint; no production check was relaxed.

CloudFormation's separate execution-state vocabulary and property-value
projection are documented in [DescribeChangeSet](https://docs.aws.amazon.com/AWSCloudFormation/latest/APIReference/API_DescribeChangeSet.html).
The one execute call binds its client request token and target as documented in
[ExecuteChangeSet](https://docs.aws.amazon.com/AWSCloudFormation/latest/APIReference/API_ExecuteChangeSet.html).

The artifact/mapping suite passes18 tests, including actual clean paired-source
fixture builds and an invented bundle that fails independent rebuilding. The
current care-script suites pass322 tests, including the new execution and
post-execution verification suite. Focused related suites pass44/44. Final
typecheck/lint and CI/package syntax checks pass. No full local Desktop
database suite was rerun for this increment. The earlier full Desktop
run passes4,314 tests/11 skips; it predates this artifact increment and is not
its full-suite or hosted CI evidence. New CI runs the artifact suite explicitly.
No artifact-level test is an AWS or physical-device acceptance result.

The original six scopes remain partial: plan continuity/legacy reconciliation;
owned lab/document/voice delivery; complete privacy/holds/export/erasure and
retained-clinic amendments; eligible source-verified clinical/catalog/knowledge
releases; Core19.99 store/provider acceptance; matched API/Desktop/mobile and
physical iOS/Android/five-persona, rollback/load/security/recovery verification.
Clinical holds and exclusions remain. Reviewed policies, actual provider
agreement/runtime coverage and separate PHI activation are still required.
