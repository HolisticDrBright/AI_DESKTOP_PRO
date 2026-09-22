# Hosted recording, transcription and drafting acceptance (synthetic account only)

September 20, 2026. Source tooling for a hosted run that has not been executed: this container has no
AWS access. Writing the harness needed none; running it needs the `ai-synthetic-staging` login to
account 588966314750, the recording planes activated on the synthetic API, and the reviewed release
rows (consent, capture, storage, transcription, drafting) present for the fixture organization.
Nothing here is hosted evidence until a report file exists.

## What it runs

`src/server/clinical-core/recording-acceptance.ts` drives the encounter recording pipeline against the
deployed synthetic API with real identities, real API Gateway authorizers, the real database, the real
recording bucket and the real providers, using **fictional audio**: a generated 16 kHz mono tone with
silence gaps (no voice, no words, no person), or a fictional recording supplied with `-AudioFile` that
the team made for this purpose. It never records or uploads anything from a real encounter.

| # | Step | Passes when | Reported, not passed, when |
|---|---|---|---|
| 1 | consent workspace | 200 workspace for the encounter; consent releases exist for `recording`, `transcription` and `ai_drafting` in the run's locale and jurisdiction; capabilities do not claim audio capture | 503 `production_not_activated` (`not_configured`; every later step `skipped`); a missing scope release (`not_configured`, names the scopes) |
| 2 | consumer token refused | a consumer token gets 401/403 on authority, readiness and transcription | |
| 3 | participants and consents | patient and practitioner participants added; six grants (two participants × three scopes) recorded under the reviewed releases | |
| 4 | readiness | 200 `ready`, `audio/wav` offered, bounds large enough for the fixture | 503 (`not_configured`) |
| 5 | start capture | 200 `capturing` with a capture token, credential version 0 and a deletion deadline | 503 (`not_configured`) |
| 6 | start replay | the same command id returns the same recording with `replayed: true` and no token | |
| 7 | segment uploads | a deliberately mismatched digest is refused with 400 and stores nothing; every chunk is stored with matching sequence, digest and length | |
| 8 | recovery state | stored segments equal uploads, none pending, processing not requested, audio not deleted | |
| 9 | finish | 200 closed against the exact inventory digest; finishing does not request processing or delete audio | |
| 10 | transcription request | 200 requested/processing job for this recording with the segment count; capabilities deny drafting | 503 (`not_configured`) |
| 11 | transcription completes | bounded advance passes end with `completed` and a provider transcript version | provider failure or cancellation → `failed` with the provider code; still processing after the pass budget → `failed` |
| 12 | transcript read | 200 content for the exact transcript whose digest equals its text | |
| 13 | drafting request | 200 requested `soap` draft bound to the transcript; capabilities say `writesClinicalNotes: false`, `review_only` | 503 `production_not_activated`, `provider_unavailable` or `prompt_unreviewed` (`not_configured`) |
| 14 | drafting completes | bounded passes end with `completed` and a proposed note version | provider failure → `failed` |
| 15 | proposed note read | 200 `proposed-note/1` document for the exact note, bound to the transcript, with sections and visible cautions | |
| 16 | cleanup review | 200 processing status for the recording and a queue page | 503 (`not_configured`) |

