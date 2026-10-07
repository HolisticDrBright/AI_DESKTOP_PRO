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

## Claim receipt and permanent settlement source

The separate `build:care-claim-recovery-source` builder now produces an
unreleased, non-deployable overlay on the unchanged canonical 105 ledger. It
does not apply SQL or register a route. Its proposed consumer route is
`POST /clinical-core/consumer/connection-claims`; requests carry a UUID and
one of `claim`, `receipt` or `settle`. The authenticated owner and clinic come
from the verified identity, never from the request body.

Claim and settlement take the same transaction advisory lock for the exact
owner, clinic and request identity before a connection can be written. If the
claim commits first, receipt and settlement recover its immutable historical
receipt without claiming again or granting consent. If settlement commits
first, it permanently records cancellation and a later claim with that identity
is refused. Reading an absent receipt returns `unresolved` and creates no
decision. Cancellation applies to that command, not to the current clinic link.

Successful receipt replay checks present access to the chart and link. Revoked,
archived or replaced links return only `withheld`, without chart or connection
identifiers. A paused but accessible link may return the historical command
receipt; it is not a current connection-status assertion. A separate current
status read remains necessary. Receipt and settlement can be used during an
account-deletion fence; a new claim cannot. Another owner or clinic cannot read
the decision. UUIDs are canonicalized before correlation.

The two new tables are immutable, forced-RLS and inaccessible directly to the
API role. Decision rows store a token hash only. Separate audit rows contain
the owner, organization, request, action, outcome and timestamp, not the code,
hash or receipt body. Per-transaction metadata checks pin the seven existing
105 connection functions and the two recovery functions, their safety metadata,
table privilege boundaries and required triggers before business work. This
is not whole-ledger qualification or a review. The API additionally requires
a distinct claim-recovery review; no review is created by the builder or tests.

Local focused verification passes **61 tests across three suites**, including
the real canonical SQL plus overlay under the actual API role, both sequential
admission orders, lost-reply recovery, exact replay, isolation, withholding,
deletion fencing, response-failure rollback, metadata drift and source artifact
mapping. PGlite serializes transactions: these are not live multi-session races
or physical second-device acceptance. Source artifact hashes identify emitted
bytes, not approvals, deployed code or a canonical migration.

Integration remains engineering. Promote through a preserving 105-prefix
upgrade and rollback operator, integrate both tables into the covered-entity
inventory and reviewed disposition, wire the route into the connection
Lambda/template and qualification fleet, then implement V2's request-id journal
and explicit receipt/settlement controls. Existing V2 v1 entries have no request
identity: preserve their unresolved state rather than fabricating a server
receipt or clearing them to permit a retry. The existing 105 claim route is
unchanged and is not covered by request-id settlement. Exact matched releases
must deliberately adopt the new contract without a legacy fallback.

Hosted deployment, real concurrent claim/cancellation, revocation races,
second-device convergence and physical iOS/Android evidence remain required.
PHI stays off, paid mobile builds remain held, and all clinical holds and source
verification requirements are preserved. Neither app is commercial or PHI ready.

The subsequent full Desktop regression passed **331 files, 4,143 tests and 11
existing skips** in 355.23 seconds, with the documented timezone and unrelated
anon-key variable unset. Typecheck and changed-file lint passed. The literal
JSON-array refusal was independently checked against the actual 105 artifact
and overlay, then its test-case wrapper was corrected so Vitest passes the
array itself rather than spreading an empty array into no argument. Final
focused verification remains separate from this preceding full-run receipt.
The recovery suites and source builder are now in the independent connection
CI job. These changes do not waive the full dependency-security gate, which
still reports five High findings in the lint-tool chain.

## Later lint security repair

The local full dependency audit now reports zero known findings after replacing
the pinned Next lint plugin's sole directory-matcher dependency. See
[the repair and exact verification scope](dependency-security-2026-10-06.md).
The audit is not narrowed or waived; Next/React/TypeScript lint enforcement is
preserved. Both container definitions include the local adapter. The first
two-worker full regression had two timeout failures; both unchanged affected
suites passed focused verification and a complete one-worker run passed
331 files, 4,143 tests and 11 existing skips. New CI and container evidence must
be observed separately. No serving connection route, canonical schema,
qualification fleet, consent, approval, PHI flag or mobile build changed.

## Prepared recovery schema transition

The source artifact now includes a qualification-only preserving transition from
the exact 105 ledger to the proposed 106 ledger. It carries all original 105
files byte for byte plus the unchanged recovery overlay as
`20261006030000_production_care_claim_recovery.sql`. The canonical manifest
still contains 105 migrations and its coverage still contains 207 tables.
The proposed transition is explicitly unregistered, noncanonical and
non-deployable; no AWS operator entry point is released by this increment.

The predecessor ledger is
`7da8e4ed999a3298bccc4ef33e7a1005201db45fa2b46682622a208486f17743`;
the proposed ledger is
`514959bf0d32de55ded312509ae2ebe39a0fdde9f59246b096b0c41ba63f4f9b`.
Both are source identities, not review hashes or activation authority.
The library refuses changed prefixes, altered overlay bytes, duplicate versions,
unknown or mismatched database history, staging, production activation and PHI.
It pins the actual qualification database name, takes the migration/fixture locks
and locks the observed tables in consistent order before applying DDL.

Bounded database-side fingerprints prove that all 207 predecessor tables are
unchanged and both added tables are empty on first admission. Same-count row
rewrites and unexpected new decisions fail the transaction. The final metadata
check exercises the actual API-role binding, including function bodies,
privileges, forced RLS and immutable triggers, without a business command or
new grant. Replay includes populated recovery and audit rows in its fingerprint.
Rehearsal throws to roll back, then opens a new read-only transaction to verify
the actual predecessor state and its data digest. Reports contain counts and
digests, not clinical content, codes or secrets.

Local focused verification passes **58 tests across five suites**, including
10 new actual-SQL transition cases and the existing connection upgrade and
command-admission suites. Typecheck and changed-file lint pass. The canonical
105 gate and 207-table coverage pass unchanged. The source builder emits and
hashes the prepared migration manifest and fourth schema-upgrade library.
This is fictional PGlite evidence, not hosted SQL, distributed concurrency,
rollback on AWS, a complete full regression, or physical-device acceptance.

Canonical promotion still requires both tables' inventory and reviewed privacy
disposition, plus an independently account/foundation-bound operator whose
upgrade command mandates this rehearsal. Append-only decisions and audit rows
must not be mislabeled as deletable records, stripped of their immutable
triggers, or retained without authority to make coverage pass. Actual route,
Lambda/template/fleet/capacity/inspector integration, safe legacy drain,
second-device request discovery and the remaining production transfers and
privacy/assignment ports remain engineering. No consent or review was created,
no AWS work occurred, and PHI and paid-build restrictions are unchanged.

The subsequent read-only AWS inspection observed the approved synthetic member
role in account 588966314750 and the qualification foundation's PHI-disabled,
blocked boundary. The actual database still has **105 migrations, 207 tables
and 46 fictional rows**, digest
`129abce49aec8e4f3f8e73f6c10c18e94827d0ae0108e176419aede5d36280bc`.
The initial inspection failed before transaction start; credential resolution and
a separate begin/rollback probe succeeded, and the subsequent same read-only
operator inspection passed. The initial cause was not established or relabeled
as a code repair. No migration, provider release, consent or activation changed.
The inspected operator was a dirty local build, so this is present database
inspection, not exact-source release qualification of this new transition.

Desktop CI at the preceding dependency-repair head
`7630cb360328127b6f92e66422797333b324dc9f` completed successfully on run
37564525163, including the full audit, physical Linux Node 22 dependency-stage
check, normal full unit suite, clinical build and client scan. That run predates
the prepared transition and does not qualify its new source. Deployed-backend
tests remain separately secret-gated; a green job is not positive AWS acceptance.

## Bound recovery operator and AWS rollback rehearsal

The prepared recovery artifact now includes a self-contained qualification-only
operator. Runtime source is `98214ef86e0cd71e29e27fff039ba6e3f3a76784`.
Its clean build embeds the exact 105 predecessor files and recovery overlay;
an adjacent file, current working directory or environment cannot replace that
SQL. The operator SHA-256 is
`d96ba26a33b0dd70d4b7ea379caf9022eca5d14ca819e45cd387e0359b4763a8`.
The prepared manifest SHA-256 is
`78410ea8bb2169b6ac5847bb14798d912b12ff82b67639f76f48297eeef64a53`.
These are source identities, not security, consent or retention approvals.

The entry point uses only `ai-synthetic-member`, Ohio and the named qualification
foundation. It obtains STS and DescribeStacks observations itself, rejects root,
production, incomplete stacks, staging, PHI and activation, and creates the
database client only after exact artifact admission. `upgrade` requires a clean
build and the explicit fictional-only confirmation, runs a rollback rehearsal,
validates its complete result and observes AWS again before the apply transaction.
A changed cluster, secret, account or foundation boundary refuses that apply.
Each transaction still independently checks the actual database name, ledger,
inventory, data fingerprints and API-role metadata. Rehearsal and apply are not
an atomic snapshot; fictional records are not frozen between transactions.
The operator accepts no target, profile, release, review or skip-rehearsal override.

Build and inspect using:

```powershell
npm run build:care-claim-recovery-source
node dist/aws-clinical-core/care-claim-recovery-source/qualification-upgrade-operator.cjs inspect
node dist/aws-clinical-core/care-claim-recovery-source/qualification-upgrade-operator.cjs rehearse --confirm-fictional-care-claim-recovery-upgrade
```

On October 6 the initial dirty-build read-only inspection failed at transaction
start. A separate credential-resolution and begin/rollback probe succeeded;
the same operator's later read-only inspection passed. The initial cause remains
unknown, not repaired or assumed harmless. The subsequent **clean runtime build**
above completed the actual AWS rollback rehearsal in account 588966314750.
It applied the proposed DDL only inside the transaction, checked the recovery
metadata under the API role, rolled back and opened a new read-only transaction.
The observed state after rollback is **105 migrations, 207 tables, 46 fictional
rows**, unchanged digest
`129abce49aec8e4f3f8e73f6c10c18e94827d0ae0108e176419aede5d36280bc`.
The result reports `rolledBack:true`, `applied:false`, `canonical:false`,
`phiAllowed:false` and `activation:blocked`. No lasting migration, record,
consent, provider release or activation changed; the route was not deployed.
This qualifies that rollback rehearsal, not a lasting upgrade, recovery business
requests, a multi-session race or a mobile journey.

