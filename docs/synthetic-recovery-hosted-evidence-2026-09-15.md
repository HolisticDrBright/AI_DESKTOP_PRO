# Synthetic recovery hosted evidence — September 15, 2026

Original commercial phases 2 and 6. This is a bounded hosted verification,
not completion of either phase or authorization for real patient data.

## Deployed backend

- Account 588966314750, Ohio; foundation reports synthetic_only and PHI false.
- Stack: ai-clinical-core-synthetic-staging-lab-analysis.
- Runtime source: 21787884010d79d211ce5a829fb23057bf6d76a4.
- Executed change set: recovery-21787884010d-20260915154448.
- UPDATE_COMPLETE; LabOwnerInventory index ACTIVE.
- API and synthetic authorizer ZIP SHA256:
  60ae0634cd2271e994e913c1c2c0f6a1173c1f1a5e2640ed86a5d073ac2ba755.
- Worker ZIP SHA256:
  ed0a84f9f6afcab48ae1e86216f687960150a9b333fbf945cc30848b214c59aa.
- All three running Lambda hashes match, with successful updates and Active state.
- Existing configuration was preserved rather than reset from historical script
  defaults. KnowledgeReleaseMode remains disabled and LabRangeMode synthetic_fixture.
  No clinical approval, source verification, signing material or PHI gate changed.
- All 26 template lab routes are protected; the separately owned labs/import
  route was left untouched. Anonymous recovery/inventory requests return 401.

## Failure found and repaired

The first authenticated hosted test reached inventory but failed. Two later
attempts failed creation with HTTP 400. Index status, Query IAM and direct empty
index-query checks were valid. Actual newly created Cognito test subjects exposed
the defect: four of six had UUID-shaped subjects without RFC variant bits.
The inventory helper incorrectly imposed the application-generated UUID format
on these opaque identity subjects.

The repair accepts the Cognito subject shape without asserting UUID version or
variant semantics. It still uses the exact verified subject, organization and
person tuple for the partition and rechecks ownership on the current base row.
Application job/request/person/organization identifiers remain strictly checked.
Tests cover all 16 subject variant digits, malformed input, unique partitions
and cross-owner denial. No authorization bypass or identity normalization.

## Executed live acceptance

Run scripts/test-aws-lab-recovery-hosted.ps1 with explicit synthetic/test-user
switches. The optional TestUploadRoundTrip switch uploads only the script's
constant non-clinical fixture, never completes the upload into analysis.

- First successful post-repair run: 13 checks.
- Extended run: 17 checks, including real Cognito sign-in; unauthorized access;
  request replay and changed-input conflict; cross-user discovery, descriptor
  and upload-URL refusal; inventory isolation and owned visibility; missing-object
  renewal; actual KMS/checksum-bound PUT; overwrite rejection (412); verified
  remote receipt reconstruction; owned job deletion; no remaining fixture
  object versions or delete markers at the time of the cleanup check.
- The two newly created users per run were globally signed out and disabled.
  Invitation email was suppressed; passwords/tokens stayed in process memory.
  Failed exploratory runs also disabled all six newly created identities.
  Audit history and request tombstones are intentionally retained.
- No real user account was modified, no health data uploaded, no model call,
  transcription, email delivery, payment or mobile build occurred.

This does not prove durable erasure against an in-flight or still-valid signed
PUT. It does not test conversion, generation, full app-to-Desktop transfer,
installed mobile presentation, legacy inventory migration, account-wide privacy
fulfillment, production guardian access or external-provider activation.

## Source verification and web candidate

- Desktop typecheck passed; 1,397 tests passed and 11 were skipped.
- Exact-source CodeBuild:
  ai-desktop-pro-synthetic-web:08a3f975-7b70-4c44-89f6-9fb6ce2e3e89.
- Source 21787884010d79d211ce5a829fb23057bf6d76a4, build SUCCEEDED;
  its buildspec boots and health-checks the built image before pushing it.
- Image digest:
  sha256:eaff6516f8603fe33ba0dd4b5255209bbb2bfd39bedb586ff22b5cf0fdf1a732.
  ECR scan COMPLETE with zero findings.
- App Runner update 2d053281e734416382f16d315053fe28 was dispatched from
  63c7c7d9585133bb72986cf6c032a39eb621fac7 to the exact 2178788 image,
  preserving the rest of SourceConfiguration, PHI false and synthetic/staging.
  Deployment completion and post-deploy checks must be recorded separately.
- CI35032422373 was still running at this checkpoint. Its deployed-backend job
  skips functional execution without secrets; a green wrapper is not a live pass.
- V2 remains source 6fc11d360ad3a9e2aa15433bdbfc0284bd5c93e7,
  CI35030278032 success. No new installed mobile build is claimed.

The anonymous hosted login baseline rendered without page exceptions, but the
shell's static “Signed-in practitioner” subtitle was misleading without a session.
The follow-up source repair uses neutral “Session & organization” wording and
adds a practitioner sign-in link to the menu. No new client identity inference
or authorization bypass. This follow-up is NOT in the 2178788 image.
