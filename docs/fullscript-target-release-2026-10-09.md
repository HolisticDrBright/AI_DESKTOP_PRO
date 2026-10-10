# Fullscript qualification target release

The native target loader and API bundle are source candidates for the isolated
synthetic service. Neither is installed. The current cart route still reports
`not_implemented`, and no provider order, patient send, charge or PHI activation
is authorized. The 111-migration database transition is a separate reviewed step.

## Configuration and publication

Build committed clean source with `npm run build:fullscript-api`. It produces
`dist/aws-clinical-core/fullscript-api/index.js`, a deterministic one-entry
`function.zip` and a separate `artifact-manifest.json`. The manifest records the
actual source, ZIP SHA-256 and base64 `codeSha256` used by Lambda. Dirty builds
are marked dirty and cannot load a target. The ZIP does not contain a reviewed
target, its own digest or approval data.

The separately reviewed JSON artifact has contract
`fullscript-qualification-target-release/1`, a `target` and a `review`. The target
contains the existing qualification API fields and all 111 exact migration
entries, except `reviewSha256`. Its `functionArn` is the unqualified function
name in synthetic account 588966314750, us-east-2. Its source commit and exact
ZIP `codeSha256` come from the clean build, not a placeholder.

The review contains Brandon Bright's actual approval time, decision `approved`,
scope `fictional-fullscript-api-target-only` and version binding
`observed-numeric-version-of-exact-reviewed-code`. This is an operator's review
attestation in a protected deployment artifact, not a cryptographic signature,
clinical approval, provider approval or production activation. Do not create it
without an actual owner review. Its schema does not prove a review happened.

Object keys are recursively sorted, arrays keep their order, and compact UTF-8
JSON ends with one LF. The SHA-256 of these exact bytes is the qualification
review hash. Store the artifact as an immutable version in the code bucket,
under `fullscript/qualification-target/<32 lowercase hex characters>/target.json`,
with content type `application/json` and the code bucket's SSE-S3 encryption.
Neither a latest-object pointer nor a `null` version is accepted. Deleting that
version makes the runtime refuse; there is no configuration fallback.

The publication sequence avoids a circular digest or a guessed Lambda version:

1. Build the ZIP and record its exact source and code digest.
2. Review the target's function name, code digest, API, database, pools,
   organization and designated fictional subjects. No numeric version is guessed.
3. Store the reviewed artifact and record its immutable S3 version and byte hash.
4. Configure the function's pointer and qualification-only settings, then publish
   a numeric Lambda version. Route integrations must name that numeric version.
5. At invocation, derive the qualified ARN only from AWS's numeric context. The
   existing observer independently reads that version's actual code/environment,
   JWT-authorized API integration, current identities and the same worker ledger.

The artifact authorizes only the exact reviewed code and configuration under
that function name. A later numeric version with different code or settings is
not authorized by it. Deployment evidence and hosted acceptance must still name
one exact published version; deriving context is not evidence that it was tested.

## Runtime safeguards

Required pointer settings are `FULLSCRIPT_TARGET_BUCKET`,
`FULLSCRIPT_TARGET_KEY`, `FULLSCRIPT_TARGET_VERSION` and
`QUALIFICATION_REVIEW_SHA256`. Required mode/source/database settings remain
`AWS_REGION=us-east-2`, `PHI_ALLOWED=false`, `PRODUCTION_ACTIVATION=blocked`,
`QUALIFICATION_EXECUTION=true`, `QUALIFICATION_ACCOUNT_ID=588966314750`, the
exact `FULLSCRIPT_SOURCE_COMMIT`, and the three clinical database settings.
Only the existing synthetic code bucket is accepted. Incoming events cannot
supply a target, review, store, provider, actor or override.

Each request fetches the pinned object version using expected bucket-owner
binding, a fixed regional S3 endpoint, one attempt and a five-second bound.
There is no successful-observation cache. The response must be a full 200 JSON
object with the exact version, no compression/range/delete marker, bounded
ContentLength and SSE-S3. The reader rejects malformed, empty, oversized or
disagreeing chunks, wrong bytes/hash, invalid UTF-8, duplicate keys, unknown
fields and pending/future reviews. It closes stalled and late response bodies;
a stream-close error cannot suppress the deadline refusal.

The runtime constructs the native observer/delivery API only after target
validation. Its existing observer must then verify signed identity, current
MFA/pool/user authority, actual published Lambda code/environment, exact API
routes and the same role-restricted database. Target load or construction failure
returns only an opaque refusal, without a successful qualification marker.

AWS documents [specific-version object reads](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html)
and [immutable published function versions](https://docs.aws.amazon.com/lambda/latest/dg/configuration-versions.html).
The candidate deployment still needs exact version-scoped `s3:GetObjectVersion`,
the existing observation grants, restricted database/token/provider permissions,
reviewed stack parameters and no public/direct Lambda invocation. Those grants
and their deployed behavior have not been qualified by local source tests.

## Evidence and remaining work

The focused loader/runtime/API group passed 140 tests in three files, and the
actual bundle/ZIP checksum and safe-refusal test passed. Responses are fictional;
no S3 object, Lambda route or provider was changed. Initial type, timeout-fixture
and lint failures remain failed observations. The stream-close issue exposed by
the timeout case was repaired rather than disabling the bound.

The final broader group passed 548 tests in 19 files with no skips, in 213.49
seconds starting at 21:26:10 PDT on October 9. Typecheck and targeted lint passed,
and the actual bundle/ZIP test passed again. The increment adds 48 loader cases,
four runtime-composition cases and one bundle case. Locally reused dependencies,
PGlite and fictional AWS/provider responses are not hosted qualification.

Required next: clean committed build, integrated regression/CI, exact owner
target review, immutable target upload and restricted candidate deployment,
actual S3/version/IAM/JWT/worker binding qualification, and the real fictional
provider journeys. Account-wide privacy/holds/provider-copy retention, OAuth
settlement, matched releases and physical devices remain open. All six original
commercial phases remain incomplete. PHI OFF, production blocked, clinical holds,
source verification, exclusions, adult-only Core launch and no paid builds remain.
