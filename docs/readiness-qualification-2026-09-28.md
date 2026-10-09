# Qualification execution — September 28, 2026

Status: not commercial-ready or PHI-ready. Production account 173535830222 and the running Desktop/mobile releases were not updated. PHI remains disabled. No positive candidate hosted acceptance is claimed.

## Actual AWS results

- Synthetic account 588966314750, us-east-2. The isolated `clinical_core_qualification` database has 102 migrations, artifact identity `d6b0a8a5d61c465f8e1db1181c52d6bf4d90db0b65068042d8ebf56358dd82b3`.
- Fixed the fixture contract to support the approved two consumers plus one practitioner. The guarded fixture runner succeeded against real Aurora and inserted 24 fictional fixture rows. No real health information; no writes to the original staging database. Local tests cover idempotence, conflicting bindings, pre-existing unauthorized access, strict validation and rollback. This database setup is not an authenticated API or device pass.
- Tried the personal-storage candidate from exact `a300c633ac81909842503ad37e77170ad63ed605` artifacts, scopes `forms_checkins,lab_history` only. Exports and cross-store inputs were empty; production activation blocked. Technical review files are Codex's bounded synthetic review, not the owner's separate security/retention approval or BAA coverage review.
- CloudFormation stack `ai-clinical-core-qualification-personal-storage` reached `ROLLBACK_COMPLETE`. Lambda `PutFunctionConcurrency` refused its reservation because this account has total/unreserved concurrency 10/10 and AWS requires its remaining unreserved minimum of 10. The failed function was removed by rollback; no serving candidate resulted.
- All ten templates require 35 reserved executions across 12 functions. The normal quota API rejected desired value 150 because it demanded a value above default 1000. No Service Quotas request was created by that failed call. Function caps were not weakened.
- With the owner's explicit approval, AWS Support case **179061879900755** was submitted at 2026-09-28T18:06:39.256Z. Console status: Unassigned; category Service Quotas / General; account 588966314750. Request: 150 total concurrency, or the smallest supported quota permitting the 35 reservations; no support-plan upgrade or provisioned concurrency. Case link: https://console.aws.amazon.com/support/home#/case/?displayId=179061879900755&language=en . Submission is not approval.
- The new read-only capacity preflight ran against AWS, observed 10/10 and 35 additional reserved units, and refused deployment. Its conservative documented unreserved floor is 100 (minimum total 135 for this plan); this differs from the reduced account's observed 10-unit rejection floor, deliberately without claiming a reduced quota is usable.
- The synthetic alarm email subscription was still pending confirmation. The earlier production budget email is not subscription or alarm-delivery evidence.

## Source versus deployed evidence

The fixture-v2 repair and capacity preflight are new source work on `agent/sept27-readiness-repairs`; they do not change the identity of uploaded a300c63 artifacts. Capacity tests pass (6 cases), fixture database tests pass (5 cases), and typecheck passed. The previously green a300c63 CI does not certify this new commit. Record new CI independently.

## Resume sequence

### Source reconciliation follow-up (local, September 28)

The follow-up deployment-preflight branch was originally based on `a300c63` and missed the already committed `e4427b6` fixture-v2/capacity work. These lines of work are now reconciled, retaining both the fleet capacity check and the initial-create resource-collision check. The already populated AWS qualification fixtures must not be duplicated; the v2 contract itself was not a newly discovered missing hosted step.

Additional retry checks refuse changed organization/person/identity bindings, changed consent artifacts, appended consent revocation, unexpected patient connections or isolation-consumer authority, and changed sync-provider configuration. All inserts and checks are in one transaction. Direct fixture-operator calls now enforce the same database/account/secret/region boundary as inspect/create. Manifest loading retains the existing `manifest_invalid` error contract and accepts a UTF-8 BOM.

Local verification: 20 Node preflight tests; 16 fixture/database-target tests against PGlite (real 102-migration artifact, 123 tables, 81 contracts); six built-operator refusal tests with no inherited AWS credentials; typecheck and targeted ESLint; qualification operator bundle. These are not a full-suite/CI, real-AWS retry, candidate acceptance or device claim. The new tests preserve both legacy fixture behavior and fresh v2 creation (24 rows), idempotence, append-only withdrawal and rollback. No AWS mutation, new fixture, production activation, paid mobile build or provider/policy approval occurred in this follow-up.

