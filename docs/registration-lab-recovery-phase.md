# September 14: adult signup, recoverable lab requests, and collection provenance

Status: source candidate only. PHI disabled; no paid EAS/TestFlight build, AWS deployment, clinical approval, or provider call with health data.

## Launch decision implemented in registration

The owner confirmed adult (18+) self-service registration; pediatric access must be through an approved parent/guardian. Both the AWS account handler and V2 signup now require a valid birth date, explicit adult attestation and adult-self-service/1 policy. Missing, malformed, underage or future dates are rejected before account creation. Date of birth is used transiently by this handler and is not forwarded to Cognito or clinical records. This is self-reported eligibility, NOT identity or guardian verification.

The existing confirmation, password recovery and authenticated bootstrap remain compatible. Existing accounts are not retrospectively verified by this change. Verified guardian authority, pediatric consent/access enforcement and existing-account eligibility reconciliation still require engineering. Do not treat a family relationship or the signup checkbox as proof of legal authority.

## Lab recovery repaired

- Pending requests are keyed by a digest of identity pool/client, subject, person, organization and API origin. The old unowned device pointer is not read, adopted or deleted.
- Poll failures retain the pending ID. A different request fingerprint is refused rather than returning another panel's result; concurrent requests in the same device process are refused.
- Identity checks surround API requests, uploads, reads and cleanup. Refreshing a token does not change the identity binding. A changed account or unexpected job ID cannot return a result for display.
- A confirmed owner-bound GET 404 clears the obsolete pointer; age alone does not prove a job is gone.
- Labs has an explicit Resume pending lab analysis button. Removed the automatic resume effect whose attempted-state dependency could invalidate its own asynchronous result.

Limits: this is the existing synthetic lab client, not the missing production-owned job service. No cross-device job discovery, upload-interruption recovery, durable pre-create idempotency or atomic result-to-local-cache acknowledgement was added. The local lock is not distributed. Old unowned pointers require a separately verified migration/recovery process; they are not claimed as the current user's. These limitations remain on the commercial backlog.

## Collection provenance repaired

The saved-lab API previously validated testDate but did not persist it unless optional longitudinal context was supplied. It now stores the source panel ID/name/date, and the worker uses it for normalization, AI input, plan source identity and the input snapshot hash. Conflicting source/history or per-marker collection dates refuse processing. Old jobs with no trustworthy date do not get today's date invented.

No new clinical targets, supplement rankings, doses or approvals were introduced. The source-panel metadata does not by itself independently verify an uploaded lab. Full collection context capture/persistence and reproductive-consent separation are not complete.

## Release order and remaining work

Verification: Desktop 1,271 tests passed / 11 conditional or hosted skips; V2 489 passed / one hosted skip.
Both typechecks passed. V2 lint passed; Desktop lint zero errors / four existing warnings.
Account Lambda and lab API/worker bundles built. Tests use fictional inputs and mocked provider/storage calls;
no deployed account, real lab, external AI call or physical phone was used. No skipped test is counted as a pass.
React review checked explicit actions, accessible checkbox/input states, hook dependencies and duplicate-submit handling.

1. Do not deploy the new account requirement ahead of a compatible V2 build. Old clients omit the new fields and would be refused.
2. Preserve blocked production/PHI controls. Prepare coordinated artifacts and run synthetic hosted/phone acceptance when mobile builds are authorized.
3. Finish production-owned labs/documents/voice and durable job discovery, personal plan/intake restoration, and explicit version-conflict handling.
4. Finish consent-separated collection history, conventional/functional range presentation and eligible signed knowledge/catalog release.
5. Finish verified guardian/pediatric access, export/correction/deletion fulfillment and production provider/store acceptance.
6. Complete production rollout, security/load/restore drills and physical iOS/Android acceptance.

Commercial readiness is not achieved. Agreements, source verification/signing, provider/business/store accounts and device tests remain separate gates.