Local focused verification passes **83 tests across five suites**, including
the command through the real preserving runner and actual SQL, exact-source
artifact admission, changed-target refusals, incomplete rollback receipts and
replay after recovery rows are populated. Typecheck and full lint pass; the full
dependency audit reports zero findings. The canonical 105 schema and 207-table
coverage gates pass unchanged, as do the workload and target-example gates.
The complete Desktop regression passed **333 files, 4,165 tests and 11 existing
skips**, 617.00 seconds, with the documented timezone and unrelated anon-key
variable unset. AST-only Graphify updated to 12,953 nodes, 26,181 edges and 914
communities; 49 zero-node files remain absent and HTML was skipped for size.
No semantic-model or API cost was incurred. Runtime source was pushed to
`agent/commercial-readiness-20261005`, independently matched to the remote.
Exact-runtime CI 37572918749 and 37572915717 was queued/in progress at inspection,
not a terminal green result. Documentation heads are not substituted for the
operator's compiled source identity.
The read-only capacity preflight for the current scripted fleet observed a
150-execution limit, 136 unreserved, 37 requested reservations and 27 additional
reservations, leaving the required floor intact. Its registry still omits the
connection candidate; that integration gap must be repaired before calling it
a complete connection/recovery fleet preflight. This is not hosted acceptance
or an approval to remove per-function caps.
V2 exact-head CI at `4595f44f47c4684cd3107dcb519167995424ee16` is now terminal
success on both 37571284334 and 37571280473; that is source-CI evidence, not a
new installed binary.

Canonical registration and both immutable tables' honest inventory/disposition
mapping remain engineering, with deletion blocked until a separately reviewed
procedure exists. Do not strip their immutable triggers or invent retention
approval. Route/Lambda/template/fleet/capacity/inspector integration, V2 legacy
drain and second-device discovery, complete clinic privacy/amendment ports,
registrar audit and production program assignments still remain. Then exact
matched synthetic deployments need real transfer, messaging, recovery,
concurrency, rollback and provider/store matrices, physical iOS/Android testing,
clinical-source/security/retention reviews and independent PHI approvals.
All six original phases remain partial; neither app is commercial or PHI ready.
PHI stays off, paid mobile builds stay held, and clinical holds, exclusions and
source-verification gates are unchanged.

## October 6 immutable disposition and connection capacity repairs

The coverage parser previously discarded `appendOnly` and `disposition`.
The generic deletion path could consequently purge external objects before an
immutable database trigger refused deletion. Database rollback does not restore
deleted storage objects. The parser now preserves and validates those fields,
captures the admitted inputs before asynchronous work, and refuses pending
immutable disposition after the read-only legal-hold check but before inventory,
database mutation or any purger call. Missing or malformed hold observations
are refused rather than treated as zero. Read-only inspection remains available.

The canonical 207-table inventory now explicitly marks all 42 in-scope tables
with unconditional `block_update_delete()` triggers as pending disposition.
The coverage gate derives this requirement from actual canonical SQL; negative
tests remove each annotation in turn and must fail. No trigger, retention policy,
clinical hold, source-verification condition or exclusion was relaxed. The
operator embeds the validated mapping and its LF-normalized SHA-256 at build
time. `COVERAGE_PATH`, extra arguments and truncated replacement manifests
cannot substitute another mapping before credential or AWS access.

The prepared recovery manifest's two proposed table mappings now parse with the
existing inventory as 209 entries. They retain pending immutable disposition;
their dependencies name only the in-scope connection table, not retained person
or organization shells. This is proposed inventory, not canonical migration
registration, deletion authority or approval of a clinic retention procedure.
The canonical assembly remains 105 migrations and seeds no approval rows.

The capacity registry now includes both care messaging and care connections,
building their actual templates in isolated temporary directories. The read-only
AWS preflight in account 588966314750 observed a limit of 150, 136 unreserved,
39 requested reserved executions and 29 additional executions. It passes the
unchanged 100-unit unreserved floor, with a minimum current total of 143. No cap
was removed, no reservation changed and no resource was deployed. This covers
the current scripted candidate fleet, not future providers or hosted acceptance.
The foundation still reports PHI false, activation blocked and qualification
execution disabled as infrastructure. API 6zt8e9qz04 has 26 routes and no care
messaging, connection or recovery route.

The final focused run passes 49 tests across four suites, including actual
canonical SQL under PGlite, unchanged legal-hold enforcement and refusal before
purger invocation with correspondence still present. The 12 Node cases cover
capacity and negative immutable mapping checks. Typecheck and lint pass. The
full regression passed 334 files and 4,175 tests, with 11 existing skips, in
633.63 seconds using the documented timezone and unrelated anon-key variable
unset. The final focused run also verifies the last changed test assertions.
Desktop runtime 98214ef has terminal-success CI 37572915717/37572918749; V2
documentation head 67aa6f6 has terminal-success CI 37573148175/37573144869.
Those results do not qualify these newer runtime repairs or an installed binary.

Runtime repairs are pushed at `29d2322cf4f0095c98de7f43489d42840ada2fbe`,
independently matched to the remote. Its built covered-entity operator SHA-256 is
`6b3f83a0453c78feacbd7850108ba339fa1998bf1c5c7940d3829b05ad145714`.
CI 37575632168 and 37575628205 is in progress, not terminal success. The final
AST-only graph has 12,967 nodes, 26,202 edges and 911 communities; 49 zero-node
source files remain absent and HTML was skipped for size. No LLM/API cost.

Next remains canonical recovery registration and route/Lambda/template/fleet/
target/inspector integration, V2 legacy drain and second-device discovery,
complete clinic privacy and retained amendments, durable erase reconciliation,
registrar audit and production program assignments. Clinic-wide disposition
still needs a separately reviewed procedure and an interruption-safe cross-store
design; refusing an unsafe path is not completion of that workflow. Then matched
synthetic deployments, real-service/concurrency/recovery/rollback matrices,
physical iOS/Android, provider/store/clinical-source/security/retention reviews
and independent PHI approvals remain. All six original phases are partial;
neither app is commercial or PHI ready. PHI stays off and paid builds stay held.

## October 6 canonical recovery release and historical admission

Desktop registration `b9248d02032d0db9bae72c46625dc37412decf88` and follow-on
source-gate hardening `cf8d388c3f37e10d896453e95df00b5c626d4168` are pushed
and independently remote-matched. The gate pins both historical ledger hashes,
the full 106 ledger and the exact recovery SQL digest. The exact recovery SQL is now migration 106,
`20261006030000_production_care_claim_recovery.sql`, with digest
`033ea35ff3d8932a7b3ca13ee9968f072fbe33e7311a2ad010d8cad80b6f0ca8`.
Its frozen historical header still describes the original unreleased overlay;
registration preserves those bytes rather than rewriting the reviewed function
identity. Registration is not policy approval, deployment or PHI activation.

The canonical ledger hash is
`514959bf0d32de55ded312509ae2ebe39a0fdde9f59246b096b0c41ba63f4f9b`;
the assembly hash, which also includes filenames, is
`fb63e0db3d9a6ff3c8020312452591b92660c5d6fc2940eae717345d85c41107`.
The exact historical 104 and 105 prefixes retain their old identities. The
104-to-105 connection operator intentionally selects and verifies only the 105
prefix. The recovery operator still admits only the exact 105-to-106 transition.
The current connection and messaging builders and inspection/consent ledger
checks bind to 106; rebuild older artifacts and target manifests before use.
Do not relabel an older deployed handler or documentation commit as this runtime.

Coverage now inventories 209 tables, including both recovery tables with pending
immutable disposition. All 44 scoped immutable tables retain that condition.
Neither table may be deleted through generic clinic cleanup. The fresh canonical
operator checks 130 application tables, 86 contract functions and zero seeded
clinical rows; exact historical predecessor checks remain separately pinned.
The consent registrar accepts the exact 105 or 106 artifact only against its
matching live ledger. Mixed releases, altered SQL and a current artifact against
an older database refuse. It never creates an approval or patient grant.

Local evidence includes the actual 106 SQL, API-role metadata and privacy mapping,
preserving historical upgrade/rollback tests, and new real-database consent-release
admission/refusal tests. Typecheck and full lint pass, as do 62 Node cases covering
whole-ledger/target observation, immutable disposition and capacity. The complete
Desktop regression passed 335 files and 4,179 tests, with 11 existing skips,
in 484.01 seconds (documented timezone, unrelated anon-key unset). The follow-on
source-gate-only change passed its standalone check; unit/runtime SQL is unchanged.
Final typecheck and full lint also pass. CI 37577290425/37577294695 (registration)
and 37577854246/37577859916 (gate hardening) are in progress, not terminal passes.
Earlier runtime 29d2322 has terminal-success CI 37575632168/37575628205;
that does not qualify this newer release or a mobile binary.

The final clean-source operator built from cf8d388 has SHA-256
`cb03961f1a52e7187bc9394ab6b0a3f0f56e4377199a2373b96f0468002049ef`,
with source manifest SHA-256
`47b6de250db1ea1647c9bda00764f0eac64b0351c4bc4ae8d0a9ee8b933f0de1`.
A fresh AWS inspection initially failed at transaction start, with no transaction
or migration admitted. A member-profile read-only begin/read/rollback probe then
passed and observed qualification database 105. A new inspection and rollback
rehearsal passed, preserving all 46 fictional rows and digest
`129abce49aec8e4f3f8e73f6c10c18e94827d0ae0108e176419aede5d36280bc`.
The startup failure remains unexplained; later success is not a diagnosed fix.
After the full regression, the final clean-source operator repeated mandatory
rollback rehearsal, re-observed the fixed member/foundation boundary and committed
the 105-to-106 upgrade. It verified unchanged old-row digest and 46 rows and both
new tables empty. A separate post-commit inspection verified 106 migrations,
209 tables, 46 rows and full-inventory digest
`fab53d6241e6cc38f36acfacb86453ded7f23dd7d5d1a77b7cdd79fcaa146950`.
This latter digest includes the two empty tables and is not the predecessor's
207-table digest. Source/API-role metadata is verified; business races are not.
A current-source consent registrar inventory passed against the actual 106 target:
six existing approved artifacts, zero registered copies, no insertion, approval
or grant. No provider/consent activation or route deployment occurred. Fresh AWS
readback still reports foundation CREATE_COMPLETE, PHI false, activation blocked,
qualification execution disabled as infrastructure, and API 6zt8e9qz04 with 26
routes and no care messaging, connection or recovery routes.

