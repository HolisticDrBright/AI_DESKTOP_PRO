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

## Final hosted web checkpoint

The follow-up web release is now deployed:

- Source 4ffd5f248432f93256ecbc6d2124ba1e798e21f0.
- CodeBuild ai-desktop-pro-synthetic-web:ccef39f7-161c-435c-93ec-d981363a0cbf
  SUCCEEDED, including same-image boot/health verification.
- ECR digest sha256:d014a93ce3b0762015fdd5843ef66949c4d37a91c57c5a90c42cf809cfa959ab;
  scan COMPLETE, zero findings.
- App Runner operation 3f883ef5153d4fdaa8d8b105fe6816bf SUCCEEDED.
  Service RUNNING on that exact source tag; PHI false, synthetic mode, staging.
  The prior 2178788 deployment also succeeded. Backend remains exact 2178788;
  4ffd5f2 changes only the shell label, smoke test and evidence documentation.
- scripts/verify-hosted-synthetic-shell.mjs passed against the hosted service:
  health 200; isolated signed-out session; login renders; Patients/Calendar
  redirect to login; account sign-in link works; no false signed-in subtitle;
  zero page exceptions, console errors or attempted writes. Screenshot inspected
  at test-results/hosted-synthetic-shell/login.png (generated, not committed).
- Desktop CI35032422373 for backend source 2178788 completed successfully.
  V2 documentation checkpoint c85a15c / CI35033282022 also succeeded.
  Desktop follow-up CI35033158376 was still running at this capture.
- The preferred agent-browser CLI was unavailable. The same read-only browser
  workflow was executed using the repository's existing Playwright engine.
  This verifies public/signed-out boundaries, not authenticated practitioner
  chart transfer or physical mobile behavior.

## Durable deletion deployment checkpoint

- Backend source ae26677f4740baa1323f57a7646fbe3ab2c1672e, PR65.
  Unit suite: 1,429 passed / 11 existing skips; typecheck, artifact build,
  infrastructure lint and diff checks passed.
- Reviewed change set recovery-ae26677f4740-20260915163526 executed in
  account 588966314750 only. No resource removal/replacement; existing clinical,
  identity and knowledge-release parameters preserved. Stack UPDATE_COMPLETE.
- API, authorizer and cleanup ZIP SHA256:
  97eaca4ab94973b7ece314dc676fd13a20d87bd49346fbf773cbf29f9a00fb5a.
  Worker ZIP SHA256:
  ac6ddbbdc73cb0d5725c1c1cfa199075df0a8b730f92c0d7ff90393230d38773.
  All four functions Active/Successful with matching hashes.
- The cleanup worker has no model credentials or object-body read/write access.
  It requires a valid scoped deletion outbox; events alone do not authorize a
  purge. Worker failure callbacks cannot overwrite deletion/awaiting-upload states.
- LabOwnerInventory remained ACTIVE. LabCleanupDue was still CREATING/backfilling
  after stack completion; acceptance was deliberately not started at that point.
  Record its ACTIVE status and actual late-upload test results separately below.
- Cleanup PHI_ALLOWED=false / synthetic_only. NotificationsConfigured=false:
  alarms exist but no approved SNS recipient was supplied. Failure queue was
  empty at the initial check. Shared concurrency is only 10; production capacity
  qualification remains open. No paid mobile build or real-data activation.
- App Runner web remains exact 4ffd5f2; this change deploys backend artifacts,
  not a new web image. CI35033158376 and evidence CI35033922115 have succeeded;
  new backend CI35036314103 was still running at the deployment checkpoint.

Read docs/durable-lab-deletion-cleanup.md for tombstone/backup retention,
operational replay and rollback boundaries. This is per-analysis object cleanup,
not account-wide erasure or completion of original phases 2/3/6.

### Live late-upload acceptance completed

Both indexes subsequently became ACTIVE. The extended hosted script completed
**23 checks**, including real Cognito authentication/isolation, immutable request
replay, renewal/receipt recovery, encrypted non-overwriting fixture uploads,
the awaiting-upload failure-callback fence, owned deletion and metadata-only
durable watch. The previously issued URL successfully recreated the fixture
after deletion; it was then removed automatically without another delete request.
The deleted job still returned 404. This demonstrates the late-write path using
actual AWS delivery/cleanup, not mocked storage.

Both newly created synthetic test identities were signed out and disabled;
audit/request/cleanup records retained intentionally. The failure queue reported
zero visible and zero in-flight messages after the test. Foundation PHI false
and synthetic_only reconfirmed. No complete-upload/model call, real data, email,
payment, account-wide erasure or mobile build was performed. Notifications remain
unconfigured pending an approved recipient. Backend CI35036314103 was still
running at this final live-test capture; do not confuse this manual acceptance
with a completed CI run or physical-device qualification.

## Active cancellation service acceptance

- Backend source **be23130a2389d923f3b82fa0bcee5c0f9a25e1ce** (PR65).
  **1,450 passed / 11 existing skips**, typecheck, lint, infrastructure lint,
  PowerShell parse, bundle build and diff checks passed.
- Exact change set recovery-be23130a2389-20260915165936 executed in synthetic
  account 588966314750. UPDATE_COMPLETE, both indexes ACTIVE. Added two existing-
  authorizer-protected cancellation routes and scoped StopExecution permission.
  No data resource replacement/removal. Two unchanged-rule invocation permissions
  were reviewed as conditional refreshes; no broader principal/source allowed.
- API/authorizer/cleanup artifact SHA256:
  4b3fb90470891a323fac41bcb9ea911cd2d1d7c49b174ffb6208d08f17dbfcf9.
  Worker SHA256:
  6b92bfce4ea26904fb984ea3ba5222afe1136037b5135b7106822f11dacd043f.
  All four functions Active/Successful, hashes matched.
- Extended test with -TestActiveCancellation passed **28 live checks**. Only its
  newly created fixture was placed in queued with a ten-minute blocking lease.
  The real workflow was RUNNING; the lease prevented provider/document access.
  Wrong-owner cancellation returned 404; missing confirmation returned 400;
  owned cancellation succeeded and exact execution became ABORTED. Repeating
  cancellation succeeded safely. Deletion/watch and late-PUT automatic removal
  passed again, with no resurrected job.
- Both new identities signed out/disabled; zero visible/in-flight failure-queue
  messages after the run. Test job/files removed; minimal audit/deletion/request
  metadata retained. No real data, model generation, email, payment or mobile build.
- Prior cleanup backend CI35036314103 succeeded. Cancellation CI35038029274 and
  preceding evidence CI35037195301 were still running at final live capture.
  App Runner web remains 4ffd5f2. V2 runtime unchanged; **mobile cancellation
  controls and durable local cancellation-intent integration remain unimplemented**.

Read docs/lab-active-cancellation.md. Active provider-call interruption/erasure is
not claimed. This completes tested service behavior, not original phase 2 or
commercial release qualification. PHI and clinical release gates remain unchanged.
