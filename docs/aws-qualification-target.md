# AWS qualification target (isolated, production-shaped, synthetic-only)

## Why the existing staging database is not a target

The September 21 audit inspected account `588966314750` (profile `ai-synthetic-staging`, region
`us-east-2`): foundation stack `ai-clinical-core-synthetic-staging` (Environment `synthetic-staging`,
DataClassification `synthetic_only`, PhiAllowed `false`), Aurora cluster
`ai-clinical-core-synthetic-clinicaldatabasecluster-lftvrccuflxa`, database `clinical_core`. That
database carries 30 synthetic migrations through `20260904090000`. Compared with the built
100-migration production artifact it shares 3 entries, has 8 same-version/different-hash entries and
19 recorded versions the artifact does not know. It is a different schema history, populated with
synthetic data. The earlier handoff instruction to "apply the missing subset of 79 to 100" to it was
wrong on three counts and is withdrawn:

- The production migration operator refuses mismatched and unknown ledger entries (`inspect` reports
  `safeToApply=false`; `apply` throws `history_mismatch`). Rewriting hashes or the ledger to make it
  pass is forbidden.
- The production artifact deliberately transforms synthetic names, classifications and constraints
  (`organization_label` for `synthetic_label`, `patient_key` for `synthetic_record_key`,
  `production-clinical`/`clinical_phi` posture checks). Its overlays do not fit the synthetic tables.
- The apply verification requires an empty clinical dataset. It is a fresh-schema installer, not an
  upgrade tool for a populated database.

The staging database, its ledger and its data stay exactly as they are. Nothing in this document or
its tooling reads it for anything but its ledger count, and nothing writes to it.

## Chosen architecture

An **isolated qualification database on the same synthetic cluster**: `clinical_core_qualification`
(any name is accepted that is a valid identifier, contains `qualification`, and is not the staging
database, `clinical_core`, `postgres`, `rdsadmin` or a template database). It is created empty,
receives the full production artifact through the unchanged production migration operator, and is
then seeded with fictional production-shaped fixtures. Candidates under qualification are deployed
with `DatabaseName=clinical_core_qualification`; every candidate template already takes the database
name as a parameter, so the staging stacks keep pointing at `clinical_core` and the qualification
stacks point at the new database. Same account, same region, same cluster, same secret, same PHI
posture (`false`), same STS pin.

The alternative (reviewed forward-only synthetic equivalents of migrations 79 to 100 with
synthetic-compatible handlers) was rejected: it would fork every owned-lab, personal-storage,
privacy-operations and recording handler into a synthetic dialect, and what it qualified would not be
the production schema. The isolated target qualifies the artifact that production will receive.

### Steps (Windows terminal, AWS login, `scripts/prepare-aws-qualification-target.ps1`)

| Step | Command | What it does | Refuses |
|---|---|---|---|
| 1 | `-Command inspect` | Read-only. Reports whether the qualification database exists, its ledger, and the staging ledger (count and latest version). | Production account, account/region not matching the reviewed deployment manifest, PhiAllowed not `false`. |
| 2 | `-Command create -ConfirmQualificationTarget` | `create database "<name>" encoding 'UTF8'` on the maintenance database, the one statement this tooling issues outside a transaction. Creates nothing else. | An existing database (exit 2, `qualification_database_exists`): a populated target is never re-created or reset here. |
| 3 | `-Command apply -ConfirmQualificationTarget` | Builds and gates the artifact, builds the migration operator, runs its `inspect` against the qualification database and applies all 100 migrations only when `safeToApply`. The staging name never reaches the operator. | Any mismatched or unknown ledger entry; a non-empty clinical dataset; a table or contract count other than the pinned artifact counts. |
| 4 | `-Command fixtures -ConfirmQualificationTarget -SyntheticManifestPath <manifest>` | Inserts the fictional fixtures (below) after re-checking that the target's ledger equals the artifact. | A manifest that is not synthetic-only; a ledger with anything missing, mismatched or unknown (so the staging database is refused by its own history); a manifest account other than the pinned account. |
| 5 | Deploy candidates with `DatabaseName=<qualification name>` | Identity, owned-lab, owned-voice, personal-storage, privacy-operations, recording candidates, in the dependency order of the handoff table. | Unchanged candidate refusals: export delivery, cleanup, retention schedule, transcription and drafting stay blocked until their reviewed parameters exist. |
| 6b | Qualify the voice shutdown transition (when the owned-voice candidate is set to drain) | `run-aws-voice-shutdown-acceptance.ps1` with the target manifest and two read-only inventory reports; the stack must report `Activation=draining` with qualification execution disabled. | A candidate that is not draining, one that still enables qualification execution while draining, any response that is not the `voice_cleanup_only` refusal, and any claim of erasure. |
| 6 | Run the hosted harnesses against the qualification API | `run-aws-export-retention-acceptance.ps1` and `run-aws-recording-acceptance.ps1`, each with `-QualificationTargetPath` (below), retention `release` then the sweep; `not_configured` is never a pass. | The staging foundation, API and database by name; any candidate stack that is not PHI-false, activation-blocked, qualification-enabled and deployed from the manifest's commit against the manifest's API and database. |

