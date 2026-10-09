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

`care-registered-deployment.mjs` provides the current-history execution and
readback primitives. The fixed live composition is now
`release-synthetic-care-registered.mjs`; it binds actual AWS, source, bytes,
proposal and compiled inspection observers, rather than loading an approval
report. The underlying primitive still has no transport, profile/target
override, standalone schema operation or activation port. This new live
composition has not yet run against AWS.

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

Slow observation cycles renew through the real preflight observer before the
last fresh full observation. No saved report timestamp is updated. The first
observation is validated when read; the last one and renewed preflight must
still be fresh at admission, with the same exhaustive inventories.

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
current care-script suites pass336 tests, including execution, current-schema
routing and live-composition boundary suites. The newest focused suites pass24/24. Final
typecheck/lint and CI/package syntax checks pass. No full local Desktop
database suite was rerun for this increment. The earlier full Desktop
run passes4,314 tests/11 skips; it predates this artifact increment and is not
its full-suite or hosted CI evidence. New CI runs the artifact suite explicitly.
No artifact-level test is an AWS or physical-device acceptance result.

### Fixed live code update and current schema recovery

After clean source, independent rebuild, tests and CI are verified, the fixed
synthetic command is:

```
node scripts/release-synthetic-care-registered.mjs --v2-root <exact-V2-checkout> --artifact <exact-current-candidate-directory> --release-fictional-registered-with-fresh-recovery
```

The interrupted-release read-only observer and the separate compensating
restoration operator below are implemented. Source and local tests establish
their distinct boundaries; actual AWS qualification remains required. Read-only
inspection deliberately cannot repair routing or permission state. The first
synthetic release is a qualification attempt, not production promotion.

Its own upload and proposal bind the new clean source pair. The encrypted
immutable object is downloaded, both complete proposal views inspected, and
two complete before observations archived. The exact final observation and
execution admission are durably saved before the one execution request. A lost
reply is observed on the same stack and change set, never retried. Complete
successor bytes, configuration, IAM, JWT routes, logs, resources, integration
and canonical data/schema history are checked after execution.

Recovery uses the actual older intent-aware version **2**, pinned to the known
0e38c130 predecessor ZIP and full configuration; it does not publish a clone of
the new code or invoke the id-less historical version1. Only the API integration
temporarily targets version2. The latest function's new bytes remain untouched.
The same full raw inventory is verified against an explicit retained-URI profile;
responses are not patched to pass a latest-URI check. Five fictional personas
run35 cases each on latest, retained2 and returned latest: four ordinary owner
reads/refusals, existing cancelled receipts, current-schema discovery of those
exact receipts and refusal of prepare without a request ID. The105 cases and
qualified Lambda invocation metric are mandatory. Discovery is parsed by a
fresh compilation of the actual application contract.

Admission is flushed before permission grant, each routing switch and cleanup.
A distinct compensating return is allowed only if independently observed
authority remains unchanged and the target is one of the two admitted URIs.
An unrelated route or authority change is not overwritten. Final reads must
show the returned API deployment, no temporary permission, unchanged retained
bytes and unchanged database. Secrets and tokens remain in memory and are not
written to evidence; only fictional account records are used.

One `registered-artifact-upload-release` custody spans all operations. Before
and admission files, journal and receipts are separate from the immutable
artifact. A failed or exhausted admitted operation retains its lock. The old
upload-only and stopped-unexecuted-proposal reconcilers intentionally cannot
settle this larger journal. The dedicated interrupted-release reconciler is
described below; do not remove or recreate the lock or rerun a write after an
unknown outcome. Neither live command is yet hosted-qualified.
Its terminal result distinguishes the upload receipt from code/recovery
evidence; neither is full erasure acceptance, release acceptance or PHI approval.

The database checks are inspection only. No migrations, down migrations,
ledger rewrites, erasure fixture writes, provider activation or paid mobile
builds are available through this command. The prepared/erased, cancellation
race, lost-reply, second-device, replay, cross-owner and consent-withdrawal
journeys remain a separate required hosted matrix.

