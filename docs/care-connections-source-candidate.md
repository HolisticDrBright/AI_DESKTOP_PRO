# Production care connection and consent candidate

This unreleased candidate implements the database and API contract for linking
a consumer account to a clinic chart and reviewing, granting and withdrawing
sharing consent. The source libraries are locally testable and non-deployable;
the separate AWS builder now emits a default-blocked Lambda candidate and
template. Neither is a hosted release. The API does not register consent copy,
approve policies, create identities or enable PHI.

## Contract and safeguards

The proposed consumer POST route `/clinical-core/consumer/connection` accepts
claim, connection, consent, grant and withdraw actions. The separate workforce
POST route `/clinical-core/workforce/connection` accepts issuance only. Both
use independently verified gateway identities, exact clinic binding and database
identity checks. Claims and grants require a recent sign-in. Workforce issuance
also requires the workforce identity and clinical clinic membership.

Issuance creates a 13-symbol, 65-bit random code using an unambiguous alphabet.
Only its SHA-256 is stored; the plaintext is returned once. A new issuance
supersedes pending codes, expires after 24 hours and cannot replace a verified
or paused link. Claiming locks the active chart, connection and owner in order,
rejects expiry, replay and foreign ownership, and records the binding once.
There is no plaintext code lookup or automatic mutation retry.

The candidate stores immutable approved text in `care_consent_texts`, separate
from existing approval metadata. Actual UTF-8 bytes must match the artifact's
SHA-256. The approving person must be an active production-bound workforce
member of that clinic. The API role cannot write approvals or text directly.
A newer approved artifact without registered text never falls back to an older
copy. Metadata-only approval is not permission to show invented wording.

A grant acknowledges the exact current artifact and displayed hash, with an
expected consent version. Stale requests cannot restore consent after a newer
withdrawal or withdraw a newer regrant. Exact repetition returns an already-
applied result without another row. New grants refuse paused/revoked links,
archived charts and account-deletion fences; status and withdrawal remain
available. Only self authority through the patient app is accepted. Guardian
and representative access are not introduced.

The review's `status` is **recorded consent history**, not a universal assertion
that sharing is currently permitted. Connection state, enabled launch scope,
artifact availability and each downstream operation's own consent gate still
apply. Withdrawal does not claim recall of delivered information or deletion
of the original clinic record. The 14 schema scopes do not approve those
features for a live launch.

## Release mapping

`npm run build:care-connections-source` emits API, service, database-binding and preserving-upgrade libraries, the exact
SQL and a byte/function-digest manifest. It never contacts AWS or applies SQL.
The manifest declares `status: unreleased`, `deployable: false`, PHI disabled,
source commit and dirty state. A dirty build is not a release candidate.

The historical **104-migration** prefix remains unchanged, with ledger hash
`57fdf022f0fdd7d70be12384d6e6d54caab1a0ddb4965a884e4d59eec4c552b0`.
Canonical source now includes the exact reviewed candidate bytes as ordered
version `20261006020000`, the 105th migration. The assembly hash is
`98f5b2db8dd2d62b4b00127beafd222585175b499c025fc1b9f0e31394d018b7`.
The complete database ledger hash is:
`7da8e4ed999a3298bccc4ef33e7a1005201db45fa2b46682622a208486f17743`.
The table inventory contains 207 covered tables, including the immutable
consent-copy table scoped by organization and dependent on its consent artifact.
Inventory coverage does **not** authorize deletion: the immutable trigger keeps
disposition blocked until a separate clinic retention procedure is reviewed.
Current installers verify 128 application tables, 85 selected contracts and zero
seed rows. Current messaging builders, whole-ledger observers and consent
registrars require 105; they deliberately refuse a still-104 hosted target.
The historical 103-to-104 upgrade library retains its original hashes and checks,
and its CLI selects that exact immutable prefix rather than rewriting history.
Old deployed artifacts and target manifests have not been promoted.

The source manifest records `canonical: true`, `hostedVerified: false` and
`cliOperatorAvailable: true`. The original candidate file is retained as a
reviewed byte-for-byte reference; the builder refuses a difference. The API
remains unreleased. Its source-library artifact is non-deployable; the separate
default-blocked Lambda/template below does not provide V2 consent integration
or establish hosted acceptance.

