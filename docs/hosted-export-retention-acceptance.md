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
| 3 | cross-owner read and delivery refused | workforce token and a second consumer token both get 401/403 on the job view, and the second consumer is also refused the download link, which is where delivery to another owner is decided | |
| 4 | advance passes to ready | each advance 200 (409 busy is retried after 1.5 s), final status `ready`, retention `downloadable`, composite checksum present, exported counts equal snapshot counts | |
| 5 | stale sign-in download refused | 401 when the consumer token's `auth_time` is older than five minutes | `skipped` when the token is fresh (the harness never forges a claim) |
| 6 | download link for the exact version | 200, `https`, 300 seconds, checksum, length and the part list (digests and sizes accounting for every byte and reproducing the composite) equal to the view | 401 recorded as `skipped` with the reason |
| 7 | download and verify the delivered object | 200 from the reviewed bucket host and the link's exact version (`x-amz-version-id` must agree when S3 sends it), no redirect followed, exactly `byteLength` bytes, every part digest in order, the composite recomputed with S3's semantics, and the document's contract, manifest counts and coverage matching the job | `skipped` only when no link was issued; denied, redirected, wrong host, unversioned, truncated, oversized, corrupt, wrong version and mismatched manifests all fail |
| 8 | cancel and cleanup | `cancelled`; then either `objectDeleted:true` with retention `removal_recorded`, or `objectDeleted:false` with `cleanup_pending` (settlement or backoff, listed under `retained`) | any other combination fails |
| 9 to 11 | operator backlog, cleanup pass, reconcile pass | 200 with each action's summary shape | 503 `export_cleanup_not_activated` or `production_not_activated` (`not_configured`); 403 (`skipped`, operator not assigned) |

The report (`dist/qualification/export-retention-acceptance-<time>.json`, exclusive-create) carries the
source commit, the production migration release hash (recomputed from the built artifact), a hash of
the configuration the run used, the AWS account it asserted, every step's outcome and status, the jobs
it left behind (`retained`), and an evidence hash over everything but timestamps.

`ok` is the verdict, not a summary of what happened. The report carries `verdict`:

| Field | Meaning |
|---|---|
| `mode` | `acceptance` (the CLI's default) makes **every** step mandatory; `exploratory` (`ACCEPTANCE_MODE=exploratory`) keeps a partial run honest and can never be read as acceptance |
| `expectedExecution` | the execution that must have answered; the CLI passes `qualification` for a qualification target |
| `mandatory` | the case names this mode requires to have **passed**; in acceptance mode that is all eleven steps, the stale sign-in and the three operator actions included |
| `unmet` | the mandatory cases that did not pass, kept in the report |

`ok` is true only when no step failed, `unmet` is empty and the observed execution is the expected one.
A skipped mandatory case, a denied operator action, a missing second owner or stale-login token, or a
mixed set of responses therefore cannot produce a pass, and the CLI's exit status is that verdict.

The report also records which execution answered (`execution`: `production`, `qualification`, `mixed`
or `unobserved`) from the `x-clinical-execution` marker that qualification candidates send on every
response (`docs/aws-qualification-target.md`), and `unmarkedDenials`, true when some 401/403 arrived
without a marker. A missing marker on a 401/403 is **not** read as production: API Gateway answers an
unauthorized request before the Lambda runs, so those responses are classified separately and count
towards neither execution. There is no boolean that promotes a report into production activation
evidence: the observed execution is a description of the run, inside the evidence hash, and a
synthetic-account report is never production approval.

## Boundaries

- The target: the runner (`scripts/run-aws-export-retention-acceptance.ps1`) takes
  `-QualificationTargetPath`, a filled copy of `infra/aws-clinical-core/qualification-target.example.json`,
  and reads the API origin, account, region, database, export bucket, source commit and migration
  release hash from it alone. It consults no foundation stack: the previous runner took the API origin
  from whatever foundation was named, and the documented name was the staging foundation, so the
  documented command drove the existing staging API. The manifest names the staging foundation stack,
  staging API origin and staging database it must refuse, and they are refused by name. Before any
  request the runner verifies the STS account (never 173535830222), the checkout's commit, the
  dedicated qualification foundation (PHI false; its `QualificationExecution=disabled` output describes
  prepared infrastructure and is not candidate evidence) and each candidate stack this run depends on:
  `PhiAllowed=false`, `Activation=blocked`, `QualificationExecution=enabled`, the manifest's
  `SourceCommit`, `DatabaseName` and `ApiId`. The Node CLI loads the same manifest itself
  (`qualification-target-manifest.ts`), so a direct CLI run cannot bypass the binding, and refuses an
  ambient `CLINICAL_API_ORIGIN` or `CLINICAL_DATABASE_NAME` that disagrees with it rather than obeying
  it. In acceptance mode the CLI also makes the observations itself rather than trusting the wrapper's:
  it reads the checkout's head, the signed-in account and both candidate stacks
  (`qualification-target-observation.ts`), comparing each stack's cluster, secret, database, API,
  export bucket and designated subjects with the manifest. `SOURCE_COMMIT` and
  `OBSERVED_AWS_ACCOUNT_ID` are assertions, not observations, and cannot produce an acceptance verdict;
  a run on asserted values must say `ACCEPTANCE_MODE=exploratory`. The harness re-checks the asserted and observed account and refuses production whatever the
  caller says. The API origin must be an `execute-api` host; tokens must be distinct JWTs; tokens are
  read from the process environment and removed afterwards; no token or URL appears in the report.
  `scripts/test-qualification-acceptance-runners.ps1` proves all of this credential-free in CI (45
  cases: the staging foundation, API and database, the production account, another account, a stale
  checkout, an unfilled example, a missing or wrongly posed candidate stack).
- Fixtures: the run creates one export job for the fixture consumer and cancels it. Its objects are
  removed by the owner's cleanup pass inside the run when the settlement window allows, or reported
  under `retained` with the honest state for the operator pass or the sweep to finish. The run never
  deletes anything it did not create.
- What it does not cover: recording, transcription and drafting flows (browser suites with intercepted
  HTTP exist; a hosted recording harness with fictional audio is unbuilt), the scheduled retention
  sweep (needs the reviewed release row; see `retention-sweep-activation-runbook.md`), the settlement bound measurement (needs a controlled late
  write; the plan is in `personal-storage-privacy-export.md`), and anything the deployment refuses.

## Running it

After the qualification database is applied and seeded (`docs/aws-qualification-target.md`) and the
personal-storage and privacy-operations candidates are deployed with the qualification execution
profile and reviewed export parameters, fill a copy of
`infra/aws-clinical-core/qualification-target.example.json` (keep it out of the repository) and run:

```powershell
# tokens for the fixture consumer, a second consumer, a workforce operator, and a legitimately issued
# consumer token whose sign-in is older than five minutes, as in run-aws-synthetic-live-acceptance.ps1
$env:CLINICAL_CONSUMER_ID_TOKEN = ...; $env:CLINICAL_WORKFORCE_ID_TOKEN = ...
$env:CLINICAL_FOREIGN_CONSUMER_ID_TOKEN = ...; $env:CLINICAL_STALE_CONSUMER_ID_TOKEN = ...
.\scripts\run-aws-export-retention-acceptance.ps1 -QualificationTargetPath .\infra\aws-clinical-core\qualification-target.json `
  -DeploymentManifestPath .\infra\aws-clinical-core\deployment-manifest.json -ConfirmSyntheticOnly
```

Add `-Mode exploratory` for a partial run before every reviewed row exists; its report says
`verdict.mode: exploratory` and is never acceptance evidence. Acceptance mode requires the second
consumer and stale sign-in tokens, because those cases are mandatory.

The unit test (`export-retention-acceptance.test.ts`) pins the request sequence and grading with a
fictional transport: a full pass, delivery not configured, a retained copy behind a wrong state, and
every configuration refusal before the first request.