The original six scopes remain partial: plan continuity/legacy reconciliation;
owned lab/document/voice delivery; complete privacy/holds/export/erasure and
retained-clinic amendments; eligible source-verified clinical/catalog/knowledge
releases; Core19.99 store/provider acceptance; matched API/Desktop/mobile and
physical iOS/Android/five-persona, rollback/load/security/recovery verification.
Clinical holds and exclusions remain. Reviewed policies, actual provider
agreement/runtime coverage and separate PHI activation are still required.

### Interrupted release inspection

The fixed read-only command is:

```
node scripts/reconcile-synthetic-care-registered-release.mjs --v2-root <exact-V2-checkout> --artifact <interrupted-run-artifact> --application-root <clean-frozen-application-checkout> --reconcile-fictional-registered-execution-only
```

The clean current operator and the clean frozen application are separately
bound to the same V2 source, template and migration release. The original
writer must be stopped; its exact lock and journal must remain unchanged.
The observer accepts only a complete, ordered journal prefix, including every
known admission. Unknown stages, fields, duplicate keys or truncated records
retain custody. A hard crash need not have produced a terminal finding.

Before execution, it repeatedly downloads the old managed code and retained
version2, checks the full old authority and canonical database, and observes
the exact candidate object. An ambiguous PUT stays `unknown` even if the object
is now exact or absent. Absence is not a deletion certificate. An admitted
change-set creation with a lost reply must be located as the exact complete,
AVAILABLE proposal. Missing, unfinished, executed or foreign proposals refuse.

After execution admission, the two archived complete before observations and
the admission file must retain their byte digests and content-addressed names.
They establish the historical input, not current service state. The observer
checks two fresh complete CloudFormation projections, exact candidate downloads,
configuration, IAM, routes, resources, API deployment status, retained version2
bytes and unchanged canonical database. The current database inspection names
the current operator; it is never rewritten to impersonate the frozen writer.

Only a complete current successor with latest routing and no version2 policy
can settle an admitted execution. In-progress execution, qualified routing,
remaining permission, missing object, incomplete inventory or any source,
principal, process, journal, admission or authority drift retains the lock.
The observer contains no execution, routing, permission, SQL, provider or build
write. Exact local custody is archived and a durable reconciliation receipt is
read back before only the local operator lock is removed. Original failed or
interrupted results are not converted into successful release results.

`deployed:true` describes the independently observed successor only. Recovery,
erasure, hosted acceptance, release acceptance, physical acceptance and PHI
remain false. A failed routing rehearsal requires a separately admitted fresh
rehearsal even when routing is now safe. A dead writer leaving qualified routing
or a temporary permission requires the distinct, bound compensating-restoration
operator below. Never remove the lock, invoke the old
proposal-only reconciler or rerun the release to work around this refusal.

Local verification uses fictional ports and filesystem fixtures, not AWS
qualification. The original six scopes remain incomplete. Paid mobile builds
remain held and all clinical exclusions and source-verification gates remain.

### Compensating restoration after a stopped writer

Use the original artifact and clean frozen application checkout. The current
operator must be clean and must retain the same mobile source, migration release
and template. This command runs on the Windows operator host:

```
node scripts/restore-synthetic-care-registered-routing.mjs --v2-root <exact-V2-checkout> --artifact <interrupted-run-artifact> --application-root <clean-frozen-application-checkout> --restore-fictional-registered-routing-only
```

The original release must have admitted the exact version2 permission and its
successor byte/revision readback. Both original writer and any earlier restoration
writer must be stopped. Two actual observations verify the executed proposal,
latest candidate bytes, retained predecessor bytes, full IAM/JWT/control inventory,
exact stored version and unchanged canonical database. Retained routing is checked
under its explicit profile; raw responses are not rewritten to look like LATEST.
A foreign route, permission, revision, incomplete execution or changed source
refuses before a write.