1. Obtain AWS's quota response, re-read the applied quota, rebuild templates and run the capacity preflight. Do not remove reserved caps, automatically request 1001, or buy a support plan.
2. Inspect the rolled-back stack before recovery. `/aws/lambda/6zt8e9qz04-personal-storage` was retained; a blind delete/recreate can collide with it. Preserve evidence and explicitly reconcile/import or approve disposal of the exact retained qualification resource. Do not delete broad log groups or touch running staging resources.
3. Review/push these source changes, rebuild from an exact clean resulting commit into a new immutable prefix, and update receipts, source bindings and the reviewed target manifest. Never relabel the a300 artifacts as newer source.
4. Deploy candidates in dependency order, still qualification-only. Complete missing reviewed scope/provider/capture/storage/retention release rows; a reserved retention subject alone is not a service release. Verify the alarm subscription and real delivery.
5. Run mandatory real-service export/download/checksum/IAM/isolation/cancel/late-write/cleanup/scheduled-retention and recording/transcription/drafting matrices. Refusal, skip and not-configured are not passes. Fix findings and repeat; do not relax activation conditions.
6. Qualify matched API/Desktop/mobile releases, rollback, provider/store test-mode journeys and physical iOS/Android acceptance. Existing mobile build 70 predates this work. No paid mobile build was authorized in this qualification plan.
7. Obtain actual security/retention decisions, launch jurisdictions and an alert backup; reconcile export deadline/deletion policy wording with measured behavior. Verify executed AWS/OpenAI agreements against the specific runtime/project/retention/subprocessors, not just an approval email. PHI activation remains a separate final reviewed action.

## Local operator evidence (no credentials in Git)

### Retention monitoring follow-up (source only)

The scheduled retention worker and its four custom CloudWatch alarms previously used a dimensionless namespace, allowing separate stacks in the same account/region to share heartbeat and backlog metrics. Emission and alarm selection now both require `FunctionName`; the runtime reads the Lambda-provided name and refuses missing/malformed scope before database or storage work. No patient/job/request identifiers are metric dimensions.

The two hourly observed-backlog/refusal alarms previously treated silence as breaching despite a daily schedule. They now use `notBreaching` for sparse hourly observations; the separate daily completed-sweep heartbeat still treats missing data as breaching, and Lambda errors remain monitored. Hosted cadence, metric extraction, missed/failed sweeps, isolation and physical notification delivery still need qualification.

The runbook and test comments no longer falsely describe 48 hours as removal: it is a download cutoff from the snapshot time. V2's existing 72-hour public promise remains a launch blocker pending reviewed policy and measured behavior, not approved by arithmetic between constants. No V2 privacy terms were rewritten or policy approval inferred.

Local evidence: 56 tests across metrics, cadence, infrastructure, real-migration/PGlite export jobs and scheduled-removal attribution; typecheck; targeted ESLint; candidate template cfn-lint; all ten generated parameter examples match their templates. These checks do not establish real CloudWatch/S3 behavior or commercial/PHI readiness.

Workspace handoffs: `handoffs/2026-09-28-qualification-personal-storage-review.md` (SHA-256 `7cfa9d65893f736709a49e3c1b35178c5688c40266387b48cd1542537fa53438`), `handoffs/2026-09-28-qualification-database-review.md` (`8ba8c615789f893627dd13d9653a9bf6b1c2567010e90800d2d92744dda7ca39`), and `handoffs/2026-09-28-security-retention-review.md`.
Public fixture/identity inputs and immutable upload receipts remain under `work/DESKTOP_RELEASE_A300C63_20260928/dist/qualification-identities/` and `dist/qualification-packages/`. The DPAPI-encrypted credential file must never be printed, copied into handoff text or committed. The old one-off deployment operator is held against reuse pending quota and rolled-back-resource recovery.