The rebuilt covered-entity operator embeds the validated 209-table inventory
and has SHA-256
`08c99dc2ffc4fb9ef17fb589f982cf1809940de4c14f978cfd72f0f52bc71d45`.
The final AST-only graph has 12,983 nodes, 26,250 edges and 897 communities; 49 files
produced no nodes and HTML was skipped for size. No LLM/API cost or canvas edit.

Next is recovery route/Lambda/template/fleet/target/inspector integration and
separately reviewed
activation. V2 legacy drain and second-device discovery, durable erase correlation,
complete clinic privacy/retained amendments, registrar audit and production program
assignments still require engineering. Matched synthetic deployments, real-service,
concurrent race/recovery/rollback acceptance, physical iOS/Android, Core purchase/
restore/provider acceptance, verified clinical source releases and independent
security/retention/agreement reviews and PHI approvals remain. All six original
phase scopes are preserved and partial; neither app is commercial or PHI ready.
PHI stays off, paid builds held, and clinical holds/exclusions/source verification
requirements are unchanged.

## October 6 connection recovery deployment integration

Desktop runtime `a9006fc9045e3869cf3d156ff47721ea1f4cfdc2` is pushed and
independently remote-matched. This supersedes the earlier statement that recovery
route/template/fleet/target/inspector integration was still unbuilt. No V2 runtime
or mobile binary changed in this increment.

The existing care-connections Lambda now includes
`POST /clinical-core/consumer/connection-claims`, with a consumer JWT authorizer
and an exact-path invoke permission. It uses the same two reserved executions;
no extra recovery function or reservation was introduced. Compiled metadata
pins the seven connection functions and two canonical recovery functions. Each
recovery transaction checks both sets through the API role before business work.

Recovery defaults off and requires both `ClaimRecoveryEnabled=true` and a
separate `ClaimRecoveryReviewSha256`, in addition to the base serving reviews
and posture. A missing/malformed recovery gate refuses that route without
creating a database client or disabling normal connection status/withdrawal.
It does not create approvals, consent grants or an automatic reconnection.

The new target contract `aws-clinical-core-qualification-target/3` requires all
twelve candidate stacks, including care messaging and care connections.
Historical /1 and /2 targets remain exact historical contracts and cannot
qualify the new connection stack. The unfilled example is
`infra/aws-clinical-core/qualification-target-connections.example.json`; its
placeholders are not review evidence and it is refused as a run target.

`npm run inspect:aws-care-connections-qualification` rebuilds the exact clean
checkout before read-only AWS calls. For a deployed candidate it requires a
separately filled reviewed binding via `--binding=<file>` and compares actual
stack parameters/outputs, template, ZIP/version, configuration, IAM, JWT routes,
integration, permissions, alarms and repeated observations with the entire
ledger. It never deploys, writes an approval, registers consent or certifies
business acceptance. Hash syntax/equality is not proof that a human reviewed it.
The source-only recovery manifest now points to this separate deployment
candidate while remaining non-deployable and activation-blocked itself.

Local verification passed: full Desktop **335 files, 4,193 tests, 11 existing
skips**, 266.88 seconds with the documented timezone and unrelated anon-key
unset; the final release-mapping assertion was separately rerun, **6/6**.
The five focused integration suites passed **106/106**, the two deployment
inspector suites **66/66**, PowerShell target-binding negatives **75/75**, and
capacity **9/9**. Final typecheck/full lint, canonical106 with zero seeded rows,
209-table coverage, PHI-disabled workload and emitted CloudFormation lint pass.
The handler-to-API-role SQL journey tests committed/lost-reply receipt,
settlement-before-claim, cross-owner refusal and zero consent grants using
fictional PGlite records. Serialized local transactions are not hosted
multi-session race or physical-device evidence.

Actual read-only AWS evidence at this exact source: the first inspection
returned `database_resuming` before a transaction or write was admitted.
The cluster then reported available with its HTTP endpoint enabled. A fresh
inspection verified the whole 106 ledger, rollback and repeated exact missing
stack response, returning **not_deployed**, mutations=false, acceptance=false,
PHI=false in account588966314750/databaseclinical_core_qualification. This
successful read is not a cold-start reliability repair. API6zt8e9qz04 still has
26 routes and no connection or messaging route. No AWS deployment, migration,
fixture, provider release, consent registration or activation occurred here.

CI37581127383/37581124168 for a9006fc are in progress, not terminal passes.
Prior cf8d388 CI37577854246/37577859916 now has terminal success; that is not
current-source hosted acceptance. AST-only Graphify has 13,008 nodes,
26,320 edges and 908 communities; 50 zero-node files remain absent and HTML
was skipped for size. No LLM/API cost or canvas edit.

Next engineering still includes the reviewed deployment operator and actual
candidate binding, V2 legacy drain/second-device pending-claim discovery, durable
erase request correlation across restart, complete clinic privacy and retained
amendments with interruption-safe cross-store disposition, distinct registrar
audit identity and production program assignments. Then exact matched synthetic
releases, hosted service/concurrency/recovery/rollback acceptance, physical
iOS/Android, Core purchase/restore and provider tests, verified clinical-source
releases and independent security/retention/agreement reviews and PHI approvals
remain. All six original scopes are partial: account/plan continuity; owned
processing/delivery; full privacy; clinical knowledge/safety; Core store/provider
acceptance; matched release/security/physical qualification. Neither app is
commercial or PHI ready. PHI stays off, paid builds held, and all clinical holds,
exclusions and source-verification requirements are unchanged.
## October 6 durable synthetic erasure recovery

Desktop runtime `22bf5f9adb0962e0c9643203c55edcf5072e270b` and V2 runtime
`78db95bc7edf0bc5f3d481e01feeb88cf2f5d826` are pushed and independently
remote-matched on the existing commercial branches (PR67 and PR21).
This supersedes the earlier statement that durable synthetic erase correlation
across an app restart was unimplemented. It is source-verified, not deployed or
device-verified, and it does not complete the full privacy phase.

Synthetic migration46, `20261006040000_synthetic_care_erasure_recovery.sql`,
adds an immutable owner/request-ID receipt or cancellation fence. The mutation
and receipt commit in one transaction under the same owner lock. Receipt
absence is `unresolved`, not failure. Settlement returns an already committed
receipt or fences an unseen request; a delayed original cannot erase newer
records under that ID. A changed scope conflicts. Direct API table access and
the old uncorrelated SQL erase are refused; the HTTP service also refuses the
old ID-less destructive action. Historical erasure history remains readable.

The replacement erase scopes empty-thread deletion and retained-thread counts
to this owner's connections; the historical implementation had considered
threads belonging to other accounts. Signed forms, cancellation records, clinic
messages, and the existing domain/closure retention distinctions are preserved.
The new migration is `production_transform:false`; all historical synthetic
migration bytes and the canonical production106 bundle remain unchanged.
**Do not apply synthetic46 to clinical_core_qualification or production.**

V2 saves and reads back an encrypted owner/environment request journal before
dispatch. It requires an explicit saved-request review before removal. After an
interruption or restart, the owner can check the exact receipt or confirm stopping
late arrival; no destructive action runs on mount or is automatically retried.
Authorization loss, an opened-view change, an organization change, a device
erasure fence, or a destination/channel change prevents opened results or journal
writes from being accepted. The journal is included in the same organization-
scoped device export/removal inventory. Terminal IDs are not silently dropped;
the local journal refuses growth past128 identities. Production still renders
the separate retained-correspondence/privacy path, not this synthetic deletion.

Local final verification passed:

- Desktop: **335 files,4,203 passed tests,11 existing skips**,286.37 seconds,
  with the documented timezone/unrelated anon-key unset; no waived failures.
  The focused database/migration/transport set passed245/245 and the final
  database/migration/error-classifier set206/206.
- V2: **213 passed files,one existing skipped file,2,488 passed tests,one
  existing skipped test**,32.86 seconds. Recovery tests cover lost committed
  replies, restart without replay, both settlement orders, retained pending
  intent after a failed receipt save, wrong receipts and account loss. The
  initial focused set75/75 and render/export recovery set70/70 passed; final
  full suite includes the extra rendered prerequisite/disabled-removal test.
- Both typechecks and linters, API build/JWT/least-privilege gate, production106
  zero-seeded-row gate,209-table coverage, PHI-disabled workloads, V2 HIPAA
  baseline/capabilities, TestFlight source scan363 files and four-surface
  disclosure gate pass. Desktop/V2 lifecycle contracts match after LF
  normalization, including section-specific export validation. Earlier failed
  runs led to repairs; they are not represented as passes.
- Root AST graphs were updated without LLM/API cost: Desktop13,016 nodes,
  26,327 edges,917 communities; V2 6,053 nodes,12,573 edges,456 communities.
  Fifty Desktop and35 V2 zero-node files remain absent; HTML was skipped for
  size. An accidentally generated Expo-only snapshot was preserved under
  the ignored root graph backup, not left as an untracked source folder.

Current runtime CI is not yet terminal: Desktop37584469004/37584464170 in
progress; V2 37584475362/37584471459 queued. The prior a9006fc Desktop runs
37581127383/37581124168 have terminal success; that does not qualify this
new release. No hosted deletion, deployment, migration, fixture, consent
registration, provider activation, paid mobile build or PHI activation occurred.

Next engineering must provide a preserving synthetic45-to46 upgrade operator
and exact matched identity-API/V2 rollout with rollback evidence before using
this path. Do not transplant this migration into the production qualification
database. Real multi-session races, connection withdrawal and second-device
journeys must be hosted-tested against the correct synthetic target. Older
requests without an ID, another device's lost intent, or a removed local journal
cannot be retroactively declared failed by this journal; these require explicit
reconciliation and further discovery/lifecycle work.

