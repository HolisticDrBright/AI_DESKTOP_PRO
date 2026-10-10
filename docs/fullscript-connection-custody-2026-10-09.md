# Fullscript saved connection and refresh safeguards

Saved Fullscript connections are now validated against their exact organization
and actor keys before use. Invalid JSON, missing fields, wrong owners, malformed
credentials, duplicate permissions and unknown fields refuse rather than appear
as a successful disconnected status. Status errors contain a fixed code, not
AWS or provider error details. An expired Desktop identity cannot access tokens.

Refresh preserves the original practitioner or staff identity, environment,
connection date and permission set. Scope order may change, but a changed owner,
added or removed permission, or unusable expiry requires reauthorization rather
than silently changing the installation. The store consistently reads the
current item, compares the complete validated previous record, then conditionally
replaces its exact stored bytes. A disconnect, concurrent refresh or reconnection
cannot be overwritten by an old in-flight refresh. Legacy JSON property order is
supported without weakening the conditional match.

Disconnect refuses an environment mismatch before revocation. After revoking
the observed token it conditionally removes only that installation. If another
connection has replaced it, the new connection is not deleted and the operation
does not claim it was disconnected. These are local custody safeguards, not an
external provider deletion certificate.

The focused fictional-transport group passed 70 tests in four files, including
49 new custody and refresh cases. Initial checks exposed a test that compared
JSON property order and missing fixture environment/type annotations; those
failed checks are not passes. The final extended group passed all 255 tests in
11 files, including the existing durable draft, canonical authority and cart
suites. Typecheck and targeted lint passed after the fixture type repairs.
These tests use a local database and fictional transports, not live DynamoDB
conditional-write or Fullscript sandbox acceptance.

This increment does not install the Fullscript cart runtime. Same-target
reviewed provider/credential binding, scoped delivery controls, hold-aware
privacy lifecycle, artifact-bound deployment and actual sandbox acceptance
remain required. The protocol-cart response remains `not_implemented`.
No token was read, rotated or revoked in AWS; all test credentials are fictional.
No provider request, deployment, consent approval, PHI activation or paid mobile
build occurred.