The preserving-upgrade library pins the complete predecessor and proposed
successor, account, Ohio region, qualification database and PHI-off posture.
It locks the ledger and table writers, checks inventory and forced RLS,
compares database-side row digests, refuses seeded copy rows and verifies all
seven added/replaced functions and four safety triggers. Function checks cover
actual body, argument/return types, language, volatility, empty search path,
security-definer and PUBLIC/API execution privileges. A rehearsal rolls the
transaction back and separately reads the predecessor again. Upgrade replay
can preserve a copy table populated later with approved fictional test text.
Each table is bounded at 5,000 rows; larger qualification fixtures refuse,
not truncate. It is not a production upgrade path.

### Qualification operator

`npm run build:aws-production-clinical-core` and
`npm run build:aws-care-connections-upgrade` build the ordered SQL and the
operator at `dist/aws-clinical-core/care-connections-schema-upgrade/index.cjs`.
Run from this repository root. Its commands are:

- `node dist/aws-clinical-core/care-connections-schema-upgrade/index.cjs inspect`
- `node dist/aws-clinical-core/care-connections-schema-upgrade/index.cjs rehearse --confirm-fictional-care-connections-upgrade`
- `node dist/aws-clinical-core/care-connections-schema-upgrade/index.cjs upgrade --confirm-fictional-care-connections-upgrade`

The write commands refuse a dirty source build. The operator uses only the
`ai-synthetic-member` profile in Ohio, directly observes STS and the completed
`ai-clinical-core-qualification-foundation`, and refuses root, production
accounts, staging, active PHI or a changed artifact. CLI and SDK share that
fixed profile. There are no target/profile/environment overrides. An upgrade
always runs and verifies a physical rollback rehearsal before its apply; a
failed rehearsal stops it. Rebuild after committing code, inspect the source
and actual target, then run only against fictional qualification.

An actual read-only run during development observed 104 migrations, 206 tables
and 46 rows with digest
`67648874524c0c8c5bc2d11774e19855f7be88e1ab11f236c128534092691345`.
It was explicitly a dirty-source inspection, not migration or acceptance.
Hosted rehearsal/apply evidence must be recorded separately.

### Hosted qualification upgrade, October 6, 2026

Exact clean pushed source `42888f2f2ffa863a6eb60cdb62b4263718871174`
built operator SHA-256
`c3d7ae2ab24ff8853c93b30d696c0dce6d9c187d058d58be44ebdaacb47037de`.
The fixed member-role operator physically observed account `588966314750`,
Ohio, and the completed qualification foundation with PHI disabled.

The separate rehearsal applied and verified the new contract inside its
transaction, rolled back, then independently observed the original **104
migrations, 206 tables and 46 rows**, with unchanged row-inventory digest
`67648874524c0c8c5bc2d11774e19855f7be88e1ab11f236c128534092691345`.
The upgrade repeated that mandatory rehearsal, then committed **105 migrations
and 207 tables** with `applied:true`, `dataPreserved:true` and that same
predecessor-row digest. The new consent-copy table was verified empty.

A separate post-commit inspection verified the complete 105 ledger and
contract. Upgrade replay repeated rehearsal and returned `alreadyApplied:true`,
`applied:false`. Both observed 46 rows and full post-upgrade inventory digest
`129abce49aec8e4f3f8e73f6c10c18e94827d0ae0108e176419aede5d36280bc`.
This digest includes the additional empty table and therefore differs from the
predecessor-only preservation digest. No row-content data was logged.

This is real hosted **schema upgrade/rollback/replay** evidence only. There is
still no serving connection candidate, consent-copy registration, patient
grant, hosted claim/message race or physical-device acceptance. No identity,
review or consent was created; PHI remains off. The generic source builder
does not read AWS, so its `hostedVerified:false` remains an honest property of
that generated source-only artifact, not a denial of this separate receipt.
Earlier 104 candidate manifests/reports are historical and must be deliberately
rebound/rebuilt; do not edit them into apparent current-release evidence.

## Verification

The dedicated database suite applies the real 105 canonical SQL files
under PGlite, then calls the real service through `clinical_core_api`. It covers
issuance parity with Desktop, single-use claiming, supersession, expiry, wrong
owner/clinic/pool, approval text immutability and byte integrity, stale artifact,
consent replay/withdrawal/regrant, deletion fencing, archived charts and direct
SQL/schema/privilege refusals. A self grant admits a message through the real
canonical messaging gate, and withdrawal refuses a new send.

