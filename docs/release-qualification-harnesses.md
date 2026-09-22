# Release qualification harnesses (security, load, application rollback)

September 16, 2026. Credential-free source tooling. Nothing here is a hosted penetration test, a production load test or an executed rollback; each harness produces hashed evidence that a later hosted run must reproduce.

## Security qualification

`npm run build:security-qualification && npm run qualify:security` builds and runs `src/server/clinical-core/security-qualification.ts`: an in-process adversarial matrix against the production-owned consumer API and the telehealth boundary with a storage adapter that records whether it was ever invoked. Twenty-nine cases cover blocked activation, nine identity forgeries (issuer, audience, expiry, future issue time, synthetic attestation, non-production binding, unverified email, access-token misuse, malformed person id), a bearer header without the gateway authorizer, owner injection, malformed cursors and collections, workforce and unknown routes, wearable and reproductive scope escalation, oversized, malformed and prototype-polluting bodies, sanitized storage failure, and telehealth refusals (production without the PHI gate, missing attestation, workforce route with consumer claims, Stripe webhook without the boundary, reminder event while disabled, payment setup without Stripe, oversized body). Each case records the expected refusal, whether storage may be touched, the actual status and error, whether any identifier or internal message leaked, and a pass flag. The report (`dist/qualification/security-qualification.json`, exclusive-create) carries a SHA-256 over the outcomes; the unit test asserts the hash is stable for a fixed clock. CI runs it as source evidence.

## Load qualification

`infra/aws-clinical-core/load-qualification-plan.json` describes refusal-path load scenarios only: unauthenticated bursts against personal records and lab jobs, oversized-body refusals and unknown-route probes, each with a concurrency, request count, the refusal statuses allowed and an SLO (p95 latency, maximum error rate). `npm run qualify:load-plan` validates the plan and prints the schedule without sending anything (CI). `node scripts/run-aws-load-qualification.mjs --execute --origin <synthetic API origin>` requires `LOAD_QUALIFICATION_CONFIRM_SYNTHETIC=1`, an origin matching the synthetic execute-api pattern and free of production markers, and writes `dist/qualification/load-qualification.json` with p50/p95/max latency, status distribution and an evidence hash. Any 2xx, any status outside the allowed refusals, or an SLO breach fails the run. The self-test (`npm run test:aws-load-qualification`) drives the runner against a local stub server to prove refusals pass, acceptance fails and unexpected statuses fail.

## Application rollback rehearsal

`scripts/run-aws-application-rollback-rehearsal.ps1` rolls one Lambda extension stack back to a previously deployed artifact. It refuses without `-ConfirmApplicationRollbackRehearsal`, outside account `173535830222`, or when the foundation reports `PhiAllowed` other than false. The previous artifact must exist in the artifact bucket and hash to the supplied SHA-256. The current `LambdaCodeKey` is recorded as the re-forward key; a change set is created with only `LambdaCodeKey` changed and every other parameter kept, then described and refused if it would touch anything other than Lambda functions. Without `-ExecuteChangeSet` the change set is deleted and nothing changes; with it the stack update is awaited and each function's `CodeSha256` is recorded. Evidence includes start and completion times, `recoveryTimeSeconds` and an evidence hash. `npm run check:aws-application-rollback` (CI) pins those safety markers.

## Hosted qualification harnesses (the reviewed target, none executed)

These four drive a deployed qualification target and produce reports bound to the source commit, the migration release
hash and the configuration they used. All take the reviewed qualification target manifest
(`infra/aws-clinical-core/qualification-target.example.json`, filled, checked with
`npm run check:aws-qualification-target -- <file>`), verify the live account, the checkout and each candidate stack
before their first request, and refuse the staging foundation, API and database by name. In acceptance mode, the default,
every case is mandatory and the observations are made by the run itself; `-Mode exploratory` keeps a partial run honest
and can never read as acceptance.

| Harness | Runner | What a pass means | What it never means |
|---|---|---|---|
| Export and retention | `run-aws-export-retention-acceptance.ps1` | Eleven cases from consumer posture to the operator passes, including the delivered object downloaded from the reviewed bucket and version and verified against every part digest and the composite checksum | Not a retention policy, and a copy still pending cleanup is not deleted; with `-ScheduledCleanupWaitMinutes` the schedule's own removal is required, otherwise that step is skipped |
| Recording, transcription, drafting | `run-aws-recording-acceptance.ps1` | Sixteen cases with fictional generated audio, from consent through review-only drafting to cleanup review | Not clinical quality, and not physical-device capture |
| Voice shutdown (drain) | `run-aws-voice-shutdown-acceptance.ps1` | The draining plane refuses every public method with `voice_cleanup_only`, serves no identity, carries no qualification marker, and two read-only inventories certify nothing and show no growth | Not erasure, not an atomic snapshot, and not a completion review |
| Retention service release | `release-aws-retention-service.ps1` | The reviewed release row is written to the qualification database, never to staging | Not an operating model and not a service level |

`scripts/test-qualification-acceptance-runners.ps1` proves the binding of all of these credential-free in CI (52 cases,
no AWS call, no request, no fixture write) and parses every operator script, alongside the 32-case name-refusal test for
the preparation runner.

## What remains

None of the hosted harnesses above has been executed: no qualification candidate is deployed, so their evidence does not
exist yet, and whatever a first run finds is new engineering. Beyond them:

Independent security review and vulnerability remediation, hosted penetration testing, load qualification against the deployed synthetic stack and later the production stack, an executed rollback rehearsal with recorded RTO, snapshot/object/Cognito recovery drills, and the tabletop exercises listed in the activation checklist. Passing these harnesses in CI does not close any of those items.