The full original scopes remain partial: account/plan continuity and legacy
provenance; owned processing and durable delivery; complete privacy, retained
clinic amendments and cross-store disposition; eligible verified clinical
knowledge and safety; Core $19.99 purchases/restore and provider acceptance;
exact matched releases, rollback/load/security/recovery and physical
iOS/Android/five-persona qualification. Reviewed deployment bindings/operators,
legacy claim drain/second-device discovery, distinct registrar audit identity
and production program assignments also remain. Independent security,
retention and agreement/runtime reviews and separate PHI approvals are required
after the engineering and acceptance work. Neither app is commercial or PHI
ready; PHI OFF, paid builds held, clinical holds/exclusions/source verification
unchanged.

## October 7 preserving staging erasure upgrade and Inbox filter repair

Desktop source `54814c8c73588174ee2b349afd7c83b04bfeb0dc` is pushed and
independently remote-matched on agent/commercial-readiness-20261005 (PR67).
It includes the preserving upgrade operator, full-inventory bound repair,
explicit bounded acceptance-test timeout, cross-database constraint comparison
repair and the Inbox response-race repair. V2 runtime
`78db95bc7edf0bc5f3d481e01feeb88cf2f5d826` is unchanged; a documentation
update is not a mobile release.

The preserving operator is now implemented and its rollback rehearsal has run
against AWS. This supersedes the previous unimplemented-operator statement, but
not the matched rollout requirement. The exact source migration remains46,
version20261006040000, SQL SHA
`3890daeb708511a0f651abd95456906048fb9f4a7bc1ef754b731e9d673dab91`.
The actual staging core ledger includes the historical20260902230000 alias of
20260821049700; the operator preserves it verbatim. Source45 is46 live entries,
and source46 would be47 live entries. It also preserves the separate two-entry
clinical_reference catalog history and every clinical/commercial reference row.

Exact bindings and identities:

- Fixed member profile ai-synthetic-member, account588966314750, us-east-2,
  foundation ai-clinical-core-synthetic-staging, databaseclinical_core,
  APIwxv734oi12. Assumed-role STS and completed foundation outputs are observed
  before admission. Root, production and qualification targets are refused.
- Live predecessor ledger
  `2563a6bbe70c75bbb2e9c423aececf6cf92eaead44f28da7a8c457225e0ed393`;
  planned successor
  `99ad59a94bab717a4e1299979db177394e931c9ebb7f40aa8be1ba1d99d52148`;
  separate catalog ledger
  `83d51dc056b41f47b5fb3d6020201163915faa2116004e3692af9bb41aad0f62`.
- The actual preserving inventory is87 non-ledger tables, not the smaller
  qualification inventory. The planned new empty receipt table makes88.
  Staging has23,980 rows, including12,171 immutable audit events. Every
  admitted row is hashed in the database. The100,000-row per-table bound
  refuses a larger table; it never certifies a truncated prefix.
- Operator commands are inspect, rehearse and upgrade. Mutating/rehearsal
  commands require a clean compiled source and the exact fictional-only
  confirmation. Upgrade must first verify a real rollback rehearsal and then
  reobserve the fixed account/foundation. No target, skip, review or activation
  overrides exist. Results explicitly state acceptance:false,
  phiActivation:false and apiDeploymentPerformed:false.

Real AWS rehearsal at that exact clean54814c8 source passed and rolled back.
A separate inspect afterward confirmed46 live entries/source45,87 tables and
all23,980 rows with the unchanged full-data digest
`bb0a6ecafad1da1f595c577124fe8e03a0e495cb524018b3f51f2e19392f3a55`.
The operator ZIP is not a Lambda: the self-contained CLI index.cjs hash is
`98e74bde9da5a477362632d18c91c0512aa21635519554db59d9571629c9c517`;
its artifact-manifest.json hash is
`89b2a11a3c449cd787c5312f932ad665ae04fb1ff6d6104d5c3b008117608737`.
A future rebuild at another commit has a different artifact identity.

Two actual qualification defects were repaired, not waived. The original5,000
row bound could not admit staging's audit history; tests now include12,001 audit
rows and a12,001-row reference history and detect a changed late row. AWS and
PGlite returned identical receipt constraint definitions in different collation
orders. The comparison now ordinally sorts the unordered constraint set only;
SQL definitions, validation flags, duplicates, physical column order, types,
nullability and defaults remain exact. Missing/weakened constraints, grants,
RLS, triggers, function bodies, ledger aliases and catalog history still refuse.
Earlier failed rehearsals rolled back and independent reads preserved the
original digest. No new schema digest was invented or whitelisted.

The earlier Desktop CI at0c86731 had a unit timeout and, in one run, an Inbox
filter failure. The multi-transaction24k-row test now has an explicit30-second
deadline with unchanged assertions, not a global timeout or skip. A new browser
regression deliberately holds the old API response until the newer resolved
filter has rendered. It failed on the original client after the late answer,
proving an out-of-order response defect. Inbox now admits only the latest request
for current filters, ignores stale errors/results, and uses current filters for
read-receipt and action refreshes. Unmount invalidates pending list completions.
The complete21-test Inbox browser suite passed with no retries in2.6minutes,
including the forced stale response and the existing persistence, conflict,
refusal, workflow, membership and cross-surface proofs. This uses a loopback
fictional contract service and Chromium, not AWS business or device acceptance.

Final local verification for54814c8 passed: **337 files,4,236 tests passed,
11 existing skips**,301.32seconds, with the documented timezone and unrelated
anon-key unset; no assertion was waived. The focused schema/command set passed
33/33, including unordered identical constraint sets and missing/weakened schema
refusals. Final typecheck and full lint passed after the Inbox change. The
unchanged production106 zero-seeded-row gate,209-table coverage and PHI-disabled
workload gate passed; no canonical or historical migration bytes changed.
The earlier d1096ce full run also passed4,236 tests in283.10seconds, before the
Inbox client change. Earlier failures remain failures, not reclassified passes.
AST-only Desktop Graphify is13,081 nodes,26,514 edges,921 communities;50
zero-node files remain absent and HTML was skipped for size, without LLM/API cost.

The current-source GitHub runs37589826721/37589818434 are in progress at
readback, not terminal passes. Prior Desktop e82e02d runs37584760042 and
37584765893 now both have terminal success. V2 documentation head30c012b,
carrying unchanged78db95b runtime, has37584774782/37584769535 terminal success;
the earlier78db95b runs were cancelled, not passed. Secret-gated hosted CI
success must not be confused with physical AWS service acceptance.

**Do not run upgrade yet without the exact matched identity-API/V2 rollout and
rollback procedure.** The new schema revokes the old ID-less erase contract;
installing it alone does not qualify old clients or an old serving handler.
Build the fixed CLI with npm run build:aws-care-erasure-upgrade; inspect is
read-only, and rehearse --confirm-fictional-care-erasure-upgrade rolls back.
Keep production106 and clinical_core_qualification separate: synthetic46 is
production_transform:false and must never be transplanted into either.
No permanent AWS migration, deployed API, fixture, consent/provider registration,
paid mobile build or activation occurred in this milestone. PHI remains OFF.

Remaining original phase scope is unchanged:

1. Account and plan continuity still needs legacy provenance/claim drain,
   second-device pending discovery and reconciliation of requests without
   recoverable device journals. A local erase journal cannot prove an older
   ID-less request failed.
2. Owned lab/document/voice processing and durable cross-app delivery need the
   matched hosted interruption, replay, withdrawal and real multi-session matrix.
3. Complete privacy still includes retained clinic amendments and interruption-
   safe cross-store disposition. This staging rehearsal is not production
   deletion authority or full erasure fulfillment.
4. Clinical knowledge/ranges/safety needs actual eligible source-verification
   releases and preserved holds/exclusions, not approval fabricated from tests.
5. Core19.99 purchases, restore/cancel and provider/store acceptance remain.
   Peptides and longevity stay excluded from initial Core activation.
6. Exact matched API/Desktop/mobile candidates, rollback/load/security/recovery
   and physical iOS/Android/five-persona acceptance remain. Paid mobile builds
   stay held until updates are complete and authorized.

Reviewed candidate deployment bindings/operators, distinct registrar audit
identity and production program assignments also remain engineering. Security,
retention, actual agreement/project/runtime/provider coverage and separate PHI
activation approvals remain independent review gates. Neither app is commercial
or PHI ready. All six phases remain partial.

## October 7 matched synthetic care release preparation

Desktop source **2321fd451240cd89c8a478f7e99a1612a1c0d589** and V2 source
**e6a5c7bed168ccc983f8c0b1ad818cddf8716c88** are committed and pushed, with
remote branch heads independently matched. This increment prepares the release;
it does not deploy it or make either app commercial or PHI ready.

### Source fixes and verification

- The synthetic release builder binds exact clean Desktop/V2 source commits and
  file inventories, byte-matching LF-normalized care-data contracts, the mobile
  journal/transport, both native synthetic profiles, compiled API bytes and
  exact synthetic core/reference histories. The ZIP has only index.js and
  release.json, fixed timestamps and standard CRC32 records. Preparation
  rebuilds the actual current API before any AWS request; a rehashed replacement
  artifact cannot stand in for that source. A standard independent ZIP reader
  checked all CRCs and exact extracted bytes.
- The read-only preparation command verifies fixed member identity, foundation,
  stack, parameters, full existing template/IAM declarations, active function
  code/configuration, integration, JWT issuer/audience, all 51 identity routes,
  and a same-source embedded operator's database inspection. It changes only the
  proposed code-key parameter and obsolete route-count output. The four source
  routes absent from staging remain absent. Source output now correctly says55;
  the prepared existing-stack output says51 rather than historical32.
- Android's synthetic-physical-test channel previously fell through to development
  and lost the synthetic warning posture. A regression reproduced that and the
  profile mismatch before the fix. It now resolves to the synthetic posture;
  both next-build profiles explicitly use synthetic-testflight. Production
  storage remains refused. The enforced tests live in __tests__, because the
  existing lib/releasePosture.test.ts is outside the configured discovery pattern.
- The image-parser subprocess test separately bounds Node/module startup and
  retains its three-second detector watchdog. A deliberate post-handshake hang
  proves the watchdog kills the worker. No parser refusal or positive PNG
  assertion was removed, and there is no retry.