API and contract tests cover disabled activation, separate pools, designated
qualification identities, recent sign-in, disabled scopes, mutation of external
configuration, bounded/invalid bodies, response correlation and sanitized RDS
errors. Artifact tests compare actual output bytes and function bodies to the
manifest. CI runs these tests independently of the full dependency audit.
PGlite serializes transactions: these tests do not establish real concurrent
claiming, cancellation, release retirement or cross-device behavior on AWS.

The original candidate passed **62 dedicated tests**, and its full Desktop
suite passed **320 files and 3,904 tests**, with 11 existing skips. Standalone
typecheck and lint pass. Canonical schema and coverage checks still report
104 migrations, zero seeded rows and 206 covered tables. The clinical build
and its 291-chunk client scan pass. These results cover source behavior and
local builds, not installed apps, live Lambda calls or clinical approval.

The preserving-upgrade increment passes **73 dedicated connection tests**,
including ten real-SQL upgrade tests and a fourth artifact-mapping test.
Before the final function-metadata tightening, the new and historical upgrade
suites also passed together (23 tests). Negative cases include altered release
bytes, unknown/rewritten history, changed old rows, injected new copy, lost RLS,
extra tables, direct table/helper/PUBLIC grants, search-path/volatility drift,
changed function bodies and disabled or rebound triggers. PGlite executes
the SQL and rollback but substitutes its single database name; it does not
establish Aurora multi-session locking, Lambda serving or physical-device use.
The admitted artifact/configuration is copied before entering the asynchronous
transaction; a caller mutation cannot change the SQL executed or the identity
reported. The final focused suites and standalone typecheck pass after this fix.

An overlapping full-suite run timed out in the historical 5,001-person fixture
test (94.5 seconds against its unchanged 60-second deadline). That fixture now
uses 5,001 real inactive clinical-domain rows, retains the same inventory bound
and deadline, and explicitly verifies no migration DDL/receipt was attempted.
All 12 historical qualification-upgrade tests pass with this repair. The failure
is not recast as a pass. A separate clean full run at pushed runtime source
`845f5c189639c3f1a564222858abc5ade78da1c0` passes **321 files, 3,915 tests,
11 existing skips**, in 279.46 seconds. Final standalone typecheck and changed-
file lint pass. No source test was skipped to obtain this result.

### Canonical 105 and operator verification, October 6, 2026

The canonical-integration work passes **322 files, 3,925 tests**, with 11
existing skips, in 335.03 seconds. Standalone typecheck and changed-file lint
pass. Focused runs cover 88 database/artifact tests and 41 command/messaging
tests, followed by the final seven artifact tests and 50 credential-free Node
runner tests. The production gate reports 105 migrations and zero seeded rows;
the coverage gate inventories 207 tables. Historical migration bytes and their
104-prefix ledger hash remain unchanged. The new operator and both source
builders build successfully. These are local source results, not hosted
rehearsal, schema application, serving-route or physical-device acceptance.

## Remaining integration

1. The exact hosted rollback/upgrade/replay above is complete. Rebind/rebuild
   all current targets and candidates to the 105 release before serving tests.
   Do not rewrite applied SQL or transplant the staging ledger. This receipt
   does not qualify a handler, concurrent claims or the full hosted matrix.
2. Complete the separately reviewed clinic hold-aware retention/disposition and
   amendment procedure. The copy table is inventoried but still immutable.
3. Add a reviewed copy-registration operator, then a blocked-by-default
   handler/template using the emitted per-transaction database binding, with
   immutable code version, separate JWT routes, narrow IAM and alarms.
4. Wire V2 to display and hash-check actual approved text before acknowledgement,
   persist status and withdrawal, recover invitation claims without unsafe
   retries, and clear opened data on owner/session/environment changes.
5. Deploy exact reviewed synthetic candidates and run the real claims, consent,
   messaging settlement race orders, two-device convergence and retained export
   matrix. Missing reviews, refusals and skipped steps are not acceptance.
6. Qualify matched releases on physical iOS and Android before the separate
   security, MFA, consent, retention/provider and PHI activation reviews.

