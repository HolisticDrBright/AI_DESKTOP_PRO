# Native multipart lesson media storage source

This successor to Desktop `363a7c86ddcceb1f00c70ab10297b27cfb3c70c8` adds the actual S3 SDK source for lesson-video initiation, measured parts, create-only completion, bounded observation, exact-version streaming verification and cleanup requests. It remains a server-only source port, not an installed host, mounted route, browser upload workflow or V2 delivery service. All resources and activation stay unconfigured; PHI remains disabled.

## Preserved authority and candidate identities

The multipart SQL candidate remains BLOCKED, unregistered and unapplied: `infra/aws-clinical-core/source-candidates/program-media-multipart.sql`, LF-byte SHA256 `a9b2a38d76f7a07569ed94342cc53a7810c6480ba6f28e0a24297265e9f70092`. No SQL, migration, mirror, custody receipt, release row, infrastructure template or production manifest changes in this increment. The restricted native parent and both selected ledger/settlement predecessors retain their identities.

The committed parent has observed exact CI [38192058876](https://github.com/HolisticDrBright/AI_DESKTOP_PRO/actions/runs/38192058876) success, a normal local suite of 473 files and 7,595 passing tests with 11 existing skips, and successful lint, clinical build and strict client scan. That is predecessor evidence, not hosted evidence or automatic verification of this successor.

`createAwsProgramMediaMultipartStoreSource` requires the reviewed synthetic storage configuration, an active request signal, the exact workforce actor and a separate multipart policy review. It retains explicit temporary credentials, synthetic account `588966314750`, Ohio endpoints, dedicated educational storage, clinical/recording resource exclusions, exact role readback and one attempt per SDK call. Current workforce/MFA/release admission and narrowly scoped role installation remain the host's job. Resource readbacks and a caller-supplied digest are not approval or proof of effective IAM.

Each mutation requires the first durable native admission for its exact operation and part. A local consumed-claim fence supplements the database fence; it cannot replace it across processes. The port never admits a database intent or accepts a browser's verification/absence declaration. Mutable part bytes are copied and checked against the immutable manifest before sending.

## Storage and observation behavior

Initiation carries the exact educational metadata, native writer claim, full-file SHA256, media type, SSE-KMS key and SHA256 composite mode. Part uploads bind the exact upload ID, number, measured bytes and part checksum. Completion sends ordered receipts, the manifest size, composite checksum and `IfNoneMatch: '*'`. A completion response must bind the exact bucket, key, non-null version, checksum mode and key; malformed success remains an uncertain writer.

The SDK's embedded-error handling is exercised with a fictional HTTP 200 completion error. No automatic retry or re-initiation is permitted by this port. Lost replies, ignored/late aborts, 5xx, conflicts and malformed successes remain uncertain. Only a structured precondition rejection or a pre-send refusal is classified as definite. This design deliberately retains the durable writer rather than treating an HTTP timeout as proof that remote work stopped. AWS documents conditional completion and errors inside HTTP 200 responses in [CompleteMultipartUpload](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CompleteMultipartUpload.html).

Parts, upload and version listings are bounded by 20 pages, requested page sizes, total observations and duplicate/loop checks. Part continuation markers use the SDK's string shape and must advance within the manifest. Prefix neighbours are never deletion targets, and oversized neighbour pages cannot evade the observation budget. Denied, malformed, interrupted or looping listings are incomplete, never absence.

Verification requests the recorded version by checksum-enabled HEAD and GET. Both replies must bind version, size, type, composite checksum, KMS key and all expected metadata. The body streams through incremental whole-file and per-part SHA256 checks, including chunks crossing part boundaries. Overrun, short read, substituted bytes, string chunks and missing bindings cannot produce a proof. Composite checksum and whole-file SHA256 remain independent. No whole-file buffer or SDK `transformToByteArray` is used.

Withdrawal/deadline races terminate even an ignored SDK/body wait. Bodies arriving after that wait are cancelled too, and acquired readers/iterators are closed. Throwing cleanup hooks cannot replace an honest refusal with provider detail. Resource inspection itself uses an abort race, rather than waiting indefinitely for a transport to observe its signal. The request lifetime remains 30 seconds across resource inspection and storage operations; a real host must measure whether its transfer/verification sizes meet that bound.

Abort and version deletion return no absence certificate. They keep the exact key/upload/version and never perform unversioned deletion. A subsequent complete inventory, after the native ledger proves every admitted writer settled, is still required before `certifyAbort`. An authorization loss does not manufacture a recovery identity.

## Separate multipart policy review

Single-PUT's blanket missing-encryption-header denial is not reused for multipart. The new `program-media-multipart-resource-review/1` binds exact observed policy bytes by SHA256 and names a separate evidence digest. Minimum denials require TLS, reject explicit non-KMS or wrong-key overrides, and enforce create-only object completion. Resource reads separately require the exact bucket KMS default, versioning, ownership, public blocks and synthetic education tags. Missing encryption headers on parts do not authorize a different destination/key.

The conditional object-creation denial exempts initiation and part calls using `s3:ObjectCreationOperation`. Those operations cannot send conditional-write headers; AWS describes the distinction in [Enforce conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes-enforce.html). This minimum source check is not a full policy evaluator or a reviewed IAM/bucket/KMS deployment. No policy or review hash is created outside fictional tests. The existing single-PUT policy check remains unchanged.

## Reproductions and local evidence

The ledger reader previously accepted QuickTime instead of the governed WebM type. The new WebM status case failed before the reader was corrected and passed afterward; the SQL and governed media contract were unchanged.

Three failures in the initial SDK draft were reproduced: a late-body cancellation gap and two new test-fixture mistakes. The missing-review fixture had invoked a helper whose default argument supplied a review; it now calls the real boundary with the missing value. The part receipt assertion incorrectly expected the manifest's full `sha256` field in a provider observation; it now asserts the exact four-field measured receipt and retains byte/checksum checks. The cancellation test is retained, and the source now disposes both immediate and late returned bodies. These are not claims that three shipped predecessor bugs were fixed.

Two additional resource-read negatives timed out against the earlier source at the unchanged five-second test deadline: one after STS withdrawal, one after policy-read withdrawal. Both now refuse without extending the timeout. Added cases cover acquired-reader cancellation, throwing iterator cleanup, SDK string pagination, oversized pages, cross-part streaming and actual SDK request/response middleware.

Observed focused results before final source freeze:

- Combined final focused run: 11 store, SDK middleware, ledger, request, settlement, HTTP and parts files, 235 tests passed. This includes six actual SDK middleware cases: three single-attempt failures, an embedded HTTP 200 error, composite streaming and exact serialized headers.
- Final all-file typecheck, changed-file lint and diff whitespace check passed. Mock-import, identity/consent, authenticated API, compatibility, operation inventory, production-core and stub-reset source gates passed. The production artifact remains 106 migrations and zero seeded rows; inventory remains 228 activation-blocked operations, zero enabled.
- The normal full suite, full lint, clinical build/strict client scan and exact successor CI are tracked separately after source freeze and must be observed to count. No predecessor result substitutes for those checks.

No AWS read/write, secret retrieval, schema application, provider call, activation, paid build, mobile upload, deployment, main merge, PR or force-push occurred. Fictional credentials and review digests never count as activation evidence.

## Remaining integration and qualification

1. Compose native first admissions, this store and exact receipt recording through an immutable per-request host. Persist admissions before external work, preserve unknown writers after receipt failure, and expose no proof operations to a browser. A listed upload after a lost creation reply lacks the initiating metadata needed to prove ownership; do not adopt it by key/count alone or blindly recreate it.
2. Add bounded multipart routes and Studio upload/resume/recovery controls on a host that genuinely carries 8 MiB parts. JSON/base64 Lambda payloads are not assumed sufficient. Add qualified cancellation/settlement reconciliation, including both late-write race orders and original-author withdrawal.
3. Bind the mirrored V2 read-only media reference to the selected native ledger and exact published version. The existing single-PUT preview requires FULL_OBJECT and cannot serve these COMPOSITE objects; add the distinct trusted multipart delivery seam rather than globally relaxing that check. Complete private short-lived delivery, retirement history, cache/withdrawal semantics and two-device/foreground isolation without overlapping Claude's purchase/enrollment/progress lane.
4. Review dedicated bucket/KMS/IAM resources, the separate multipart policy, schema upgrade, delivery origin and retention before any registration or deployment. Prior fictional schema approval does not approve this candidate.
5. Qualify actual STS/S3/KMS shapes, denied IAM, checksums, both markers, uncertain initiation/completion, cancellation, late receipts, post-settlement inventory and no-op cleanup in the isolated target. Fictional HTTP and embedded databases do not prove these hosted cases.
6. Reconcile exact source pairs, rebind release kits and qualify matched backend/Desktop/mobile candidates with rollback and physical iOS/Android acceptance. Paid mobile builds and PHI activation remain separately held.

The original six commercial-readiness scopes remain incomplete. Preserve clinical holds, exclusions, source verification, measured inputs, guardian deferral, free personal-data recovery and Core launch boundaries. The shared Graphify canvas is untouched.
