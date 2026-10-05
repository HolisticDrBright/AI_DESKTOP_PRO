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

## Hosted synthetic program assignment — later October 5

The guarded program migration changed only staging `clinical_core`, not the isolated qualification database. A reviewed change set then updated `ai-clinical-core-synthetic-staging-authenticated-api`: two JWT routes were added (`POST /clinical-core/consumer/programs`, `POST /clinical-core/workforce/programs`) and the existing Lambda code was updated in place. No resource was replaced. The stack reached `UPDATE_COMPLETE`, the Lambda was Active/Successful, and its immutable S3 artifact is `clinical-core/authenticated-api/58f5978301be218896b269a44438fecb8ae89a690bee6671008b64f215f14247.zip` (SSE-KMS, bucket version `GsDkhEuyC.7rZk63usQjzzoUU5Pcc._3`). The previous artifact remains available for rollback. Staging `PhiAllowed=false` and its exact 35-row migration ledger were rechecked before preparing the change.

`scripts/verify-synthetic-program-routes-hosted.mjs` ran through the real API with existing fictional, synthetic-attested Cognito users. It observed authenticated consumer/workforce reads, role and anonymous refusals, a published fictional version, practitioner assignment, consumer read and acceptance, cross-owner refusal, and a refusal to complete an unresolved supplement. The program review reported `inventoryComplete=false` with that supplement held; no product link or catalog approval was invented. The test fixture is fictional and retained for replay. An initial attempt using older fictional identities was refused because their immutable synthetic-attestation claim was absent. That guard was not weakened; the successful run used previously designated attested fictional accounts.

This is a synthetic staging journey, not a qualification execution for the other ten candidate stacks, a current mobile/Desktop release, or PHI approval. The governed catalog is not reachable from this program target, so every supplement step remains held. No device journey or real patient data was tested. The user instructed us to hold TestFlight/paid mobile builds until the remaining updates are complete.

## Not proven

- These requests exercised an older `a300c63` personal-storage candidate, not an exact matched current V2/Desktop release.
- The other qualification candidates, full hosted harnesses, retention schedule, export delivery, recording/transcription/drafting, cross-clinic access, and exact matched release candidates were not accepted by this narrow run. Program assignment now has a separate fictional staging run above; that does not imply qualification-target or mobile acceptance.
- At the start of this run the separate synthetic-staging database `clinical_core` had 33 applied migrations, latest `20260929110000`. The current manifest lists 45 migrations; a historical alias in the live ledger accounts for one extra row. After the narrow operation below, 11 manifest-listed migrations remain unapplied. None were included in this operation.
- No physical iOS/Android journey, store billing, provider live-mode acceptance, or complete security/privacy/retention review was performed.
- PHI remains disabled. Do not infer commercial readiness, HIPAA compliance, or readiness for real patients from this document.
- At source HEAD, the full Desktop dependency audit still reports five high findings through a development-only `braces` dependency chain. A runtime-only audit reports zero findings, but the full CI security gate is not green and must not be silently weakened.

## Narrow staging migration rehearsal

The source-bound program-assignment audit now reports no findings, and focused program and specimen-context tests pass. The staging ledger has 33 entries. Its only source-version alias is the previously reviewed `20260902230000` workforce directory row, whose digest matches source `20260821049700`. The source manifest also contains an older-numbered, unapplied lab-specimen-context migration; it must precede program assignments.

`syntheticProgramMigration` is a guarded, synthetic-only operator for exactly those two migration digests. It checks the STS account, foundation posture, exact 33-row predecessor ledger including the alias, and the selected SQL hashes. `inspect` is read-only. `rehearse --confirm-synthetic-only` executed both migrations in one Aurora transaction, intentionally rolled them back, and verified the ledger remained at 33. Then `apply --confirm-synthetic-only` committed only `20260916080000` and `20260929120000`; subsequent inspect verified the exact 35-row ledger. No other migration was included. These database changes do not deploy the program API routes or constitute a hosted program journey.