The owner's exact fictional **staging intake** consent approval is preserved.
It is not messaging consent, a qualification-copy substitution or production
policy approval. No new AWS consent artifact or grant was written by this work.
Paid mobile builds remain held. Neither app is commercial or PHI ready.

## Current CI distinction

V2 source `690fafaae0d68810bb35bdd44b84ae597e15f04c` has both hosted CI runs
`37534535367` and `37534530598` completed successfully. Desktop `10d09e9` runs
`37532619532` and `37532627965` are terminal failures at the unchanged full
dependency audit. Its independent messaging and fixture/browser jobs passed;
deployed-backend steps were skipped for missing secrets. The development chain
through `braces` has an [unpatched advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).
The audit is not waived or narrowed, and a new source push is not claimed green.

At candidate source `c92f35453f0ca74aa7dc82200d714acddbd7bf72`, run
`37537563002` finished failed at the same full dependency gate (five high
findings through braces); the independent connection/messaging job and all
fixture browser jobs passed. Deployed-backend steps remain skipped, not
acceptance. Run `37537556686` was still in progress when inspected. Neither
receipt establishes the later preserving-upgrade increment as hosted verified.

The later `ebca789` runs `37540508649` and `37540502411` are terminal failures;
the inspected main job failed at **Dependency security gate**. Full dependency
audit remains unwaived. Exact integration source `42888f2` runs `37542557009`
and `37542551276` are in progress at this checkpoint, not claimed green.
Local full-suite success is not a substitute for that unresolved security gate.

## Per-transaction connection contract binding

The emitted `database-binding-library.cjs` is a new source-only component, not
a serving handler. The handler must supply its independently compiled seven
function-body digests; caller-supplied approval hashes are not used. The binding
captures the input before asynchronous work and verifies each transaction
before connection business SQL under `clinical_core_api`, never an admin role.
It checks exact signatures, return types, bodies, language, security-definer,
volatility, empty search path and PUBLIC/API execution privileges. Extra
overloads refuse. It verifies the consent-copy table's forced RLS, all table
privileges including truncate, API/PUBLIC column grants and four exact trigger
table/function/event bindings. The preserving-upgrade verifier now checks
truncate and column grants too. No canonical SQL or release identity changed.

The final focused run passes **72 tests** across four files, including 49 actual
API-role SQL tests, ten preserving-upgrade tests, nine transport-only admission
tests and four emitted-artifact tests. Standalone typecheck and changed-file
lint pass. An initial test replacement omitted the existing function parameter
name; it was repaired. The initial column-ACL query incorrectly exploded an
empty ACL array and failed positive tests; null/empty ACLs are now handled
explicitly, with both grant/refusal and post-revoke admission tested. Those
failures are not reported as passes. The CI workflow's edited indentation was
repaired and the complete YAML parsed successfully with the installed parser.
The final full regression run at source `d9b0a74c7d88ab271e8f332a8c754c1dd9446a6a`
passes **323 files, 3,951 tests**, with 11 existing skips, in 371.85 seconds.
Standalone typecheck and changed-file lint passed before that run. The canonical
105/zero-seed gate and 207-table inventory gate passed again afterward.

Clean `d9b0a74` operator bundle
`286dc494d15e1d57bf76168b7de7580c3dcb1a152f9eef8b9740b08af40ce75e`
passed actual read-only AWS inspection and rollback rehearsal with the stronger
table/column privilege checks. Both observed 105 migrations, 207 tables and
46 rows, digest `129abce49aec8e4f3f8e73f6c10c18e94827d0ae0108e176419aede5d36280bc`.
Rehearsal returned `rolledBack:true`, `alreadyApplied:true`, `applied:false`.
This is schema-contract evidence, not API-role serving or a new migration.

This verifies local per-transaction contract metadata, not the full database
ledger, an atomic deployment snapshot, real concurrent DDL or a deployed
consumer connection. Copy registration, handler/template integration, V2 UI
and the actual hosted serving/settlement/device matrix remain unfinished.

### RDS mutation transport repair

