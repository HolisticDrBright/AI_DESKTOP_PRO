# Hosted export and retention acceptance (synthetic account only)

September 20, 2026. Source tooling for a hosted run that has not been executed: this container has no
AWS access. Writing the harness needed none; running it needs the `ai-synthetic-staging` login to
account 588966314750. Nothing here is hosted evidence until a report file exists.

## What it runs

`src/server/clinical-core/export-retention-acceptance.ts` drives the personal-storage export job and
the operator retention actions against the deployed synthetic API with real identities, real API
Gateway authorizers, the real database and the real export bucket:

| # | Step | Passes when | Reported, not passed, when |
|---|---|---|---|
| 1 | consumer posture | `personal-posture/1`, tier `core` | |
| 2 | request export job | 200, status `requested`, retention `packaging` | 503 `export_delivery_not_configured` (`not_configured`; every later step `skipped`) |
| 3 | cross-owner read refused | workforce token and a second consumer token both get 401/403 | |
| 4 | advance passes to ready | each advance 200 (409 busy is retried after 1.5 s), final status `ready`, retention `downloadable`, composite checksum present, exported counts equal snapshot counts | |
| 5 | stale sign-in download refused | 401 when the consumer token's `auth_time` is older than five minutes | `skipped` when the token is fresh (the harness never forges a claim) |
| 6 | download link for the exact version | 200, `https`, 300 seconds, checksum and length equal to the view | 401 recorded as `skipped` with the reason |
| 7 | cancel and cleanup | `cancelled`; then either `objectDeleted:true` with retention `removal_recorded`, or `objectDeleted:false` with `cleanup_pending` (settlement or backoff, listed under `retained`) | any other combination fails |
| 8 to 10 | operator backlog, cleanup pass, reconcile pass | 200 with each action's summary shape | 503 `export_cleanup_not_activated` or `production_not_activated` (`not_configured`); 403 (`skipped`, operator not assigned) |

The report (`dist/qualification/export-retention-acceptance-<time>.json`, exclusive-create) carries the
source commit, the production migration release hash (recomputed from the built artifact), a hash of
the configuration the run used, the AWS account it asserted, every step's outcome and status, the jobs
it left behind (`retained`), and an evidence hash over everything but timestamps. `ok` requires every
step to pass or be skipped for a stated reason and the ready step to have passed; a run against a
deployment that refuses is therefore never `ok`.

## Boundaries

- The runner (`scripts/run-aws-export-retention-acceptance.ps1`) pins the account with
  `aws sts get-caller-identity` against the deployment manifest and refuses account 173535830222; the
  Node harness re-checks the asserted and observed account and refuses production whatever the
  caller says. The API origin must be an `execute-api` host; tokens must be distinct JWTs; tokens are
  read from the process environment and removed afterwards; no token or URL appears in the report.
- Fixtures: the run creates one export job for the fixture consumer and cancels it. Its objects are
  removed by the owner's cleanup pass inside the run when the settlement window allows, or reported
  under `retained` with the honest state for the operator pass or the sweep to finish. The run never
  deletes anything it did not create.
- What it does not cover: recording, transcription and drafting flows (browser suites with intercepted
  HTTP exist; a hosted recording harness with fictional audio is unbuilt), the scheduled retention
  sweep (needs the reviewed release row), the settlement bound measurement (needs a controlled late
  write; the plan is in `personal-storage-privacy-export.md`), and anything the deployment refuses.

## Running it

After migrations 79 to 97 are applied and the personal-storage and privacy-operations candidates are
redeployed with export parameters reviewed (or left empty, in which case the run reports
`not_configured`):

```powershell
# tokens for the fixture consumer, an unassigned/second consumer (optional) and a workforce operator, as in run-aws-synthetic-live-acceptance.ps1
$env:CLINICAL_CONSUMER_ID_TOKEN = ...; $env:CLINICAL_WORKFORCE_ID_TOKEN = ...; $env:CLINICAL_FOREIGN_CONSUMER_ID_TOKEN = ...
.\scripts\run-aws-export-retention-acceptance.ps1 -FoundationStackName ai-clinical-core-synthetic-staging -DeploymentManifestPath .\infra\aws-clinical-core\deployment-manifest.json -ConfirmSyntheticOnly
```

The unit test (`export-retention-acceptance.test.ts`) pins the request sequence and grading with a
fictional transport: a full pass, delivery not configured, a retained copy behind a wrong state, and
every configuration refusal before the first request.
