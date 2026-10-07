# Synthetic care release preparation

This release binds the request-ID erasure API to the matching V2 source, the
existing synthetic database and its preserved historical alias. It prepares
artifacts only. It does not deploy, authorize deletion, qualify a mobile binary
or activate real patient data. All six commercial-readiness phases remain partial.

## Build and inspect

Both checkouts must have committed, clean runtime sources. Graphify output is
not a runtime input. Commands below run from the Desktop checkout. Replace only
the V2 filesystem path, not the fixed AWS target.

```powershell
npm run test:synthetic-care-release
npm run build:synthetic-care-release -- --v2-root C:/path/to/V2
npm run build:aws-care-erasure-upgrade
node scripts/prepare-synthetic-care-release.mjs --v2-root C:/path/to/V2 --candidate dist/synthetic-care-release/DESKTOP_HEAD/V2_HEAD --prepare-fictional-only
```

The deterministic candidate ZIP contains exactly `index.js` and `release.json`.
The manifest binds both source commits and file inventories, matching care-data
contracts, the device journal and transport, synthetic native build profiles,
the source template and exact core/catalog migration histories. Preparation
rebuilds the actual current API and byte-compares it before any AWS request.
An artifact hash alone is not source provenance.

The inspection operator must also be built from the same clean Desktop commit.
Preparation observes member STS identity, the completed staging foundation,
stack parameters/template, active Lambda code/configuration, JWT authorizers,
all identity-integration routes and the operator's read-only database inventory.
It refuses root, other accounts/databases, source or history drift, unknown
routes, missing/doubled authorities and the wrong deployed code.

Account is `588966314750`, region `us-east-2`, API `wxv734oi12`, database
`clinical_core`. This is not `clinical_core_qualification` or production.
There are 51 deployed identity routes. Source defines 55; the four absent
routes stay absent. The candidate fixes only the obsolete route-count output
and changes only the code-key parameter; IAM and authorization stay unchanged.

## Verified code-artifact upload

With both source commits clean, build the candidate and same-source inspection
operator above. The uploader itself reruns preparation against live AWS before
any write; a saved plan or fabricated checksum cannot substitute for that check.

```powershell
npm run upload:synthetic-care-release -- --v2-root C:/path/to/V2 --candidate dist/synthetic-care-release/DESKTOP_HEAD/V2_HEAD --upload-fictional-code-only
```

Only the fixed synthetic code bucket/key is writable. Region, owner, enabled
versioning and the exact KMS key are verified. A conditional create-only put
cannot overwrite an existing key. A 412 is reusable only after exact-version
HEAD and a bounded actual download agree on source metadata, encryption, byte
length and SHA-256. A 409, timeout, access denial, wrong object or unknown result
is not success and never triggers a blind retry or deletion. The recorded S3
version ID must be pinned as `Code.S3ObjectVersion` in the subsequent reviewed
Lambda-only change set; deploying a mutable latest key is not sufficient. Upload alone is
not deployment, recovery rehearsal or hosted application acceptance.

AWS semantics: [conditional PutObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html)
and [version-specific GetObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html).

## Reviewable code-only change set

```powershell
npm run prepare:synthetic-care-code-change -- --v2-root C:/path/to/V2 --candidate dist/synthetic-care-release/DESKTOP_HEAD/V2_HEAD --prepare-code-change-only
```

This reruns the full live preparation and version-specific S3 readback, pins the
actual version into the Lambda code declaration and creates an UPDATE change
set. It verifies the proposed AWS template, all resolved parameters and every
resource change. Only the existing identity Lambda's Code may change; its role,
environment, JWT routes and database remain untouched. Incomplete, paginated,
wrong-target or non-code changes cannot receive a review report. The tool has
no stack-execution method. An AVAILABLE change set is not a deployed candidate,
an API recovery rehearsal, hosted journey evidence or a PHI approval. Its target
must be freshly checked again before execution, particularly the still-old
database ledger and source-compatible recovery requirements.

