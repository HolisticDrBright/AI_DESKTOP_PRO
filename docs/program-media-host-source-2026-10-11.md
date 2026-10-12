# Native media host authority and bounded routes

This source increment connects the existing media ledger, SDK storage adapter and
binary handlers to a dedicated managed-host entry point. It is for fictional
qualification only, disabled by default. It does not install AWS resources,
release a candidate, grant learner access or establish commercial or PHI readiness.

Branch: `agent/program-media-host-source-20261011`, deliberately based on
`1c618f54f79548ea33c603012cf11547dc87059e` from
`agent/program-media-preview-delivery-20261011`. The parent has exact successful
[CI 38201616307](https://github.com/HolisticDrBright/AI_DESKTOP_PRO/actions/runs/38201616307),
478 unit files, 7,772 passing tests and 11 existing skips. Parent evidence is not
verification of this successor. Claude's commerce branch remains separate.

## Request authority

`program-media-host-target/1` binds the exact application commit, host review,
account `588966314750`, Ohio region, isolated `clinical_core_qualification`
database, cluster, dedicated login secret, distinct managed-host/storage roles,
workforce pool/client, HTTPS origin, designated subjects and complete ordered
migration ledger. It also binds the dedicated bucket/key, native and multipart
release evidence and reviewed multipart policy. A structurally valid target is
not proof of any review or installation. Missing candidate identities, duplicate
subjects or ledger versions, production targets, PHI and shared storage refuse.

The native factory captures one temporary managed-host credential copy and uses
it for fixed-endpoint STS, Cognito and Data API clients. It never substitutes an
operator profile, permanent access key or administrative database credential.
Bootstrap rejects malformed or nearly expired credentials, honors withdrawal
before resolution, observes late failures and closes partially opened clients.
Only fictional resolver/constructor tests exercise this assembly locally; no
ambient credential resolver or metadata endpoint was contacted.

The authority cryptographically verifies the server cookie's Cognito ID token
and independently reads the current host principal, pool, client and user.
Mandatory MFA, local password/SRP-only sign-in, preferred TOTP, current enabled
confirmed user and verified email must agree with the designated signed identity.
Authentication must be within 15 minutes and not predate pool/client/user policy
changes. Federation, remembered-device bypass, passwordless/custom flows and
browser-supplied identity fields do not establish authority. A refresh does not
refresh `auth_time`. This strict qualification profile is not a replacement for
reviewing the actual production workforce design.

Before storage issuance, the restricted SQL ledger independently authorizes the
program. STS issues a 15-minute session with the host review as ExternalId and
the current person as SourceIdentity. The session policy restricts objects and
KMS context to the one clinic/program prefix. Current identity and SQL permission
are checked again after STS; credentials are withheld if either changed during
issuance. Credentials stay server-side and are never a response field.

## Dedicated database authority

`program-media-host-authority.sql` is a distinct BLOCKED, unregistered and
unapplied candidate. Its LF-normalized SHA-256 is
`17f6bda07a4ec3fe541e4954abf63daf9b1ac4b4ca9149509851abf043f6892b`.
It seeds no password, login activation, record, review or release. A separately
reviewed operator would provision the dedicated credential; this candidate
creates `program_media_runtime` as NOLOGIN and NOINHERIT with membership only in
the existing reduced worker role. A non-bypass metadata owner exposes only ledger
version, name and hash through an empty-search-path function.

All five exact source identities are required in the target's actual ledger:

| Candidate | LF normalized SHA-256 |
| --- | --- |
| `program-media-ledger.sql` | `6dae2f237c13540b13cc3b7ecde877be104c35e59c7fddd9206130a62356a34d` |
| `program-media-settlement.sql` | `74f54bbb72539218dc6d12098a1773da572f4eb9230faae10010f69d5c95ff04` |
| `program-media-native-ledger.sql` | `69eb187cd22500014c1b79bf5dfdc7577e1c18376f30197eded0804f9114a6d7` |
| `program-media-multipart.sql` | `a9b2a38d76f7a07569ed94342cc53a7810c6480ba6f28e0a24297265e9f70092` |
| `program-media-host-authority.sql` | `17f6bda07a4ec3fe541e4954abf63daf9b1ac4b4ca9149509851abf043f6892b` |

Before every short media transaction, the guard checks the actual database,
SESSION login, current worker, all reachable roles, schema CREATE, raw table and
column privileges, sequence privileges, callable sensitive functions and exact
whole ledger. An administrative session temporarily using SET ROLE refuses.
An inspection error is not an empty privilege inventory. Provider HTTP calls
remain outside these transactions.

The worker's allowed function inventory is the native and multipart dispatchers,
the metadata-only host ledger, request-context setter and historical pure
`consumer_collection_scope(text)` mapping. The latter maps a collection name to
a constant scope, not a record read. Trigger-only routines are not directly
callable and neither role can attach them; raw TRIGGER/CREATE privileges remain
denied. Any additional directly callable clinical or SECURITY DEFINER function,
including a PUBLIC grant, refuses before media work. Production grants and real
PostgreSQL contention remain separately unverified.

## Installed route source

Four Next.js Node route modules call the single installed entry:

- POST `/api/live/programs/media/control`.
- PUT `/api/live/programs/media/image/[artifactId]`.
- POST `/api/live/programs/media/multipart/control`.
- PUT `/api/live/programs/media/multipart/part/[artifactId]/[partNumber]/[commandId]`.

This is container-compatible source, not a deployed route or Lambda JSON/base64
tunnel. The existing program editor has not yet gained a native upload/resume
controller in this increment.

The entry stays closed unless the edition is clinical, qualification is explicitly
enabled, PHI is false and production activation is blocked. It reads only the
reviewed read-only mount `/run/alp/program-media-host-target.json`, verifies its
exact byte hash against `PROGRAM_MEDIA_HOST_TARGET_SHA256` and source identity
against `PROGRAM_MEDIA_SOURCE_COMMIT`, and obtains the existing HttpOnly server
session. There is no browser path, env-file search, fixture fallback, cached
authorization or browser Authorization override.

File opening is non-blocking and refuses symlinks. Reads are bounded to 262,144
bytes plus an overflow byte, reject malformed UTF-8, growth, truncation and changed
descriptor metadata, and close late descriptors. One 30-second deadline spans
file opening, inspection, reading, closure, session lookup and the entire handler,
even when a dependency ignores cancellation. The downstream handlers retain
their own body and authority checks.

Image uploads independently authorize the immutable reservation before reading
an unencoded binary body. Measured length and SHA-256 must match exactly and stay
within the 16 MiB bound. The native source admits and verifies the exact READY
artifact; retry reuses it instead of writing another object. Genuine multipart
video uses the existing source and per-part checks. Text attachment/publication
use SQL without accidentally opening the single-PUT policy against a reviewed
multipart bucket. Final control replies recheck identity and current release
evidence; a release change withholds the private response, not a claimed success.

Original-author image/video preview is an exact-version signed URL. It grants
neither staff-team nor purchased-learner authority. A previously issued signed URL
is a bearer capability until its short expiry; this source does not claim immediate
revocation of an already issued URL. The separate learner/reference contract and
its privacy/access policy remain required.

## Storage policy boundaries

S3 Bucket Keys are refused because the selected KMS encryption-context fence is
object-prefix bound. Image PUT in a multipart-reviewed bucket requires that same
captured policy review; it is not permission to bypass a missing review. Existing
single-object FULL_OBJECT integrity checks stay in force.

The STS session policy can only narrow the reviewed storage role. Bucket-level
`ListBucketMultipartUploads` does not support a prefix IAM condition in this
design, so the native adapter independently validates exact-prefix output.
Effective role/trust/KMS/policy isolation and S3 listing behavior have not run
against real resources. Per-transaction inventory and repeated current-user reads
also require a measured latency/capacity check before commercial qualification.

## Reproductions and local evidence

The real SQL fixture applies the 47 historical qualification migrations and the
five exact BLOCKED source candidates. It explicitly creates fictional test ledger
versions and a test login. PGlite's physical database is `postgres`: the positive
fixture changes only that observed name to the reviewed qualification name;
a separate negative proves the unadapted physical name refuses. This is not
application of the 106 production migrations or a real dedicated login secret.

The composed positive uses an actual locally signed RSA token and Cognito verifier,
restricted SESSION role, guarded native SQL, handlers, SDK resource-check command
construction, create-only PUT/HEAD and actual URL signing. Only the network SDK
transport and host opener are replaced with fictional dependencies. It exercises
prepare, binary image, replay without a second PUT, supplied caption, publication
and exact-version preview. Forged signatures, changed MFA and changed release
evidence refuse. It does not exercise the mounted filesystem, native managed-task
credential chain, real Data API, real KMS or effective IAM as one deployed system.

Failing-before evidence is preserved in the engineering record:

- Three guard tests initially admitted an extra worker/PUBLIC SECURITY DEFINER
  function or sequence grant. The expanded inventory refuses all three before work.
- The composed release-change test initially returned 200 after review changed.
  Final configuration binding now returns an honest refusal.
- One issuance-race test initially returned credentials after program permission
  was withdrawn. The post-STS SQL check now refuses.
- Five bootstrap tests initially accepted missing/short secrets or an empty token,
  resolved credentials after pre-withdrawal, or leaked a partially constructed
  client. All now pass with no ambient credential resolution.

The first healthy privilege-inventory fixture exposed seven trigger-only functions
and one pure historical scope helper. The test and guard now classify those
accurately rather than granting arbitrary callable routines. Two composed-test
assumptions were corrected: the actual preview field is `previewToken`, and real
file closure returns a Promise. No permission, integrity or deadline negative was
removed or loosened to obtain a pass.

Current terminal local evidence: 553 tests across 23 media files passed with no
skips; standalone typecheck passed; lint and seven source gates passed. The latest
bootstrap/authority run passed 55 tests. Clinical production build completed with
exit 0 and the strict bundle scan passed 313 client chunks. The Windows build
reported a standalone symlink EPERM warning, so it is not proof of a deployable
container image. The normal full unit suite completed with exit 0: 483 files,
7,894 passing tests and 11 existing skips in 754.34 seconds. No successor CI
result is yet available; observe the exact committed head before recording it
as CI verified. These local results are not installed-host or hosted evidence.

Local AST-only Graphify completed with 18,427 nodes and 42,226 edges. It reports
88 source files with zero extracted nodes and omits HTML visualization above its
size limit; the graph is navigation evidence, not exhaustive verification.

CI has an explicit fictional-only host step in addition to the normal suite.
Focused commands from the repository root:

```powershell
npx vitest run src/server/programs/program-media-host-authority.test.ts src/server/programs/program-media-host-bootstrap.test.ts src/server/programs/program-media-host-database.test.ts src/server/programs/program-media-image-http.test.ts src/server/programs/program-media-installed-host.test.ts
npm run typecheck
npm run lint
npm run test:unit
npm run build:clinical
npm run check:clinical-bundle -- --strict
```

## Remaining engineering and qualification

Native editor upload/resume/recovery, separately authorized learner media delivery,
the mirrored V2 reference successor, independent cleanup/drain, native host packaging,
reviewed resource/credential installation and preserving candidate custody remain.
The current native media SQL resolves `synthetic_desktop_programs` on the historical
qualification family. A separately reviewed production family bound to the canonical
authoring program and purchased curriculum is still engineering; this qualification
host must not be relabeled as that port or pointed at production by changing a flag.
So do actual storage/IAM/refusal/race tests, measured request latency, matched
Desktop/API/V2 releases, native-device acceptance and provider/store/policy reviews.
No review hash, consent, fixture, provider permission or activation is invented to
make a positive test possible.

This increment advances reliable processing, privacy/access and release engineering
inside the original six scopes. Account/plan continuity; owned lab/document/voice
processing; privacy/retention; clinical knowledge/release; commerce/providers; and
exact matched-release/device qualification all retain their remaining completion
requirements. It does not add another readiness phase or certify any whole phase.

Clinical holds, exclusions, source verification, measured inputs, guardian deferral,
free recovery of existing personal data, Core launch scope, peptide/longevity gates,
PHI-off restrictions and the paid-mobile-build hold remain unchanged. No AWS write,
secret retrieval, provider call, schema application, deployment, activation, paid
build, main merge, PR or force-push occurred. Graphify is updated locally through
AST only; the shared canvas is untouched.
