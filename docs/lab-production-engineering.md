# Lab pipeline engineering — September 8, 2026

This increment is not commercial activation. PHI stays disabled, Core remains the only launch tier, and no EAS/TestFlight build is authorized here.

## Implemented

- Read a result after the complete analyte name: digits in HbA1c, Free T3/T4 and 25-hydroxy vitamin D are not measurements.
- Retain incompatible-unit results without assigning a synthetic range from a different unit. Missing units are not guessed. Preserve Lipoprotein(a); do not classify ratios by a component's name.
- Comparison-qualified source results (`<`, `>`, `≤`, `≥`) stop document plan generation for source review rather than being converted into exact values or silently discarded.
- Do not manufacture collection dates. Do not trust client-supplied historical functional limits. Reviewed historical ranges remain unavailable unless historical population context can be established.
- OCR confidence and saved numeric values are not labeled independently verified.
- Retry queue dispatch for a durable queued job using the identical execution name and input. Return the persisted ID if dispatch temporarily fails. Cross-user polling cannot dispatch another user's job.
- Reject out-of-order worker passes, protect completed/deleted job records against late callbacks, and refuse deletion success when S3 reports partial object-deletion errors.

## Reviewed reference release

`src/server/clinical-core/lab-range-release.ts` verifies an Ed25519-signed UTF-8 payload, pinned SHA-256, schema, expiration and attributable source/reviewer fields. Numeric limits match exact analyte/alias, unit and known age/sex/pregnancy population. Missing or ambiguous applicability does not produce an optimal label. Critical thresholds must be explicit signed values, not arithmetic extrapolations.

The optional `reviewed_release` infrastructure mode requires a bucket, exact object key, hash and public signing key. Jobs pin the release hash; a changed deployment configuration is refused for an in-flight job. The worker receives read access to only that object. Use SSE-S3 or the already-permitted clinical KMS key; a different encryption key requires separately reviewed IAM access. No signing private key is deployed.

The tests sign fictional `widgets` ranges with ephemeral test keys. They are not clinical approvals. No real range release was authored, signed or activated by this change. The existing synthetic fixture mode remains the default for installed-client compatibility; it is not a production source of clinical thresholds. A misspelled mode is refused instead of falling back.

V2 accepts `unclassified` measurements, shows a neutral “Range unavailable” label and preserves measured trends without inventing progress toward an optimal range. Ask ALP receives a source-review status, not a normal label, for these results. Reviewed mode must not be enabled for older clients that lack this contract.

## Verification and rollout

Local typechecks, lint and regression suites cover parsing, signature/hash validation, demographics/units, missing ranges and mocked job lifecycle errors. Hosted acceptance and exact artifact hashes must be recorded separately after a successful deployment. These tests do not constitute physical phone or complete App-to-Desktop verification.

`scripts/update-aws-synthetic-lab-code.ps1` targets only account 588966314750 and the existing synthetic lab stack. It preserves all existing parameters, checks the change set for unexpected resources/replacements, and reports UPDATE_REQUESTED, not deployment success. Confirm UPDATE_COMPLETE and Lambda archive digests afterward.

`scripts/run-aws-saved-lab-plan-live-test.ps1` submits fictional saved markers, checks a generated plan and source-review labels, then removes the test job. It reports incomplete cleanup if a job is still active. This does not certify clinical product selection or physical UI behavior.

## Hosted evidence recorded September 8

- Runtime code: `866a79ab84c3b07e682d9b6b3f59d383e1268363`; the subsequent deployment-script-only commit `8ba1e2ea42ede4d069fb6e51bc7105e14edeee3b` does not change the bundles.
- Stack `ai-clinical-core-synthetic-staging-lab-analysis`: UPDATE_COMPLETE. Account 588966314750, us-east-2. `PhiAllowed=false`, `DataClassification=synthetic_only`, `LabRangeMode=synthetic_fixture` independently rechecked. No production clinical activation or public Desktop UI deployment.
- API ZIP SHA-256: `101a19abee56b07028305fd12e21fcfafd44ff535bb28454dc794c37c80f6458`; worker ZIP: `fe0c5e5498c88e0bd26d0ade5621944c5feb13e1919dfe31c1dc60a4bbb13f72`. Both exactly match the deployed Lambda CodeSha256 values; update status Successful.
- First authenticated hosted test: 3 fictional current markers retained, 6 plan tasks, 2 historical supplement considerations, source-review provenance retained, job deleted.
- Expanded authenticated hosted test: all 30 fictional current markers retained, 6 plan tasks, 2 historical considerations, source-review provenance retained, job deleted and subsequent GET returned 404.
- These consideration counts are fixture expectations, not clinical product-selection approval or a prescription. No real user lab payload or provider secret value was read or printed.
- Final local Desktop run: 1,121 passed / 10 skipped, typecheck passed, lint zero errors / four existing warnings. V2: 372 passed / one skipped, typecheck/lint passed; exact commit `92356dd4c69ee2af68ed9b602fb2e3d1b757109f` GitHub run `34295860233` passed. Desktop run `34295955899` has unit/typecheck/lint/build and four executed browser suites passing; its long fixture suite was still in progress at evidence capture. The secrets-gated backend job is not physical user acceptance.

## Remaining engineering

Latest independent-history increment: [personal lab history](personal-lab-history-readiness.md).
The new owned observation store feeds consented production chat without a clinic
connection, but uploaded observations stay unverified. This does not convert the
existing synthetic document/job API into a production clinical service.

- Convert the lab API/ownership/consent contract and routing to the approved standalone production consumer model; this extension is still synthetic-only.
- Supply and qualify an actually reviewed reference release and independently verified source extraction. Qualified measurements need an explicit data model if they are to be supported automatically.
- Add a background recovery policy and concurrent worker leases where required. Current guards prevent terminal ledger corruption; they do not guarantee exactly-once external model calls.
- Qualify production voice identity, consent and retention. Durable synthetic voice start/status/cancel and late-transcript cleanup are implemented; that does not authorize a production voice deployment.
- Finish end-to-end privacy fulfillment, provider acceptance, independent Core production scope, release/security/restore testing and physical iOS/Android acceptance.

No claim is made that only human paperwork remains.
