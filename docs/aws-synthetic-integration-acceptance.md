# AWS synthetic integration acceptance

Last verified: 2026-08-12

## Current posture

- AWS account: `588966314750`, region: `us-east-2`.
- Foundation stack: `ai-clinical-core-synthetic-staging`.
- Authenticated extension: `ai-clinical-core-synthetic-staging-authenticated-api`.
- Contract: `clinical-core/1`; environment: `synthetic-staging`; data classification: `synthetic_only`.
- `PhiAllowed=false` and `RealPatientDataAllowed=false` remain structural boundaries.
- The Desktop bridge uses only the Cognito workforce route. The V2 bridge uses only the Cognito consumer route.
- Supabase sessions are not accepted as Cognito identities. Login federation is required before either app can perform clinical-core operations for ordinary signed-in users.
- Junction and Passio are prepared but inactive. Credentials and environment variables cannot authorize transmission.

## Evidence completed

- Three synthetic Cognito accounts were provisioned: primary workforce, isolation workforce, and primary consumer.
- Workforce acceptance sessions required software-token MFA.
- The live API acceptance completed 11 HTTPS operations against API Gateway:
  - workforce and consumer authenticated posture;
  - invitation issue and single-use claim;
  - invitation replay refusal;
  - wrong-pool refusal;
  - PHI-shaped field refusal;
  - cross-tenant refusal;
  - consent grant, duplicate-grant refusal, and revocation.
- Both migrations are present exactly once: `20260812010000` and `20260812220000`.
- The audit/recovery acceptance confirmed CloudTrail delivery, created an encrypted Aurora snapshot, restored it privately, verified the restore, and deleted the temporary restore.
- Retained acceptance snapshot: `ai-clinical-synthetic-acceptance-1786573175` (encrypted with the clinical KMS key).
- Temporary passwords, ID tokens, invitation material, and the generated acceptance manifest were not committed and were destroyed after use.

## Connector posture

### Junction

Prepared server boundary:

- approved HTTPS origins only;
- opaque subject identifiers only;
- short-lived Link URL returned to the app;
- manual redirect handling, bounded response size, and no team key in the client;
- governed registry, approved purpose, consent, clinical-use approval, security review, and executed vendor BAA required before any request.

No Junction request was made in this acceptance.

### Passio

Prepared server boundary:

- approved HTTPS origin only;
- server-only credential;
- no local nutrition fallback;
- governed registry, approved purpose, consent, clinical-use approval, security review, and executed vendor BAA required before any request;
- returned nutrition remains a candidate until human confirmation.

No Passio request was made in this acceptance.

## Honest limitations

- The deployment manifest still records `aws_baa_status=pending-organization-acceptance`; production PHI activation must remain blocked until the management-account status is independently verified and the manifest is reviewed and updated.
- Cognito-to-existing-app session federation is not implemented. The app bridges accept Cognito ID tokens only and fail closed otherwise.
- The durable AWS connector-registry read is not implemented. Junction and Passio therefore remain unavailable in normal runtime.
- This acceptance is not a HIPAA certification and does not authorize real patient data.