- V2 full final suite: **215 files,2,492 passed,1 existing skip**,36.11seconds;
  actual installed TypeScript compiler, Expo lint and TestFlight source gate pass.
  The earlier loaded run had one child-startup timeout; it was not called passed.
- Desktop release tests5/5 with negative matrices and care-data/command tests39/39
  pass; typecheck, full lint and authenticated API gate pass. The loaded full run
  had two bounded child-process timeouts (4,234 passed,2 failed,11 skipped).
  After the competing graph/mobile jobs ended, the complete unchanged Desktop
  suite passed **337 files,4,236 passed,11 existing skips**,271.44seconds. The
  earlier failure remains recorded; no tests or deadlines were waived.

### Actual AWS observation and artifact identity

At **2026-10-07T08:23:30.736Z**, the command prepared the fixed synthetic
588966314750/us-east-2/clinical_core/APIwxv734oi12 target. It still ran ZIP
58f5978301be218896b269a44438fecb8ae89a690bee6671008b64f215f14247,
Lambda revision6b1d2617-30a8-4e01-be1e-5087b6dd1188,Timeout29,51 JWT identity
routes and the original live46/source45 database history. All **23,980 rows**
remained, full-data digest
bb0a6ecafad1da1f595c577124fe8e03a0e495cb524018b3f51f2e19392f3a55.
The destination artifact bucket was independently observed as versioned and
encrypted with the fixed clinical KMS key. This is inspection, not deployment.

- Candidate ZIP: **ae8b0d62e21708057ec279654db09ac2109aaeccce385035b885d6dec03ce106**,
  **1,818,387 bytes**.
- Emitted path:
  dist/synthetic-care-release/2321fd451240cd89c8a478f7e99a1612a1c0d589/e6a5c7bed168ccc983f8c0b1ad818cddf8716c88/.
- Preparation subdirectory:
  preparation/f20ce0571d223529e15f6385418884403554a6d738ba301768e9f6587142a8c3/.
- Same-source erasure operator index.cjs:
  **df734e9d53845248fb3d780fa7e0c50d6c1044d68542b51638872a5dfbec692f**.
  It inspected only; the previous54814c8 rehearsal remains a separate identity.
- Preparation marks awsMutationPerformed:false,candidateUploaded:false,
  changeSetCreated:false,deployed:false,hostedAcceptance:false,
  rollbackRehearsed:false,phiAllowed:false,paidMobileBuildStarted:false.

The previous Desktop54814c8 and doc7f87116 CI pairs and V2cb858da CI pairs are
now terminal success. New V2e6a5c7b CI37593402068/37593395470 is terminal success.
Desktop2321fd4 CI37593412783/37593405855 was in progress at the last observation.
New documentation heads must be checked separately; a saved report never
qualifies a later rebuilt artifact.

### Exact next actions and remaining scope

Use **Desktop docs/synthetic-care-release.md** for build/prepare commands.
The next cloud step is independent exact-ZIP upload verification and a freshly
observed, reviewed Lambda-only change set. Deploy the request-ID-aware handler
before the schema change and prove safe legacy refusal plus unaffected routes.
Then rehearse explicitly schema-compatible recovery before the lasting
preserving upgrade. **Do not restore the old ID-less API after live47, down-
migrate, or discard receipts.** A prepared re-forward policy is not a rollback
rehearsal. Documentation-only HEAD changes still require a fresh same-source
build/inspection under these strict commands.

Paid native builds remain held. The next actual binaries need physical
iOS/Android restart, ambiguous delivery, exact receipt/settlement, second-device
convergence, isolation and retained-record tests. A matched mobile source is not
a matched mobile binary.

All six original phases remain partial: account/plan continuity and legacy
provenance; owned processing/durable cross-app delivery; complete privacy,
retained clinic amendments and interruption-safe cross-store disposition;
eligible verified clinical knowledge/safety; Core19.99 purchase/restore/cancel
and provider/store acceptance; exact release/rollback/load/security/recovery and
physical five-persona iOS/Android acceptance. Legacy claim drain, second-device
pending discovery and missing-journal reconciliation, reviewed candidate
deployment operators/bindings, distinct registrar audit identity and production
program assignments remain engineering. Security, retention, actual agreement/
project/runtime/provider coverage and separate PHI approvals remain independent
review gates. Clinical holds/exclusions/source verification are unchanged.
PHI OFF; no lasting migration, fixture, consent/provider release or paid build.

## October 7 synthetic identity API deployment

The request-ID-aware identity API is now deployed in synthetic staging. This
does not complete authenticated erasure acceptance, API recovery, native-device
verification, commercial readiness or PHI readiness. The database remains at its
previous preserved history; no receipt migration or patient-data activation was
performed.

Desktop tooling commits c79189c7b3543eccb5d36817e0b5b3c8994ded64 and
5b6f8aa45347d33757ac9bfb34658e2e09daefd3 are pushed on the existing branch/PR67.
V2 source remains 11197e527a1ffc9317513837087e347531076957. New uploader and
change-set tools are documented in docs/synthetic-care-release.md; their
credential-free suite passes 14/14, with no skips. Full lint and authenticated
API gate pass; typecheck passed before the second script-only increment. The
earlier full Desktop4236/V22492 results retain their original source scope;
neither full application suite was rerun for these tooling-only commits.
Desktop4e0b7f9 CI37594222846/37594215363 is terminal success. At the final read,
c79189c CI37595977957 is success,37595970927 remains active;5b6f8aa
CI37596703754/37596695070 remains active. V211197e5's two CI runs remain green.
Pending or skipped jobs are not passes.

### Actual artifact and change set

The uploader rebuilds current source and reobserves STS, the fixed foundation,
stack/template/function/JWT routes and full database inventory before its
create-only write. It verifies owner, region, enabled versioning, exact KMS key,
source metadata, byte count and SHA-256 by downloading the exact S3 version.
Wrong or ambiguous upload outcomes, stale preparation, overrun/short/stalled
streams, mismatched checksums, redirects and nonidentical collisions refuse.
No blind overwrite, retry or artifact deletion is implemented.

An initial c79189c source artifact b9d27543ec7c7a9a52fab989d534110b3151379e0c5e55b004feca14a3cfa88c
was uploaded/read back at2026-10-07T08:46:53.672Z, version
N4e.6M9UU9y_ColOQj2pmFDpx9tNdeLB; it was not deployed. After the second tooling
increment, the actual deployed artifact is:

- Desktop source:5b6f8aa45347d33757ac9bfb34658e2e09daefd3.
- Mobile source binding:11197e527a1ffc9317513837087e347531076957; built:false/deviceVerified:false.
- ZIP SHA-256:644967eec4241c19f2365aabc7cec304f200f95622c8ef3a0188f57633dd64db,1,818,387bytes.
- Bucket:ai-clinical-core-synthetic-clinicaldocumentsbucket-1wv5abdrcnn7.
- Key:clinical-core/authenticated-api/care-release/5b6f8aa45347d33757ac9bfb34658e2e09daefd3/644967eec4241c19f2365aabc7cec304f200f95622c8ef3a0188f57633dd64db.zip.
- Exact S3 version:hruo6Qx4lq5maqBp.E_Kp.x1utrFXFPh.
- Change set:arn:aws:cloudformation:us-east-2:588966314750:changeSet/care-release-1c598354d9e398432cf74aa2e6cad22e/8de53f04-c098-492b-a241-9a4aab9a7bd8.
- Reviewed template canonical SHA-256:dfd973cb9ba14323bc25f64219a91ce1ace63f5dd88e1b496ee25513bdad5dc2.
- Report directory:dist/synthetic-care-release/5b6f8aa45347d33757ac9bfb34658e2e09daefd3/11197e527a1ffc9317513837087e347531076957/change-sets/1c598354d9e398432cf74aa2e6cad22e0bdad191ac5d6dc380831fc61773fab1.

The source tool creates and inspects an unexecuted change set only. Execution
was a separate controlled operator step after another full live preparation,
source check, observed function revision and freshly reverified AWS change set.
Only the existing Lambda Code changed, with Code.S3ObjectVersion pinned and
the obsolete route-count output corrected. All other ten parameters, IAM,
environment declarations, authorizers and routes stayed unchanged; the four
source-only routes remain absent. No code tool silently executed its plan.

### Independent deployment checks

CloudFormation completed UPDATE_COMPLETE at2026-10-07T08:55:40.839Z. Function
wxv734oi12-synthetic-identity is Active/Successful, nodejs22.x,index.handler,
arm64,256MB,29seconds, no layer/VPC additions, with exactly the existing seven
identifier environment variables. Actual CodeSha256 is
ZEln7sQkHBnyNlqrx87DBPIA+VYiyO86AYj1djPdZNs= and revision
ce2df715-719f-464f-bc73-5a24e0220483. The deployed template, all eleven resolved
parameters, pinned object version, unchanged integration, all51 JWT identity
routes and all112 API routes were independently checked. Full route inventory
digest remains96dd1d133a73a8ecea3804cf95346e3da5ad0d64e6d659a6d26f1959458017cd.

Actual GET consumer records without a token and POST consumer care-data with
no token or an invalid token each returned401. These are gateway-denial proofs,
not authenticated consumer/workforce journeys, runtime legacy-erasure refusal
or cross-owner/clinic acceptance. No forged authorizer claims or substituted
health data were used.

The separately rebuilt5b6f8aa inspection operator confirmed the original
46 live/core entries (45 source),87 non-ledger tables,23,980 rows and entire
data digestbb0a6ecafad1da1f595c577124fe8e03a0e495cb524018b3f51f2e19392f3a55
unchanged. Reference history remains2 entries. It reports applied:false,
alreadyApplied:false,acceptance:false,phiActivation:false. No fixture, consent,
provider release, lasting migration or paid build occurred.

### Next engineering and review gates

The old-baseline preparation/upload/change-set commands are deliberately
one-shot: they require old58f code and the historical output32. They now refuse
this deployed successor. Do not edit pins or falsify observations to rerun them.
Extend the deployment/recovery operator with an explicit reviewed deployed5b6f8aa
binding, exact version/template/source provenance and post-deployment checks.