`ok` is the verdict. In `acceptance` mode (the CLI's default) every one of the sixteen steps is
mandatory and must have **passed**, and the execution that answered must be the expected one; in
`exploratory` mode (`ACCEPTANCE_MODE=exploratory`, `-Mode exploratory`) the run keeps its partial
results honestly and can never be read as acceptance. The report carries `verdict` (`mode`,
`expectedExecution`, `mandatory`, `unmet`), so a run in which any plane refuses, or in which responses
come from mixed executions, is never `ok`, whatever else passed. The report
(`dist/qualification/recording-acceptance-<time>.json`, exclusive-create) carries the source commit,
the production migration release hash (recomputed from the built artifact), a hash of the configuration
the run used (origin, account, encounter, locale, jurisdiction, audio digest), the audio's source, size,
digest and segment count, the AWS account it asserted, every step's outcome and status, the recording it
left behind (`retained`, with its deletion deadline) and an evidence hash over everything but timestamps.

The report also records which execution answered (`execution`: `production`, `qualification`, `mixed`
or `unobserved`) from the `x-clinical-execution` marker that qualification candidates send
(`docs/aws-qualification-target.md`), and `unmarkedDenials`, true when some 401/403 arrived without a
marker: API Gateway answers an unauthorized request before the Lambda, so an unmarked denial is
classified separately and counts towards neither execution. Both are inside the evidence hash, and no
boolean promotes a synthetic report into production activation evidence.

## Boundaries

- The target: the runner (`scripts/run-aws-recording-acceptance.ps1`) takes `-QualificationTargetPath`,
  a filled copy of `infra/aws-clinical-core/qualification-target.example.json`, and reads the API
  origin, account, region, database, source commit and migration release hash from it alone. It
  consults no foundation stack: the previous runner took the fixture database and the API origin from
  whatever foundation was named, and the documented name was the staging foundation, so the documented
  command wrote the fixture encounter into the staging database and drove the staging API. The manifest
  names the staging foundation stack, staging API origin and staging database it must refuse, and they
  are refused by name. Before any request or fixture write the runner verifies the STS account (never
  173535830222), the checkout's commit, the dedicated qualification foundation (PHI false; its
  `QualificationExecution=disabled` output is prepared infrastructure, not candidate evidence) and the
  five recording candidate stacks: `PhiAllowed=false`, `Activation=blocked`,
  `QualificationExecution=enabled`, the manifest's `SourceCommit`, `DatabaseName` and `ApiId`. The Node
  CLI loads the same manifest itself (`qualification-target-manifest.ts`), so a direct CLI run cannot
  bypass the binding, and refuses an ambient `CLINICAL_API_ORIGIN` or `CLINICAL_DATABASE_NAME` that
  disagrees with it. The harness re-checks the asserted and observed account and refuses production
  whatever the caller says. The API origin must be an `execute-api` host; tokens must be distinct JWTs
  read from the process environment and removed afterwards; no token, capture token or URL appears in
  the report. `scripts/test-qualification-acceptance-runners.ps1` proves this credential-free in CI.
- The encounter: recording needs an open encounter for the fixture patient, and encounters are started
  by the Desktop's clinical workflow, not a public route. Without `-EncounterId` the wrapper runs
  `recordingAcceptance.js fixture`, which starts (or reuses) a telehealth encounter for the synthetic
  fixture patient as the fixture practitioner through the administrative path
  (`recording-acceptance-fixture.ts`, same SQL entry point as the Desktop). It creates nothing else.
  The fixture command guards itself rather than trusting its caller: the database must be the
  manifest's qualification database (a name containing `qualification`, never `clinical_core`, a
  maintenance database or the staging database), the synthetic acceptance manifest's account and
  designated consumer and workforce subjects must equal the target manifest's, and the database's
  migration ledger must equal the built production artifact exactly (nothing missing, mismatched or
  unknown, same release hash) before the encounter is written. The populated staging database fails
  that ledger check by its own history, so it cannot receive a fixture write even if it were named.
- Reviewed rows the harness does not create and reports as `not_configured` when absent: consent
  releases per scope (locale and jurisdiction must match the run's), the capture release and storage
  release (readiness), the transcription release and provider qualification, the drafting release,
  prompt review and provider secret. Their absence is an activation state, not a defect in this code.
- Retention: the fictional audio stays in the recording bucket until the reviewed deletion deadline
  (`audioRetentionHours`) and then goes through the operator-authorized cleanup process; the harness
  never deletes media. Run the cleanup review afterwards to see the recording queued.
- Provider output on a tone: the transcript may be empty or near-empty and the draft's cautions should
  say so. The harness grades the pipeline (job states, bindings, digests, review-only capabilities),
  not the clinical content, which is fictional by construction.

## Running it

Fill a copy of `infra/aws-clinical-core/qualification-target.example.json` (keep it out of the
repository), then:

```powershell
$env:CLINICAL_WORKFORCE_ID_TOKEN = ...; $env:CLINICAL_CONSUMER_ID_TOKEN = ...
.\scripts\run-aws-recording-acceptance.ps1 -QualificationTargetPath .\infra\aws-clinical-core\qualification-target.json `
  -DeploymentManifestPath .\infra\aws-clinical-core\deployment-manifest.json `
  -SyntheticManifestPath .\infra\aws-clinical-core\synthetic-acceptance-manifest.json `
  -Jurisdiction US-SYNTHETIC -ConfirmSyntheticOnly
```

Add `-Mode exploratory` before every reviewed release row exists; that report is not acceptance
evidence. `-EncounterId` reuses an encounter and skips the fixture step; `-AudioFile` supplies
fictional audio instead of the generated tone.

## Not yet done

- No hosted run. The unit test (`recording-acceptance.test.ts`) pins the request sequence and grading
  against a fictional deployment; the fixture module is exercised against the executable SQL in PGlite.
- Cleanup execution of the retained fictional audio after its deadline is an operator pass
  (`cleanup-execution`), outside this run.
- Physical-device capture (browser MediaRecorder on real hardware) is a separate device verification.
