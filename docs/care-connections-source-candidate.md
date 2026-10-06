# Production care connection and consent candidate

This unreleased candidate implements the database and API contract for linking
a consumer account to a clinic chart and reviewing, granting and withdrawing
sharing consent. It is locally testable, not deployable. It does not register
consent copy, approve policies, create identities or enable PHI.

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
remains unreleased and non-deployable: a schema and upgrade operator are not
a serving connection handler or V2 consent interface.

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
The full regression suite is running and must be recorded separately.

This verifies local per-transaction contract metadata, not the full database
ledger, an atomic deployment snapshot, real concurrent DDL or a deployed
consumer connection. Copy registration, handler/template integration, V2 UI
and the actual hosted serving/settlement/device matrix remain unfinished.