Next: use/create designated fictional Cognito identities with their authentic
sessions, verify safe authenticated legacy refusal and unaffected consumer/
workforce routes, implement and rehearse source-verified schema-compatible
recovery, then perform the preserving staging upgrade only after those checks.
Never restore old ID-less58f code after live ledger47; never down-migrate or
discard receipts. The saved local lab-test envelope is not on the required
fictional email domain and was not decrypted, reused or reset. No real account
is a substitute for fictional qualification.

All six original scopes remain partial: account/plan continuity and legacy
provenance; owned processing/durable cross-app delivery; complete privacy and
retained clinic amendments/cross-store disposition; eligible verified clinical
knowledge/safety; Core19.99 purchase/restore/cancel/provider/store acceptance;
exact matched release/rollback/load/security/recovery and physical iOS/Android/
five-persona acceptance. Legacy claim drain, second-device pending discovery,
missing-journal reconciliation, distinct registrar audit identity, production
program assignments and reviewed qualification candidate deployment still need
engineering. Security/retention and actual agreement/project/runtime/provider
coverage remain separate reviewed gates. Neither app is commercial or PHI
ready. PHI remains OFF, clinical holds/exclusions/source verification preserved,
paid mobile builds held.

## October 7 authenticated consumer acceptance and deployed authority inspection

The deployed identity API remains source
`5b6f8aa45347d33757ac9bfb34658e2e09daefd3`, ZIP
`644967eec4241c19f2365aabc7cec304f200f95622c8ef3a0188f57633dd64db`,
exact S3 version `hruo6Qx4lq5maqBp.E_Kp.x1utrFXFPh`. No serving code,
schema, fixture, consent/provider release or PHI flag changed in this increment.

### Authenticated AWS evidence

At `2026-10-07T09:22:22.005Z`, clean Desktop checker source
`938d37f6fcba4107cb1043b386b2a36e77566038` ran the five existing fictional
persona accounts through real Cognito sign-in and the real API Gateway.
All **20 required HTTP cases passed**: each persona received synthetic posture
200, legacy ID-less erasure 400/request_invalid, one-item thread-export query
200, and erasure-history query 200. Each export was empty; this proves the
authorized empty-response contract, not message content, transfer or isolation.
Credentials and JWTs stayed in process memory and never entered the report.
The result is in Desktop
`dist/synthetic-care-consumer/938d37f6fcba4107cb1043b386b2a36e77566038/1791364942006.json`.

No password reset, account creation, consent grant, erasure admission or
settlement was requested. Sign-in metadata and read audit activity were not
assumed immutable. New request-ID erasure receipts, workforce journeys,
self-service registration, cross-owner/clinic isolation and physical device
acceptance remain unverified by this checker.

### Live deployment and permission evidence

At `2026-10-07T09:31:22.417Z`, clean inspection source
`7548bb860ab2c9c6ef7fbdabf7973996a925b9f3` independently rebuilt the handler,
downloaded the exact deployed S3 version and verified live stack parameters,
template, configuration, 51 identity JWT routes, actual IAM trust and all three
inline policies, absence of attached policies, and encrypted 30-day logging.
The function revision remains `ce2df715-719f-464f-bc73-5a24e0220483`.
The fresh preserving operator confirmed **46 live entries /45 source entries,
87 non-ledger tables,23,980 rows**, full-data digest
`bb0a6ecafad1da1f595c577124fe8e03a0e495cb524018b3f51f2e19392f3a55`,
and the unchanged two-entry reference history.

The result is in Desktop
`dist/synthetic-care-deployed/7548bb860ab2c9c6ef7fbdabf7973996a925b9f3/1791365482418.json`.
Its historical `previousCodeSha256` field came from a normalized comparison,
not a contemporaneous observation of old code. Source
`9f953ab1877246904270be8f4fd31c8143573d35` removes that misleading report field;
the underlying AWS checks are unchanged. Do not count the historical field as
observed deployed evidence.

The first inspection at5a2d6fb refused: AWS CLI aggregation omitted
`IsTruncated`. Repair7548bb8 uses bounded, non-paginated IAM reads and still
refuses missing or true truncation flags. No permission check was weakened and
no IAM policy changed. The corrected hosted inspection passed.

### Engineering and rollout still required

The target has **no POST /clinical-core/consumer/account/bootstrap route**
(actual get-routes returned an empty list). The route exists in the separate
source account extension; designated persona sign-in does not prove a deployed
self-service registration/bootstrap journey. Implement the reviewed account
deployment and verify it with fictional identities; do not forge claims or
widen authorization to bypass the missing route.

Use `npm run verify:synthetic-care-consumer` for the bound authenticated check.
For current deployed inspection, rebuild the clean preserving operator with
`npm run build:aws-care-erasure-upgrade`, then run
`npm run verify:deployed-synthetic-care`. Old-baseline prepare/upload/change-set
commands remain deliberately one-shot. Neither new verifier permits mutation,
recovery, permanent SQL upgrade or activation.

New local release/verifier suite: **24/24 pass**, focused lint clean, typecheck
passed before the final MJS-only increments, authenticated API gate passed.
Earlier full Desktop4236/V22492 suites retain their original source scope.
Desktop0511df1 CI37597928331/37597922136 is now terminal success.
Checker938d37f CI37600110106/37600105257 and later source CI were still active
at the recorded readback, not accepted as passed.

Next engineering remains a real, source-verified, schema-compatible API
recovery rehearsal; authentic workforce and isolation checks; the preserving
staging upgrade and request-ID/receipt/settlement journeys; registration
deployment; legacy claim drain, second-device pending discovery and missing
journal reconciliation; distinct registrar audit identity; reviewed qualification
candidate deployment and production program assignments. Never restore old58f
ID-less code after live ledger47, down-migrate or discard erasure receipts.

All six original scopes remain partial: account/plan continuity and legacy
provenance; owned processing and durable cross-app delivery; complete privacy,
retained clinic amendments and cross-store disposition; eligible source-verified
clinical knowledge and safety; Core19.99 purchase/restore/cancel/provider/store
acceptance; exact matched releases, rollback/load/security/recovery and physical
iOS/Android/five-persona acceptance. Provider/agreement/project/runtime coverage,
retention and security policies and separate PHI activation still require actual
review. Neither app is commercial or PHI ready. PHI OFF, paid mobile builds held,
clinical holds/exclusions/source verification unchanged.

## October 7 immutable synthetic API recovery prerequisite

At `2026-10-07T11:00:27.279Z`, clean Desktop harness
`34d0193022a1545acfd727a8e5456c0e80c34d4c` retained and independently
read back Lambda version **1**:
`arn:aws:lambda:us-east-2:588966314750:function:wxv734oi12-synthetic-identity:1`.
The retained application source is still
`5b6f8aa45347d33757ac9bfb34658e2e09daefd3`, with deployed ZIP
`644967eec4241c19f2365aabc7cec304f200f95622c8ef3a0188f57633dd64db`
and S3 version `hruo6Qx4lq5maqBp.E_Kp.x1utrFXFPh`. No serving release or
mobile binary changed. Publishing changed Lambda bookkeeping revision to
`c7d671c2-b7d8-4fd3-8647-e6ef4c0c1228`, not the executable settings.

The tool performs fresh complete deployed inspection before publication,
service-side code/revision guards, bounded actual version inventory, qualified
readback of all executable configuration, and a second complete deployed
inspection. An existing exact version is reusable without a new publication.
Unknown publication results are not retried. It contains no alias, integration,
permission, code/configuration update, clinical-data or schema mutation method.

The first attempt at2994648 stopped without a report. Independent inventory
showed only $LATEST, so no version existed; a separate read-only inspection
then passed. The cause of that attempt is unproven. Repair34d0193 preserves a
bounded child refusal and its preflight/postflight stage without printing
commands, tokens or transport responses. The subsequent actual run passed.

Evidence is in Desktop
`dist/synthetic-care-retained-version/34d0193022a1545acfd727a8e5456c0e80c34d4c/1791370827282.json`.
Preflight and postflight are in
`dist/synthetic-care-deployed/34d0193022a1545acfd727a8e5456c0e80c34d4c/`,
files1791370769653.json and1791370826565.json. Both verify actual IAM/logging,
exact-version S3 readback, the unchanged template and 51 identity JWT routes,
**46 live/45 source ledger entries,87 non-ledger tables,23,980 rows** and full-data
SHA `bb0a6ecafad1da1f595c577124fe8e03a0e495cb524018b3f51f2e19392f3a55`.
The two-entry reference history is unchanged. No alias/traffic switch, SQL
upgrade, fixture/consent/provider release, PHI activation or paid build occurred.

**Retained configuration is not functional recovery acceptance.** Version1 has
not been exercised through a recovery traffic switch or after live ledger47.
The report explicitly sets recoveryRehearsed, functionalRollbackVerified,
afterUpgradeVerified and upgradeAuthorized false. A genuinely source-verified,
schema-compatible recovery and return-to-candidate rehearsal remains required
before the permanent preserving upgrade. An identical ZIP under another key,
maintenance-only fallback or compatible source test cannot substitute. Never
restore old58f ID-less code after47, down-migrate or discard receipts.

Source commits2994648/34d0193 are pushed on Desktop's commercial branch/PR67.
The final local release-tool suite is **32/32 pass**, including unknown outcome,
configuration drift, pagination, reuse and sanitized child-failure negatives;
focused lint passes. Typecheck passed at2994648 before the final MJS-only repair.
Earlier full Desktop4236/V22492 suites retain their original source scopes.
Desktop9f953ab CI37601300901/37601294830 and2f3ac56 CI37601676214/37601669764
are terminal success; V2ed8689d CI37601690138/37601683010 is terminal success.
New2994648 CI37610533967/37610528088 and34d0193 CI37610946797/37610939442
are active/queued at readback, not passes. AST-only Desktop Graphify now has
13,210 nodes,26,882 edges,940 communities;50 zero-node files remain absent,
HTML skipped for size,no LLM/API cost.

