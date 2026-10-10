# Fullscript canonical delivery service

The database authority, durable delivery ledger and native credential-bound
Fullscript provider are now composed in one request-scoped service. It is
unreleased: no HTTP route, deployed worker, approval, patient send, order or charge
is enabled. The cart contract still returns `not_implemented`. This increment
advances provider integration, not commercial or PHI activation.

## Authority and provider sequence

`createCanonicalFullscriptDelivery` fixes the actor and session for the life of
one request. Its methods accept only selectors or intent IDs, never another actor,
a provider review, a mapping body, credentials or a caller-selected transport.
The new qualification HTTP source boundary derives this actor and session from
verified identity and live target observations. This internal constructor is
not a JWT, MFA or target verifier; the new boundary is not installed or deployed.
See `docs/fullscript-qualification-api-2026-10-09.md` for its release requirements.

Preparation and writer admission use the canonical SQL authority and ledger.
After admission commits, the provider bridge reads the exact stored intent in
the same database, verifies its original writer actor, immutable input and current
authority, and loads the provider release from that complete current snapshot.
Consumer status, cancellation and single-intent exports never construct a
credential provider, and consumers cannot prepare, dispatch or reconcile drafts.

Before POST, the writer must still be dispatching, unsettled and inside its
database-clock lease. The provider observes the actual saved OAuth installation
and sandbox clinic. After that I/O, the bridge rechecks current database authority
and the provider rechecks unchanged credential custody before transport. Recovery
uses the same current authority and installation, with metadata and GET only.
These checks do not make provider calls atomic with database revocation. A request
already admitted or handed to the provider cannot be recalled by a later local
withdrawal. Known late receipts remain in custody and are withheld, not erased.

Aurora JSON cells may arrive as strings; the bridge decodes them before strict
input and actor comparison. It does not mistake a string cell for a different
actor or silently use an unvalidated payload. Errors remain one opaque refusal.

`createRdsDataFullscriptDraftDatabase` assumes only the fixed
`fullscript_draft_worker` role before application queries. Failure to assume it
rolls back; no API-role or administrative fallback is available. Role membership
and the source-candidate SQL still require a reviewed migration/deployment.

## Verification

The final focused group passed 286 tests in three files with no skips, including
35 new cases across the authority/composition, credential and RDS-role suites.
Typecheck and targeted lint passed. The composition tests use actual local
PostgreSQL roles and SQL; the two native-provider cases also use the real token
parser, installation observer, clinic read, HTTP serializer and response decoder.
Only their AWS and HTTP transports are fictional. They include both a verified
draft and withdrawal during the clinic read, with no POST in the latter case.

The earlier native fixture incorrectly omitted JSON response headers and then
withdrew the predecessor consent revision rather than the new revision. Those
runs failed and are not acceptance evidence; the final fixtures preserve the
production checks. The first typecheck also found two test-helper type errors,
which were corrected before the final typecheck and focused pass. No real provider
or AWS operation ran, and PGlite does not prove hosted multi-session races.

## Remaining integration

The scoped HTTP handler and native observer now exist as unreleased source.
Their source-candidate registration, target artifact loader, published Lambda
deployment, restricted IAM and positive hosted qualification remain engineering.
Forward application and rollback for the source candidates, hold-aware account-wide
privacy and provider-copy lifecycle, exact deployed artifacts and positive real
DynamoDB/Aurora/Fullscript sandbox acceptance remain open. OAuth-start,
disconnect and late-callback settlement remain a separate unqualified lifecycle.
No invented review hash, configuration flag or successful local fixture is a
substitute for reviewed releases or hosted acceptance. PHI remains disabled.