Only two AWS mutations are available: returning the known identity integration
to LATEST, and removing the exact admitted version2 statement using its observed
permission revision. Each admission is appended and flushed to the original
journal before its request. The original failed prefix remains byte-for-byte
unchanged. A lost response leads to observation, never a second request. On a
subsequent invocation, an existing return or removal admission is reconciled from
the actual service, not replayed. An unconfirmed mutation keeps the original lock.

A Windows kernel mutex excludes concurrent restoration operators and relinquishes
ownership after process loss. A dead read-only inspection guard can be archived
after its process and settlement are checked; the admitted release lock is never
removed by this helper. Local Windows tests exercise mutex contention, actual
parent-process termination and stale inspection-guard archival. They are not AWS
or mobile acceptance.

Two final complete observations must show LATEST with a successful API deployment,
no version2 policy, identical candidate and predecessor bytes, and unchanged data.
The restoration receipt and original lock archive are flushed and read back before
only that local release lock is retired. The original failure remains a failure;
the receipt certifies current restoration, not functional recovery, erasure,
release, device or PHI acceptance. A fresh independently admitted functional
rehearsal after a failed release is still required. The standalone operator below
implements that separate admission; do not re-execute an already executed proposal
to obtain a rehearsal.

The complete compensating path still needs actual AWS qualification. No provider
activation, schema replay, patient-data write, paid build or PHI switch is available
through this operator. All six original commercial-readiness scopes remain partial.

### Fresh standalone rehearsal and stopped recovery

`care-registered-standalone.mjs` and `care-registered-standalone-custody.mjs`
implement the separate orchestration and journal required for a fresh rehearsal
after the original release failed. The fixed live constructor is
`rehearse-synthetic-care-registered-standalone.mjs`. The
credential-free test command is `npm run test:synthetic-care-registered-standalone`.
Its fictional transports are not hosted evidence.

A fresh run has its own ID, writer and purpose; it pins the original failed
lock and journal byte digests and preserves that original result. It refuses an
existing standalone journal instead of resuming a mutating test. Clean current
operator and frozen application sources are independent and must agree on
mobile source, migration release and template. Original archived admissions,
source rebuild, stored version, latest and retained bytes, deployed API stage,
full control and canonical data are independently checked. Two pre-test reads
and their flushed archive precede the fresh rehearsal admission. Every later
admission is flushed and parsed before its associated write. Original and new
evidence files remain guarded throughout the run.

The returned functional report is not accepted from its pass flags. The core
revalidates all 105 cases, distinct per-persona request IDs, real compiled intent
contract answers, stable cancelled receipts, all three phases, qualified-version
metric, source and database bindings. Two final actual-observer reads must
preserve code, authority, projections, stored bytes and data and show LATEST with
no retained-version permission. A durable completion archive is separate from
the original failure. Local tests use fictional observers; actual AWS qualification
remains required. There is no code/schema write, proposal execution,
erasure, provider activation, release or PHI grant in this core.

The stopped-run parser accepts each exact hard-crash prefix and binds its new
permission SID to the new run ID. Unknown/reordered fields, incomplete archives,
false failure attribution and premature completion refuse. A stopped run is
not automatically rerun, unlocked or certified by this parser.

The public constructor acquires the Windows restoration mutex and inspection
guard. It seeds and flushes a parseable admission-free journal before exclusively
creating its own shared operator lock. The creation verifier remains live and
checks the exact lock/journal bytes and file identities. Durable archive and
receipt readback precede retirement of only that own local lock. Every directory,
evidence basename, digest and size is bounded; an existing operator lock is held.
The fixed recovery transport uses the frozen application's contract parser and
the independently clean current operator's database inspector. Reports name both
sources. The SDK profile, account, region, predecessor and routes are fixed;
single-attempt writes, credentials kept in memory and client destruction remain.

