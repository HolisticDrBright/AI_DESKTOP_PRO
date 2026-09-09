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

## Remaining engineering

- Convert the lab API/ownership/consent contract and routing to the approved standalone production consumer model; this extension is still synthetic-only.
- Supply and qualify an actually reviewed reference release and independently verified source extraction. Qualified measurements need an explicit data model if they are to be supported automatically.
- Add a background recovery policy and concurrent worker leases where required. Current guards prevent terminal ledger corruption; they do not guarantee exactly-once external model calls.
- Implement durable production voice start/status/cancel and late-transcript cleanup. The current synchronous transcription request is not a durable production workflow.
- Finish end-to-end privacy fulfillment, provider acceptance, independent Core production scope, release/security/restore testing and physical iOS/Android acceptance.

No claim is made that only human paperwork remains.