AWS review semantics: [CreateChangeSet](https://docs.aws.amazon.com/AWSCloudFormation/latest/APIReference/API_CreateChangeSet.html).

## Authenticated consumer checks

```powershell
npm run verify:synthetic-care-consumer
```

The checker binds to the deployed 5b6f8aa identity API and its exact ZIP digest,
the synthetic member account, the native consumer pool and the five existing
fictional persona records held in Secrets Manager. It refuses dirty runtime
source, non-fictional credentials, an incorrect token owner or audience, a
short-lived token, a changed deployment and oversized or mismatched responses.
It neither creates accounts nor resets passwords. Sign-in metadata and read
audits may change; it requests no clinical-data mutation.

Each authentic session checks the synthetic posture, the refusal of old
ID-less erasure, a one-item thread export and erasure-history retrieval. A
successful report under `dist/synthetic-care-consumer/HARNESS_COMMIT/` contains
only statuses and counts, never credentials, tokens or record content. A
failure stops at the first broken boundary. These checks do not verify new
erasure admission or receipts, workforce access, self-service registration,
cross-owner isolation, browser rendering or physical mobile acceptance.

## Inspect the deployed successor

```powershell
npm run build:aws-care-erasure-upgrade
npm run verify:deployed-synthetic-care
```

This read-only path supports the reviewed deployed 5b6f8aa ZIP and its exact S3
version without relaxing the original one-shot preparer's old-code guard. It
rebuilds the current handler and compares its actual bytes with the deployed
artifact, downloads that exact version, and checks the live stack, parameters,
function configuration, all 51 identity routes and their native JWT authorities.
It also inspects the actual IAM role and policies, including trust, absence of
attached policies, resource-bound permissions and logging encryption/retention.
An unchanged template cannot conceal a manually broadened role. Sensitive
configuration values never become credentials in the report.

The preserving database operator must be rebuilt from the clean current source.
Its inspection verifies the existing 46-entry staging ledger, historical alias,
two-entry reference ledger and original 87-table inventory. The recorded row
count and data digest are a fresh observation, not an assertion that read-audit
growth must equal an earlier count. The report does not authorize a migration,
execute a change set, rehearse recovery or certify an application journey.

## Retain the deployed recovery version

```powershell
npm run retain:synthetic-care-version
```

This command retains a numbered immutable version of the exact deployed 5b6f8aa
handler. A fresh full deployed inspection, the clean harness source, live role
permissions, encrypted logging and the old database ledger must all agree before
publication. AWS receives both the expected code checksum and revision ID. A
bounded version inventory reconciles an existing identical retained version
without publishing again; an unknown publication result is not retried.

Qualified configuration readback and a second full deployed inspection verify
the retained code, executable settings and unchanged target. Reports under
`dist/synthetic-care-retained-version/HARNESS_COMMIT/` distinguish a new
publication from reuse. The command does not change aliases, API integrations,
live traffic, permissions or schema. Publication is a recovery prerequisite,
not a functional rollback drill, a successful journey after the database upgrade
or permission to apply that upgrade. Those remain separately required below.

AWS semantics: [PublishVersion](https://docs.aws.amazon.com/lambda/latest/api/API_PublishVersion.html).

## Deployment and recovery still required

1. Independently verify the ZIP after uploading it under its exact source/hash
   key. Reobserve the live target and review a Lambda-only change set. A saved
   preparation is a dated observation, not an execution permit.
2. Deploy the request-ID-aware handler before the database upgrade. Prove old
   ID-less erasure is refused and unaffected authorized routes still work.
   Receipt requests remain unavailable until the matching SQL exists; they must
   never be translated into an uncorrelated erase.
3. Rehearse recovery using explicitly source-verified, schema-compatible code.
   After live ledger 47, the old API ZIP must not be restored: its SQL authority
   is revoked. No down migration or disposal of receipts is permitted. A
   source-compatible re-forward is not proof of a rehearsed rollback.
4. Perform the preserving upgrade only after the matched deployment/recovery
   path is ready. Rehearse and independently inspect every original row and
   both ledgers. The earlier successful rollback-only schema rehearsal is not
   API or erasure journey acceptance.
5. Build matched native candidates only after paid-build authorization.
   Physically verify iOS/Android restart, ambiguous delivery, exact receipt,
   settlement, second-device convergence, owner isolation and retained clinic
   records. Historical ID-less requests and missing device journals still need
   reconciliation; the new journal does not prove they failed.

Reviewed security/retention/provider configuration, real agreement coverage,
Core $19.99 store/provider acceptance and separate PHI activation remain gates.
Clinical holds/exclusions/source verification and the mobile-build hold remain.

## Intent inspection and rollback runner

`npm run build:aws-care-erasure-intent-inspector` produces the embedded runner
at `dist/aws-clinical-core/care-erasure-intent-operator/index.cjs`. Its manifest
binds the exact source commit, clean status, parent 46-source migration history,
two reference migrations and the blocked successor SQL digest. The target is
fixed to member account 588966314750, Ohio, synthetic staging `clinical_core`.
Qualification and production target overrides are refused before opening a
database. Build and inspection do not authorize release or PHI activation.

```powershell
node dist/aws-clinical-core/care-erasure-intent-operator/index.cjs inspect
node dist/aws-clinical-core/care-erasure-intent-operator/index.cjs rehearse --confirm-fictional-intent-rollback
```

Inspection requires the exact terminal parent to be applied: live47/source46,
or the already-applied successor live48/source47. The older live46/source45
target is refused; this runner never applies the parent automatically. A
rollback rehearsal requires a clean build, performs initial inspection,
transactional DDL with rollback, and independent final inspection. It compares
complete bounded data digests, schema, counts and history, then freshly checks
the AWS account and completed foundation. Drift or missing prerequisites is a
refusal, not a skipped pass.

The `upgrade` command always returns `api_recovery_required` before AWS access.
There is no report-file, environment, review-hash or confirmation override.
Implement and physically observe the schema-compatible API recovery and return
to candidate before adding the lasting invocation and canonical registration.
The earlier parent upgrade executable remains held under the required order
above; its confirmation option does not meet the recovery prerequisite.

This runner changes no API traffic, records, provider releases, retention
approval or activation. `hostedAcceptance`, `recoveryAcceptance` and
`activationApproved` remain false. All six original commercial scopes remain
partial until their hosted, device, provider and human gates are satisfied.
