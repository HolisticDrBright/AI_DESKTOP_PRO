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
| 6 | Run the hosted harnesses against the qualification API | `run-aws-export-retention-acceptance.ps1`, `run-aws-recording-acceptance.ps1`, retention `release` then the sweep; `not_configured` is never a pass. | Nothing new. |

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
  `execution` (`production`, `qualification`, `mixed`, `unobserved`) and
  `productionActivationEvidence`, which is true only for a run answered by production responses
  alone. The field is part of the report's evidence hash, so a qualification report can never be
  passed off as production evidence, and a `mixed` run counts for neither.

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

### Deploying the qualification profile (owner, Windows terminal)

For each candidate, deploy with `PhiAllowed=false`, `Activation=blocked`, `DatabaseName=clinical_core_qualification`,
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
