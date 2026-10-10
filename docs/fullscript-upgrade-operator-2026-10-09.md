# Fullscript qualification upgrade operator

The separate local operator can inspect, rehearse, apply and reconcile the exact
107 or 108 to 111 schema transition in the isolated synthetic database. It does
not install the Fullscript API, authorize a provider call, create an approval or
enable patient data. PHI stays false and production activation stays blocked.
The installed cart route still reports `not_implemented`.

## Target and operator binding

Build with `npm run build:fullscript-upgrade` from committed, clean source.
The operator is `dist/aws-clinical-core/fullscript-upgrade/index.cjs`; its
separate `artifact-manifest.json` records the source commit and operator digest.
Dirty builds remain marked dirty and the public command refuses them. A smoke
build during development is not a usable reviewed release.

The target is a separate, bounded UTF-8 JSON file. It has contract
`fullscript-upgrade-target/1`, execution `qualification`, account `588966314750`,
region `us-east-2`, foundation `ai-clinical-core-qualification-foundation` and
operator role `OrganizationAccountAccessRole`. Its database and staging refusal
are `clinical_core_qualification` and `clinical_core`, respectively. Cluster and
secret ARNs must equal the current foundation outputs. `sourceCommit` and
`operatorSha256` must equal the actual clean build. The predecessor is the exact
107 or 108 ledger identity in the release document; the successor is the pinned
111 ledger. `phiAllowed` is false and `activation` is `blocked`.

The review object records `reviewer`, `reviewedAt` and `scope`: Brandon Bright,
the actual UTC review time and `fictional-schema-transition-only`. Do not fill
those values on the owner's behalf or reuse a security/retention approval.
This privileged local metadata is not a cryptographic signature or proof of a
clinical/provider review. The operator requires the owner's explicit local
confirmation; this review can authorize only a fictional schema transition.

Serialize the reviewed file with object keys recursively sorted, array order
unchanged, no extra whitespace and exactly one trailing LF. The caller supplies
its SHA-256. Any change requires another review/hash; duplicate keys, unknown
fields, ambiguous encoding and future review dates are refused. This hash
binds reviewed bytes, not the zip's own digest inside itself.

## Commands

Every command takes `--target <absolute-file>` and `--target-sha256 <sha256>`.
Use the exact built operator, not an operator rebuilt from a later checkout.

| Command | Additional confirmation | Effect |
| --- | --- | --- |
| `inspect` | None | Read-only parent inspection; a completed 111 target requires reconciliation |
| `rehearse` | `--confirm-fictional-fullscript-upgrade` | Actual extension SQL and receipts inside a transaction, then rollback and original-state readback |
| `upgrade` | `--confirm-fictional-fullscript-upgrade` | Mandatory rehearsal, durable writer admission, one forward call and two locked successor readbacks |
| `reconcile` | `--reconcile-fictional-fullscript-upgrade` | Three locked inspections of original custody's target; no forward call, inverse migration or retry |

For example, run the built operator with `inspect --target <file>
--target-sha256 <reviewed-sha>`. Do not run an upgrade until the artifact and
target have been reviewed and the current source checks pass. There are no
profile, endpoint, region, database, PHI or custody-directory overrides.

Current STS and DescribeStacks observations are repeated before protected
steps; environment booleans and saved reports cannot substitute. The actual
database identifies itself again. The existing fixed member-profile Data API
transport has one attempt, a pinned endpoint and bounded requests, and refuses
`continueAfterTimeout`. It never retries a migration after an uncertain reply.
AWS documents that [commit ends the transaction](https://docs.aws.amazon.com/rdsdataservice/latest/APIReference/API_CommitTransaction.html)
and that [transaction expiration and running queries require careful handling](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/data-api.troubleshooting.html).
No timeout or empty inspection is treated as proof that an admitted writer stopped.

## Custody and recovery

The operator uses the existing shared routing/operator namespace, not a private
lock per checkout. A complete archived header, original operator and baseline
journal precede atomic hard-link publication of `operator.lock`. Every journal
entry has an ordered stage and hash chain. The target digest is in the binding.
Changed source, targets, journals, directory identities or fences refuse.

The SQL transition and settled inspections acquire migration, fixture and
historical-table locks. Historical rows and receipts, roles, grants, functions,
schema metadata and existing domain constraints are checked. Successor inspection
also checks all eight new tables and 22 functions and requires their rows empty;
it cannot certify a target on which provider/authority activity already occurred.
There is no destructive rollback of a committed Fullscript intent or hold.

A failed or uncertain forward call retains the lock and journal. Reconciliation
requires the original exact artifact and target, the same host, an actually stopped
original process, at least 60 seconds after the last journal observation and the
database fence. Time alone is insufficient. A torn final journal entry is retained
and cannot create write admission. A changed or live recovery guard is not replaced.
Both a preserved predecessor and a preserved successor may be observed, but an
unadmitted successor cannot be certified. The original write outcome remains
`unknown`; reconciliation reports its observed state and never claims to recover
the missing transport response.

Normal settlement archives a verified receipt before removing the matching shared
lock. Recovery archives the original bytes before retiring only matching custody.
The local file protocol handles process interruption; it is not a guarantee about
disk power loss or a remotely replicated audit archive.

## Verification and hosted work

The final operator group passed 76 tests in four files. Relative target paths
are refused before file access or AWS observations. Real files and process
liveness, the actual SQL transition, rollback and journal composition are covered.
AWS observations and the outer multi-session fence are fictional in those tests;
PGlite does not prove multi-session Aurora behavior. The related draft/authority/cart
group passed 621 tests in 16 files, and the release builder passed 16 tests.
Typecheck and targeted lint passed with locally reused dependencies.

The first fixture failed because its hold author lacked the required reviewer
identity, not because the safety constraint was wrong. The corrected fixture
creates an explicitly fictional reviewer before the preservation baseline and
retains the immutable hold until fixture disposal. Initial typing and fixture
failures remain failed observations. No runtime protection was weakened.

Read-only AWS observations on October 9 show the member role, prepared inactive
qualification foundation, PHI false, activation blocked and the exact 107 ledger
`542b101ca1729576d2b203c9c2b3d98d2d9dd897e7480ab08ff150c8eacf773c`.
The filename-bound 107 artifact is
`79e84d1984eb45780da3d66d119c7e0b6105b5f964821ce8ea54b997dcb401db`.
The first read encountered Aurora auto-resume; the subsequent same read succeeded
with zero records updated. No new schema was applied.

Required next: exact clean operator/target review, actual AWS rollback rehearsal,
forward transition and interrupted-response recovery qualification. Measure native
transport, engine metadata/shape equality, locks and settlement rather than assuming
the local result transfers. Then build and qualify the separate Fullscript API
target loader, published version, restricted IAM and provider sandbox workflows,
including privacy/holds/retention and OAuth settlement. All six original launch
phases, matched releases, physical-device checks and actual policy/provider reviews
remain incomplete. No paid mobile build or real patient-data activation is implied.
