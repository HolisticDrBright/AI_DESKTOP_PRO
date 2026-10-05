# Synthetic AWS qualification evidence — 2026-10-05

This is narrow, fictional-data evidence, **not** commercial acceptance or PHI approval.

## Target and posture

- AWS account `588966314750`, region `us-east-2`; `ai-synthetic-staging` sign-in verified by STS.
- Isolated database `clinical_core_qualification` had 103 migrations, latest `20260928010000`.
- Qualification foundation reports `PhiAllowed=false`. The recovered personal-storage candidate reports `Activation=blocked`, `QualificationExecution=enabled`, and source `a300c633ac81909842503ad37e77170ad63ed605`.
- The account's observed Lambda concurrency quota is 150. The current candidate capacity preflight passes for 35 requested reservations. It does not prove all candidates can deploy or run.

## Personal-storage recovery

The previously rolled-back `ai-clinical-core-qualification-personal-storage` stack retained only its log group. A reviewed change set added the Lambda, role, routes and alarms without deleting or replacing that group. The stack reached `UPDATE_COMPLETE`; the Lambda became Active, and its code digest matched the reviewed `personal-storage.zip` artifact. Anonymous posture access returned 401.

The owner approved **only** this exact fictional-test consent copy in this chat:

> I agree to store and use fictional test intake and lab-history data in the isolated ALP qualification service for software testing. No real personal or health information may be entered.

The guarded operator `scripts/register-aws-qualification-consent.mjs` registered that copy in `forms_checkins` and `lab_history`, version `qualification-test-2026-10-05`, SHA-256 `4dba561f24d61172401f6ce70e067458ee114e0caf530ef81c2a17adeeba86e5`. A repeat invocation returned `already_registered` without replacing the release. This is not a production patient consent or PHI activation.

## Hosted observations

All authenticated responses below carried `x-clinical-execution: qualification`:

- Two fictional Cognito consumers each saw the exact forms and lab release and granted revision 1.
- Consumer A saved one fictional wellness profile: HTTP 200, revision 1. An identical replay returned HTTP 200 with `duplicate=true`.
- Consumer A reread that record. Consumer B's read of its ID returned no data; Consumer B's list returned zero items.
- Consumer A saved one fictional lab observation: HTTP 200, revision 1. Consumer A reread it; Consumer B's read returned no data.
- No real personal information, health information, wearable data, or recording was entered.

The first attempted wellness write was refused `request_invalid` because the test payload included an extra fixture field. The test was corrected to the published schema before the successful run. This is evidence of schema refusal, not evidence of a production failure.

## Not proven

- These requests exercised an older `a300c63` personal-storage candidate, not an exact matched current V2/Desktop release.
- The other qualification candidates, current identity routes and latest synthetic migrations, full hosted harnesses, retention schedule, export delivery, recording/transcription/drafting, cross-clinic access, messaging settlement and program assignment were not accepted by this narrow run.
- A read-only check of the separate synthetic-staging database `clinical_core` found 33 applied migrations, latest `20260929110000`; the current source tree contains 46 synthetic migrations. The remaining 13 were not applied by this run. In particular, program-assignment migration `20260929120000` was previously held for a source-bound content-validation finding; it must be reviewed and rollback-tested before application.
- No physical iOS/Android journey, store billing, provider live-mode acceptance, or complete security/privacy/retention review was performed.
- PHI remains disabled. Do not infer commercial readiness, HIPAA compliance, or readiness for real patients from this document.
- At source HEAD, the full Desktop dependency audit still reports five high findings through a development-only `braces` dependency chain. A runtime-only audit reports zero findings, but the full CI security gate is not green and must not be silently weakened.