Next engineering still includes authentic workforce/isolation checks, real
functional recovery, preserving staging SQL and request-ID/receipt/settlement
journeys, reviewed self-service/bootstrap deployment, legacy claim drain,
second-device pending discovery and missing-journal reconciliation, distinct
registrar audit identity, production program assignments and reviewed
qualification candidate deployment. Hosted export/retention/recording/drafting
acceptance, exact matched releases and physical iOS/Android/five-persona
acceptance still require execution. Core19.99 purchase/restore/cancel and provider/
store acceptance remain open, as do eligible clinical-source releases, retained
clinic amendments and cross-store privacy disposition. These are not all human-only.

All six original scopes remain partial and unchanged. Reviewed security,
retention and actual agreement/project/runtime/provider coverage, policy
choices and separate PHI activation are independent gates. Neither app is
commercial or PHI ready. PHI remains OFF, paid mobile builds held, clinical
holds/exclusions/source-verification requirements preserved.

## October 7 V2 contradictory erasure receipt repair

V2 source `5a446ecee0c757f8c42d96773918897ee50b6102` is pushed and
remote-matched on agent/v2-commercial-20261005/PR21. It adds consistency checks
before an erasure receipt can clear the durable owner request, both in the
actual care-data transport and in the journal's injected recovery boundary.
It does not change Desktop runtime, SQL, deployed AWS resources or a mobile binary.

The new negative test failed against the old client: a receipt retaining a
cancellation row with no retention reason was accepted as terminal. The repair
requires a retention reason exactly when its count is positive, refuses domain
receipts claiming deletion of signatures/packets/disputes/consult requests or
cancellation tombstones, and refuses closure receipts claiming those rows were
retained. Shared threads containing another participant's record remain valid
retained records. Counts are not estimated or substituted.

A contradictory send or recovered receipt leaves the exact pending UUID intact.
After a lost reply, a later consistent receipt can resolve that same intent
without repeating deletion. Transport tests cover send, receipt read and
settlement responses, distinguishing uncertain mutation from unavailable read.
These are consistency checks, not proof that a server erased data or a
certification of full-account, original-clinic-record or cross-store deletion.

Final local verification: **2,498 tests passed /1 existing skip,216 files,
31.97 seconds**, installed TypeScript clean, Expo lint clean, TestFlight source
check passed with364 source files scanned. The initial four focused suites
passed47 tests before the two final transport/recovery cases; the full run
includes those final cases. No intercepted response counts as real AWS/device
acceptance. New-source hosted CI is not yet accepted as passed. Earlier
Desktop2994648 CI37610533967/37610528088 and V27b5522c
CI37611554369/37611546865 are terminal success, not proof for this repair.
AST-only V2 Graphify updated to6,076 nodes,12,620 edges,450 communities;
35 zero-node files remain absent,HTML skipped,no LLM/API cost.

### Lost journal and second device work remains

The current server request table contains only terminal erased/cancelled
outcomes. Its history endpoint omits request UUIDs and bounds the old summaries
to50. A journal that is absent or an empty history cannot prove that a request
never left another device or will not arrive late. This repair does not close
that gap or reconcile pre-journal requests.

The remaining implementation must durably register intent before destructive
dispatch, expose bounded owner-scoped discovery with request IDs and exact
states, and let another authorized device reconcile or explicitly fence the
same ID without reissuing deletion. Discovery and terminal settlement must be
serializable with admission; a negative read is not a cancellation fence.
Historical ID-less requests need an explicit transition/reconciliation path;
timestamps or similar counts cannot manufacture correlation. Preserve immutable
receipts, revoked legacy erase authority, exact historical migration bytes and
all original rows during any new preserving upgrade. No new SQL or registration
workflow was implemented or activated in this increment.

The real schema-compatible API recovery drill and request-ID hosted journeys
remain outstanding. API source5b6f8aa and retained version1 remain the dated
AWS evidence; this newer V2 source is not their matched mobile binary. The
self-service/bootstrap deployment, legacy claim drain, registrar identity,
production assignments, qualification candidate acceptance and complete privacy
workflows also remain engineering. All six original scopes remain partial;
matched releases, physical iOS/Android/five personas, Core19.99 store/provider
acceptance, source-verified clinical releases and separate security/retention/
agreement-project-runtime-provider reviews are still required. Neither app is
commercial or PHI ready. PHI OFF, paid builds held, clinical holds/exclusions
and source-verification requirements unchanged.

## October 7 Durable erasure intent source candidate

Desktop source ad59aae8e9da16bb607cb460114d570138270ed2 is pushed and
remote-matched on agent/commercial-readiness-20261005, PR67. This introduces
immutable owner/request/scope intent registration before destructive admission
and owner-scoped UUID-keyset discovery. The original terminal function is
preserved under a private predecessor name; its raw API execute grant is revoked.
The guarded wrapper refuses new deletion without the exact prior intent.
Cancellation and receipt recovery still support historical terminal UUIDs.
A cancelled UUID never becomes prepared again. Discovery never reissues deletion.

This is a BLOCKED SOURCE CANDIDATE, not a canonical migration or serving release.
The SQL is infra/aws-clinical-core/source-candidates/care-erasure-intents.sql.
The separate service and contract libraries are not imported by the live identity
handler. No preserving operator exists and no AWS schema, routes, identity,
provider, consent or activation changed. Existing canonical staging history
remains source46/live46 with its historical alias; this candidate requires the
source46 terminal schema, whose lasting application remains outstanding.

Local checks: 19 actual PGlite database tests pass using the non-superuser API role
for boundary assertions; 4 release-mapping tests pass; installed typecheck and
focused lint pass; the existing clinical-core gate and 32 release-tool checks pass.
The full local Desktop suite passes: 338 files, 4,255 tests and 11 existing skips,
293.21 seconds. The process used America/Los_Angeles and cleared the stray test
CLINICAL_SUPABASE_ANON_KEY setting; no provider credentials were printed or changed.
The tests cover lost prepare replies, terminal replay, both cancellation orders,
owner isolation, immutable intents, raw/helper/predecessor grant denial, malformed
paging/replies, old receipts, explicit legacy counts and rollback on receipt failure.
They do not prove real AWS transaction races, hosted recovery or physical devices.

Commands: npm run test:care-erasure-recovery-source and
npm run build:care-erasure-recovery-source. The clean build binds source46 history
52f2027ba0db0fd570bc4714fadf5ccd39e2caabf992081cb24be56497a52017 and normalized
overlay aa96e287e3a67095ee523030b9d00a9f015563fe0926c3c405ca90bf91e8dd8d.
Its metadata declares deployable, operatorExists, handlerIntegrated,
clientIntegrated, hostedVerified, deviceVerified and productionApproved false.
Source hashes are not review hashes. The SQL bytes are LF-pinned.

Discovery coverage is committed_owner_records_not_global_clearance. An empty page
or a completed scan does not fence unregistered/in-flight requests or certify
all-device clearance. New UUIDs can be inserted behind a cursor, so refresh is
required and no atomic scan is promised. Older ID-less erasures are counted,
never correlated by timestamps or similar counts. Immutable intent/terminal
retention still needs a reviewed disposition policy; provider copies are outside
this candidate's coverage.

Next: register and preserve the migration through a reviewed operator with
rollback/data proof, integrate API actions and exact schema/code release mapping,
then implement V2 server preparation before dispatch, durable journal and
owner-paged discovery with explicit receipt/settlement recovery controls.
Run real concurrent/lost-reply/second-device and denial journeys before activation.
The actual API recovery drill, registration/bootstrap deployment, legacy drain,
registrar audit identity, production assignments, qualification candidates,
complete privacy/clinic amendments/disposition, matched releases, physical devices,
Core19.99 store/provider acceptance and eligible source-verified clinical releases
remain. All six original scopes remain partial. Neither app is commercial or
PHI ready; PHI OFF, paid builds held, clinical holds and verification unchanged.

## October 7 Paired erasure recovery source integration

Desktop runtime 8faddc7cbd428d9bde3d960c99fe1dc7963d0675 and V2 runtime
811f55b3d6841dc01d64e966ef29a8183c887fbf are pushed and remote-matched on
the existing commercial-readiness branches, PR67 and PR21. The prior dated
source-candidate section remains historical evidence; this section supersedes
its statement that API routing and V2 source integration are not implemented.

The existing synthetic consumer care-data route now accepts prepare_erasure
and discover_erasure_requests. It derives the owner from authenticated claims,
checks current expiry, and rejects body ownership overrides before SQL.
Recovery uses the existing database/API authority; no new API URL or IAM grant
is introduced. An absent schema or internal database fault returns unavailable,
not success or a misleading invalid-sign-in message. Actual RDS error
classification now recognizes care_erasure_intent_required as an invalid request.

V2 writes and verifies the exact local intent before server preparation.
Only a verified prepared reply permits the destructive request. A lost,
refused or malformed preparation reply keeps the same UUID pending and never
falls through to deletion. Receipt and explicit settlement recovery do not
retry preparation or deletion. A terminal preparation reply is recorded without
a new deletion. Recovery on another authorized device saves the selected exact
ID locally before reading or cancelling it, and refuses to overwrite another
pending or lifetime-completed ID.

The privacy screen can page committed owner requests, read exact receipts and
explicitly stop late arrival. An owner-level PostgreSQL lock refuses another
new UUID while a committed prepared intent is unresolved. Local/remote pending
records, further pages and legacy uncorrelated records block a new removal.
An empty page or completed scan is not all-device clearance; unregistered or
in-transit requests are not certified. No request is sent by rendering the list.
Authorization/background invalidation clears opened recovery data. Production
still uses the separate retained-message privacy component, not this synthetic
candidate.

Final local evidence: Desktop 338 files, 4,263 passed, 11 existing skips,
289.74 seconds; V2 217 files, 2,509 passed, 1 existing skip, 28.57 seconds.
The Desktop run uses America/Los_Angeles with the stray test-only environment
key cleared in that process. Installed compilers and lint pass on both.
Desktop focused database/API/RDS classification checks pass 230/230; source
mapping passes 4/4; clinical-core gate passes; retaining/deployed/release tools
pass 17/17. V2 focused journal/transport/render checks pass 59/59, TestFlight
source gate passes 365 files, and capabilities gate passes. The earlier
Desktop full run failed two fixture error-classification assertions; the
fixture was corrected to match the real RDS identity classification, and the
fresh full run above passed without weakening those assertions.