```sh
npm run rehearse:synthetic-care-registered-standalone -- --v2-root "<exact frozen V2>" --artifact "<original interrupted artifact>" --application-root "<clean frozen Desktop>" --original-run "<original 32-character run ID>" --rehearse-fictional-registered-only
```

The original archive must be unique, exact, independently verified and incomplete.
Its source pair is not replaced by the current application pair. This command
performs a separately admitted synthetic routing test, not a source deployment.
It has no target/profile/report/PHI/build override.

For an interrupted standalone writer, use the same arguments with
`--restore-stopped-fictional-standalone-only` instead. Both original and standalone
writers, and any prior compensation writer, must be stopped and settled. This
mode constructs observations itself and can only return the admitted route to
LATEST and remove the exact own SID at its observed revision. Lost replies admit
observation, never replay. Pre-grant interruption can settle without an AWS write.
Completed custody gets read-only observations and refuses route/permission drift
before recording a repair admission; it does not requalify the previous test.
Original release and standalone prefixes/outcomes are preserved independently.

`test:synthetic-care-registered-standalone-live` covers the actual local filesystem
constructor, seed, exclusive lock, evidence and receipt retirement plus source
attribution and negative CLI boundaries. `test:synthetic-care-registered-standalone-restoration`
covers failed/interrupted/completed journals, changed authorities, lost replies,
late completion, independent compensator attribution and original evidence drift.
These tests do not contact AWS. New source construction is implemented and locally
verified, not hosted qualified. The staged07ca object and the running older API
are unchanged. All six original readiness scopes remain open, PHI OFF and paid
mobile builds HELD.

Local recheck for this constructor increment: all407 care-script tests pass,
including22 new filesystem/live-boundary and stopped-standalone tests, with no
failures or skips (65.638 seconds). Typecheck, focused lint with zero warnings,
package/workflow parsing and diff checks pass. The first workflow-parse check
used an unavailable `yaml` module; the rerun with installed `js-yaml` passed.
No full Desktop database-suite rerun, AWS mutation or paid mobile build occurred
in this source verification. CI for the prior a3e0c62 source completed successfully
in runs37805926406 and37805917604; that is not CI evidence for this new increment.

### October 8 actual freshness failure and guarded renewal

The d3a0f05/38ea48c source pair passed Desktop CI37813544467 and37813553611.
Its exact ZIP0c422a0ffe160082a64dff2300e06e5c10f67c63680c0dd6a317e0298da19d10
was uploaded and independently checked. Fresh combined run
435bf370a054c342c2ffe8952fce8504 nevertheless failed at17:28:15.057Z with
upload_preflight after creating and observing an unexecuted proposal. The
proposal care-registered-3b2a5ec168ac212b5bf318aa3bacfbab was independently
observed CREATE_COMPLETE/AVAILABLE; Lambda remained predecessor revision
f0bb13e8-e726-4ea8-86d3-459e19106df0. No execute admission, code update,
recovery switch or schema/fixture/mobile/PHI mutation occurred. That failed
result and its custody must not be changed into a pass.

Repeated control observations consumed the same120-second preparation window.
Two new positive regression tests fail against the old source. The repaired
proposal constructor may renew elapsed observations only through its own full
read-only current preflight. It rechecks principal/source, exact original
control binding and both fresh canonical database observations. The120-second
limit is unchanged, a slow control read still refuses, and stale/future/partial
or changed renewal never authorizes creation. Initial stale input still refuses;
no caller-supplied report, timestamp rewrite or create retry is introduced.
Renewal is bounded; its timestamp/hash/count are recorded in the proposal report.
Both the proposal-only and combined-release constructors pass their actual
paired source/artifact paths to that observer.