The installed SDK's default was **three attempts**. Before the repair, actual
SDK middleware tests with a fictional HTTP transport reproduced three requests
for each retryable begin, mutation and commit failure. No AWS requests were
sent by these regression tests. The shared clinical and administrative database
adapters now use a single-attempt factory. It captures configuration once,
overrides supplied retry-count providers and refuses custom retry strategies.
Every other shipped RDS constructor in source and scripts now explicitly pins
`maxAttempts:1`, including the two synthetic scripts that previously set 2.

The explicit `DatabaseResumingException` retry remains limited to admission
before a transaction begins and eligible read-only inspection. No timeout,
throttling response, general server failure, transaction body or commit is
automatically repeated. An uncertain rollback remains best effort, not proof
of success, non-delivery or deletion.

All **202 focused tests** pass across the actual-SDK, database-adapter, resume
and connection-command suites. They cover begin/write/commit timeouts, throttling
and server errors, uncertain rollback, supplied retry options and source-level
constructor regressions. The AST check rejects unsafe spread overrides, computed
retry keys, aliased imports and namespace constructors. Standalone typecheck,
changed-file lint and complete CI YAML parsing pass. The 50 credential-free
deployment/ledger/registrar tests pass too. Initial new-test typing and an
incorrect fictional endpoint path were corrected before the passing run; those
failed runs are not reported as passes.

The final full Desktop regression run passes **324 files, 3,979 tests**, with
11 existing skips, in 304.36 seconds. Exact candidates and operators must be
rebuilt from clean source before use; previously serving
Lambdas are unchanged. This is transport/source evidence, not hosted ambiguity,
concurrent claim, installed-app or PHI activation evidence. Canonical SQL and
the 105-migration identity are unchanged.

Prior Desktop documentation head `f43bbca` CI runs `37544290731` and
`37544283819`, and runtime `d9b0a74` runs `37543645583` and `37543639510`,
are terminal failures. The inspected main jobs fail at **Dependency security
gate**; independent connection/message and fixture/browser jobs pass. A gated
deployed-backend job can report success while its secret-dependent steps are
skipped; it is not hosted acceptance. The full audit is not waived.

### Exact source and AWS inspection receipts

The repair is clean and pushed at
`6d3b84160d143133035be075d6a4d0d8e3bc3ad2`. The canonical zero-seed gate
still reports 105 migrations and the coverage gate 207 tables. The connection
source library, blocked messaging candidate and qualification-only operator
rebuild successfully from that exact clean source. Messaging ZIP SHA-256 is
`8131f662028f4ecb2bce3fae302c7f4fda30ef6f01b14cd6436726fa26fdc261`;
operator bundle SHA-256 is
`3142f9ad188c7d518659c016234b71e44752d5599725c2ef96ec5f9d1c115f8e`.
No candidate was uploaded or deployed.

Actual AWS member-role inspection first failed with
`upgrade_failed:transaction_start`; it is not acceptance. A separate read-only
inspection passed, followed by an already-applied rollback rehearsal and its
independent readback. Both observed 105 migrations, 207 tables, 46 rows and
digest `129abce49aec8e4f3f8e73f6c10c18e94827d0ae0108e176419aede5d36280bc`.
Rehearsal returned `rolledBack:true`, `alreadyApplied:true`, `applied:false`.
No new SQL, row, identity, copy, consent, provider or activation was committed.
The generic start failure does not identify its provider cause; the warm pass
does not close cold-start reliability or prove ambiguous-failure behavior on AWS.

AST-only Graphify regeneration completed with 12,705 nodes, 25,660 edges and
908 communities. Forty-nine unsupported/unparsed source files remain absent;
HTML is skipped for size. This is code navigation, not runtime acceptance.
New source CI runs `37546178583` and `37546175030` are in progress at inspection,
not claimed green. The full dependency scan still has five high findings; the
security gate remains unchanged. Paid mobile builds and PHI activation stay held.

## Approved consent copy registration

The qualification-only registrar is implemented in source. It registers the
exact UTF-8 text of an existing current approved artifact; it cannot create
that approval or grant patient consent. An active workforce approver, active
person, active clinical membership and active organization must all agree with
the artifact. A newer approved artifact without registered text prevents an
older release from being substituted. UUID spelling is normalized; consent text
is neither trimmed nor newline-normalized.

