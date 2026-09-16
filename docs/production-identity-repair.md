# Production identity repair — September 8, 2026

Status: implemented and tested; production registration remains disabled. This is not a commercial release.

## Changes

- Production Cognito sessions accept the actual production-bound schema, without requiring a nonexistent synthetic=false attribute. Email verification and matching pool/client remain required.
- Production V2 sign-in calls an authenticated identity-only bootstrap endpoint before saving the session. It does not require a practitioner connection or an activated clinical posture.
- ConfirmSignUp failures cannot be treated as successful confirmation. The current Cognito account must be confirmed, enabled, and bound to the claimed person and environment.
- Bootstrap is retryable and idempotent; callers cannot supply another person, clinic, role or clinical payload.
- Expired V2 ID tokens now trigger refresh instead of premature sign-out. Failed refresh never returns an expired session. Refreshed sessions undergo governed account verification before persistence.
- Patient-server middleware refuses production health requests while activation is absent, including when only the production identity-mode variable is set. The existing lab/intake pilot does not authorize this separate server's AI generation routes.

## Actual AWS evidence

Account 173535830222, us-east-2; stack `ai-longevity-production-consumer-account-disabled`; function `gfljw066o6-production-consumer-account`.

- Function Active / update Successful; AccountActivation=blocked.
- Bundle source SHA-256: `f0983fc82a81bab2d066f70d1ab7644a51b85447bebd18e0e756261904a08c8a`.
- Lambda ZIP digest: `UP95Y/KFYGlMxHdVSEjpX22GyEGOD4xiBAEjoilcPwQ=`; independently matches the local deployment ZIP.
- POST public registration returns 503 consumer_account_not_activated.
- POST authenticated bootstrap without a token returns 401.
- Role has only BoundedRegistrationLogging; no attached policies or data/Cognito-access policies.
- Aurora rollback acceptance, using clinical_core_api for bootstrap calls, passed identity creation, duplicate idempotency and conflicting-person denial. Administrative readback confirmed zero retained fixture identity/person/organization rows. No real emails were used.

Routes: existing registration/confirmation/resend/recovery under `/clinical-core/public/consumer/`; new POST `/clinical-core/consumer/account/bootstrap` uses the login client's JWT authorizer. Successful bootstrap returns only `state: ready`, `contractVersion: consumer-account/1`, `clinicalAccessGranted: false`.

## Verification and release limits

Desktop: 1,094 passed / 10 skipped, typecheck passed, lint zero errors (four existing warnings).
V2: 371 passed / one hosted test skipped, typecheck/lint passed, production backend build and bounded smoke passed.
Account/provider mocks do not prove delivery of registration/reset email. Aurora tests do not prove the installed phone flow.

No EAS build, TestFlight submission, public Desktop replacement, clinical activation, real charge, new mailbox or provider secret was created. These changes are on the commercial-readiness PRs, not an installed mobile release.

## Concrete engineering still required

1. Production lab pipeline: explicit production contracts, authenticated ownership, durable async jobs, consent/withdrawal, and reviewed range provenance. The current worker still includes synthetic functional-range fixtures; merely changing its classification would not be a safe conversion.
2. Production voice pipeline: durable asynchronous transcription, ownership checks, consent/revocation and reliable cleanup. The current synthetic handler polls within a short request timeout.
3. Independent consumer clinical storage/context and a reviewed Core route policy for labs, intake, health/cycle data and AI. The existing narrow clinic pilot is not the full consumer product.
4. Persist attributable acceptance versions for terms/privacy and feature consents; finish request fulfillment across records, files, transcripts, identities and retention.
5. Configure and physically verify the selected email, store subscriptions, calendar/Zoom and product-provider accounts. Billing sandbox identity must match its consumer pool.
6. Verify exact deployed App/Desktop release together: registration/recovery, lab upload/regeneration, truthful chat context, partial Health data, consent withdrawal, transfer, caregiver isolation and purchases. Complete abuse/load, backup/restore and security acceptance.

Do not enable PHI or claim only human requirements remain. See commercial-launch-handoff.md and core-launch-engineering.md for owner decisions and provider gates.