Two stopped-release read-only observations returned aws_unconfirmed and did not
retire custody. New diagnostics report only a finite command phase/reason;
provider stderr, credentials, URLs and stacks are never output. A later read-only
observation still requires independently clean frozen application/current
operator sources and exact unchanged archives. It cannot execute the proposal,
retry a write or certify functional recovery. Source tests are not a hosted
renewal or reconciliation result. Full nine mutating erasure journeys, all six
scopes, store/provider/device acceptance and policy/PHI reviews remain open.

Local evidence for this repair: the broad412 care-script tests pass,0 failures
or skips (69.253 seconds); final focused38 tests pass after refining diagnostic
reason priority,0 failures/skips (8.531 seconds). Typecheck and focused lint
with0 warnings pass. Two renewal positives failed before the source fix. No
full Desktop database-suite rerun. This is source evidence, not successful
hosted renewal, reconciliation, deployment or erasure acceptance; new CI must
be observed separately. V2 source and all PHI/build/clinical holds are unchanged.

### October 8 frozen dependency layout and exact AWS absence header

The frozen d3a0f05 checkout's dependency junction changed esbuild's embedded
module paths, including paths used by generated initialization code. Its bundle
was 1,855,147 bytes instead of 1,822,566. Replacing only that ignored junction
with a normal copy of the same installed dependencies reproduced the original
bundle byte for byte, SHA95f86da0180533f1007da4e258ac3a1b9bd03608cacfbcc7827230b27d88579b.
The target dependencies, tracked frozen source and byte verifier were unchanged.

The subsequent read-only reconciliation stopped with
release_reconciliation_aws_retained_policy_unknown_unconfirmed. An independent
exact version2 GetPolicy read identified the format difference: AWS_MAX_ATTEMPTS=1
adds `(reached max retries: 0)` before the response header's colon. The old parser
refused even the expected ResourceNotFoundException. The repaired parser accepts
only that exact optional annotation for the exact qualified GetPolicy absence,
still excluding version1, changed function/operation, denied or transport errors,
other retry counts and oversized/non-string error content. Diagnostics recognize
the same annotation on denied reads but never classify those as absence.

The new absence regression and denied-diagnostic case both fail before and pass
after the repair. Focused25 tests pass,0 failures/skips. This establishes parsing,
not stopped-run settlement: the original failure, journal, unexecuted proposal
and shared lock remain intact until a new complete read-only observation passes.
No deployment, schema, provider, fixture, paid build or PHI activation occurred.

Broad verification after this fix:413 care-script tests pass,0 failures/skips
(51.271 seconds), typecheck and focused lint0 warnings pass. The exact
single-attempt AWS read now classifies the actual version2 response as qualified
policy absence. The complete stopped-run observer must still rerun from a clean
committed operator; this one read does not replace either full observation.

### Report publication freshness

The exact cbb8fce/38ea48c synthetic run252f634aad58c2f2a443589dd26b6834
stopped at18:25:27.669Z with proposal_preflight_renewal_required. Its verified
artifact upload and new unexecuted proposal remain historical evidence; no
execution admission or code deployment occurred. The saved proposal report
used a preflight almost120 seconds old. Durable readback and the final principal
check crossed that deadline, correctly preventing a completed proposal result.

Before publishing, the constructor now obtains a fresh complete read-only
preflight when time has elapsed, binds its original controls, both canonical
database observations, source and principal, and rechecks the exact proposal
 projections. Both proposal views and the template are re-read after this
 potentially slow observation, so an intervening execution or missing proposal
 cannot be reported from cached views. A separate negative test reproduces that
 stale-projection defect before the repair. The saved report names the new
 qualifying observation. The final
guard still forbids renewal after saving, and the120-second limit remains.
Slow saves, slow control reads, stale/future/partial observations, changed
controls, changed identity and unknown replies still refuse. No create or
execute retry is introduced. The new publication regression fails against the
old implementation and passes after the repair; the negative refresh matrix
passes too. Actual stopped-run custody settlement and a fresh source-bound
release remain separate hosted work. PHI and paid mobile builds remain off.
