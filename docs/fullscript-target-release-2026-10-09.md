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
`fullscript-qualification-target-release/2`, a `target`, `credentials` and a `review`. Version 1 is refused. The target
contains the existing qualification API fields and all 111 exact migration
entries, except `reviewSha256`. Its `functionArn` is the unqualified function
name in synthetic account 588966314750, us-east-2. Its source commit and exact
ZIP `codeSha256` come from the clean build, not a placeholder.

The credentials binding names one sandbox JSON secret ARN and immutable version,
one token table and the exact registered HTTPS OAuth callback. These are
identifiers, not secret values. They must match the function's four corresponding
settings. The provider and database secrets are distinct. The protected secret
has contract `fullscript-sandbox-credentials/1` and fields `environment=sandbox_us`,
`clientId`, `clientSecret`, `stateSecret` and `redirectUri`. Use recursively sorted
compact JSON with one LF. Do not paste values into source, reports or Lambda
environment variables. Existing separate connector secrets are not automatically
combined or copied; a reviewed operator must prepare this explicit sandbox
credential version, preserve its custody and confirm the OAuth installation.

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
   organization, designated fictional subjects and credential identifiers. Review
   the generated template and database credential's restricted login privileges
   as well. No numeric version is guessed.
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
The candidate builder now generates those grants and published-version routes
as source. Their deployed behavior remains unqualified.

## Scoped provider credentials

Only an admitted workforce send or reconciliation invokes the native secret
loader, after the API has verified the signed identity, current MFA, exact AWS
target and worker ledger, and the delivery service has checked current SQL
authority. Consumer read, cancel and export do not read provider secrets.

The loader requests the exact secret ARN and version, verifies the returned
identity/version and sandbox content, refuses malformed or oversized content,
and applies a five-second deadline with one native attempt. The 8 KiB check is
on the SDK-decoded secret value, not a proof of network streaming bounds.
Secrets are not cached. The resulting environment belongs to one request and
is used by configuration, token refresh and every credential-custody recheck;
shared `process.env` is never changed. The source tests also poison global
settings to ensure they cannot redirect a request. Failures return opaque codes.

## Restricted qualification candidate

After a clean committed API build, run
`npm run build:fullscript-qualification-template`. A dirty or mismatched ZIP
cannot produce the template. It uses the synthetic account, Ohio, the isolated
qualification database and two new, separate JWT authorizers whose issuer and
audience match the reviewed target. Default
qualification execution is off; only the retained log group is unconditional.
PHI and production activation have no enabled parameter value.

The function and both exact POST routes are conditional. They use one published
numeric version whose code digest must match the build. Invocation permissions
name only API Gateway, this account, this API and those two POST paths. No
function URL, alias, default route, direct-invoke grant or provider-send endpoint
is created. The function reserves one execution, which still needs actual AWS
capacity. Lambda errors and throttles target the existing qualification alarm
topic; source wiring does not prove a subscription or delivery.

Runtime permissions read only the pinned S3 target version, the selected function
configuration, the selected API's route/authorizer/integration metadata, two
Cognito pools and current users, the reviewed cluster and database secret, and
the pinned provider secret version. Token custody permits GetItem and conditional
PutItem only within the reviewed organization's partition. It permits no token
scan, deletion, nonce write, secret mutation or object write. Customer-managed
secret keys require separately reviewed exact key ARNs and decrypt grants limited
to Secrets Manager and the corresponding secret encryption context. The database
secret is still not a claim of least-privilege SQL access: inspect its login and
role membership before deployment. The native worker never falls back to an
administrative role.

Before a deployment, independently compare all filled parameters with the reviewed
target, exact source/ZIP, foundation, IAM policies, existing token store, actual
secret encryption and authorizers. Register current SQL/provider/consent releases
only from real reviews. The template contains no release rows, consent grants,
provider approval or fictional identities. A deployment and acceptance operator,
live permission checks and real fictional sandbox journeys remain required.

## Offline deployment preflight

Build the local inspector with `npm run build:fullscript-deployment-preflight`
from the same clean committed source as the API ZIP and template. Run its
`dist/aws-clinical-core/fullscript-deployment-preflight/index.cjs` with
`--inspect-fictional-fullscript-deployment-only`, followed by five absolute
paths in order: artifact manifest, ZIP, generated template, reviewed target,
and explicit CloudFormation parameters. The parameter file is a canonical
compact JSON array of `ParameterKey` and `ParameterValue` rows, followed by LF.
Include every parameter, including the two empty optional KMS values. Duplicate
keys, `UsePreviousValue`, unknown or missing parameters are refused.

The inspector verifies actual ZIP bytes, the generated template, source commit,
target hash, all 111 migration identities and the exact function, API, pools,
organization, database and credential bindings. It requires immutable object
versions, separate pool/client audiences and sandbox credentials. The fixed report contains
only digests, source and status, never credentials or target contents.
`locally_consistent` is not deployment approval: authorizer configuration,
S3 object versions, KMS keys, token-table schema, SQL privileges and provider
registration must still be inspected in AWS and independently reviewed. The
report explicitly leaves `approvedForDeployment=false`, `awsObserved=false`
and `ownerDeploymentReviewRequired=true`. The inspector performs no AWS call,
secret read, review creation, upload, stack change or provider operation.

## Local verification

The offline preflight adds 39 unit checks. Its combined loader/runtime/API group
passed 218 tests in five files. The broad source group passed 629 tests in 21
files, no skips, in 179.78 seconds starting at 22:07:52 PDT on October 9.
Typecheck and targeted lint pass. The first parameter-count assertion expected
29 instead of the generated template's 27 and failed; the corrected assertion
passes. Built-command acceptance is a separate check, not implied by these
module results. All targets, transports and review attestations in tests are
fictional; no actual review or AWS deployment is established.

The first actual built-command run passed six checks and failed the
outside-repository refusal because Git's child-process stderr escaped the
opaque error boundary. Git output is now explicitly captured. The seven-case
command suite passed on clean source 61f2e93; its initial failure is retained,
not recast as success. That report predates the authorizer-owned candidate below.

A read-only inspection of API 6zt8e9qz04 found four existing JWT authorizers,
three pointing to an older shared pool and one to an older separate pool. It
found no Fullscript draft routes. The code bucket is versioned, and the synthetic
account's name-filtered secret listing has no Fullscript entry. No secret value
was read. The candidate now creates its own two issuer/audience-pinned
authorizers instead of reusing those IDs. The offline preflight compares both
client audiences to the reviewed target. Preparing an actual sandbox secret,
registration and token store remains independently reviewed work.

The credential and restricted-template increment passed the broad source group:
590 tests in 20 files, no skips, in 167.87 seconds starting at 21:52:12 PDT on
October 9. The template has 19 passing Node tests, and its generated fictional
instance passes local CloudFormation schema/reference lint. Typecheck and
targeted lint pass. The 31 secret-loader cases, eight credential-target cases
and three provider-binding cases add 42 unit regressions. The real SQL/native
provider composition also verifies request-scoped credentials under poisoned
global settings and consent withdrawal. These are local fictional transports,
PGlite and reused dependencies, not AWS, Fullscript or device acceptance.

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