Rollback of the target is `drop database` by a human after review; the tooling never drops. Rollback
acceptance for the artifact itself remains `build-aws-production-rollback-acceptance.mjs`.

### Fixtures

`provisionQualificationFixtures` (`qualification-fixtures.ts`) writes, idempotently and under an
advisory lock, from the reviewed synthetic acceptance manifest: the clinic and the isolation clinic
(labels only), the workforce, consumer and isolation-workforce persons (`subject_…` keys) with their
production-bound identities, the two practitioner memberships, one patient record whose only name is
the literal placeholder "Fictional Qualification" (no email, phone, birth date or MRN), the consumer's
verified patient connection, six approved consent artifacts (programs, lab results import,
protocols and supplements, nutrition, symptoms and adherence, forms and check-ins) each with a
granted self-authorized `patient_app` consent, and the active `alp_patient_sync` provider. A repeated
run inserts nothing and reports the same ids. The production tables' `production-clinical` /
`clinical_phi` / `contains_phi=true` columns describe the schema's posture and are satisfied by
defaults; the data under them is fictional, and the account, foundation stack and manifest all say
synthetic-only. No provider release, retention release, export delivery or PHI flag is seeded.

## Defect found while building this (fixed)

The production migration operator's post-apply verification pinned 114 application tables. The
100-migration artifact creates 123 (`clinical_core` and `clinical_audit`, ledger excluded; the
contract count of 81 still holds). Every fresh apply of the current artifact would therefore have
rolled back as `verification_failed`, including step 3 above. The pin is now
`PRODUCTION_APPLICATION_TABLE_COUNT = 123`, and `qualification-fixtures.database.test.ts` applies the
real artifact through the real `applyProductionClinicalCoreMigrations` in PGlite and asserts both
counts, so the pin can no longer drift silently behind a mock. The previous mock-only test kept 114
passing.

## Design decision (decided September 21, later): qualification execution

The recheck showed that reviewed test parameters alone could not produce positive hosted acceptance,
because every candidate refuses to serve while PHI is disabled. The decision is an explicit,
disabled-by-default qualification execution profile, described in the section of that name below. It
does not turn any PHI flag on: "do not turn real-PHI flags on just to make a test pass" stands, and the
production activation conditions are unchanged.

## Status

- Implemented and locally verified: name and account refusals, read-only inspection, single
  create-database statement, fixture provisioning and its refusals (`qualification-target.test.ts`,
  `qualification-fixtures.database.test.ts`), the verification pin against the real artifact, the
  operator bundle build, the PowerShell runner (syntax only; not executed).