The operator fixes account `588966314750`, region `us-east-2`, the completed
qualification foundation and database `clinical_core_qualification`. It refuses
root, production/staging targets, activation overrides, changed migration
artifacts and dirty-source writes. Every transaction checks the full 105-entry
ledger, 207-table inventory, seven function contracts, copy-table privileges and
four trigger bindings. Registration uses the consent-release lock and a short
transaction. Read-only inventory and inspection do not register anything.

The copy package has exactly these fields: `contract:care-consent-copy/1`,
`artifactId`, `organizationId`, `scope`, `artifactVersion`, `contentSha256` and
`content`. No reviewer, approval or activation field is accepted. The digest must
match the exact valid UTF-8 content, bounded to 16,000 bytes. The CLI reads an
absolute regular file, bounded to 65,536 bytes, and rejects invalid UTF-8.

Build from the intended clean checkout with
`npm run build:aws-production-clinical-core` then `npm run build:aws-care-consent-copy`.
From that same checkout the generated command is
`node dist/aws-clinical-core/care-consent-copy-registration/index.cjs inventory`.
Inspection uses `inspect --copy-file=<absolute approved package path>`.
Rehearsal or registration uses `rehearse` or `register` with that file argument
and `--confirm-fictional-consent-copy-registration`. These are qualification
commands, not a production consent or approval workflow. Do not run registration
until the actual approved artifact and matching copy exist on the same target.

Registration always performs rollback rehearsal with independent readback
first. Exact replay reuses an identical copy without updating it. No automatic
retry follows an ambiguous insert or commit. An observed session digest
attributes the CLI receipt; it is **not** an approval hash. The immutable copy
and `registered_at` link it to the approved artifact, but a separate application
audit event naming the AWS operator is not yet implemented. Do not label this a
complete production approval/audit workflow.

The focused run passes **281 tests across seven files**, including the new
68-case copy-registration and command suites, the real embedded schema, actual
SDK transport checks and predecessor-upgrade regressions. Standalone typecheck,
changed-file lint and complete CI YAML parsing pass. Canonical gates still report
105 migrations with zero seeded rows and coverage of 207 tables. The registrar
bundle builds; the pre-commit build reports `clean:false` and cannot register.
Initial fixture errors used an invalid subject key, an incorrectly expanded
argument row and an impossible unbound-identity update; those runs failed and
were repaired before rerunning. The production identity constraint independently
rejects that unbound update. The first full run failed the unchanged logging
guard because a logging call without its own semicolon caused its scanner to
include the following comment. The operator now explicitly terminates that call; the
guard was not weakened. The 71-case consent/logging rerun passes. The final full
Desktop run passes **326 files, 4,048 tests and 11 existing skips**, in 247.89
seconds, with `TZ=America/Los_Angeles` and the unrelated Supabase anon-key
environment variable unset. Typecheck and changed-file lint pass again.

Previous runtime `6d3b841` CI runs `37546178583` and `37546175030` are terminal
failures. The inspected first run fails at the unwaived Dependency security
gate; its independent connection/message and fixture/browser jobs passed.
Secret-dependent deployed-backend steps remain skipped, not hosted acceptance.
No registrar AWS write, new approval, patient grant, serving deployment or paid
mobile build has occurred. All six phases remain partial.

The registrar is clean and pushed at
`6e23091b4da8d6775e0eebdb7f239a2365f38843`. Its clean rebuilt bundle SHA-256 is
`cb40cd8c6104502bde21e06c276253a559ccd2c8976d596ca4e0a6fa87ef41a6`.
Actual AWS `inventory` exited successfully from that operator in account
`588966314750`: qualification execution, PHI false, activation blocked, the exact
105-migration ledger admitted, **six approved artifacts and zero registered
copies**. Counts do not establish that every artifact remains eligible for a
particular scope or that any copy has been approved for this registrar.
`approvalsCreated:false`, `grantsCreated:false`, `copyInserted:false`.
No rehearsal or registration was requested; this is read-only target/contract
evidence, not positive hosted insertion, ambiguity or concurrent-release evidence.

The next engineering includes a distinct operator audit event, the blocked
connection handler/template with compiled binding, and V2 approved-copy review,
grant/status/withdrawal and uncertain-claim recovery. Obtain the exact approved
copy package for each enabled scope before positive hosted registration. No
operator-created approval, invented review hash or fallback copy may satisfy
that prerequisite. Retained clinic amendments/disposition, program assignments,
matched serving/device/provider/store/security/retention/recovery evidence and
the unwaived dependency security finding remain open.

