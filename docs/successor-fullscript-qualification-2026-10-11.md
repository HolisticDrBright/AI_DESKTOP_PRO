# Fullscript successor qualification source

October 11, 2026. Separate source on
`agent/qualification-successor-fullscript-bindings-20261011`, based on
`3eca21f035db6f6db58c15d654d6c82669251bfc`. This adds the Fullscript
request candidate for the proposed exact 117 release. It does not deploy a
candidate, execute migrations, supply credentials, activate a provider, qualify
the complete fleet or approve either application for PHI.

## Separate admission and unchanged authority

The historical 111/112 target union, target release contracts and entry points
retain their original admission. New entry points explicitly parse
`clinical-successor-qualification/117` and
`clinical-successor-qualification/1`. They bind every ordered migration
version, filename and body digest, not a matching count or prefix.

The successor release digest is
`34037e1ff05d583868c9a3796f673937777f88bcf4cebc2d589c6604626e9364`;
its assembly digest is
`d73f67f2197886cf24360f773018a72c92d666789891e679e151ae2c65bd796a`.
The existing request parsing, owner and clinic checks, current Cognito user
checks, fresh authentication and workforce MFA policy remain shared unchanged.
The existing canonical cart authority, delivery ledger, writer settlement and
credential-bound provider remain the actual operations; a reviewed target is
not a substitute for their authority.

## Immutable target and provider binding

`fullscript-qualification-target-release/4` contains a strict successor
target payload, the existing exact provider credential metadata, and the
existing explicit fictional-target review. The target carries source commit
and source-input digest, profile, complete ledger and assembly, API, unversioned
function name, code digest, organization and designated identity subjects.
The review must name observed numeric-version binding. It is an operator
attestation, not a cryptographic signature or provider agreement.

The target payload omits `reviewSha256` and `providerCredentials`.
The bounded loader derives the review digest from the exact canonical stored
bytes, derives the numeric function version from the actual invocation context,
and supplies `providerCredentials` from the outer reviewed credentials.
The resulting internal target is strict, requires distinct database/provider
secrets and at most 16 distinct designated subjects, and is never supplied by
an incoming request.

The immutable S3 target is read each request with its exact bucket, key and
object version, canonical UTF-8 bytes, byte bound and deadline. No successful
observation is cached. Before any target read, the new loader verifies clean
compiled source, source-input/profile/ledger/assembly bindings, PHI off,
production blocked, the synthetic account and the dedicated worker credential
namespace. The historical Fullscript `true` execution spelling is
translated only for the common validation call; no environment is changed.

The native observer verifies the actual numeric function, code digest, API
route/integration/authorizer, current Cognito identities and matching source,
database and provider metadata. It observes `current_database()`,
`current_user` and the complete ledger through the same delivery database
object. The role must be `fullscript_draft_worker`. The API credential,
operator credential, wrong database, extra/altered migrations and provider
metadata drift are refused. Native provider-secret loading remains lazy:
consumer reads/cancel/export do not invoke it.

The compiled runtime captures source and environment defensively. It checks
drift before/after target loading, before/after provider credential loading
and before returning a response. Only AWS's per-invocation tracing key is
excluded. The credential metadata schema is a data-only module; importing it
does not construct a Secrets Manager client. Its historical validation is
unchanged and remains re-exported from the existing module.

## Packaging and template

`npm run build:successor-fullscript-api` refuses dirty source. It compiles
the actual native successor, validates the actual proposed SQL release and
records source identity before and after building. It produces the index,
stored ZIP, manifest, exact release descriptor, separate template and
historical template reference under
`dist/aws-clinical-core/successor-fullscript-api`.

The template has its own contract, `successor-fullscript-qualification-candidate/1`,
and binds the new ZIP's digest to a published numeric version. Code uses a
separate source-addressed prefix including commit and source-input digest.
The observed source-clean Boolean is passed to the historical template helper
only after validation, never replaced by an invented true value.

The copied template retains the original restricted IAM statements, versioned
target read, exact provider credential version, organization-bound token
custody, routes, published version, alarms and disabled-by-default execution.
The dedicated database-secret pattern and exact successor binding condition
are additive. Neither existing builder nor its migration admission is changed.
Packaging success alone is not a positive hosted provider journey.

## Source verification and limits

The failing-before diagnostic completed with 23 cases, 8 failures and 15
passes. The historical factories correctly refused the new release; the
expected new early binding checks were not implemented. No historical safety
assertion was weakened to get a positive successor.

During implementation, a TypeScript line-break parse error and a historical
mock dependency exposed by importing the secret-loading module were repaired.
The new embedded database initially used a nonexistent database at startup;
the corrected test creates the fictional database locally, snapshots and
reopens it, and checks its actual name rather than faking that observation.
These failed runs are not passes.

The new binding suite passed 34 cases on the completed implementation,
including actual 117 SQL, actual worker role, complete worker-visible ledger,
direct clinical-schema access refusals and consumer/workforce JWT verification
using locally signed RSA tokens and fictional cached JWKS. AWS observations
are fictional command transports. Eight template tests passed. Typecheck and
lint passed before publication. An earlier six-file historical/new run passed
240 cases before the additional workforce observation case was added.

The following commands define final exact-source verification; publication
and terminal results are recorded separately in the root checkpoint:

```text
npm run typecheck
npm run lint
npm run test:successor-fullscript-binding
npm run test:fullscript-target-runtime
npm run test:successor-fullscript-template
npm run test:successor-fullscript-build
npm run build:successor-fullscript-api
cfn-lint dist/aws-clinical-core/successor-fullscript-api/template.json
npm run test:unit
npm run build:clinical
npm run check:clinical-bundle
```

AST-only Graphify refresh is required after code changes; no LLM extraction
or clustering is used. Local tests, embedded PostgreSQL and template conditions
are not AWS, provider, physical-device or production activation evidence.

## Ordered execution dependencies

1. Review and execute only the exact preserving schema sequence and establish
   the complete managed ledger. Last inspected managed qualification ledger
   remains 107; this source does not change it. Earlier approval of a different
   executable does not authorize the changed operator or the proposed 117.
2. Separately review/provision the dedicated worker credential, effective login
   and grants, database isolation, rotation, Secrets Manager/KMS and IAM.
   A namespace assertion neither creates a secret nor proves its permissions.
3. Review the real immutable target for this exact code and identities, provider
   secret/version, organization-bound token custody and API resources. Do not
   create review hashes from fictional test fixtures.
4. Prepare a separate preserving deployment/operator path for this contract.
   The historical deployment operators are not silently broadened here.
5. Deploy under the reviewed qualification profile only, then run the actual
   consumer/workforce, wrong-owner/clinic, revoked identity/MFA, consent,
   cart/revision, provider, cancellation/settlement, export and cleanup journeys.
   Refusal/skipped steps are not positive acceptance.
6. Complete the remaining telehealth-request artifacts and complete fleet
   target/resource/code/ledger/credential observation, matched releases,
   physical devices, provider/store acceptance and human approvals.

The clinical and commercial rules, catalog holds/exclusions, source
verification, adult Core launch scope, PHI off and paid-build hold remain.