The normalized Desktop/V2 recovery contracts match exactly at SHA-256
5d991aa388a61942e2de99236fcd85308d1d1bf60a919f8c9aeb43ff1333de35.
A clean source build binds predecessor source46 history
52f2027ba0db0fd570bc4714fadf5ccd39e2caabf992081cb24be56497a52017 and overlay
4be2ca72b0486bec171f16c5299c898d70bfbdbfd3143c4bb216fccc329299ec (9,225 bytes).
Its source handlerIntegrated flag is true; deployable, canonicalRegistered,
operatorExists, matchedMobileRelease, hostedVerified, deviceVerified,
productionApproved and phiAllowed remain false. Source identity is not a
review hash or a matched serving release. The actual serving API remains
5b6f8aa45347d33757ac9bfb34658e2e09daefd3 with mobile binding 11197e5.
No AWS operation, lasting schema application, traffic switch, consent/provider
release, TestFlight/Android build or PHI activation occurred for this integration.

Next engineering is the preserving operator and canonical migration/release
mapping, including historical alias, original rows, grants and terminal receipts;
the real schema-compatible API recovery and return-to-candidate rehearsal;
then authentic hosted preparation/lost-reply/cancellation races, owner isolation
and second-device recovery. Run those with exact matched sources before device
acceptance. Legacy claim drain and ID-less erasure reconciliation, registration/
bootstrap, registrar audit identity, production assignments and qualification
candidate acceptance remain. Complete privacy/clinic amendments/disposition,
source-verified clinical releases, Core19.99 store/provider acceptance and exact
matched releases/physical iOS/Android/five personas are not proved by these
tests. Separate security, retention, actual agreement-project-runtime-provider
reviews and PHI activation approvals remain human gates. All six original scopes
remain partial; neither app is commercial or PHI ready. PHI OFF, paid builds held,
clinical holds/exclusions and source-verification requirements unchanged.

## October 7 Preserving intent upgrade library and release mapping

Desktop source 38fb3667860e8ba0a46c86bbb96ef1838bd67c42 is pushed and
remote-matched on agent/commercial-readiness-20261005, PR67. V2 runtime remains
811f55b3d6841dc01d64e966ef29a8183c887fbf. This adds an administrative operator
library candidate, not an AWS command or authorization to apply it. The
canonical staging manifest is unchanged at source46.

The library supports inspect, rollback rehearsal and an idempotent successor
transaction. It refuses an unapplied terminal predecessor, wrong account,
database, region, PHI posture, reference history or altered SQL. The historical
alias is preserved verbatim. Operator and writer locks protect the transaction;
every admitted original/reference/receipt row is fingerprinted within the
existing 100,000-row per-table bound. A bounded prefix never counts as a full
preservation check. An independently read-back inspection verifies rollback.

Preserved schema checks include old columns, defaults, constraints, indexes,
policies, triggers and ACLs, not only counts and row-level security flags.
Successor checks pin exact function bodies, search paths, execute authority,
the immutable intent trigger, all four intent columns and their defaults and
constraints. Raw table/helper/predecessor API authority is refused. A failure
rolls the disposable transaction back without hiding its bounded stage.

The separate candidate maps source46/live47 to source47/live48 using migration
20261007010000 synthetic_care_erasure_intents. Exact overlay bytes remain
4be2ca72b0486bec171f16c5299c898d70bfbdbfd3143c4bb216fccc329299ec.
Candidate source-after digest is
02026932fff5a37db42a17a1c4f80bd38a759cf8e2ccb2f4d53b8299c66065e7;
live-after digest is
447cf4ea8c8da3decbaa7edea964f97d9e3bdb029c38723bf3a5767c38679a50.
No canonical ledger has been rewritten. The clean source builder now emits
the preserving operator library SHA
193ce599d901cab7251e246e0ef403cc1b02fa3cca594d387cb902619a598e44.
CI builds the blocked libraries and tests mapping drift. Metadata says
preservingOperatorLibrary true, while operatorExists and deployable remain
false because a reviewed AWS executable/invocation is not provided.

Final local checks: 339 Desktop files, 4,289 passed, 11 existing skips,
303.82 seconds; installed compiler and lint pass; focused predecessor/successor
database tests pass 54/54, source mapping 4/4 and clinical-core gate passes.
The new successor suite has 26 cases against actual disposable PGlite SQL.
Only the database name is substituted; these tests do not establish real AWS
lock races, upgrade/recovery, hosted journeys or device acceptance. Initial
column-drift test failed on diagnostic order; schema comparison now precedes
data comparison, preserving the original negative assertion. An interim
compiler failure on optional alias narrowing was repaired before the final run.

Read-only AWS inspection reconfirmed account588966314750, clinical_core,
46 live/source45 migrations, 87 tables and 23,980 rows with unchanged digest
bb0a6ecafad1da1f595c577124fe8e03a0e495cb524018b3f51f2e19392f3a55 and
reference history83d51dc056b41f47b5fb3d6020201163915faa2116004e3692af9bb41aad0f62.
The first SDK inspection ended with upgrade_failed:transaction_start;
a direct read confirmed migration count46 and the repeated full read-only
inspection passed. The original failure is not a pass or a proven cold-start
diagnosis. That inspection used the uncommitted source build and is not release
qualification. Lambda code/revision readback remains
ZEln7sQkHBnyNlqrx87DBPIA+VYiyO86AYj1djPdZNs= /
c7d671c2-b7d8-4fd3-8647-e6ef4c0c1228, Active/Successful.
No lasting schema, record, API traffic, provider/consent release, PHI or paid
mobile build changed.

Next: implement the reviewed AWS invocation and canonical release transition,
complete the real schema-compatible API recovery/return-to-candidate drill,
then apply preserving successors only after their prerequisites pass. Run
authentic hosted lost-reply/cancel/late-admission/owner-isolation/second-device
journeys with exact matched sources. Legacy drain and ID-less reconciliation,
registration/bootstrap, registrar identity, production assignments,
qualification candidate acceptance, complete privacy/clinic amendments and
disposition, eligible source-verified clinical releases, Core19.99 store/provider
acceptance and matched releases/physical iOS/Android/five personas remain.
Separate security/retention/actual agreement-project-runtime-provider reviews
and PHI activation approvals remain human gates. All six original scopes are
partial; neither app is commercial or PHI ready. PHI OFF, paid builds held,
clinical holds/exclusions/source-verification requirements preserved.

## October 7 Fixed intent inspection and rollback executable

Desktop source **784154086cb8469f21235be60008a776f1df7068** is pushed and
remote-matched on PR67. V2 runtime remains
**811f55b3d6841dc01d64e966ef29a8183c887fbf**; this increment changes no mobile
runtime, native build or device evidence.

The embedded runner is built with
`npm run build:aws-care-erasure-intent-inspector` and emitted at
`dist/aws-clinical-core/care-erasure-intent-operator/index.cjs`. Clean artifact
SHA256 is **071a2abbb1d3915c7264166764b49dbfa0b26922b5a07d803b535e5b8aa0d638**.
It binds exact source46/reference2/overlay artifacts and the fixed synthetic
member account, completed foundation, cluster, secret, database and API.
`inspect` is read-only. `rehearse --confirm-fictional-intent-rollback` requires
a clean source build, initial inspection, transactional rollback with independent
readback, final complete data/schema/history comparison and fresh AWS observation.
Wrong accounts, changed/missing outputs, overrides, artifact drift, altered
results and approval claims fail closed.

The executable deliberately has no lasting-upgrade route:
`upgrade` returns `api_recovery_required` before AWS access. Neither a saved
report nor an environment flag nor a confirmation substitutes for actual API
recovery. This is an inspection/rehearsal executable, not the completed release
operator. Source mapping now explicitly separates
`inspectionRehearsalExecutable:true` from
`lastingUpgradeExecutable:false`; `operatorExists:false` still means no
approved lasting release invocation. Canonical registration and deployability
remain false. Parent/operator pins and all migration SQL bytes are unchanged.

Local focused **37/37** (26 database successor cases plus 11 command cases);
compiler/lint, clinical-core gate, source mapping **4/4**, and clean builds pass.
Final documented `npm run test:unit`: **340 files, 4,300 passed, 11 existing
skips, 296.82 seconds**. The first raw invocation failed with two hook timeouts
and a missing required TZ; it is not a pass. Windows recorded a standby
transition during that run. The documented rerun changes no tests, skips or
deadlines. An earlier `npm test` invocation had no such package script and did
not run the suite.

Hosted source CI **37630753091** and **37630760785** at 7841540 are terminal
success; the preceding 38fb366 and 090e8de runs are also terminal success.
CI proves source/browser checks, not hosted migration or device acceptance.
Final AST-only graph: **13,316 nodes, 27,122 edges, 946 communities**; 50 zero-node
files absent, HTML skipped for graph size, no LLM/API cost.

Fresh AWS STS is member **588966314750**. The first new inspection ended
`upgrade_failed:transaction_start`; the direct read reported
`DatabaseResumingException`. A subsequent inspection reached the database
and returned **history_refused:history**, correctly refusing the unapplied
terminal parent. Final direct read: **clinical_core, 46 migrations, zero records
updated**. Lambda remains Active/Successful at codeSHA
**ZEln7sQkHBnyNlqrx87DBPIA+VYiyO86AYj1djPdZNs=**, revision
**c7d671c2-b7d8-4fd3-8647-e6ef4c0c1228**. These refusals are not positive hosted
acceptance or a full data fingerprint. No lasting schema, records, traffic,
provider/consent releases, PHI settings or paid builds changed.

Next: implement and execute the schema-compatible API recovery and return-to-
candidate drill; gate the lasting parent/successor invocation on observations
from that drill; register the versioned canonical successor without rewriting
history; then run actual lost-reply, cancellation, late-admission, owner isolation
and second-device journeys. Legacy drain/ID-less reconciliation, bootstrap and
registrar authority, production assignments and qualification acceptance,
complete clinic amendments/disposition/privacy, eligible verified clinical
releases, Core $19.99 store/provider acceptance, matched releases and physical
iOS/Android/five-persona acceptance remain engineering or verification work.
Security, retention, actual agreement/project/runtime/provider coverage and
separate PHI activation remain human gates. **All six original scopes are
partial. Neither app is commercial or PHI ready. PHI OFF; paid builds held;
clinical holds, exclusions and source-verification requirements preserved.**