## October 6 connection Lambda and blocked release template

`npm run build:aws-care-connections` builds `index.js`, a versioned-object
deployment ZIP, `template.json` and their exact byte hashes under
`dist/aws-clinical-core/care-connections`. The compiled handler pins source,
clean serving posture, all 105 migrations and the seven connection function
digests. It validates these inputs before constructing a clinical API-role
database client; every business transaction still checks deployed function
bodies, signatures, grants, forced RLS and safety triggers. Environment and
compiled metadata are captured before asynchronous work, so later mutation
cannot retarget a cached handler. The ledger gate remains separate from these
per-transaction metadata checks.

The template creates only the two POST routes, each with its own consumer or
workforce JWT authorizer and exact API invocation permission. Blocked defaults
permit only bounded encrypted logs. Database execution, the exact secret and
secret-bound KMS decrypt are conditional on separately supplied reviews.
Database, workforce MFA, connection, consent and retention review identifiers
remain distinct; the builder supplies none. Production approval and synthetic
qualification are separate conditions. Qualification is pinned to account
588966314750, Ohio and `clinical_core_qualification`, with PHI false and
activation blocked. Invalid deployments do not emit a qualification marker.

`EnabledConsentScopes` defaults to empty. This enables no new sharing grant;
status and withdrawal remain available to a valid identity. Unknown or duplicate
scopes refuse before client construction. The template retains encrypted logs,
count-only API/Lambda alarms, immutable S3 code version, exact source/ledger
parameters and bounded two-execution concurrency. CloudFormation conditions
stay within the ten-item conjunction limit. It never uploads, deploys or signs
reviews.

Local focused evidence passes 64 tests across five suites, including the emitted
Lambda's actual blocked response, configuration capture, wrong account/region,
missing independent reviews, deployed-contract drift, cross-clinic identity,
stale sign-in, separate workforce issuance and withdrawal with scopes disabled.
Initial builder/fictional-response mistakes were corrected before that passing
run. A subsequent isolated-child environment typing error was corrected without
changing the runtime or weakening a gate. CloudFormation lint passes for the
actual generated template; CI YAML parses, canonical gate remains 105 with
zero seeded rows and coverage remains 207 tables.

Both registrar runtime CI runs 37548701302 and 37548695045 are now terminal
failures at the unchanged Dependency security gate. The inspected first run's
independent connection/message and fixture-browser jobs passed. Secret-gated
backend steps do not prove live acceptance. The security finding stays unwaived.

Next engineering includes adding this twelfth candidate to a new qualification
target/fleet/capacity contract, actual V2 POST connection and exact-copy consent
review/grant/status/withdrawal wiring, and a distinct registrar operator audit
event. The current V2 clinic adapter still issues the older GET connection
request and expects its older response shape; it has not been silently switched
or given a production fallback. Real approved copy packages, independent
template review, exact matched deployment, hosted claim/grant races, all other
hosted/device/provider/store/security/retention/recovery evidence remain required.
All six original phases remain partial. No AWS resource, consent, approval,
provider release, installed app or paid build changed in this increment.

Final full local regression passes **328 files, 4,082 tests and 11 existing
skips**, in 413.52 seconds, with the documented timezone and the unrelated
Supabase anon-key variable unset. Standalone typecheck and changed-file lint
pass after the child-environment typing repair. This is source evidence, not
hosted transfer, native permission, store or PHI activation evidence.

The pushed clean source is `694121a145d7dd679654a3f89e1609c99088de99`.
Its clean rebuild passes CloudFormation lint and emits ZIP SHA-256
`a9f6c34c8ec84e59e024e7649dd3a73bbcf99417c34489304c7d06a3ee3d5149`
(789,061 bytes), code SHA-256
`2e31a0dcd3ea01674db0310f86a2e54d7fe1d7136d43afefa80bfb1777731d19`,
and template SHA-256
`f7801c8c6f27c03a6be0b012b8703c86649423a5106ca95281ec35010a59b609`.
CI runs 37550894195 and 37550890399 were in progress at inspection, not green.
Nothing was uploaded to AWS. Build again from the intended exact runtime source
before reviewing a new deployment; a documentation head is not interchangeable
with an artifact's compiled source identity.