- Not hosted verified: no database was created, inspected or seeded from the container (the AWS
  sign-in host is blocked by the container's network policy). Steps 1 to 6 are the owner's Windows
  terminal work.

## Qualification execution (September 21, later): serving fixture identities with PHI disabled

The recheck confirmed the database side of the target and named the next blocker: every candidate
serves requests only while `phiAllowed === true` and its production activation is approved, and every
template attaches its data permissions under a condition that requires `PhiAllowed=true`. Reviewed
test buckets and providers alone could not yield positive hosted acceptance. Qualification execution is
the one reviewed way a candidate serves requests with PHI disabled, and it is built so that it cannot
widen production activation.

### Policy (`qualification-execution.ts`, shared by every candidate)

- **Disabled by default.** A deployment names it with `QualificationExecution=enabled`; nothing else
  turns it on. An unset or `disabled` value leaves every candidate exactly as before.
- **Never together with production.** The policy is refused (`qualification_execution_invalid`, at
  function start, before any request) when `PHI_ALLOWED` is not `false`, when the candidate's own
  activation is not `blocked`, or when a voice candidate is draining. `Active` and `Qualification` can
  never both be true; `Enabled` is their disjunction and is what the data permissions ride.
- **Pinned.** `QualificationAccountId` must equal the deploying account (a template condition on
  `AWS::AccountId`) and must not be the production account `173535830222`; the database cluster ARN
  must belong to that account; `DatabaseName` must be a qualification name (contains `qualification`,
  never `clinical_core`, `postgres`, `rdsadmin` or a template database). The same checks run again in
  the function from its environment, so a template edit cannot bypass them.
- **Reviewed.** `QualificationReviewSha256` (the reviewed qualification execution policy evidence)
  stands in for the production activation evidence; every other reviewed input a candidate needs in
  production (database review, MFA review, alarm topic, scopes, provider and storage reviews, release
  ids) is required in qualification too. A candidate that is missing one refuses at start rather than
  serving partially.
- **Designated identities only.** `QualificationIdentitySubjects` (1 to 16 Cognito subjects from the
  reviewed synthetic acceptance manifest) are the only identities served. Every request still passes
  the real JWT verification first (issuer, audience, production binding, no synthetic attestation,
  expiry, fresh login for workforce); a verified identity that is not designated receives exactly the
  refusal an unactivated deployment gives (`503 production_not_activated`), before any consent,
  billing or storage access. Ordinary consumer or practitioner traffic therefore never reaches the
  qualification target even if it is pointed at it.
- **Unchanged authorization.** Owner and clinic isolation, consent state, processing consent, legal
  holds, deletion fences and every sub-activation's own evidence run exactly as in production. The
  privacy sub-activations (personal purge, external inventory and purge, identity deletion, export
  cleanup, retention schedule) ride `Enabled` with their own reviewed evidence; the retention sweep's
  service identity must be a designated subject.
- **Marked evidence.** Every response produced under qualification carries
  `x-clinical-execution: qualification`. Both hosted harnesses record what answered them:
  `execution` (`production`, `qualification`, `mixed`, `unobserved`) and `unmarkedDenials`. A 401 or
  403 without a marker is **not** read as production: API Gateway answers an unauthorized request
  before the Lambda runs, so expected authorizer denials are classified separately and count towards
  neither execution. Both fields are inside the report's evidence hash, a `mixed` run counts for
  neither execution and can never be `ok`, and no boolean promotes a synthetic-account report into
  production activation evidence.

### Where it lives

| Candidate | Template (`Enabled` gates the data IAM) | Function | Extra |
|---|---|---|---|
| personal-storage | `scripts/personal-storage-candidate.mjs` | `owned-consumer-api` | export delivery and cross-store readers ride `Enabled` with the same reviewed export inputs |
| owned-lab | `scripts/build-aws-owned-lab.mjs` | `owned-lab-api`, worker, cleanup | qualification requires `AllowedScopes=ai_context,lab_history` and `LabRangeMode=reviewed_release`; cleanup runs hold-aware under the personal namespace |
| owned-voice | `scripts/build-aws-owned-voice.mjs` | `owned-voice-api` and its sweep | never while draining; `AllowedScopes=ai_context,voice_transcription` |
| privacy-operations | `scripts/build-aws-privacy-operations.mjs` | `privacy-operations-api`, retention sweep | sub-activation rules accept `PhiAllowed=true` or `QualificationExecution=enabled`; the sweep needs a designated service subject |
| recording (6) | `scripts/build-aws-recording-authority.mjs` and modes | authority, capture, transcription, drafting, cleanup review, cleanup execution | one shared execution helper; each keeps its own release ids and review hashes |

Shared template profile: `scripts/qualification-execution-template.mjs` (parameters, `QualificationPosture`,
`Qualification`, `Enabled`, the `QualificationRequiresSyntheticPosture` rule, environment). Fixed on the
way: the recording-capture template's route and permission logical ids contained underscores, which
CloudFormation refuses (cfn-lint E3001); CI now builds and lints all six recording templates.

### The qualification target manifest (what a hosted run is bound to)

The September 21 profile audit found that the hosted runners selected the target from whatever
foundation stack the caller named, and the documented command named the staging foundation
(`ai-clinical-core-synthetic-staging`, `DatabaseName=clinical_core`,
`ApiOrigin=https://wxv734oi12.execute-api.us-east-2.amazonaws.com`). The export runner therefore drove
the staging API, and the recording runner passed the staging database to the fixture writer. Both are
now bound to an explicit reviewed manifest instead: `infra/aws-clinical-core/qualification-target.example.json`
(a copy is filled by the owner and kept out of the repository; the example itself is refused, because
its placeholders are).

It names one API (`apiId` and the origin derived from it), the account and region, the qualification
foundation stack, the Aurora cluster, secret and qualification database, the export and recording
buckets, the exact `sourceCommit` and `migrationReleaseHash` the candidates were deployed and the
database applied from, the designated fictional subjects (consumer, workforce, the second consumer,
and the retention service when the sweep is under test), the candidate stack names, and — explicitly —
the staging foundation stack, staging API origin and staging database that must be refused.

The second consumer is designated deliberately. An identity the qualification gate refuses outright
cannot demonstrate owner isolation, because the refusal would come from the outer gate rather than
from the owner check under test; the cross-owner cases need an admitted identity that the owner checks
then refuse.

Both wrappers (`scripts/qualification-target-verify.ps1`) verify, before any request or fixture write:
the manifest's own shape and posture, the reviewed deployment manifest's account and region, the STS
account (never `173535830222`), that the checkout is the manifest's commit, the qualification
foundation (PHI false, and its API or database where it states them), and every candidate stack the
run depends on. A stack passes only when its outputs read `PhiAllowed=false`, `Activation=blocked`,
`QualificationExecution=enabled` and the manifest's `SourceCommit`, its status is a completed one, and
its **parameters name the manifest's own resources**: `DatabaseClusterArn`, `DatabaseSecretArn`,
`DatabaseName` and `QualificationAccountId` for every candidate, `ApiId` for every candidate that has
an API, `ExportBucketName` for personal-storage and privacy-operations, `RecordingBucket` for the
recording candidates that store audio, and `QualificationIdentitySubjects` equal to the manifest's
designated subjects. A database or API *name* does not identify one database or API across clusters,
and a parameter a candidate uses but does not carry is a refusal rather than a pass. Codex's prepared foundation
(`ai-clinical-core-qualification-foundation`, API `6zt8e9qz04`, September 21) reports
`QualificationExecution=disabled` and `QualificationInfrastructure=prepared_no_candidates` by design:
that is prepared infrastructure, not candidate execution evidence, and the candidates are verified one
by one.

A filled manifest can be checked before anything is deployed, with no AWS access at all:
`npm run check:aws-qualification-target -- <file>` validates the same shape the runners do and prints what the run would
bind to. With no argument it checks the committed example, which must stay a valid shape and must stay refused as a run
target because of its placeholders; CI runs that.

Both CLIs load the same manifest themselves (`qualification-target-manifest.ts`), so running a CLI
directly cannot bypass the binding; an ambient `CLINICAL_API_ORIGIN` or `CLINICAL_DATABASE_NAME` that
disagrees with the manifest is refused rather than obeyed. An acceptance verdict, moreover, is issued
only from observations the CLI made itself (`qualification-target-observation.ts`): in acceptance mode,
its default, it runs `git rev-parse HEAD`, `aws sts get-caller-identity` and
`aws cloudformation describe-stacks` for the candidates that harness depends on, and applies the same
posture, source, status, resource and subject checks before the first request. `SOURCE_COMMIT` and
`OBSERVED_AWS_ACCOUNT_ID` are assertions by whoever set them, never a substitute for that; the
recording `fixture` command observes the target whatever the mode, because it writes. A diagnostic run
on asserted values needs `ACCEPTANCE_MODE=exploratory`, and its report line says
`target.source: asserted_by_caller` so it cannot read as acceptance. The recording `fixture` command re-checks
the qualification database name, the designated subjects and the database's migration ledger against
the built artifact before writing the encounter, so the populated staging database is refused by its
own history. `scripts/test-qualification-acceptance-runners.ps1` runs all of these refusals
credential-free in CI (52 cases, no AWS call, no request, no fixture write), alongside the 32-case
name-refusal test for the preparation runner.

### Deploying the qualification profile (owner, Windows terminal)

Copy-and-fill parameter files for all ten candidate stacks live in
`infra/aws-clinical-core/qualification-parameters/` (`<candidate>.example.json`, with a README naming
every placeholder to replace). They are generated from the built templates
(`npm run build:aws-qualification-parameters`), CI refuses drift (`check:aws-qualification-parameters`),
and `qualification-parameters.test.ts` proves each file names exactly its template's parameters,
satisfies every pattern, makes `Qualification` true only in the synthetic account, and never makes
`Active` true. In words, each candidate deploys with `PhiAllowed=false`, `Activation=blocked`, `DatabaseName=clinical_core_qualification`,
`QualificationExecution=enabled`, `QualificationAccountId=588966314750`, `QualificationReviewSha256=<reviewed>`,
`QualificationIdentitySubjects=<manifest consumer and workforce subjects>`, plus the candidate's reviewed
inputs (database review, MFA review, alarm topic, scopes, export bucket and key where export delivery is
under test, provider releases and review hashes for recording). Stack outputs report
`QualificationExecution=enabled`; a stack that reports `disabled` has a failing boundary and serves no one.
Then run the hosted harnesses against that API and keep only reports whose `execution` is
`qualification` for the qualification record; none of them is production activation evidence.

### Status

- Implemented and locally verified: policy module (resolution, every refusal, admission, marker),
  eleven handlers and their lambdas, seven templates with condition evaluation tests, harness report
  binding (production, qualification, mixed), full Desktop suite and cfn-lint on every template.
- Not hosted verified: no qualification candidate has been deployed; the hosted harnesses have not
  run against the qualification database. That is the owner's next step, after which whatever they find
  is new engineering.
- Hosted CI at `f3dcbff`: the main job (typecheck, lint, unit, every gate, cfn-lint on every template
  including the six recording candidates, the PowerShell runner test, builds) and six of seven browser
  jobs passed. The live-fixture browser job failed on one test, `live-scribe.spec.ts` "microphone loss
  mid-recording pauses with an unmistakable status": the recording status reached `unconfirmed` instead
  of `recording` within ten seconds, at minute 25 of the job with the dev server's heap at 7.1 GB. The
  commit changes nothing under the Next app (`src/app`, `src/components`, `src/lib`) and none of the
  changed modules is reachable from it; the same test passed on the previous run and passed three of
  three repetitions locally against the committed contract fixture (30 of 30 scribe tests). It is
  recorded here as a runner-side timing failure, not a pass: CI could not be re-run from the cloud
  session (no permission), so the next push re-ran it. At `079bad0` (documentation only on top of
  `f3dcbff`) all eight jobs passed, the live-fixture browser job included.
